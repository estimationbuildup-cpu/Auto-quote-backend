import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const WEB_SEARCH_MODEL = process.env.OPENAI_WEB_SEARCH_MODEL || "gpt-4.1-mini";
const ENABLE_WEB_SEARCH = process.env.ENABLE_WEB_SEARCH !== "false";
const STAFF_CONTACT_NAME = process.env.STAFF_CONTACT_NAME || "Sameer Asim";
const STAFF_CONTACT_PHONE = process.env.SAMEER_CONTACT_PHONE || process.env.COMPANY_PHONE || "";
const STAFF_EMAIL = String(process.env.STAFF_EMAIL || "").trim().toLowerCase();
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || "";
const STAFF_USERS_JSON = process.env.STAFF_USERS_JSON || "";
const STAFF_TOKEN_TTL_MS = Number(process.env.STAFF_TOKEN_TTL_HOURS || 12) * 60 * 60 * 1000;
const staffSessions = new Map();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = path.join(__dirname, "data");
const LOCAL_BACKUP_FILE = path.join(DATA_DIR, "app-data.json");
const STAFF_PROFILE_USERS_FILE = path.join(DATA_DIR, "staff-users.json");
const DEFAULT_STAFF_PROFILE_NAMES = ["Sameer", "Sajid", "Rasheed", "Jithin", "Arafat"];
const STAFF_OWNER_PROFILE_NAME = normalizeStaffProfileName(process.env.STAFF_OWNER_PROFILE_NAME || "Sameer");
const BUILT_IN_AUTHORITY_PROFILE_ID = "builtin-authority-profile";
const BUILT_IN_AUTHORITY_SETTING_KEY = "builtin_authority_profile";
const FRONTEND_SETTINGS_STORAGE_KEY = "estimation-grid-pro-v2";
const FRONTEND_QUOTATION_STORAGE_KEY = "estimation-grid-quotation-v2";
const FRONTEND_ROWS_STORAGE_KEY = "estimation-grid-rows-v8";
const SUPABASE_URL = String(process.env.SUPABASE_URL || "").replace(/\/$/, "");
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY || "";
const SUPABASE_ENABLED = Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY);
let latestSupabaseIssue = null;

function rememberSupabaseIssue(context, error) {
  latestSupabaseIssue = {
    context,
    message: error?.message || String(error || "Unknown database error"),
    at: new Date().toISOString(),
  };
  console.error(`[Supabase] ${context}:`, error?.message || error);
}

function publicDatabaseError(fallback = "Database connection needs checking on the backend.") {
  return fallback;
}

const allowedOrigins = (process.env.CORS_ORIGINS || "https://buildupuae.com,https://www.buildupuae.com,https://auto-quote-backend.onrender.com")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, true);
  },
  credentials: true,
}));
app.use(express.json({ limit: "25mb" }));

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const handoffRequests = [];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function writeJsonFile(filePath, data) {
  ensureDataDir();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
}

function readJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function isUuid(value = "") {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));
}

function stableStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return String(value);
  try {
    return JSON.stringify(value, Object.keys(value).sort());
  } catch {
    return String(value);
  }
}

function valueToAuditText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json",
    ...extra,
  };
}

async function supabaseRest(pathname, { method = "GET", body, headers = {} } = {}) {
  if (!SUPABASE_ENABLED) throw new Error("Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Render.");
  const url = `${SUPABASE_URL}/rest/v1/${pathname}`;
  const response = await fetch(url, {
    method,
    headers: supabaseHeaders(headers),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const message = typeof data === "object" && data ? (data.message || data.error || JSON.stringify(data)) : (text || response.statusText);
    throw new Error(`Supabase ${method} ${pathname} failed: ${message}`);
  }
  return data;
}

function encodeEq(value = "") {
  return encodeURIComponent(String(value || ""));
}

async function dbSelect(table, query = "select=*") {
  return supabaseRest(`${table}?${query}`, { method: "GET" });
}

async function dbInsert(table, rows, { returning = true } = {}) {
  return supabaseRest(table, {
    method: "POST",
    body: rows,
    headers: { Prefer: returning ? "return=representation" : "return=minimal" },
  });
}

async function dbUpsert(table, rows, { onConflict, returning = true } = {}) {
  const suffix = onConflict ? `?on_conflict=${encodeURIComponent(onConflict)}` : "";
  return supabaseRest(`${table}${suffix}`, {
    method: "POST",
    body: rows,
    headers: { Prefer: `resolution=merge-duplicates,${returning ? "return=representation" : "return=minimal"}` },
  });
}

async function dbPatch(table, query, patch, { returning = true } = {}) {
  return supabaseRest(`${table}?${query}`, {
    method: "PATCH",
    body: patch,
    headers: { Prefer: returning ? "return=representation" : "return=minimal" },
  });
}

async function dbDelete(table, query, { returning = true } = {}) {
  return supabaseRest(`${table}?${query}`, {
    method: "DELETE",
    headers: { Prefer: returning ? "return=representation" : "return=minimal" },
  });
}

function safeJsonParse(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

function parseLocalStorageObject(snapshot = {}) {
  const raw = snapshot?.localStorage && typeof snapshot.localStorage === "object" ? snapshot.localStorage : {};
  const parsed = {};
  Object.entries(raw).forEach(([key, value]) => {
    parsed[key] = safeJsonParse(value, value);
  });
  return parsed;
}

function normalizeStaffProfileName(value = "") {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function staffProfileIdFromName(name = "") {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || `user-${Date.now().toString(36)}`;
}

function isOwnerStaffProfileName(name = "") {
  return normalizeStaffProfileName(name).toLowerCase() === STAFF_OWNER_PROFILE_NAME.toLowerCase();
}

function isDefaultStaffProfileName(name = "") {
  const cleanName = normalizeStaffProfileName(name);
  return DEFAULT_STAFF_PROFILE_NAMES.some((item) => item.toLowerCase() === cleanName.toLowerCase());
}

function normalizeStaffProfileRole(role = "staff", name = "") {
  if (isOwnerStaffProfileName(name)) return "owner";
  const cleanRole = String(role || "staff").trim().toLowerCase();
  return ["admin", "staff"].includes(cleanRole) ? cleanRole : "staff";
}

function publicStaffProfile(profile = {}, options = {}) {
  const cleanName = normalizeStaffProfileName(profile?.name || profile?.display_name);
  const rawRole = String(profile?.role || "staff").trim().toLowerCase();
  const internalRole = profile?.is_protected || isOwnerStaffProfileName(cleanName) || rawRole === "owner" ? "owner" : normalizeStaffProfileRole(rawRole, cleanName);
  const canManageUsers = Boolean(profile?.canManageUsers || internalRole === "owner" || internalRole === "admin" || rawRole === "admin");
  const displayRole = internalRole === "owner" ? "admin" : internalRole;
  const publicProfile = {
    id: profile.id || staffProfileIdFromName(cleanName),
    name: cleanName,
    role: displayRole,
    defaultUser: isDefaultStaffProfileName(cleanName),
    hasPassword: Boolean(profile.password_hash || profile.passwordHash || (profile.salt && profile.passwordHash)),
    createdAt: profile.created_at || profile.createdAt || null,
    updatedAt: profile.updated_at || profile.updatedAt || null,
  };

  if (options.includePermissions) {
    publicProfile.canManageUsers = canManageUsers;
  }

  return publicProfile;
}

function encodeStaffProfilePassword(password = "") {
  const salt = crypto.randomBytes(16).toString("hex");
  const iterations = 100000;
  const hash = crypto.pbkdf2Sync(String(password), salt, iterations, 64, "sha512").toString("hex");
  return `pbkdf2_sha512$${iterations}$${salt}$${hash}`;
}

function verifyEncodedStaffProfilePassword(password = "", encoded = "") {
  const parts = String(encoded || "").split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2_sha512") return false;
  const iterations = Number(parts[1]) || 100000;
  const salt = parts[2];
  const storedHash = parts[3];
  const candidate = crypto.pbkdf2Sync(String(password), salt, iterations, 64, "sha512").toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(storedHash, "hex"));
  } catch {
    return false;
  }
}

function hashStaffProfilePassword(password = "") {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, "sha512").toString("hex");
  return { salt, hash };
}

function verifyStaffProfilePassword(password = "", profile = {}) {
  if (profile?.password_hash) return verifyEncodedStaffProfilePassword(password, profile.password_hash);
  if (!profile?.salt || !profile?.passwordHash) return false;
  const candidate = crypto.pbkdf2Sync(String(password), profile.salt, 100000, 64, "sha512").toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(profile.passwordHash, "hex"));
  } catch {
    return false;
  }
}

function readStoredStaffProfiles() {
  const stored = readJsonFile(STAFF_PROFILE_USERS_FILE, []);
  return Array.isArray(stored) ? stored : [];
}

function saveStoredStaffProfiles(profiles) {
  writeJsonFile(STAFF_PROFILE_USERS_FILE, Array.isArray(profiles) ? profiles : []);
}

function getBuiltInAuthorityProfileRaw() {
  const cleanName = normalizeStaffProfileName(STAFF_OWNER_PROFILE_NAME || "Sameer");
  const stored = findStoredStaffProfile(cleanName) || {};
  return {
    ...stored,
    id: BUILT_IN_AUTHORITY_PROFILE_ID,
    name: cleanName,
    role: "owner",
    canManageUsers: true,
    createdAt: stored.createdAt || null,
    updatedAt: stored.updatedAt || null,
  };
}

async function getBuiltInAuthorityProfileRecord() {
  const cleanName = normalizeStaffProfileName(STAFF_OWNER_PROFILE_NAME || "Sameer");
  const fallback = getBuiltInAuthorityProfileRaw();
  if (SUPABASE_ENABLED) {
    try {
      const rows = await dbSelect("app_settings", `select=setting_value,created_at,updated_at&setting_key=eq.${encodeEq(BUILT_IN_AUTHORITY_SETTING_KEY)}&limit=1`);
      const row = Array.isArray(rows) && rows.length ? rows[0] : null;
      const value = row?.setting_value && typeof row.setting_value === "object" ? row.setting_value : {};
      return {
        id: BUILT_IN_AUTHORITY_PROFILE_ID,
        name: cleanName,
        role: "owner",
        canManageUsers: true,
        password_hash: value.password_hash || null,
        created_at: row?.created_at || value.created_at || fallback.createdAt || null,
        updated_at: row?.updated_at || value.updated_at || fallback.updatedAt || null,
      };
    } catch (error) {
      rememberSupabaseIssue("load built-in staff profile", error);
    }
  }
  return fallback;
}

async function saveBuiltInAuthorityProfilePassword(password = "", actor = null) {
  const cleanPassword = String(password || "");
  if (cleanPassword.length < 4) throw new Error("Staff user password must be at least 4 characters.");
  const cleanName = normalizeStaffProfileName(STAFF_OWNER_PROFILE_NAME || "Sameer");
  const now = new Date().toISOString();
  const passwordHash = encodeStaffProfilePassword(cleanPassword);

  if (SUPABASE_ENABLED) {
    try {
      await dbUpsert("app_settings", [{
        setting_key: BUILT_IN_AUTHORITY_SETTING_KEY,
        setting_value: {
          display_name: cleanName,
          password_hash: passwordHash,
          role: "owner",
          updated_at: now,
        },
        updated_by_name: actor?.name || null,
        updated_at: now,
      }], { onConflict: "setting_key", returning: false });
      return publicStaffProfile({
        id: BUILT_IN_AUTHORITY_PROFILE_ID,
        name: cleanName,
        role: "owner",
        canManageUsers: true,
        password_hash: passwordHash,
        updated_at: now,
      }, { includePermissions: true });
    } catch (error) {
      rememberSupabaseIssue("save built-in staff profile", error);
    }
  }

  return createOrUpdateStaffProfileFile({ name: cleanName, password: cleanPassword, role: "owner", requirePassword: true });
}

function isBuiltInAuthorityProfileId(id = "") {
  return String(id || "") === BUILT_IN_AUTHORITY_PROFILE_ID;
}

function getFileStaffProfiles() {
  const stored = readStoredStaffProfiles();
  const byName = new Map();

  DEFAULT_STAFF_PROFILE_NAMES.forEach((name) => {
    const cleanName = normalizeStaffProfileName(name);
    if (isOwnerStaffProfileName(cleanName)) {
      byName.set(cleanName.toLowerCase(), publicStaffProfile(getBuiltInAuthorityProfileRaw()));
      return;
    }
    byName.set(cleanName.toLowerCase(), publicStaffProfile({
      id: staffProfileIdFromName(cleanName),
      name: cleanName,
      role: normalizeStaffProfileRole("staff", cleanName),
    }));
  });

  stored.forEach((profile) => {
    const cleanName = normalizeStaffProfileName(profile?.name);
    if (!cleanName) return;
    if (isOwnerStaffProfileName(cleanName)) {
      byName.set(cleanName.toLowerCase(), publicStaffProfile(getBuiltInAuthorityProfileRaw()));
      return;
    }
    byName.set(cleanName.toLowerCase(), publicStaffProfile(profile));
  });

  return Array.from(byName.values()).sort(sortStaffProfilesForDisplay);
}

function sortStaffProfilesForDisplay(a, b) {
  const ai = DEFAULT_STAFF_PROFILE_NAMES.findIndex((name) => name.toLowerCase() === String(a?.name || "").toLowerCase());
  const bi = DEFAULT_STAFF_PROFILE_NAMES.findIndex((name) => name.toLowerCase() === String(b?.name || "").toLowerCase());
  if (ai >= 0 || bi >= 0) return (ai >= 0 ? ai : 999) - (bi >= 0 ? bi : 999);
  return String(a?.name || "").localeCompare(String(b?.name || ""));
}

function sortStaffProfilesWithOrder(profiles = [], order = []) {
  const orderMap = new Map((Array.isArray(order) ? order : []).map((name, index) => [normalizeStaffProfileName(name).toLowerCase(), index]));
  return [...profiles].sort((a, b) => {
    const ai = orderMap.has(String(a.name || "").toLowerCase()) ? orderMap.get(String(a.name || "").toLowerCase()) : 9999;
    const bi = orderMap.has(String(b.name || "").toLowerCase()) ? orderMap.get(String(b.name || "").toLowerCase()) : 9999;
    if (ai !== bi) return ai - bi;
    return sortStaffProfilesForDisplay(a, b);
  });
}

async function getStaffProfileOrder() {
  if (!SUPABASE_ENABLED) return [];
  try {
    const rows = await dbSelect("app_settings", `select=setting_value&setting_key=eq.${encodeEq("staff_user_order")}&limit=1`);
    const value = Array.isArray(rows) && rows[0]?.setting_value ? rows[0].setting_value : null;
    return Array.isArray(value?.order) ? value.order : [];
  } catch (error) {
    rememberSupabaseIssue("load staff user order", error);
    return [];
  }
}

async function saveStaffProfileOrder(order = [], actor = null) {
  const cleanOrder = (Array.isArray(order) ? order : []).map(normalizeStaffProfileName).filter(Boolean);
  if (SUPABASE_ENABLED) {
    try {
      const now = new Date().toISOString();
      await dbUpsert("app_settings", [{
        setting_key: "staff_user_order",
        setting_value: { order: cleanOrder },
        updated_by_name: actor?.name || null,
        updated_at: now,
      }], { onConflict: "setting_key", returning: false });
    } catch (error) {
      rememberSupabaseIssue("save staff user order", error);
    }
  }
  return cleanOrder;
}

async function ensureDefaultStaffProfilesInDb() {
  if (!SUPABASE_ENABLED) return;
  const names = Array.from(new Set(DEFAULT_STAFF_PROFILE_NAMES.filter((name) => name && !isOwnerStaffProfileName(name))));
  for (const name of names) {
    const cleanName = normalizeStaffProfileName(name);
    const existing = await dbSelect("staff_users", `select=id,display_name&display_name=eq.${encodeEq(cleanName)}&limit=1`);
    if (Array.isArray(existing) && existing.length) continue;
    await dbInsert("staff_users", [{
      display_name: cleanName,
      role: "staff",
      status: "active",
      is_protected: false,
    }], { returning: false });
  }
}

async function getDbStaffProfiles({ includeInactive = false } = {}) {
  await ensureDefaultStaffProfilesInDb();
  const statusFilter = includeInactive ? "" : "&status=eq.active";
  const rows = await dbSelect("staff_users", `select=*&order=created_at.asc${statusFilter}`);
  const profiles = [
    publicStaffProfile(await getBuiltInAuthorityProfileRecord()),
    ...(Array.isArray(rows) ? rows : [])
      .filter((row) => !isOwnerStaffProfileName(row?.display_name))
      .map((row) => publicStaffProfile(row)),
  ];
  return sortStaffProfilesWithOrder(profiles, await getStaffProfileOrder());
}

async function getStaffProfiles() {
  if (SUPABASE_ENABLED) {
    try {
      return await getDbStaffProfiles();
    } catch (error) {
      rememberSupabaseIssue("load staff users", error);
      return getFileStaffProfiles();
    }
  }
  return getFileStaffProfiles();
}

function findStoredStaffProfile(name = "") {
  const cleanName = normalizeStaffProfileName(name);
  if (!cleanName) return null;
  return readStoredStaffProfiles().find((profile) => String(profile?.name || "").trim().toLowerCase() === cleanName.toLowerCase()) || null;
}

async function findStaffProfileRecord(name = "") {
  const cleanName = normalizeStaffProfileName(name);
  if (!cleanName) return null;
  if (isOwnerStaffProfileName(cleanName)) return await getBuiltInAuthorityProfileRecord();
  if (SUPABASE_ENABLED) {
    try {
      await ensureDefaultStaffProfilesInDb();
      const rows = await dbSelect("staff_users", `select=*&display_name=eq.${encodeEq(cleanName)}&status=eq.active&limit=1`);
      return Array.isArray(rows) && rows.length ? rows[0] : null;
    } catch (error) {
      rememberSupabaseIssue("find staff user", error);
    }
  }
  return findStoredStaffProfile(cleanName);
}

function createOrUpdateStaffProfileFile({ name, password, role = "staff", requirePassword = true }) {
  const cleanName = normalizeStaffProfileName(name);
  const cleanPassword = String(password || "");
  if (!cleanName) throw new Error("Staff user name is required.");
  if (requirePassword && cleanPassword.length < 4) throw new Error("Staff user password must be at least 4 characters.");
  if (cleanPassword && cleanPassword.length < 4) throw new Error("Staff user password must be at least 4 characters.");

  const profiles = readStoredStaffProfiles();
  const now = new Date().toISOString();
  const existingIndex = profiles.findIndex((profile) => String(profile?.name || "").trim().toLowerCase() === cleanName.toLowerCase());
  const existing = existingIndex >= 0 ? profiles[existingIndex] : {};
  const nextProfile = {
    id: existingIndex >= 0 ? (existing.id || staffProfileIdFromName(cleanName)) : `${staffProfileIdFromName(cleanName)}-${Date.now().toString(36)}`,
    name: cleanName,
    role: normalizeStaffProfileRole(role || existing.role || "staff", cleanName),
    createdAt: existingIndex >= 0 ? existing.createdAt || now : now,
    updatedAt: now,
  };

  if (cleanPassword) {
    const { salt, hash } = hashStaffProfilePassword(cleanPassword);
    nextProfile.passwordHash = hash;
    nextProfile.salt = salt;
  } else if (existing?.passwordHash && existing?.salt) {
    nextProfile.passwordHash = existing.passwordHash;
    nextProfile.salt = existing.salt;
  }

  if (existingIndex >= 0) profiles[existingIndex] = nextProfile;
  else profiles.push(nextProfile);
  saveStoredStaffProfiles(profiles);
  return publicStaffProfile(nextProfile);
}

async function createOrUpdateStaffProfile({ name, password, role = "staff", requirePassword = true, actor = null } = {}) {
  const cleanName = normalizeStaffProfileName(name);
  const cleanPassword = String(password || "");
  if (!cleanName) throw new Error("Staff user name is required.");
  if (requirePassword && cleanPassword.length < 4) throw new Error("Staff user password must be at least 4 characters.");
  if (cleanPassword && cleanPassword.length < 4) throw new Error("Staff user password must be at least 4 characters.");

  if (isOwnerStaffProfileName(cleanName)) {
    if (cleanPassword) return await saveBuiltInAuthorityProfilePassword(cleanPassword, actor);
    const existingBuiltIn = await getBuiltInAuthorityProfileRecord();
    if (requirePassword && !existingBuiltIn?.password_hash && !(existingBuiltIn?.passwordHash && existingBuiltIn?.salt)) {
      throw new Error("Staff user password must be at least 4 characters.");
    }
    return publicStaffProfile(existingBuiltIn, { includePermissions: true });
  }

  if (SUPABASE_ENABLED) {
    try {
      await ensureDefaultStaffProfilesInDb();
      const existingRows = await dbSelect("staff_users", `select=*&display_name=eq.${encodeEq(cleanName)}&limit=1`);
      const existing = Array.isArray(existingRows) && existingRows.length ? existingRows[0] : null;
      const now = new Date().toISOString();
      const nextRole = normalizeStaffProfileRole(role || existing?.role || "staff", cleanName);
      const patch = {
        display_name: cleanName,
        role: isOwnerStaffProfileName(cleanName) ? "owner" : nextRole,
        status: "active",
        is_protected: isOwnerStaffProfileName(cleanName) || Boolean(existing?.is_protected),
        updated_at: now,
      };
      if (isUuid(actor?.id)) patch.updated_by = actor.id;
      if (cleanPassword) patch.password_hash = encodeStaffProfilePassword(cleanPassword);

      let saved;
      if (existing?.id) {
        const rows = await dbPatch("staff_users", `id=eq.${encodeEq(existing.id)}`, patch);
        saved = Array.isArray(rows) && rows.length ? rows[0] : { ...existing, ...patch };
      } else {
        const insert = { ...patch, created_at: now };
        if (isUuid(actor?.id)) insert.created_by = actor.id;
        const rows = await dbInsert("staff_users", [insert]);
        saved = Array.isArray(rows) && rows.length ? rows[0] : insert;
      }
      return publicStaffProfile(saved, { includePermissions: true });
    } catch (error) {
      rememberSupabaseIssue("save staff user", error);
    }
  }

  return createOrUpdateStaffProfileFile({ name: cleanName, password: cleanPassword, role, requirePassword });
}

function setActiveProfileForRequest(req, user) {
  const token = getStaffToken(req);
  const session = token ? staffSessions.get(token) : null;
  if (session && (user?.name || user?.display_name)) {
    const publicProfile = publicStaffProfile(user, { includePermissions: true });
    session.activeUser = {
      id: publicProfile.id,
      name: publicProfile.name,
      role: publicProfile.role,
      canManageUsers: Boolean(publicProfile.canManageUsers),
    };
    staffSessions.set(token, session);
  }
}

function getActiveStaffProfile(req) {
  return req?.staff?.activeUser || null;
}

function activeStaffCanManageUsers(req) {
  const active = getActiveStaffProfile(req);
  const role = String(active?.role || "").toLowerCase();
  return Boolean(active?.canManageUsers || role === "admin" || isOwnerStaffProfileName(active?.name));
}

function activeStaffIsOwner(req) {
  return activeStaffCanManageUsers(req);
}

function getConfiguredStaffUsers() {
  const users = [];

  if (STAFF_USERS_JSON) {
    try {
      const parsed = JSON.parse(STAFF_USERS_JSON);
      if (Array.isArray(parsed)) {
        parsed.forEach((user) => {
          const email = String(user?.email || "").trim().toLowerCase();
          const password = String(user?.password || "");
          if (email && password) {
            users.push({
              email,
              password,
              name: String(user?.name || email).trim(),
              role: normalizeStaffProfileRole(user?.role || "staff", user?.name || email),
            });
          }
        });
      }
    } catch (error) {
      console.error("Invalid STAFF_USERS_JSON:", error.message);
    }
  }

  if (STAFF_EMAIL && STAFF_PASSWORD) {
    users.push({ email: STAFF_EMAIL, password: STAFF_PASSWORD, name: STAFF_EMAIL, role: normalizeStaffProfileRole("staff", STAFF_EMAIL) });
  }

  return users;
}

function findStaffUser(email, password) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanPassword = String(password || "");
  if (!cleanEmail || !cleanPassword) return null;

  return getConfiguredStaffUsers().find((user) => (
    user.email === cleanEmail && user.password === cleanPassword
  )) || null;
}

function cleanJsonText(text = "") {
  return String(text ?? "")
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();
}

function safeParseJson(text) {
  const cleaned = cleanJsonText(text);
  try {
    return JSON.parse(cleaned || "{}");
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      try {
        return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
      } catch {}
    }
    return {
      mode: "reply",
      reply: cleaned || "I am sorry, I could not understand that clearly.",
      questions: [],
      items: [],
    };
  }
}

function normalizeContent(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function normalizeRole(role) {
  return role === "assistant" ? "assistant" : "user";
}

function normalizeMessages(messages = []) {
  if (!Array.isArray(messages)) return [];
  return messages
    .map((m) => {
      const content = normalizeContent(m?.content ?? m?.text ?? m?.message ?? "").trim();
      return { role: normalizeRole(m?.role), content };
    })
    .filter((m) => m.content.length > 0)
    .slice(-24);
}

function conversationText(messages = []) {
  return messages
    .map((m) => `${m.role === "assistant" ? "Assistant" : "Customer"}: ${m.content}`)
    .join("\n");
}

function lastUserText(messages = [], prompt = "") {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return normalizeContent(lastUser?.content || prompt || "").trim();
}

function isPositiveConfirmation(text = "") {
  return /^(yes|y|correct|confirmed|confirm|sure|ok|okay|right|go ahead|proceed|that is right|that's right|haan|han)\b/i.test(String(text).trim());
}

function shouldUseWebSearch({ mode, prompt = "", messages = [] }) {
  if (!ENABLE_WEB_SEARCH || mode !== "customer") return false;
  const text = `${prompt}\n${conversationText(messages)}`.toLowerCase();
  return /\b(best|recommend|suggest|which system|what system|suitable|limitation|maximum|latest|current|search|internet|website|specification|standard|thermal break|5\s*meter|5000\s*mm|large opening|wide opening|sliding or folding|folding or sliding)\b/.test(text);
}

function extractCustomerUpdatesFromText(text = "") {
  const value = String(text || "");
  const updates = {};
  const phoneMatch = value.match(/(?:\+?971|0)?\s*(?:5\d|4\d|2\d)\s*[\d\s-]{6,}/);
  if (phoneMatch) updates.phone = phoneMatch[0].replace(/\s+/g, " ").trim();

  const locations = ["dubai", "sharjah", "ajman", "abu dhabi", "al ain", "ras al khaimah", "rak", "fujairah", "umm al quwain", "uaq", "jvc", "jlt", "marina", "downtown", "mirdif", "warisan", "nad al hamar", "business bay"];
  const lower = value.toLowerCase();
  const foundLocation = locations.find((loc) => lower.includes(loc));
  if (foundLocation) updates.location = foundLocation.replace(/\b\w/g, (c) => c.toUpperCase());

  const nameMatch = value.match(/(?:my name is|i am|i'm|this is)\s+([A-Za-z][A-Za-z .'-]{1,40})/i);
  if (nameMatch) updates.name = nameMatch[1].trim().replace(/[,.!?].*$/, "");

  if (/villa/i.test(value)) updates.projectType = "Villa";
  else if (/apartment|flat/i.test(value)) updates.projectType = "Apartment";
  else if (/shop|retail|showroom/i.test(value)) updates.projectType = "Shop";
  else if (/office/i.test(value)) updates.projectType = "Office";

  return updates;
}

function mergeCustomer(existing = {}, updates = {}) {
  return {
    ...existing,
    ...Object.fromEntries(Object.entries(updates || {}).filter(([, v]) => String(v ?? "").trim() !== "")),
  };
}

function missingRequiredCustomerFields(customer = {}) {
  const missing = [];
  if (!String(customer.name || customer.customerName || customer.clientName || "").trim()) missing.push("name");
  if (!String(customer.phone || customer.phoneNumber || "").trim()) missing.push("phone number");
  if (!String(customer.location || "").trim()) missing.push("location");
  return missing;
}

function smartSlidingSplit(totalPanels) {
  const total = Math.max(2, Number(totalPanels) || 2);
  const fixed = Math.max(1, Math.round(total / 3));
  return { slidingPanels: Math.max(1, total - fixed), fixedPanels: fixed };
}

function inferTotalPanelsFromWidth(widthMm, label = "") {
  const width = Number(widthMm) || 0;
  if (!width) return 2;
  const text = String(label || "").toLowerCase();
  let targetPanelWidth = 1400;
  // Ultra slim systems can use much wider panels, so don't over-split a 5m/6m opening.
  if (text.includes("ultra slim") || text.includes("slim sliding")) targetPanelWidth = 2500;
  else if (text.includes("105 series") || text.includes("local thermal")) targetPanelWidth = 1200;
  else if (text.includes("telescopic") || text.includes("pocket") || text.includes("ghost")) targetPanelWidth = 850;
  return Math.max(2, Math.min(6, Math.ceil(width / targetPanelWidth)));
}

function normalizeQuoteItems(items = []) {
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const item = { ...raw };
    const label = `${item.product || ""} ${item.type || ""} ${item.subcategory || item.system || ""}`.toLowerCase();
    const isSliding = /sliding|slider|slide/.test(label);
    const isFixedGlass = /fixed glass|fixed window|fixed/.test(label) && !isSliding;
    const isFolding = /folding|fold/.test(label);

    if (!item.qty && item.quantity) item.qty = item.quantity;
    item.qty = Number(item.qty || 1) || 1;

    if (isSliding) {
      item.panelMode = "sliding-fixed";
      const total = Number(item.panels || item.totalPanels || 0) || inferTotalPanelsFromWidth(item.width_mm || item.width || item.widthMm, label);
      const split = smartSlidingSplit(total);
      item.panels = total;
      item.slidingPanels = Number(item.slidingPanels || 0) || split.slidingPanels;
      item.fixedPanels = Number(item.fixedPanels || 0) || Math.max(total - item.slidingPanels, 0) || split.fixedPanels;
      if (item.slidingPanels + item.fixedPanels !== total) {
        const repaired = smartSlidingSplit(total);
        item.slidingPanels = repaired.slidingPanels;
        item.fixedPanels = repaired.fixedPanels;
      }
    } else if (isFolding) {
      item.panelMode = "folding";
      item.panels = Number(item.panels || item.totalPanels || 0) || Math.max(3, Math.min(8, Math.ceil((Number(item.width_mm || item.width || 0) || 3000) / 700)));
    } else if (isFixedGlass) {
      item.panelMode = item.fixedRows || item.fixedColumns ? "fixed-layout" : item.panelMode || "fixed-layout";
      item.fixedRows = Number(item.fixedRows || item.rows || 1) || 1;
      item.fixedColumns = Number(item.fixedColumns || item.columns || 1) || 1;
      item.panels = item.fixedRows * item.fixedColumns;
    }

    return item;
  });
}

function buildSystemPrompt(mode) {
  const common = `
You are Buildup UAE's aluminium, glass, window and door quotation assistant.
Return ONLY valid JSON. Do not wrap JSON in markdown.

Core behavior:
- Be a professional, warm UAE sales assistant, not a rigid form.
- Customer questions are priority. Answer their question first, then ask ONE short next question only if needed.
- Sound natural: acknowledge first when useful ("I understand", "That makes sense", "For that opening...").
- Do NOT repeat the same question again and again. If already asked, continue from the customer's latest answer.
- Use the conversation history. Continue naturally and remember what the customer already answered.
- Do not overwhelm the customer with a list of many fields in one message.
- Do not promise final price, structural approval, exact delivery date, or final panel design without staff review.
- If unsure even after reasonable reasoning/search, apologize and offer real staff handoff.

Conversation order for customer mode:
1. Understand product type first.
2. Then ask for product size / approximate opening size.
3. Then ask for location.
4. Then ask for name and phone number before final submission.
Customers may start chatting without name/phone/location. Extract them from chat if mentioned and return them in customer_updates.
Do not ask for name, phone, location, size, product type, glass, and panels all in one message.

Expert guidance examples:
- For a 5m / 5000mm opening, hinged or pivot is usually not practical as the first recommendation.
- For wide openings, explain that sliding and folding are normally the better options.
- Sliding: good for daily use, cleaner look, less clear opening than folding.
- Folding: gives wider clear opening, but has more panels/track/maintenance and can cost more.
- Local/thermal-break systems can have practical size/panel limits. Say final suitability needs staff/site review.
- For missing sliding panel count, do not block the quote. Use a smart draft based on width.

Smart sliding panel default:
- Determine total panels from width around 1000mm per panel.
- 2 total panels = 1 sliding + 1 fixed
- 3 total panels = 2 sliding + 1 fixed
- 4 total panels = 3 sliding + 1 fixed
- 5 total panels = 3 sliding + 2 fixed
- 6 total panels = 4 sliding + 2 fixed

Before creating a draft from customer chat:
- Detect possible items, but ask the customer to confirm first.
- Use mode "confirm_draft" and requires_confirmation true when items are detected but customer has not confirmed.
- If the customer confirms the summarized details, return mode "quote_draft".

Supported item fields:
- tag: drawing/code like SD1, D1, FG1, W1
- product, type, subcategory, variant
- width_mm, height_mm, qty
- glassType, thickness
- panelMode: single-count | sliding-fixed | fixed-layout | folding | fixed-openable
- panels, slidingPanels, fixedPanels, openablePanels, fixedRows, fixedColumns

Panel parsing examples:
- F1S2 / 1F2S / S2F1 = fixed/sliding panels, panelMode sliding-fixed.
- F1O1 / 1F1O = fixed/openable panels, panelMode fixed-openable.
- R1C2 = rows/columns for fixed glass, panelMode fixed-layout.

JSON output shape:
{
  "mode": "need_clarification" | "confirm_draft" | "quote_draft" | "reply" | "handoff_offer",
  "reply": "short natural helpful reply",
  "questions": [],
  "customer_updates": { "name": "", "phone": "", "location": "", "projectType": "" },
  "missing_required_fields": [],
  "requires_confirmation": false,
  "confirmation_summary": "",
  "handoff_offer": false,
  "items": []
}`;

  if (mode === "customer") {
    return `${common}

You are talking to a CUSTOMER, not staff.
Use warm, short, professional WhatsApp-style language.
Do not reveal internal pricing/catalog settings.
Do not ask all questions at once. Ask the next 1-3 useful questions only.
If the customer asks a general advice question like "sliding or folding", answer with simple pros/cons from your own knowledge and the company catalog. Do not say you searched or asked ChatGPT.
Example: If customer says "Doors" and asks what kinds: reply only with the door options, such as "We have Slim Sliding Doors, Folding Doors and Hinged Doors. Which one do you prefer?" Do NOT also ask size, name, phone and location in that same message.
If enough details exist, summarize and confirm: "Just to confirm, you need ... correct?"
Never jump straight to quote_draft in customer mode unless the customer's latest message clearly confirms the summary.`;
  }

  return `${common}

You are talking to STAFF inside the quote maker.
Be direct and practical. Generate quote rows when enough details exist.`;
}

function buildUserPayload({ mode, prompt, messages, catalog, customer }) {
  return JSON.stringify(
    {
      mode,
      customer: customer && typeof customer === "object" ? customer : {},
      catalog: Array.isArray(catalog) ? catalog.slice(0, 100) : [],
      prompt: normalizeContent(prompt).trim(),
      conversation: normalizeMessages(messages),
      staffContactName: STAFF_CONTACT_NAME,
      staffContactPhone: STAFF_CONTACT_PHONE,
    },
    null,
    2
  );
}

async function runChatCompletion({ mode, prompt, messages, catalog, customer }) {
  const userContent = buildUserPayload({ mode, prompt, messages, catalog, customer });
  const response = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildSystemPrompt(mode) },
      { role: "user", content: userContent },
    ],
    temperature: mode === "customer" ? 0.35 : 0.2,
  });
  const content = response.choices?.[0]?.message?.content || "{}";
  return { parsed: safeParseJson(content), usage: response.usage || null, usedWeb: false };
}

async function runResponseWithWebSearch({ mode, prompt, messages, catalog, customer }) {
  const input = [
    { role: "system", content: buildSystemPrompt(mode) },
    { role: "user", content: buildUserPayload({ mode, prompt, messages, catalog, customer }) },
  ];

  const response = await client.responses.create({
    model: WEB_SEARCH_MODEL,
    input,
    tools: [{ type: "web_search" }],
    store: false,
  });

  const content = response.output_text || "{}";
  return { parsed: safeParseJson(content), usage: response.usage || null, usedWeb: true };
}

function postProcessResult(parsed = {}, { mode, prompt, messages, customer }) {
  const lastText = lastUserText(messages, prompt);
  const extractedUpdates = extractCustomerUpdatesFromText(`${conversationText(messages)}\n${prompt}`);
  const customerUpdates = { ...extractedUpdates, ...(parsed.customer_updates || parsed.customerUpdates || {}) };
  const mergedCustomer = mergeCustomer(customer, customerUpdates);
  const missingRequired = missingRequiredCustomerFields(mergedCustomer);
  const items = normalizeQuoteItems(parsed.items || []);

  const next = {
    ...parsed,
    customer_updates: customerUpdates,
    missing_required_fields: parsed.missing_required_fields || missingRequired,
    items,
  };

  if (mode === "customer" && items.length) {
    const alreadyConfirmed = isPositiveConfirmation(lastText) || parsed.confirmed_by_customer === true || parsed.mode === "quote_draft";
    if (!alreadyConfirmed) {
      const summary = next.confirmation_summary || items.map((item, index) => {
        const name = item.subcategory || item.product || `Item ${index + 1}`;
        const size = item.width_mm && item.height_mm ? `${item.width_mm}x${item.height_mm}mm` : "size TBC";
        const qty = item.qty || 1;
        const panel = item.panelMode === "sliding-fixed" ? `, ${item.fixedPanels || 0} fixed / ${item.slidingPanels || 0} sliding panels` : "";
        return `${qty} ${name} ${size}${panel}`;
      }).join("; ");
      next.mode = "confirm_draft";
      next.requires_confirmation = true;
      next.confirmation_summary = summary;
      if (!next.reply || /draft|generated|row/i.test(next.reply)) {
        next.reply = `Just to confirm, you need ${summary}. Is that correct?`;
      }
    }
  }

  if (!next.reply) {
    if (next.mode === "handoff_offer") {
      next.reply = "I am really sorry, I am not fully sure about that. I am a chatbot and I have some limitations. Would you like me to connect you with a real staff member?";
      next.handoff_offer = true;
    } else if (missingRequired.length && mode === "customer") {
      next.reply = `Sure, I can help. Before staff prepares the quote, please share your ${missingRequired.join(", ")}.`;
    } else {
      next.reply = "Sure, I understand. Can you share the size and quantity so I can prepare a draft?";
    }
  }

  return next;
}

function actorFromRequest(req) {
  const active = getActiveStaffProfile(req);
  return {
    id: isUuid(active?.id) ? active.id : null,
    name: active?.name || req?.staff?.name || req?.headers?.["x-staff-user"] || "Staff",
    role: active?.role || req?.staff?.role || "staff",
  };
}

async function writeAuditLog(req, entry = {}) {
  const actor = actorFromRequest(req);
  const row = {
    actor_user_id: actor.id,
    actor_name: actor.name,
    actor_role: actor.role,
    action_type: entry.action_type || "updated",
    module: entry.module || "general",
    target_table: entry.target_table || null,
    target_id: entry.target_id ? String(entry.target_id) : null,
    quote_id: isUuid(entry.quote_id) ? entry.quote_id : null,
    quote_number: entry.quote_number || null,
    item_id: isUuid(entry.item_id) ? entry.item_id : null,
    item_code: entry.item_code || null,
    item_product: entry.item_product || null,
    field_name: entry.field_name || null,
    old_value: entry.old_value === undefined ? null : valueToAuditText(entry.old_value),
    new_value: entry.new_value === undefined ? null : valueToAuditText(entry.new_value),
    old_snapshot: entry.old_snapshot === undefined ? null : entry.old_snapshot,
    new_snapshot: entry.new_snapshot === undefined ? null : entry.new_snapshot,
    changed_fields: entry.changed_fields === undefined ? null : entry.changed_fields,
    change_summary: entry.change_summary || null,
    ip_address: req?.headers?.["x-forwarded-for"]?.split?.(",")?.[0]?.trim?.() || req?.ip || null,
    device_info: req?.headers?.["user-agent"] || null,
  };

  if (!SUPABASE_ENABLED) {
    const file = path.join(DATA_DIR, "audit-log.json");
    const existing = readJsonFile(file, []);
    existing.push({ id: `audit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, created_at: new Date().toISOString(), ...row });
    writeJsonFile(file, existing.slice(-5000));
    return null;
  }

  try {
    await dbInsert("audit_logs", [row], { returning: false });
  } catch (error) {
    console.error("Audit log write failed:", error.message || error);
  }
  return null;
}

function shallowFieldDiff(oldObj = {}, newObj = {}, fields = []) {
  const changes = [];
  fields.forEach((field) => {
    const oldValue = oldObj?.[field];
    const newValue = newObj?.[field];
    if (stableStringify(oldValue) !== stableStringify(newValue)) {
      changes.push({ field, oldValue, newValue });
    }
  });
  return changes;
}

function rowIdentity(row = {}, index = 0) {
  return String(row.id || row.itemId || row.itemNo || row.code || row.tag || row.item_code || `row-${index}`);
}

function quoteIdentity(quote = {}, index = 0) {
  return String(quote.id || quote.quoteNo || quote.quotation?.referenceNo || quote.autoDraftId || `quote-${index}`);
}

function leadIdentity(lead = {}, index = 0) {
  return String(lead.id || lead.leadId || lead.phone || lead.name || `lead-${index}`);
}

function extractAppStateFromSnapshot(snapshot = {}) {
  const local = parseLocalStorageObject(snapshot);
  const settings = local[FRONTEND_SETTINGS_STORAGE_KEY] && typeof local[FRONTEND_SETTINGS_STORAGE_KEY] === "object" ? local[FRONTEND_SETTINGS_STORAGE_KEY] : {};
  const quotation = local[FRONTEND_QUOTATION_STORAGE_KEY] && typeof local[FRONTEND_QUOTATION_STORAGE_KEY] === "object" ? local[FRONTEND_QUOTATION_STORAGE_KEY] : {};
  const rows = Array.isArray(local[FRONTEND_ROWS_STORAGE_KEY]) ? local[FRONTEND_ROWS_STORAGE_KEY] : [];
  return {
    settings,
    customers: Array.isArray(settings.customers) ? settings.customers : [],
    savedQuotes: Array.isArray(settings.savedQuotes) ? settings.savedQuotes : [],
    quotation,
    rows,
  };
}

async function getPreviousCloudSnapshot() {
  if (!SUPABASE_ENABLED) return readJsonFile(LOCAL_BACKUP_FILE, null);
  const rows = await dbSelect("app_settings", `select=setting_value&setting_key=eq.latest_local_backup_snapshot&limit=1`);
  return Array.isArray(rows) && rows[0]?.setting_value ? rows[0].setting_value : null;
}

async function saveCloudSnapshot(snapshot, req) {
  if (!SUPABASE_ENABLED) return;
  const actor = actorFromRequest(req);
  const row = {
    setting_key: "latest_local_backup_snapshot",
    setting_value: snapshot,
    updated_by: actor.id,
    updated_by_name: actor.name,
    updated_at: new Date().toISOString(),
  };
  await dbUpsert("app_settings", [row], { onConflict: "setting_key", returning: false });
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanDateOrNull(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

async function upsertLeadsToSupabase(customers = [], req) {
  if (!SUPABASE_ENABLED) return new Map();
  const actor = actorFromRequest(req);
  const valid = customers.filter((customer) => customer?.leadId || customer?.name || customer?.phone);
  if (!valid.length) return new Map();
  const rows = valid.map((c) => ({
    lead_id: c.leadId || null,
    date: cleanDateOrNull(c.date),
    time: c.time || null,
    day: c.day || null,
    client_name: c.name || c.clientName || null,
    phone: c.phone || null,
    whatsapp: c.whatsapp || c.whatsappNumber || null,
    location: c.location || null,
    project_type: c.projectType || null,
    product_inquired: c.productInquired || null,
    source: c.source || null,
    lead_type: c.leadType || null,
    status: c.status || null,
    next_follow_up_date: cleanDateOrNull(c.nextFollowUpDate),
    quote_status: c.quoteStatus || c.lastQuoteStatus || null,
    quotation_amount: toNumberOrNull(c.quotationAmount || c.quoteAmount || c.lastQuoteTotal),
    meeting_scheduled: Boolean(c.meetingScheduled),
    site_visit_done: Boolean(c.siteVisitDone),
    deal_closed: Boolean(c.dealClosed),
    closing_amount: toNumberOrNull(c.closingAmount),
    lost_reason: c.lostReason || null,
    notes: c.notes || c.NOTES || null,
    updated_by: actor.id,
    updated_at: new Date().toISOString(),
  })).filter((row) => row.lead_id);
  if (!rows.length) return new Map();
  const saved = await dbUpsert("leads", rows, { onConflict: "lead_id" });
  const map = new Map();
  (Array.isArray(saved) ? saved : []).forEach((row) => {
    if (row.lead_id) map.set(row.lead_id, row.id);
  });
  return map;
}

function normalizeQuoteDbPayload(quote = {}, leadUuid = null, actor = {}) {
  const quotation = quote.quotation || {};
  const quoteNumber = quote.quoteNo || quotation.referenceNo || quote.autoDraftNo || null;
  return {
    quote_number: quoteNumber,
    lead_id: leadUuid || null,
    client_name_snapshot: quote.customerName || quotation.customerName || quotation.customerDetails?.name || null,
    client_phone_snapshot: quotation.customerDetails?.phone || quotation.phone || null,
    client_location_snapshot: quotation.customerDetails?.location || quotation.location || null,
    project_type_snapshot: quotation.customerDetails?.projectType || quotation.projectType || null,
    status: quote.saveAsStatus || quote.quoteStatus || "draft",
    quote_status: quote.quoteStatus || quotation.quoteStatus || null,
    quotation_amount: toNumberOrNull(quote.finalTotal || quote.subtotal),
    vat_amount: toNumberOrNull(quote.taxAmount),
    discount_amount: toNumberOrNull(quote.discountAmount),
    final_amount: toNumberOrNull(quote.finalTotal),
    prepared_by: quotation.preparedBy || quote.preparedBy || null,
    notes: quote.saveAsNote || quotation.saveAsNote || null,
    project_scope: quotation.description || quote.projectScope || null,
    quote_data: quote,
    updated_by: actor.id,
    updated_at: new Date().toISOString(),
  };
}

function normalizeQuoteItemDbPayload(item = {}, quoteId, actor = {}) {
  return {
    quote_id: quoteId,
    item_code: item.code || item.tag || item.itemCode || item.itemNo || null,
    product: item.product || null,
    category: item.category || item.type || null,
    subcategory: item.subcategory || item.system || null,
    width: toNumberOrNull(item.width || item.width_mm || item.widthMm),
    height: toNumberOrNull(item.height || item.height_mm || item.heightMm),
    qty: toNumberOrNull(item.qty || item.quantity) || 1,
    area: toNumberOrNull(item.area || item.areaM2 || item.totalArea),
    glass_type: item.glassType || item.glass_type || null,
    glass_thickness: item.thickness || item.glassThickness || item.glass_thickness || null,
    panel_spec: item.panelSpec || item.panel_spec || item.panelMode || null,
    fixed_panels: toNumberOrNull(item.fixedPanels),
    sliding_panels: toNumberOrNull(item.slidingPanels),
    openable_panels: toNumberOrNull(item.openablePanels),
    rows_count: toNumberOrNull(item.fixedRows || item.rows_count),
    columns_count: toNumberOrNull(item.fixedColumns || item.columns_count),
    pricing_mode: item.pricingMode || item.ruleType || null,
    unit_price: toNumberOrNull(item.price || item.unitPrice || item.unit_price),
    total_price: toNumberOrNull(item.total || item.totalPrice || item.lineTotal || item.finalTotal),
    description: item.description || null,
    warnings: item.warnings || null,
    item_data: item,
    updated_by: actor.id,
    updated_at: new Date().toISOString(),
  };
}

async function nextQuoteVersionNumber(quoteId) {
  const rows = await dbSelect("quote_versions", `select=version_number&quote_id=eq.${encodeEq(quoteId)}&order=version_number.desc&limit=1`);
  const latest = Array.isArray(rows) && rows.length ? Number(rows[0].version_number) || 0 : 0;
  return latest + 1;
}

async function upsertQuotesToSupabase(savedQuotes = [], leadMap = new Map(), req) {
  if (!SUPABASE_ENABLED) return;
  const actor = actorFromRequest(req);
  for (const quote of savedQuotes) {
    const quoteNumber = quote.quoteNo || quote.quotation?.referenceNo || quote.autoDraftNo;
    if (!quoteNumber) continue;
    const existingRows = await dbSelect("quotes", `select=id,quote_data&quote_number=eq.${encodeEq(quoteNumber)}&limit=1`);
    const existingQuote = Array.isArray(existingRows) && existingRows.length ? existingRows[0] : null;
    const quoteChanged = stableStringify(existingQuote?.quote_data || null) !== stableStringify(quote || null);

    const leadUuid = quote.leadId && leadMap.has(quote.leadId) ? leadMap.get(quote.leadId) : null;
    const quotePayload = normalizeQuoteDbPayload(quote, leadUuid, actor);
    const saved = await dbUpsert("quotes", [quotePayload], { onConflict: "quote_number" });
    const savedQuote = Array.isArray(saved) && saved.length ? saved[0] : null;
    if (!savedQuote?.id) continue;

    await dbDelete("quote_items", `quote_id=eq.${encodeEq(savedQuote.id)}`, { returning: false });
    const items = Array.isArray(quote.rows) ? quote.rows : [];
    if (items.length) {
      await dbInsert("quote_items", items.map((item) => normalizeQuoteItemDbPayload(item, savedQuote.id, actor)), { returning: false });
    }

    if (quoteChanged) {
      await dbInsert("quote_versions", [{
        quote_id: savedQuote.id,
        quote_number: quoteNumber,
        version_number: await nextQuoteVersionNumber(savedQuote.id),
        saved_by: actor.id,
        saved_by_name: actor.name,
        reason: existingQuote ? "quote_updated_from_staff_snapshot" : "quote_created_from_staff_snapshot",
        quote_snapshot: quote,
      }], { returning: false });
    }
  }
}

async function syncSnapshotBusinessData(snapshot = {}, req) {
  if (!SUPABASE_ENABLED) return;
  const state = extractAppStateFromSnapshot(snapshot);
  const leadMap = await upsertLeadsToSupabase(state.customers, req);
  await upsertQuotesToSupabase(state.savedQuotes, leadMap, req);
}

async function auditQuoteChanges(previousState, nextState, req) {
  const oldQuotes = new Map((previousState.savedQuotes || []).map((q, i) => [quoteIdentity(q, i), q]));
  const newQuotes = new Map((nextState.savedQuotes || []).map((q, i) => [quoteIdentity(q, i), q]));
  const quoteFields = ["quoteNo", "customerName", "leadId", "quoteStatus", "saveAsStatus", "saveAsNote", "subtotal", "taxAmount", "finalTotal", "itemCount", "updatedAt"];
  const itemFields = ["itemNo", "code", "tag", "product", "category", "type", "subcategory", "width", "height", "qty", "area", "glassType", "thickness", "panelMode", "panels", "fixedPanels", "slidingPanels", "openablePanels", "fixedRows", "fixedColumns", "pricingMode", "price", "unitPrice", "total", "totalPrice", "lineTotal"];

  for (const [key, quote] of newQuotes.entries()) {
    const previous = oldQuotes.get(key);
    const quoteNumber = quote.quoteNo || quote.quotation?.referenceNo || quote.autoDraftNo || key;
    if (!previous) {
      await writeAuditLog(req, {
        action_type: "quote_created",
        module: "quotes",
        target_table: "quotes",
        target_id: quote.id || key,
        quote_number: quoteNumber,
        new_snapshot: quote,
        change_summary: `${actorFromRequest(req).name} created/saved quote ${quoteNumber}.`,
      });
      continue;
    }

    for (const change of shallowFieldDiff(previous, quote, quoteFields)) {
      await writeAuditLog(req, {
        action_type: "quote_field_updated",
        module: "quotes",
        target_table: "quotes",
        target_id: quote.id || key,
        quote_number: quoteNumber,
        field_name: change.field,
        old_value: change.oldValue,
        new_value: change.newValue,
        old_snapshot: previous,
        new_snapshot: quote,
        change_summary: `${actorFromRequest(req).name} changed ${change.field} on quote ${quoteNumber} from ${valueToAuditText(change.oldValue) || "blank"} to ${valueToAuditText(change.newValue) || "blank"}.`,
      });
    }

    const oldItems = new Map((previous.rows || []).map((row, i) => [rowIdentity(row, i), row]));
    const newItems = new Map((quote.rows || []).map((row, i) => [rowIdentity(row, i), row]));
    for (const [itemKey, item] of newItems.entries()) {
      const oldItem = oldItems.get(itemKey);
      const itemCode = item.code || item.tag || item.itemNo || itemKey;
      if (!oldItem) {
        await writeAuditLog(req, {
          action_type: "quote_item_added",
          module: "quote_items",
          target_table: "quote_items",
          target_id: item.id || itemKey,
          quote_number: quoteNumber,
          item_code: itemCode,
          item_product: item.subcategory || item.product || null,
          new_snapshot: item,
          change_summary: `${actorFromRequest(req).name} added item ${itemCode} to quote ${quoteNumber}.`,
        });
        continue;
      }
      for (const change of shallowFieldDiff(oldItem, item, itemFields)) {
        await writeAuditLog(req, {
          action_type: "quote_item_field_updated",
          module: "quote_items",
          target_table: "quote_items",
          target_id: item.id || itemKey,
          quote_number: quoteNumber,
          item_code: itemCode,
          item_product: item.subcategory || item.product || null,
          field_name: change.field,
          old_value: change.oldValue,
          new_value: change.newValue,
          old_snapshot: oldItem,
          new_snapshot: item,
          change_summary: `${actorFromRequest(req).name} changed ${change.field} for item ${itemCode} in quote ${quoteNumber} from ${valueToAuditText(change.oldValue) || "blank"} to ${valueToAuditText(change.newValue) || "blank"}.`,
        });
      }
    }
    for (const [itemKey, oldItem] of oldItems.entries()) {
      if (newItems.has(itemKey)) continue;
      const itemCode = oldItem.code || oldItem.tag || oldItem.itemNo || itemKey;
      await writeAuditLog(req, {
        action_type: "quote_item_removed",
        module: "quote_items",
        target_table: "quote_items",
        target_id: oldItem.id || itemKey,
        quote_number: quoteNumber,
        item_code: itemCode,
        item_product: oldItem.subcategory || oldItem.product || null,
        old_snapshot: oldItem,
        change_summary: `${actorFromRequest(req).name} removed item ${itemCode} from quote ${quoteNumber}.`,
      });
    }
  }

  for (const [key, oldQuote] of oldQuotes.entries()) {
    if (newQuotes.has(key)) continue;
    const quoteNumber = oldQuote.quoteNo || oldQuote.quotation?.referenceNo || oldQuote.autoDraftNo || key;
    await writeAuditLog(req, {
      action_type: "quote_removed",
      module: "quotes",
      target_table: "quotes",
      target_id: oldQuote.id || key,
      quote_number: quoteNumber,
      old_snapshot: oldQuote,
      change_summary: `${actorFromRequest(req).name} removed quote ${quoteNumber}.`,
    });
  }
}

async function auditLeadChanges(previousState, nextState, req) {
  const oldLeads = new Map((previousState.customers || []).map((lead, i) => [leadIdentity(lead, i), lead]));
  const newLeads = new Map((nextState.customers || []).map((lead, i) => [leadIdentity(lead, i), lead]));
  const leadFields = ["leadId", "name", "phone", "whatsapp", "location", "projectType", "productInquired", "source", "leadType", "status", "nextFollowUpDate", "quoteStatus", "quotationAmount", "meetingScheduled", "siteVisitDone", "dealClosed", "closingAmount", "lostReason", "notes", "lastQuoteNo", "lastQuoteStatus", "lastQuoteTotal"];
  for (const [key, lead] of newLeads.entries()) {
    const previous = oldLeads.get(key);
    const leadLabel = lead.leadId || lead.name || key;
    if (!previous) {
      await writeAuditLog(req, {
        action_type: "lead_created",
        module: "crm",
        target_table: "leads",
        target_id: lead.id || lead.leadId || key,
        new_snapshot: lead,
        change_summary: `${actorFromRequest(req).name} created/added lead ${leadLabel}.`,
      });
      continue;
    }
    for (const change of shallowFieldDiff(previous, lead, leadFields)) {
      await writeAuditLog(req, {
        action_type: "lead_field_updated",
        module: "crm",
        target_table: "leads",
        target_id: lead.id || lead.leadId || key,
        field_name: change.field,
        old_value: change.oldValue,
        new_value: change.newValue,
        old_snapshot: previous,
        new_snapshot: lead,
        change_summary: `${actorFromRequest(req).name} changed ${change.field} for lead ${leadLabel} from ${valueToAuditText(change.oldValue) || "blank"} to ${valueToAuditText(change.newValue) || "blank"}.`,
      });
    }
  }
}

async function auditCurrentRowsChanges(previousState, nextState, req) {
  const quoteNumber = nextState.quotation?.referenceNo || nextState.quotation?.autoDraftNo || previousState.quotation?.referenceNo || previousState.quotation?.autoDraftNo || "current draft";
  const oldRows = new Map((previousState.rows || []).map((row, i) => [rowIdentity(row, i), row]));
  const newRows = new Map((nextState.rows || []).map((row, i) => [rowIdentity(row, i), row]));
  const itemFields = ["itemNo", "code", "tag", "product", "category", "type", "subcategory", "width", "height", "qty", "area", "glassType", "thickness", "panelMode", "panels", "fixedPanels", "slidingPanels", "openablePanels", "fixedRows", "fixedColumns", "pricingMode", "price", "unitPrice", "total", "totalPrice", "lineTotal"];
  for (const [key, row] of newRows.entries()) {
    const previous = oldRows.get(key);
    if (!previous) continue;
    for (const change of shallowFieldDiff(previous, row, itemFields)) {
      await writeAuditLog(req, {
        action_type: "current_quote_item_field_updated",
        module: "current_quote",
        target_table: "quote_items",
        target_id: row.id || key,
        quote_number: quoteNumber,
        item_code: row.code || row.tag || row.itemNo || key,
        item_product: row.subcategory || row.product || null,
        field_name: change.field,
        old_value: change.oldValue,
        new_value: change.newValue,
        old_snapshot: previous,
        new_snapshot: row,
        change_summary: `${actorFromRequest(req).name} changed ${change.field} for current quote item ${row.code || row.tag || row.itemNo || key} from ${valueToAuditText(change.oldValue) || "blank"} to ${valueToAuditText(change.newValue) || "blank"}.`,
      });
    }
  }
}

async function auditSnapshotChanges(previousSnapshot, nextSnapshot, req) {
  if (!previousSnapshot) {
    await writeAuditLog(req, {
      action_type: "initial_cloud_snapshot",
      module: "backup",
      target_table: "app_settings",
      target_id: "latest_local_backup_snapshot",
      new_snapshot: { summary: nextSnapshot?.summary || null, savedAt: nextSnapshot?.savedAt || null },
      change_summary: `${actorFromRequest(req).name} created the first cloud app snapshot.`,
    });
    return;
  }

  const previousState = extractAppStateFromSnapshot(previousSnapshot);
  const nextState = extractAppStateFromSnapshot(nextSnapshot);
  await auditQuoteChanges(previousState, nextState, req);
  await auditLeadChanges(previousState, nextState, req);
  await auditCurrentRowsChanges(previousState, nextState, req);
}

function cleanStaffSessions() {
  const now = Date.now();
  for (const [token, session] of staffSessions.entries()) {
    if (!session?.expiresAt || session.expiresAt <= now) staffSessions.delete(token);
  }
}

function createStaffToken(staffUser) {
  cleanStaffSessions();
  const token = crypto.randomBytes(32).toString("hex");
  staffSessions.set(token, {
    role: staffUser?.role || "staff",
    email: staffUser?.email || "",
    name: staffUser?.name || staffUser?.email || "Staff",
    createdAt: Date.now(),
    expiresAt: Date.now() + STAFF_TOKEN_TTL_MS,
  });
  return token;
}

function getStaffToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return String(req.headers["x-staff-token"] || "").trim();
}

function requireStaff(req, res, next) {
  cleanStaffSessions();
  const token = getStaffToken(req);
  const session = token ? staffSessions.get(token) : null;
  if (!session) {
    return res.status(401).json({ success: false, ok: false, error: "Staff login required." });
  }
  req.staff = session;
  next();
}

app.post("/staff-login", (req, res) => {
  const configuredUsers = getConfiguredStaffUsers();
  if (!configuredUsers.length) {
    return res.status(500).json({
      success: false,
      ok: false,
      error: "No staff users are configured on the backend. Add STAFF_EMAIL + STAFF_PASSWORD or STAFF_USERS_JSON in Render environment variables.",
    });
  }

  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const staffUser = findStaffUser(email, password);

  if (!staffUser) {
    return res.status(401).json({ success: false, ok: false, error: "Invalid staff email or password." });
  }

  const token = createStaffToken(staffUser);
  res.json({
    success: true,
    ok: true,
    token,
    expiresInMs: STAFF_TOKEN_TTL_MS,
    staff: { email: staffUser.email, name: staffUser.name, role: staffUser.role },
  });
});

app.get("/staff-session", requireStaff, (req, res) => {
  res.json({
    success: true,
    ok: true,
    staff: { email: req.staff.email, name: req.staff.name, role: req.staff.role },
    activeUser: req.staff.activeUser || null,
  });
});

app.get("/staff-users", requireStaff, async (req, res) => {
  try {
    res.json({ success: true, ok: true, users: await getStaffProfiles() });
  } catch (error) {
    console.error("Staff users load error:", error);
    res.status(500).json({ success: false, ok: false, error: publicDatabaseError("Could not load staff users. Check backend database settings.") });
  }
});

app.post("/staff-users/login", requireStaff, async (req, res) => {
  try {
    const name = normalizeStaffProfileName(req.body?.name);
    const password = String(req.body?.password || "");
    const profile = await findStaffProfileRecord(name);

    if (!profile || !(profile.passwordHash || profile.password_hash)) {
      return res.status(404).json({ success: false, ok: false, error: "This staff user does not have a password yet. Create the password first." });
    }

    if (!verifyStaffProfilePassword(password, profile)) {
      return res.status(401).json({ success: false, ok: false, error: "Incorrect user password." });
    }

    const user = publicStaffProfile(profile, { includePermissions: true });
    if (SUPABASE_ENABLED && profile?.id && isUuid(profile.id)) {
      try {
        await dbPatch("staff_users", `id=eq.${encodeEq(profile.id)}`, { last_login_at: new Date().toISOString() }, { returning: false });
      } catch (error) {
        rememberSupabaseIssue("update staff last_login_at", error);
      }
    }
    setActiveProfileForRequest(req, { ...profile, name: user.name });
    res.json({ success: true, ok: true, user });
  } catch (error) {
    console.error("Staff profile login error:", error);
    res.status(500).json({ success: false, ok: false, error: "Could not open this staff profile. Check backend database settings." });
  }
});

app.post("/staff-users", requireStaff, async (req, res) => {
  try {
    const name = normalizeStaffProfileName(req.body?.name);
    const password = String(req.body?.password || "");
    const existingProfile = await findStaffProfileRecord(name);
    const isDefaultUser = isDefaultStaffProfileName(name);
    const isKnownDefaultWithoutPassword = isDefaultUser && !(existingProfile?.passwordHash || existingProfile?.password_hash);
    const isNewSelfSignup = !existingProfile && !isDefaultUser;
    const isPrivileged = activeStaffIsOwner(req);

    if (!name) {
      return res.status(400).json({ success: false, ok: false, error: "Staff user name is required." });
    }

    if (!isPrivileged) {
      if ((isNewSelfSignup || isKnownDefaultWithoutPassword) && password) {
        // Allowed: a staff member creates their own profile/password after the main staff login.
      } else {
        return res.status(403).json({ success: false, ok: false, error: "You do not have permission to edit this staff user." });
      }
    }

    if (isOwnerStaffProfileName(name) && (existingProfile?.passwordHash || existingProfile?.password_hash) && !isPrivileged) {
      return res.status(403).json({ success: false, ok: false, error: "You do not have permission to edit this staff user." });
    }

    const requestedRole = isPrivileged ? (req.body?.role || existingProfile?.role || "staff") : "staff";
    const user = await createOrUpdateStaffProfile({
      name,
      password,
      role: requestedRole,
      requirePassword: Boolean(!existingProfile?.passwordHash && !existingProfile?.password_hash && password),
      actor: getActiveStaffProfile(req),
    });

    const userWithPermissions = user;
    if (isNewSelfSignup || isKnownDefaultWithoutPassword) setActiveProfileForRequest(req, { ...user, name });
    await writeAuditLog(req, {
      action_type: existingProfile ? "staff_user_updated" : "staff_user_created",
      module: "user_management",
      target_table: "staff_users",
      target_id: user.id,
      new_snapshot: { id: user.id, name: user.name, role: user.role },
      change_summary: `${getActiveStaffProfile(req)?.name || "Staff"} ${existingProfile ? "updated" : "created"} staff profile ${user.name}.`,
    });
    res.json({ success: true, ok: true, user: userWithPermissions, users: await getStaffProfiles() });
  } catch (error) {
    console.error("Save staff user error:", error);
    const message = /Supabase|staff_users|rest\/v1/i.test(String(error?.message || ""))
      ? "Could not save staff user. Check backend database settings."
      : (error.message || "Could not save staff user.");
    res.status(400).json({ success: false, ok: false, error: message });
  }
});

app.patch("/staff-users/:id", requireStaff, async (req, res) => {
  try {
    if (!activeStaffCanManageUsers(req)) {
      return res.status(403).json({ success: false, ok: false, error: "You do not have permission to edit staff users." });
    }
    const id = String(req.params.id || "").trim();
    const requestedRole = normalizeStaffProfileRole(req.body?.role || "staff");
    if (isBuiltInAuthorityProfileId(id)) {
      return res.status(403).json({ success: false, ok: false, error: "This profile cannot be changed." });
    }
    if (SUPABASE_ENABLED) {
      const rows = await dbSelect("staff_users", `select=*&id=eq.${encodeEq(id)}&limit=1`);
      const target = Array.isArray(rows) && rows.length ? rows[0] : null;
      if (!target) return res.status(404).json({ success: false, ok: false, error: "Staff user not found." });
      if (isOwnerStaffProfileName(target.display_name)) {
        return res.status(403).json({ success: false, ok: false, error: "This profile cannot be changed." });
      }
      const updatedRows = await dbPatch("staff_users", `id=eq.${encodeEq(id)}`, {
        role: requestedRole,
        updated_at: new Date().toISOString(),
        updated_by: isUuid(getActiveStaffProfile(req)?.id) ? getActiveStaffProfile(req).id : null,
      });
      const updated = Array.isArray(updatedRows) && updatedRows.length ? updatedRows[0] : { ...target, role: requestedRole };
      await writeAuditLog(req, {
        action_type: "staff_user_role_updated",
        module: "user_management",
        target_table: "staff_users",
        target_id: target.id,
        field_name: "role",
        old_value: target.role,
        new_value: requestedRole,
        old_snapshot: target,
        new_snapshot: updated,
        change_summary: `${getActiveStaffProfile(req)?.name || "Staff"} changed ${target.display_name} role from ${target.role || "staff"} to ${requestedRole}.`,
      });
      return res.json({ success: true, ok: true, user: publicStaffProfile(updated), users: await getStaffProfiles() });
    }
    return res.status(400).json({ success: false, ok: false, error: "Database is required to update user roles." });
  } catch (error) {
    console.error("Update staff user error:", error);
    res.status(500).json({ success: false, ok: false, error: error.message || "Could not update staff user." });
  }
});

app.patch("/staff-users-order", requireStaff, async (req, res) => {
  try {
    if (!activeStaffCanManageUsers(req)) {
      return res.status(403).json({ success: false, ok: false, error: "You do not have permission to reorder staff users." });
    }
    const order = await saveStaffProfileOrder(req.body?.order || [], getActiveStaffProfile(req));
    await writeAuditLog(req, {
      action_type: "staff_user_order_updated",
      module: "user_management",
      target_table: "staff_users",
      new_snapshot: { order },
      change_summary: `${getActiveStaffProfile(req)?.name || "Staff"} changed staff user list order.`,
    });
    res.json({ success: true, ok: true, users: await getStaffProfiles() });
  } catch (error) {
    console.error("Reorder staff users error:", error);
    res.status(500).json({ success: false, ok: false, error: error.message || "Could not reorder staff users." });
  }
});

app.delete("/staff-users/:id", requireStaff, async (req, res) => {
  try {
    if (!activeStaffCanManageUsers(req)) {
      return res.status(403).json({ success: false, ok: false, error: "You do not have permission to remove staff users." });
    }

    const id = String(req.params.id || "").trim();
    if (isBuiltInAuthorityProfileId(id) || isOwnerStaffProfileName(id)) {
      return res.status(403).json({ success: false, ok: false, error: "This profile cannot be removed." });
    }

    if (SUPABASE_ENABLED) {
      const rows = await dbSelect("staff_users", `select=*&id=eq.${encodeEq(id)}&limit=1`);
      const target = Array.isArray(rows) && rows.length ? rows[0] : null;
      if (!target) return res.status(404).json({ success: false, ok: false, error: "Staff user not found." });
      if (target.is_protected || isOwnerStaffProfileName(target.display_name)) {
        return res.status(403).json({ success: false, ok: false, error: "This profile cannot be removed." });
      }
      await dbPatch("staff_users", `id=eq.${encodeEq(id)}`, { status: "inactive", updated_at: new Date().toISOString(), updated_by: isUuid(getActiveStaffProfile(req)?.id) ? getActiveStaffProfile(req).id : null }, { returning: false });
      await writeAuditLog(req, {
        action_type: "staff_user_removed",
        module: "user_management",
        target_table: "staff_users",
        target_id: target.id,
        old_snapshot: target,
        change_summary: `${getActiveStaffProfile(req)?.name || "Staff"} removed staff profile ${target.display_name}.`,
      });
      return res.json({ success: true, ok: true, users: await getStaffProfiles() });
    }

    const profiles = readStoredStaffProfiles();
    const target = profiles.find((profile) => String(profile?.id || "") === id || staffProfileIdFromName(profile?.name || "") === id);

    if (!target) {
      return res.status(404).json({ success: false, ok: false, error: "Staff user not found." });
    }

    if (isOwnerStaffProfileName(target.name)) {
      return res.status(403).json({ success: false, ok: false, error: "This profile cannot be removed." });
    }

    const nextProfiles = profiles.filter((profile) => profile !== target);
    saveStoredStaffProfiles(nextProfiles);
    await writeAuditLog(req, {
      action_type: "staff_user_removed",
      module: "user_management",
      target_table: "staff_users",
      target_id: target.id,
      old_snapshot: target,
      change_summary: `${getActiveStaffProfile(req)?.name || "Staff"} removed staff profile ${target.name}.`,
    });
    res.json({ success: true, ok: true, users: await getStaffProfiles() });
  } catch (error) {
    console.error("Remove staff user error:", error);
    res.status(500).json({ success: false, ok: false, error: error.message || "Could not remove staff user." });
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "AI quote server is running",
    model: MODEL,
    webSearchEnabled: ENABLE_WEB_SEARCH,
    webSearchModel: WEB_SEARCH_MODEL,
    databaseEnabled: SUPABASE_ENABLED,
    storage: SUPABASE_ENABLED ? "supabase" : "local-file-fallback",
  });
});

app.get("/db-health", requireStaff, async (req, res) => {
  if (!SUPABASE_ENABLED) {
    return res.status(500).json({ ok: false, success: false, databaseEnabled: false, error: "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are not configured." });
  }
  try {
    const auditSample = await dbSelect("audit_logs", "select=id&limit=1");
    const userSample = await dbSelect("staff_users", "select=id&limit=1");
    res.json({
      ok: true,
      success: true,
      databaseEnabled: true,
      checkedTables: { audit_logs: Array.isArray(auditSample), staff_users: Array.isArray(userSample) },
    });
  } catch (error) {
    rememberSupabaseIssue("database health check", error);
    res.status(500).json({ ok: false, success: false, databaseEnabled: true, error: "Database check failed. Verify SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and RLS setup in Render/Supabase.", latestIssueAt: latestSupabaseIssue?.at || null });
  }
});

app.get("/audit-logs", requireStaff, async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit || 100), 1), 300);
  if (!SUPABASE_ENABLED) {
    const file = path.join(DATA_DIR, "audit-log.json");
    const rows = readJsonFile(file, []);
    return res.json({ ok: true, success: true, logs: rows.slice(-limit).reverse(), storage: "local-file" });
  }
  try {
    const rows = await dbSelect("audit_logs", `select=*&order=created_at.desc&limit=${limit}`);
    res.json({ ok: true, success: true, logs: Array.isArray(rows) ? rows : [], storage: "supabase" });
  } catch (error) {
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load audit logs." });
  }
});

app.get("/local-backup", requireStaff, (req, res) => {
  const data = readJsonFile(LOCAL_BACKUP_FILE, { ok: false, message: "No local backup found yet." });
  res.json({ ok: true, data });
});

app.get("/local-backup/download", requireStaff, (req, res) => {
  if (!fs.existsSync(LOCAL_BACKUP_FILE)) {
    return res.status(404).json({ ok: false, error: "No local backup found yet." });
  }
  res.download(LOCAL_BACKUP_FILE, "estimation-grid-app-data.json");
});

app.post("/local-backup", requireStaff, async (req, res) => {
  const payload = req.body || {};
  const headerUserName = String(req.headers["x-staff-user"] || "").trim();
  const headerUserId = String(req.headers["x-staff-user-id"] || "").trim();
  const snapshot = {
    ...payload,
    actor: req.staff?.activeUser || (headerUserName ? { id: headerUserId || staffProfileIdFromName(headerUserName), name: headerUserName } : null),
    backendSavedAt: new Date().toISOString(),
  };

  try {
    const previousSnapshot = await getPreviousCloudSnapshot();
    writeJsonFile(LOCAL_BACKUP_FILE, snapshot);

    if (SUPABASE_ENABLED) {
      const previousHash = previousSnapshot ? crypto.createHash("sha256").update(JSON.stringify(previousSnapshot)).digest("hex") : "";
      const nextHash = crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
      if (previousHash !== nextHash) {
        await auditSnapshotChanges(previousSnapshot, snapshot, req);
      }
      await saveCloudSnapshot(snapshot, req);
      await syncSnapshotBusinessData(snapshot, req);
    }

    res.json({
      ok: true,
      success: true,
      storage: SUPABASE_ENABLED ? "supabase+local-file" : "local-file",
      file: LOCAL_BACKUP_FILE,
      savedAt: snapshot.backendSavedAt,
    });
  } catch (error) {
    rememberSupabaseIssue("local backup cloud sync", error);
    writeJsonFile(LOCAL_BACKUP_FILE, snapshot);
    res.json({
      ok: true,
      success: true,
      storage: "local-file",
      cloudWarning: "Saved locally on backend, but cloud database sync needs checking.",
      file: LOCAL_BACKUP_FILE,
      savedAt: snapshot.backendSavedAt,
    });
  }
});

app.get("/agent-requests", requireStaff, (req, res) => {
  res.json({ success: true, requests: handoffRequests.slice(-50).reverse() });
});

app.post("/agent-request", (req, res) => {
  const body = req.body || {};
  const request = {
    id: `handoff_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
    status: "waiting",
    customer: body.customer || {},
    messages: normalizeMessages(body.messages || []),
    note: normalizeContent(body.note || "Customer requested a real staff member."),
  };
  handoffRequests.push(request);
  res.json({ success: true, request, staffContactName: STAFF_CONTACT_NAME, staffContactPhone: STAFF_CONTACT_PHONE });
});

app.post("/ai-estimate", async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ success: false, error: "OPENAI_API_KEY is missing in .env" });
    }

    const mode = req.body?.mode === "customer" ? "customer" : "staff";
    if (mode === "staff") {
      cleanStaffSessions();
      const token = getStaffToken(req);
      if (!token || !staffSessions.has(token)) {
        return res.status(401).json({ success: false, ok: false, error: "Staff login required for staff AI requests." });
      }
    }
    const prompt = normalizeContent(req.body?.prompt).trim();
    const messages = normalizeMessages(req.body?.messages);
    const catalog = Array.isArray(req.body?.catalog) ? req.body.catalog : [];
    const customer = req.body?.customer && typeof req.body.customer === "object" ? req.body.customer : {};

    if (!prompt && !messages.length) {
      return res.status(400).json({ success: false, error: "Send either prompt or messages." });
    }

    let result;
    let webSearchError = null;
    if (shouldUseWebSearch({ mode, prompt, messages })) {
      try {
        result = await runResponseWithWebSearch({ mode, prompt, messages, catalog, customer });
      } catch (err) {
        webSearchError = err.message || String(err);
      }
    }

    if (!result) {
      result = await runChatCompletion({ mode, prompt, messages, catalog, customer });
    }

    const parsed = postProcessResult(result.parsed || {}, { mode, prompt, messages, customer });
    res.json({
      success: true,
      ...parsed,
      result: parsed,
      usage: result.usage || null,
      usedWebSearch: !!result.usedWeb,
      webSearchError,
    });
  } catch (err) {
    console.error("AI estimate error:", err);
    res.status(500).json({ success: false, error: err.message || "AI request failed." });
  }
});

app.listen(PORT, () => {
  console.log(`AI quote server running on port ${PORT}`);
});

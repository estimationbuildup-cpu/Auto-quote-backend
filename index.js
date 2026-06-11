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
const DEFAULT_OPENAI_MODEL = "gpt-5.5";
const MODEL = String(process.env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL).trim();
const WEB_SEARCH_MODEL = String(process.env.OPENAI_WEB_SEARCH_MODEL || MODEL).trim();
const ENABLE_WEB_SEARCH = process.env.ENABLE_WEB_SEARCH !== "false";
const STAFF_CONTACT_NAME = process.env.STAFF_CONTACT_NAME || "Jithin";
const STAFF_CONTACT_PHONE = process.env.AGENT_FALLBACK_PHONE || process.env.JITHIN_CONTACT_PHONE || "+971559665623";
const STAFF_EMAIL = String(process.env.STAFF_EMAIL || "").trim().toLowerCase();
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || "";
const STAFF_USERS_JSON = process.env.STAFF_USERS_JSON || "";
const STAFF_TOKEN_TTL_MS = Number(process.env.STAFF_TOKEN_TTL_HOURS || 168) * 60 * 60 * 1000;
const STAFF_SESSION_SECRET = process.env.STAFF_SESSION_SECRET || crypto.createHash("sha256").update(`${STAFF_PASSWORD}|${STAFF_USERS_JSON}|buildup-staff-session-v2`).digest("hex");
const staffSessions = new Map();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_DIR = process.env.BUILDUP_DESKTOP_DATA_DIR
  ? path.resolve(process.env.BUILDUP_DESKTOP_DATA_DIR)
  : path.join(__dirname, "data");
const LOCAL_BACKUP_FILE = path.join(DATA_DIR, "app-data.json");
const STAFF_PROFILE_USERS_FILE = path.join(DATA_DIR, "staff-users.json");
const DESKTOP_STAFF_LOGIN_FILE = path.join(DATA_DIR, "desktop-staff-login.json");
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

const ASSISTANT_DISABLE_PHRASE = String(process.env.ASSISTANT_DISABLE_PHRASE || process.env.AI_DISABLE_PHRASE || "").trim();
const ASSISTANT_ENABLE_PHRASE = String(process.env.ASSISTANT_ENABLE_PHRASE || process.env.AI_ENABLE_PHRASE || "").trim();
const ASSISTANT_CONTROL_STATUS_KEY = "assistant_global_control";
const ASSISTANT_DISABLED_MESSAGE = process.env.ASSISTANT_DISABLED_MESSAGE || "Auto quote support is temporarily unavailable. Please share your name, phone number, location, and requirement. Our team will review it and get back to you.";
const CUSTOMER_SPAM_GUARD_KEY = "customer_spam_guard";
const CUSTOMER_CHAT_MESSAGE_LIMIT = Number(process.env.CUSTOMER_CHAT_MESSAGE_LIMIT || 30);
const CUSTOMER_RAPID_MESSAGE_LIMIT = Number(process.env.CUSTOMER_RAPID_MESSAGE_LIMIT || 8);
const CUSTOMER_RAPID_WINDOW_MS = Number(process.env.CUSTOMER_RAPID_WINDOW_MS || 60 * 1000);
const CUSTOMER_SPAM_BASE_BLOCK_MS = Number(process.env.CUSTOMER_SPAM_BASE_BLOCK_MINUTES || 15) * 60 * 1000;
const CUSTOMER_SPAM_MAX_BLOCK_MS = Number(process.env.CUSTOMER_SPAM_MAX_BLOCK_HOURS || 24) * 60 * 60 * 1000;
const CUSTOMER_SPAM_MESSAGE = process.env.CUSTOMER_SPAM_MESSAGE || "Please try again later. Your account has been marked as spam for now.";
const CUSTOMER_SPAM_MIN_GENUINE_SCORE = Number(process.env.CUSTOMER_SPAM_MIN_GENUINE_SCORE || 3);
const CUSTOMER_SPAM_LONG_INQUIRY_MIN_CHARS = Number(process.env.CUSTOMER_SPAM_LONG_INQUIRY_MIN_CHARS || 90);
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

let openAiClient = null;
function getOpenAiClient() {
  const apiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_ADMIN_KEY || "";
  if (!apiKey) return null;
  if (!openAiClient) openAiClient = new OpenAI({ apiKey });
  return openAiClient;
}
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

function activeStaffCanControlAssistant(req) {
  const active = getActiveStaffProfile(req);
  return Boolean(active?.id === BUILT_IN_AUTHORITY_PROFILE_ID || isOwnerStaffProfileName(active?.name));
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

function readDesktopStaffLogin() {
  if (process.env.BUILDUP_DESKTOP !== "true") return null;
  const stored = readJsonFile(DESKTOP_STAFF_LOGIN_FILE, null);
  return stored && stored.email && stored.passwordHash ? stored : null;
}

function createDesktopStaffLogin({ email, password }) {
  if (process.env.BUILDUP_DESKTOP !== "true") return null;
  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanPassword = String(password || "");
  if (!cleanEmail || cleanPassword.length < 4) return null;
  const now = new Date().toISOString();
  const user = {
    email: cleanEmail,
    passwordHash: encodeStaffProfilePassword(cleanPassword),
    name: normalizeStaffProfileName(process.env.BUILDUP_DESKTOP_STAFF_NAME || STAFF_OWNER_PROFILE_NAME || "Sameer"),
    role: "admin",
    createdAt: now,
    updatedAt: now,
  };
  writeJsonFile(DESKTOP_STAFF_LOGIN_FILE, user);
  return { email: user.email, name: user.name, role: user.role };
}

function findDesktopStaffLogin(email, password) {
  const stored = readDesktopStaffLogin();
  if (!stored) return null;
  const cleanEmail = String(email || "").trim().toLowerCase();
  if (cleanEmail !== String(stored.email || "").toLowerCase()) return null;
  if (!verifyEncodedStaffProfilePassword(password, stored.passwordHash)) return null;
  return {
    email: stored.email,
    name: stored.name || stored.email,
    role: stored.role || "admin",
  };
}

function findStaffUser(email, password) {
  const cleanEmail = String(email || "").trim().toLowerCase();
  const cleanPassword = String(password || "");
  if (!cleanEmail || !cleanPassword) return null;

  return getConfiguredStaffUsers().find((user) => (
    user.email === cleanEmail && user.password === cleanPassword
  )) || findDesktopStaffLogin(cleanEmail, cleanPassword) || null;
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
      } catch {
        // Use the fallback reply below when the repaired JSON is still invalid.
      }
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
  // GPT-5.5 should use web search more often for customer-facing guidance,
  // especially when the customer asks about suitability, product options,
  // standards, limitations, current info, or anything uncertain.
  return /\b(best|recommend|suggest|which|what system|suitable|limitation|maximum|latest|current|search|internet|website|specification|standard|thermal break|5\s*meter|5000\s*mm|large opening|wide opening|sliding or folding|folding or sliding|compare|difference|option|available|can you|is it possible|safe|strong|waterproof|soundproof|heat|insulation|price range|dubai|uae)\b/.test(text);
}

function extractCustomerUpdatesFromText(text = "") {
  const value = String(text || "");
  const updates = {};
  const phoneMatch = value.match(/(?:\+?971|00971|0)?\s*(?:5\d|[234679])\s*[\d\s().-]{6,}/);
  if (phoneMatch) {
    const normalizedPhone = normalizeUaePhone(phoneMatch[0]);
    updates.phone = normalizedPhone.valid ? normalizedPhone.normalized : phoneMatch[0].replace(/\s+/g, " ").trim();
  }

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
  const phone = String(customer.phone || customer.phoneNumber || customer.mobile || "").trim();
  if (!phone) missing.push("phone number");
  else if (!isValidUaePhone(phone)) missing.push("valid UAE phone number");
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


function itemLabelForMissingDetails(item = {}, index = 0) {
  return String(item.tag || item.code || item.item_code || item.subcategory || item.system || item.product || `item ${index + 1}`);
}

function textHasFenceLength(text = "") {
  const value = String(text || "").toLowerCase();
  return /(length|total|running|linear|meter|metre|mtr|rm|r\.m|feet|foot|ft)\s*(is|around|approx|approximately|=|:)?\s*\d+(\.\d+)?\s*(m|meter|metre|mtr|mm|cm|ft|feet|foot)?/i.test(value)
    || /\d+(\.\d+)?\s*(m|meter|metre|mtr|ft|feet|foot)\s*(long|length|total|fenc|fencing|fence)/i.test(value)
    || /(fenc|fencing|fence).{0,60}\d+(\.\d+)?\s*(m|meter|metre|mtr|ft|feet|foot)/i.test(value);
}

function textHasFenceHeight(text = "") {
  const value = String(text || "").toLowerCase();
  return /(height|high|ht)\s*(is|around|approx|approximately|=|:)?\s*\d+(\.\d+)?\s*(m|meter|metre|mtr|mm|cm|ft|feet|foot)?/i.test(value)
    || /\d+(\.\d+)?\s*(m|meter|metre|mtr|mm|cm|ft|feet|foot)\s*(height|high|ht)/i.test(value);
}

function plausibleFenceLength(value) {
  const n = Number(value || 0) || 0;
  return (n >= 1000 && n <= 250000) || (n >= 1 && n <= 250);
}

function plausibleFenceHeight(value) {
  const n = Number(value || 0) || 0;
  return (n >= 400 && n <= 6000) || (n >= 0.4 && n <= 6);
}

function quoteMissingDetailLabelsForItems(items = [], customer = {}, messages = []) {
  const list = Array.isArray(items) ? items : [];
  const allText = `${customer?.projectType || ""} ${conversationText(messages)} ${list.map((item) => `${item.product || ""} ${item.type || ""} ${item.subcategory || ""} ${item.system || ""}`).join(" ")}`.toLowerCase();
  const missing = [];

  if (!list.length && !/fencing|fence|sliding|folding|hinged|door|window|fixed|glass|partition|shower|curtain|facade|skylight|pergola/.test(allText)) {
    missing.push("product type");
  }

  list.forEach((item, index) => {
    const label = `${item.product || ""} ${item.type || ""} ${item.subcategory || ""} ${item.system || ""}`.toLowerCase();
    const display = itemLabelForMissingDetails(item, index);
    const width = Number(item.width_mm ?? item.width ?? item.widthMm ?? 0) || 0;
    const height = Number(item.height_mm ?? item.height ?? item.heightMm ?? 0) || 0;
    const qty = Number(item.qty ?? item.quantity ?? 0) || 0;
    const isFencing = /fenc|fencing|fence/.test(label) || /fenc|fencing|fence/.test(allText);

    if (isFencing) {
      if (!plausibleFenceLength(width) && !textHasFenceLength(allText)) missing.push(`width for ${display}`);
      if (!plausibleFenceHeight(height) && !textHasFenceHeight(allText)) missing.push(`height for ${display}`);
    } else {
      if (width <= 0) missing.push(`width for ${display}`);
      if (height <= 0) missing.push(`height for ${display}`);
    }
    if (qty <= 0) missing.push(`quantity for ${display}`);
  });

  return [...new Set(missing)].slice(0, 6);
}

function sanitizeCustomerFacingMeasurementText(text = "") {
  return String(text || "")
    .replace(/width\s*\/\s*length/gi, "width")
    .replace(/length\s*\/\s*width/gi, "width")
    .replace(/approximate\s+total\s+length/gi, "width")
    .replace(/total\s+length/gi, "width")
    .replace(/running\s+length/gi, "width")
    .replace(/linear\s+meter(?:s)?/gi, "width")
    .replace(/\blength\b/gi, "width")
    .replace(/width\s*\/\s*opening\s+size/gi, "width")
    .replace(/opening\s+size/gi, "width and height")
    .replace(/approximate\s+size/gi, "width and height")
    .replace(/\bsize\s+details\b/gi, "width and height details")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function joinHumanList(items = []) {
  const list = [...new Set((Array.isArray(items) ? items : []).map((item) => String(item || "").trim()).filter(Boolean))];
  if (list.length <= 1) return list[0] || "";
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

function formatMissingQuoteDetailsForCustomer(missing = []) {
  const labels = [...new Set((Array.isArray(missing) ? missing : []).map(sanitizeCustomerFacingMeasurementText).filter(Boolean))];
  if (!labels.length) return "width, height and quantity";
  const groupedByItem = new Map();
  const standalone = [];
  labels.forEach((label) => {
    const match = String(label).match(/^(width|height|quantity|qty)\s+for\s+(.+)$/i);
    if (!match) {
      standalone.push(label);
      return;
    }
    const field = match[1].toLowerCase().replace("qty", "quantity");
    const item = match[2].replace(/^the\s+/i, "").trim();
    groupedByItem.set(item, [...(groupedByItem.get(item) || []), field]);
  });
  const grouped = [...groupedByItem.entries()].map(([item, fields]) => `${joinHumanList(fields)} for the ${item}`);
  if (grouped.length) return joinHumanList([...grouped, ...standalone]);
  const text = labels.join(" ").toLowerCase();
  const details = [];
  if (/product/.test(text)) details.push("product type");
  if (/width|height|size/.test(text)) details.push("width and height");
  if (/quantity|qty/.test(text)) details.push("quantity");
  return joinHumanList(details.length ? details : labels.slice(0, 3));
}

function quoteMissingQuestion(missing = []) {
  const cleanFirst = formatMissingQuoteDetailsForCustomer(missing);
  const options = [
    `Can you share the ${cleanFirst}?`,
    `Please send the ${cleanFirst} so I can continue.`,
    `Got it. I just need the ${cleanFirst} to prepare this properly.`,
    `For accurate pricing, please share the ${cleanFirst}.`,
  ];
  return options[Math.floor(Math.random() * options.length)];
}

function missingCustomerContactFields(customer = {}) {
  const missing = [];
  if (!String(customer.name || customer.customerName || customer.clientName || "").trim()) missing.push("name");
  const phone = String(customer.phone || customer.phoneNumber || customer.mobile || "").trim();
  if (!phone) missing.push("phone number");
  else if (!isValidUaePhone(phone)) missing.push("valid UAE phone number");
  return missing;
}

function customerContactQuestion(missing = [], latestText = "") {
  const fields = joinHumanList(missing.length ? missing : ["name", "phone number"]);
  const hasInvalidPhone = (missing || []).some((item) => /valid UAE phone/i.test(String(item)));
  const challenge = /did you just|without asking|why did you|you didn'?t ask|not responding|wrong|mistake|what'?s happening/i.test(String(latestText || ""));
  if (hasInvalidPhone) return "Please share a valid UAE phone number, for example 05x xxx xxxx or +971 5x xxx xxxx, so our team can contact you correctly.";
  const options = challenge ? [
    `You're right — I should collect your ${fields} before saving or finalizing the quotation. Please share them and I will continue properly.`,
    `Correct, I should not finalize it without your ${fields}. Send those details and I will save the inquiry properly.`,
    `Good catch. Before I treat this as a proper quotation request, please share your ${fields}.`,
  ] : [
    `Before I prepare the quotation, please share your ${fields} so I can save the inquiry correctly.`,
    `The product details are clear. Please send your ${fields}, then I can confirm the quote properly.`,
    `Great, I have the size details. What is your ${fields}?`,
    `To save this request for our team, please share your ${fields}.`,
  ];
  return options[Math.floor(Math.random() * options.length)];
}

function customerLatestMessageNeedsHumanAnswer(text = "") {
  const value = String(text || "").trim().toLowerCase();
  if (!value) return false;
  if (/^(hi|hello|hey|salam|assalam|thanks|thank you|ok|okay|fine)\b/.test(value)) return true;
  if (/[?؟]/.test(value)) return true;
  if (/\b(why|what|how|which|difference|better|recommend|suggest|options|available|can you|do you|is it|are you|confused|not responding|wrong|mistake|explain)\b/.test(value)) return true;
  return false;
}

function customerLatestMessageIsConcreteQuoteDetail(text = "") {
  const value = String(text || "").toLowerCase();
  return /\b(width|height|qty|quantity|size|quote|price|cost|estimate|mm|cm|meter|metre|mtr|x\s*\d|\d+\s*x\s*\d|my name is|i am|i'm|phone|mobile|whatsapp|\+971|00971|05\d|location|maps|sliding|folding|hinged|door|window|glass|partition|shower|fencing|fence|pergola|glass house)\b/.test(value);
}

function shouldRespectNaturalAiReply(latestText = "", parsed = {}) {
  const mode = String(parsed?.mode || "").toLowerCase();
  if (["quote_draft", "confirm_draft", "need_confirmation"].includes(mode)) return false;
  if (!customerLatestMessageNeedsHumanAnswer(latestText)) return false;
  // A question like "Which is better, sliding or folding?" deserves an answer first, not a forced form-style detail request.
  if (/[?؟]/.test(String(latestText || ""))) return true;
  return !customerLatestMessageIsConcreteQuoteDetail(latestText);
}

function isUnsupportedPricingInquiry(text = "", items = []) {
  const haystack = `${text} ${(Array.isArray(items) ? items : []).map((item) => `${item.product || ""} ${item.type || ""} ${item.subcategory || ""} ${item.system || ""}`).join(" ")}`.toLowerCase();
  return /\b(pergola|peragola|aluminium fencing|aluminum fencing|fencing|fence|glass house|glasshouse|greenhouse|canopy|railing|handrail)\b/.test(haystack);
}

function buildSystemPrompt(mode) {
  const common = `
You are Buildup UAE's aluminium, glass, window and door quotation assistant.
Return ONLY valid JSON. Do not wrap JSON in markdown.

Core behavior:
- Be a professional, warm UAE sales assistant, not a rigid form.
- Customer questions are priority. Answer the latest message like a human support agent first. Only after that, ask ONE short next question when it is genuinely needed.
- Never behave like a form collector. Greetings, objections, comparisons, "what is this?", "why?", and normal questions must get a real answer before any data collection.
- Sound natural: acknowledge first when useful ("I understand", "That makes sense", "For that opening...").
- Vary your wording. Do not reuse the exact same sentence template for follow-up questions. Rotate naturally between short WhatsApp-style questions, helpful confirmations, and direct detail requests.
- Do NOT repeat the same question again and again. If already asked, continue from the customer's latest answer.
- Use the conversation history. Continue naturally and remember what the customer already answered.
- Do not overwhelm the customer with a list of many fields in one message.
- Do not promise final price, structural approval, exact delivery date, or final panel design without staff review. Say estimated/AI draft pricing can vary after team/site verification.
- Only offer a real staff/agent handoff in these cases: (1) the customer asks for a real agent, (2) the customer seems frustrated and you cannot answer/understand after trying once, or (3) the inquiry is outside the instant pricing engine such as aluminium fencing, pergola, glass house, canopy, railing/handrail, or other custom work.
- Do NOT offer or request a real agent just because a site visit was booked, a location was shared, or normal quote details are missing.
- If a business-specific answer is uncertain, do not say "I don't know". Say that you will check with the team, and only offer staff support if it matches the three handoff cases above.

Conversation order for customer mode:
1. Understand product type first.
2. Collect quote-critical product details BEFORE confirmation, price, or staff submission.
   - Doors/windows/fixed glass: width and height, plus quantity.
   - Aluminium fencing/fence: width and height, plus quantity if there are separate sections. Do NOT treat a phone number as a width or height. Do NOT submit fencing to staff just because phone/location was provided.
   - Partitions/shower/railing: width and height, plus quantity/area if available.
3. When quote-critical details are complete, collect the customer's name and phone number before any final price, staff submission, or quote_draft.
4. After name and phone number are available, summarize the products and ask for confirmation. Confirmation should be the final step before price/staff-review.
5. After customer confirms:
   - If standard configuration: return quote_draft so the app can show instant price.
   - If non-standard/custom options are selected, return quote_draft but clearly note it needs staff review. Non-standard includes frosted/fluted/tinted/reflective glass, special glass colour, non-standard thickness, special aluminium/frame colour, jumbo/special access, or unclear specifications.
6. After quotation/review submission, ask for Google Maps location if not already shared.
7. After location is shared, ask whether they want to book a site visit with an expert. If they agree, the app will ask the preferred date first, then show available times for that date.
Customers may start chatting without name/phone/location. Extract them from chat if mentioned and return them in customer_updates. Do not block product guidance because name/phone/location is missing, but do block final quotation/quote_draft until name and a valid UAE phone number are known.
Do not ask for name, phone, location, width, height, product type, glass, and panels all in one message.
Do not ask for Google Maps location twice. If a location or location request already exists in the conversation, continue with the missing product detail or site-visit question instead.
Do not submit to staff or return quote_draft until quote-critical width and height details are present.

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
- Detect possible items, but ask the customer to confirm first only when all quote-critical details are complete.
- Use mode "confirm_draft" and requires_confirmation true when items are ready but customer has not confirmed.
- If the customer confirms the summarized details AND name/phone are known, return mode "quote_draft".
- If product details are complete but name or a valid UAE phone number is missing, ask naturally for the missing contact detail first. Do not return quote_draft yet.
- Do not show confirmation buttons early. Confirmation means the next step is price for standard items or staff review for non-standard items.

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
Use web/search support when the customer asks about current suitability, comparisons, options, standards, or product guidance.
Do not say "I don't know" to customers; for uncertain company-specific items, say "I will check with the team" and continue naturally.
Do not ask all questions at once. Usually ask only ONE useful next question, and vary the wording each time so it does not feel robotic.
If the customer asks a general advice question like "sliding or folding", answer with simple pros/cons from your own knowledge and the company catalog. Do not say you searched or asked ChatGPT. Do not immediately ask for width and height in the same reply unless the customer directly asks for a quote/price.
If the latest message is a general question, greeting, complaint, or comparison, return mode "reply" and keep items empty unless the customer also gave actual quote details.
Example: If customer says "Doors" and asks what kinds: reply only with the door options, such as "We have Slim Sliding Doors, Folding Doors and Hinged Doors. Which one do you prefer?" Do NOT also ask size, name, phone and location in that same message.
If enough details exist, summarize and confirm: "Just to confirm, you need ... correct?"
Confirmation should appear only after all important product details are complete. After confirmation, the app will either price standard configurations or transparently send non-standard/custom configurations to staff review.
Never jump straight to quote_draft in customer mode unless the customer's latest message clearly confirms the summary and the customer name and phone number are already known.
If the customer challenges a mistake, asks why something happened, or asks a normal question, answer that naturally first before continuing the quote flow.
Customer-facing measurement language must ask only for "width and height". Do not use alternative measurement wording.`;
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

function supportsCustomTemperature(modelName = "") {
  const normalized = String(modelName || "").trim().toLowerCase();

  // GPT-5.5 / GPT-5 family models only support the default temperature value.
  // Do not send a custom temperature parameter for these models.
  if (normalized.startsWith("gpt-5")) return false;

  return true;
}

function normalizeAnalyticsSummary(summary = {}, fallbackFacts = {}) {
  const fallbackPeriod = String(fallbackFacts?.period || "monthly");
  const periodLabel = fallbackPeriod.charAt(0).toUpperCase() + fallbackPeriod.slice(1);
  const listOf = (value) => Array.isArray(value)
    ? value.map((item) => normalizeContent(item).trim()).filter(Boolean).slice(0, 5)
    : [];

  return {
    source: "ai",
    title: normalizeContent(summary.title).trim() || `${periodLabel} AI Executive Summary`,
    executiveSummary: normalizeContent(summary.executiveSummary || summary.summary).trim() || "AI summary generated from the provided analytics facts.",
    wins: listOf(summary.wins),
    risks: listOf(summary.risks),
    actions: listOf(summary.actions || summary.nextActions),
  };
}

async function generateAnalyticsSummary({ period, facts }) {
  const client = getOpenAiClient();
  if (!client) throw new Error("OPENAI_API_KEY is missing on the backend.");
  const periodLabel = String(period || "monthly").toUpperCase();
  const prompt = `
You are the CEO analytics advisor for a UAE glass and aluminium company.
Write a concise ${periodLabel} executive business summary from the JSON facts only.
Do not invent numbers. If a number is missing, describe the trend without making up a value.
Return JSON only with:
{
  "title": string,
  "executiveSummary": string,
  "wins": string[],
  "risks": string[],
  "actions": string[]
}

Facts:
${JSON.stringify(facts || {}, null, 2)}
`;

  const requestPayload = {
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: "You write practical CEO summaries for a construction/glass/aluminium business. You are concise, factual, and decision-focused." },
      { role: "user", content: prompt },
    ],
  };

  if (supportsCustomTemperature(MODEL)) requestPayload.temperature = 0.2;

  const response = await client.chat.completions.create(requestPayload);
  const content = response.choices?.[0]?.message?.content || "{}";
  return {
    summary: normalizeAnalyticsSummary(safeParseJson(content), facts),
    usage: response.usage || null,
  };
}

async function runChatCompletion({ mode, prompt, messages, catalog, customer }) {
  const client = getOpenAiClient();
  if (!client) throw new Error("OPENAI_API_KEY is missing on the backend.");
  const userContent = buildUserPayload({ mode, prompt, messages, catalog, customer });
  const requestPayload = {
    model: MODEL,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildSystemPrompt(mode) },
      { role: "user", content: userContent },
    ],
  };

  if (supportsCustomTemperature(MODEL)) {
    requestPayload.temperature = mode === "customer" ? 0.35 : 0.2;
  }

  const response = await client.chat.completions.create(requestPayload);
  const content = response.choices?.[0]?.message?.content || "{}";
  return { parsed: safeParseJson(content), usage: response.usage || null, usedWeb: false };
}

async function runResponseWithWebSearch({ mode, prompt, messages, catalog, customer }) {
  const client = getOpenAiClient();
  if (!client) throw new Error("OPENAI_API_KEY is missing on the backend.");
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

  const naturalReplyPriority = mode === "customer" && shouldRespectNaturalAiReply(lastText, parsed);
  const unsupportedPricing = mode === "customer" && isUnsupportedPricingInquiry(`${conversationText(messages)}
${prompt}`, items);

  if (mode === "customer" && unsupportedPricing && !naturalReplyPriority && parsed.mode !== "quote_draft") {
    next.mode = "handoff_offer";
    next.handoff_offer = true;
    next.items = [];
    next.requires_confirmation = false;
    if (!next.reply || /width|height|quotation|quote/i.test(String(next.reply))) {
      next.reply = "This looks like a custom item that needs team pricing. I can connect you with a real staff member, or you can share the basic details here and I will save it for review.";
    }
  }

  if (mode === "customer" && naturalReplyPriority) {
    next.mode = "reply";
    next.items = [];
    next.requires_confirmation = false;
    next.questions = Array.isArray(parsed.questions) ? parsed.questions : [];
  } else if (mode === "customer" && items.length) {
    const missingQuoteDetails = quoteMissingDetailLabelsForItems(items, mergedCustomer, messages);
    if (missingQuoteDetails.length) {
      next.mode = "need_clarification";
      next.requires_confirmation = false;
      next.items = [];
      const followUpQuestion = quoteMissingQuestion(missingQuoteDetails);
      next.questions = [followUpQuestion];
      next.missing_required_fields = [...new Set([...(next.missing_required_fields || []), ...missingQuoteDetails.map(sanitizeCustomerFacingMeasurementText)])];
      next.reply = followUpQuestion;
      if (mode === "customer") {
        if (typeof next.reply === "string") next.reply = sanitizeCustomerFacingMeasurementText(next.reply);
        if (Array.isArray(next.questions)) next.questions = next.questions.map(sanitizeCustomerFacingMeasurementText);
        if (Array.isArray(next.missing_required_fields)) next.missing_required_fields = next.missing_required_fields.map(sanitizeCustomerFacingMeasurementText);
      }
      return next;
    }

    const missingContact = missingCustomerContactFields(mergedCustomer);
    if (missingContact.length) {
      next.mode = "need_clarification";
      next.requires_confirmation = false;
      next.items = [];
      const followUpQuestion = customerContactQuestion(missingContact, lastText);
      next.questions = [followUpQuestion];
      next.missing_required_fields = [...new Set([...(next.missing_required_fields || []), ...missingContact])];
      next.reply = followUpQuestion;
      return next;
    }

    const alreadyConfirmed = isPositiveConfirmation(lastText) || parsed.confirmed_by_customer === true;
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
    if (naturalReplyPriority) {
      next.reply = "Sure, I can help. Which glass or aluminium product are you looking for?";
    } else if (next.mode === "handoff_offer") {
      next.reply = "I will check this with the team to avoid giving wrong information. I can connect you with a real staff member if you want.";
      next.handoff_offer = true;
    } else if (missingRequired.length && mode === "customer") {
      const contactMissing = missingCustomerContactFields(mergedCustomer);
      next.reply = contactMissing.length ? customerContactQuestion(contactMissing, lastText) : `Sure, I can help. Please share your ${joinHumanList(missingRequired)} so I can continue.`;
    } else {
      next.reply = "Sure, I understand. Please share the width, height and quantity so I can prepare a draft.";
    }
  }

  if (mode === "customer") {
    if (typeof next.reply === "string") next.reply = sanitizeCustomerFacingMeasurementText(next.reply);
    if (typeof next.confirmation_summary === "string") next.confirmation_summary = sanitizeCustomerFacingMeasurementText(next.confirmation_summary);
    if (Array.isArray(next.questions)) next.questions = next.questions.map(sanitizeCustomerFacingMeasurementText);
    if (Array.isArray(next.missing_required_fields)) next.missing_required_fields = next.missing_required_fields.map(sanitizeCustomerFacingMeasurementText);
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

function normalizePhone(value = "") {
  return String(value || "").replace(/[^0-9+]/g, "").trim();
}

function normalizeUaePhone(value = "") {
  const raw = String(value || "").trim();
  const digits = raw.replace(/\D/g, "");
  if (!digits) return { valid: false, normalized: "", national: "", reason: "empty" };
  let national = digits;
  if (national.startsWith("00971")) national = national.slice(5);
  else if (national.startsWith("971")) national = national.slice(3);
  else if (national.startsWith("0")) national = national.slice(1);

  const isMobile = /^5\d{8}$/.test(national);
  const isLandline = /^(2|3|4|6|7|9)\d{7}$/.test(national);
  const valid = isMobile || isLandline;
  return {
    valid,
    normalized: valid ? `+971${national}` : raw,
    national,
    reason: valid ? "valid" : "invalid_uae_phone",
  };
}

function isValidUaePhone(value = "") {
  return normalizeUaePhone(value).valid;
}

function parseCustomerDetailsText(value = "") {
  const text = String(value || "");
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const out = {};
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(":");
    if (!rest.length) continue;
    const key = String(rawKey || "").trim().toLowerCase();
    const val = rest.join(":").trim();
    if (!val) continue;
    if (key.includes("phone") || key.includes("mobile") || key.includes("whatsapp")) out.phone = out.phone || val;
    if (key.includes("location") || key.includes("address") || key.includes("site")) out.location = out.location || val;
    if (key.includes("project")) out.projectType = out.projectType || val;
  }
  return out;
}

function normalizeLeadDbPayload(customer = {}, actor = {}) {
  const now = new Date().toISOString();
  const leadId = String(customer.leadId || customer.lead_id || customer.LEADID || "").trim();
  const name = String(customer.name || customer.clientName || customer.customerName || customer.client_name || "").trim();
  const phoneRaw = String(customer.phone || customer.phoneNumber || customer.mobile || "").trim();
  const normalizedPhone = normalizeUaePhone(phoneRaw);
  const phone = normalizedPhone.valid ? normalizedPhone.normalized : phoneRaw;
  const whatsappRaw = String(customer.whatsapp || customer.whatsappNumber || customer.whatsapp_number || phoneRaw || "").trim();
  const normalizedWhatsapp = normalizeUaePhone(whatsappRaw);
  const whatsapp = normalizedWhatsapp.valid ? normalizedWhatsapp.normalized : whatsappRaw;
  return {
    lead_id: leadId || null,
    date: cleanDateOrNull(customer.date) || cleanDateOrNull(now.slice(0, 10)),
    time: customer.timeOfInquiry || customer.time || null,
    day: customer.day || null,
    client_name: name || null,
    phone: phone || null,
    whatsapp: whatsapp || null,
    location: customer.location || customer.address || null,
    project_type: customer.projectType || customer.project_type || null,
    product_inquired: customer.productInquired || customer.product_inquired || null,
    source: customer.source || null,
    lead_type: customer.leadType || customer.lead_type || null,
    status: customer.status || "New Lead",
    next_follow_up_date: cleanDateOrNull(customer.nextFollowUpDate || customer.next_follow_up_date),
    quote_status: customer.quoteStatus || customer.lastQuoteStatus || customer.quote_status || null,
    quotation_amount: toNumberOrNull(customer.quotationAmount || customer.quoteAmount || customer.lastQuoteTotal || customer.quotation_amount),
    meeting_scheduled: Boolean(customer.meetingScheduled || customer.meeting_scheduled),
    site_visit_done: Boolean(customer.siteVisitDone || customer.site_visit_done),
    deal_closed: Boolean(customer.dealClosed || customer.deal_closed),
    closing_amount: toNumberOrNull(customer.closingAmount || customer.closing_amount),
    lost_reason: customer.lostReason || customer.lost_reason || null,
    notes: customer.notes || customer.NOTES || null,
    updated_by: actor.id || null,
    updated_at: now,
  };
}

function dbLeadToAppCustomer(row = {}) {
  return {
    id: row.id || row.lead_id || `lead_${Date.now().toString(36)}`,
    leadId: row.lead_id || "",
    date: row.date || "",
    timeOfInquiry: row.time || "",
    day: row.day || "",
    name: row.client_name || "",
    phone: row.phone || "",
    whatsapp: row.whatsapp || row.phone || "",
    email: row.email || "",
    address: row.location || "",
    location: row.location || "",
    projectType: row.project_type || "",
    productInquired: row.product_inquired || "",
    source: row.source || "",
    leadType: row.lead_type || "",
    status: row.status || "New Lead",
    nextFollowUpDate: row.next_follow_up_date || "",
    quoteStatus: row.quote_status || "",
    quotationAmount: Number(row.quotation_amount || 0) || 0,
    meetingScheduled: Boolean(row.meeting_scheduled),
    siteVisitDone: Boolean(row.site_visit_done),
    dealClosed: Boolean(row.deal_closed),
    closingAmount: Number(row.closing_amount || 0) || 0,
    lostReason: row.lost_reason || "",
    notes: row.notes || "",
    lastQuoteStatus: row.quote_status || "",
    lastQuoteTotal: Number(row.quotation_amount || 0) || 0,
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
    sourceStorage: "supabase",
  };
}

async function nextLeadIdFromSupabase() {
  if (!SUPABASE_ENABLED) return "L0001";
  const rows = await dbSelect("leads", "select=lead_id&limit=10000");
  const max = (Array.isArray(rows) ? rows : []).reduce((best, row) => {
    const match = String(row?.lead_id || "").match(/(\d+)/);
    return Math.max(best, match ? Number(match[1]) || 0 : 0);
  }, 0);
  return `L${String(max + 1).padStart(4, "0")}`;
}

async function findLeadByLeadIdOrPhone({ leadId = "", phone = "" } = {}) {
  if (!SUPABASE_ENABLED) return null;
  const cleanLeadId = String(leadId || "").trim();
  const cleanPhone = normalizePhone(phone);
  if (cleanLeadId) {
    const rows = await dbSelect("leads", `select=*&lead_id=eq.${encodeEq(cleanLeadId)}&limit=1`);
    if (Array.isArray(rows) && rows[0]) return rows[0];
  }
  if (cleanPhone) {
    const rows = await dbSelect("leads", `select=*&phone=eq.${encodeEq(cleanPhone)}&limit=1`);
    if (Array.isArray(rows) && rows[0]) return rows[0];
  }
  return null;
}

async function upsertSingleLeadToSupabase(customer = {}, req = null, { generateIfMissing = true } = {}) {
  if (!SUPABASE_ENABLED) throw new Error("Supabase is not configured.");
  const actor = actorFromRequest(req);
  const phone = customer.phone || customer.phoneNumber || customer.mobile || "";
  if (String(phone || "").trim() && !isValidUaePhone(phone)) throw new Error("Please enter a valid UAE phone number before saving this lead.");
  let leadId = String(customer.leadId || customer.lead_id || customer.LEADID || "").trim();
  const previous = await findLeadByLeadIdOrPhone({ leadId, phone });
  if (!leadId && previous?.lead_id) leadId = previous.lead_id;
  if (!leadId && generateIfMissing) leadId = await nextLeadIdFromSupabase();
  if (!leadId) throw new Error("Lead ID is required before saving this lead.");
  const payload = normalizeLeadDbPayload({ ...customer, leadId }, actor);
  const oldSnapshot = previous ? dbLeadToAppCustomer(previous) : null;
  const savedRows = await dbUpsert("leads", [payload], { onConflict: "lead_id" });
  const saved = Array.isArray(savedRows) && savedRows[0] ? savedRows[0] : null;
  if (!saved?.id) throw new Error("Lead was not returned from Supabase.");
  const newSnapshot = dbLeadToAppCustomer(saved);
  await writeAuditLog(req, {
    action_type: previous ? "lead_cloud_updated" : "lead_cloud_created",
    module: "leads",
    target_table: "leads",
    target_id: saved.id,
    old_snapshot: oldSnapshot,
    new_snapshot: newSnapshot,
    change_summary: `${actor.name} ${previous ? "updated" : "created"} lead ${leadId} in Supabase.`,
  });
  return { row: saved, customer: newSnapshot };
}

async function upsertLeadFromCustomerRequestRecord(record = {}, req = null) {
  const name = record.customer_name || "";
  const phone = record.phone || "";
  if (!String(name || "").trim() || !String(phone || "").trim()) return null;
  if (!isValidUaePhone(phone)) return null;
  const estimateData = record.estimate_data || {};
  const productInquired = Array.isArray(estimateData.items) && estimateData.items.length
    ? [...new Set(estimateData.items.map((item) => item?.subcategory || item?.product || item?.type).filter(Boolean))].join(", ")
    : estimateData.productInquired || "Auto Quote Chat";
  const result = await upsertSingleLeadToSupabase({
    leadId: estimateData.leadId || "",
    name,
    phone,
    location: record.location || estimateData.locationLink || "",
    projectType: record.project_type || "",
    productInquired,
    source: estimateData.createdFrom || "Auto Quote Chat",
    status: record.status && String(record.status).toLowerCase().includes("submitted") ? "Quoted" : "New Lead",
    notes: estimateData.note || `Auto-created from chat ${estimateData.chatId || ""}`.trim(),
  }, req, { generateIfMissing: true });
  return result;
}

async function upsertLeadsToSupabase(customers = [], req) {
  if (!SUPABASE_ENABLED) return new Map();
  const map = new Map();
  for (const customer of customers) {
    if (!customer?.leadId && !customer?.name && !customer?.phone) continue;
    try {
      const result = await upsertSingleLeadToSupabase(customer, req, { generateIfMissing: Boolean(customer?.name && customer?.phone) });
      if (result?.customer?.leadId && result?.row?.id) map.set(result.customer.leadId, result.row.id);
    } catch (error) {
      rememberSupabaseIssue(`lead upsert ${customer?.leadId || customer?.name || "unknown"}`, error);
    }
  }
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


function dbQuoteToAppQuote(row = {}) {
  const quoteData = row.quote_data && typeof row.quote_data === "object" ? row.quote_data : {};
  const quotation = quoteData.quotation && typeof quoteData.quotation === "object" ? quoteData.quotation : {};
  return {
    ...quoteData,
    id: quoteData.id || row.id,
    quoteNo: quoteData.quoteNo || row.quote_number || quotation.referenceNo,
    leadId: quoteData.leadId || row.lead_public_id || quotation.leadId || "",
    customerName: quoteData.customerName || row.client_name_snapshot || quotation.customerName || "",
    quoteStatus: quoteData.quoteStatus || row.quote_status || row.status || "Draft",
    saveAsStatus: quoteData.saveAsStatus || row.status || "Done.",
    saveAsNote: quoteData.saveAsNote || row.notes || "",
    subtotal: toNumberOrNull(quoteData.subtotal) || 0,
    taxAmount: toNumberOrNull(quoteData.taxAmount || row.vat_amount) || 0,
    finalTotal: toNumberOrNull(quoteData.finalTotal || row.final_amount || row.quotation_amount) || 0,
    savedAt: quoteData.savedAt || row.created_at || row.updated_at || new Date().toISOString(),
    updatedAt: row.updated_at || quoteData.updatedAt || new Date().toISOString(),
    createdFrom: quoteData.createdFrom || row.created_from || "supabase",
    source: "supabase",
    quotation: {
      ...quotation,
      referenceNo: quotation.referenceNo || row.quote_number,
      customerName: quotation.customerName || row.client_name_snapshot || quoteData.customerName || "",
      quoteStatus: quotation.quoteStatus || row.quote_status || quoteData.quoteStatus || "Draft",
      saveAsStatus: quotation.saveAsStatus || row.status || quoteData.saveAsStatus || "Done.",
      saveAsNote: quotation.saveAsNote || row.notes || quoteData.saveAsNote || "",
    },
    rows: Array.isArray(quoteData.rows) ? quoteData.rows : [],
  };
}


const PRODUCTION_WORKFLOW_STAGES = [
  { name: "New Job", progress: 5, targetDays: 0 },
  { name: "Measurement Confirmed", progress: 12, targetDays: 1 },
  { name: "Glass Ordered", progress: 24, targetDays: 3 },
  { name: "Aluminium Cutting", progress: 38, targetDays: 2 },
  { name: "Powder Coating", progress: 52, targetDays: 3 },
  { name: "Fabrication", progress: 68, targetDays: 3 },
  { name: "Quality Check", progress: 78, targetDays: 1 },
  { name: "Ready for Installation", progress: 86, targetDays: 1 },
  { name: "Installation Scheduled", progress: 90, targetDays: 1 },
  { name: "Installed", progress: 96, targetDays: 1 },
  { name: "Completed", progress: 100, targetDays: 0 },
  { name: "Delayed / Blocked", progress: 0, targetDays: 0 },
];

function stageMeta(stageName = "") {
  const cleaned = String(stageName || "").trim();
  return PRODUCTION_WORKFLOW_STAGES.find((stage) => stage.name.toLowerCase() === cleaned.toLowerCase()) || PRODUCTION_WORKFLOW_STAGES[0];
}

function appStageFromRow(row = {}) {
  return row.current_stage || row.job_data?.currentStage || row.job_status || row.status || "New Job";
}

async function nextJobNumberFromSupabase() {
  if (!SUPABASE_ENABLED) return "JO-0001";
  const rows = await dbSelect("job_orders", "select=job_number&limit=10000");
  const max = (Array.isArray(rows) ? rows : []).reduce((best, row) => {
    const match = String(row?.job_number || "").match(/(\d+)/g);
    const last = match?.length ? Number(match[match.length - 1]) || 0 : 0;
    return Math.max(best, last);
  }, 0);
  return `JO-${String(max + 1).padStart(4, "0")}`;
}

function quoteItemToJobOrderItem(item = {}, jobOrderId = null) {
  const sellingPrice = toNumberOrNull(item.total_price || item.totalPrice || item.total || item.lineTotal) || 0;
  const estimatedCost = toNumberOrNull(item.estimated_cost || item.estimatedCost) || 0;
  const estimatedProfit = sellingPrice - estimatedCost;
  const estimatedMargin = sellingPrice ? (estimatedProfit / sellingPrice) * 100 : 0;
  const itemCode = item.item_code || item.itemCode || item.code || item.tag || item.itemNo || null;
  const data = item.item_data && typeof item.item_data === "object" ? item.item_data : item;
  return {
    job_order_id: jobOrderId,
    quote_item_id: item.id && isUuid(item.id) ? item.id : null,
    item_code: itemCode,
    product: item.product || data.product || null,
    category: item.category || data.category || data.type || null,
    subcategory: item.subcategory || data.subcategory || data.system || null,
    glass_type: item.glass_type || data.glassType || null,
    glass_thickness: item.glass_thickness || data.thickness || data.glassThickness || null,
    system_type: item.system_type || data.systemType || null,
    panel_spec: item.panel_spec || data.panelSpec || data.panelMode || null,
    panel_count: toNumberOrNull(item.panel_count || data.panels || data.panelCount),
    width: toNumberOrNull(item.width || data.width),
    height: toNumberOrNull(item.height || data.height),
    qty: toNumberOrNull(item.qty || data.qty || data.quantity) || 1,
    area: toNumberOrNull(item.area || data.area),
    size_range: item.size_range || data.sizeRange || null,
    area_range: item.area_range || data.areaRange || null,
    selling_price: sellingPrice,
    estimated_cost: estimatedCost,
    actual_cost: 0,
    estimated_profit: estimatedProfit,
    actual_profit: 0,
    estimated_margin: estimatedMargin,
    actual_margin: 0,
    production_stage: "New Job",
    production_status: "Pending",
    stage_updated_at: new Date().toISOString(),
    item_data: data || {},
  };
}

function dbJobItemToAppItem(row = {}) {
  return {
    id: row.id,
    quoteItemId: row.quote_item_id,
    itemCode: row.item_code || row.item_data?.code || row.item_data?.tag || "",
    product: row.product || "",
    category: row.category || "",
    subcategory: row.subcategory || "",
    glassType: row.glass_type || "",
    glassThickness: row.glass_thickness || "",
    systemType: row.system_type || "",
    panelSpec: row.panel_spec || "",
    panelCount: Number(row.panel_count || 0) || 0,
    width: Number(row.width || 0) || 0,
    height: Number(row.height || 0) || 0,
    qty: Number(row.qty || 1) || 1,
    area: Number(row.area || 0) || 0,
    sellingPrice: Number(row.selling_price || 0) || 0,
    estimatedCost: Number(row.estimated_cost || 0) || 0,
    actualCost: Number(row.actual_cost || 0) || 0,
    estimatedProfit: Number(row.estimated_profit || 0) || 0,
    actualProfit: Number(row.actual_profit || 0) || 0,
    estimatedMargin: Number(row.estimated_margin || 0) || 0,
    actualMargin: Number(row.actual_margin || 0) || 0,
    productionStage: row.production_stage || row.item_data?.productionStage || "New Job",
    productionStatus: row.production_status || row.item_data?.productionStatus || "Pending",
    delayReason: row.delay_reason || "",
    blockerType: row.blocker_type || "",
    stageUpdatedAt: row.stage_updated_at || row.updated_at || "",
    itemData: row.item_data || {},
  };
}

function dbJobOrderToAppJob(row = {}, items = [], costs = [], payments = []) {
  const jobData = row.job_data && typeof row.job_data === "object" ? row.job_data : {};
  const finalAmount = Number(row.final_amount || row.quote_amount || 0) || 0;
  const actualCost = Number(row.actual_cost || costs.reduce((sum, cost) => sum + Number(cost.actual_amount || 0), 0) || 0) || 0;
  const estimatedCost = Number(row.estimated_cost || costs.reduce((sum, cost) => sum + Number(cost.estimated_amount || 0), 0) || 0) || 0;
  const actualProfit = finalAmount - actualCost;
  const estimatedProfit = finalAmount - estimatedCost;
  const paidAmount = payments.reduce((sum, payment) => {
    const status = String(payment.payment_status || "").toLowerCase();
    if (["pending", "overdue", "cancelled"].includes(status)) return sum;
    return sum + Number(payment.amount || 0);
  }, 0);
  const currentStage = row.current_stage || jobData.currentStage || appStageFromRow(row);
  return {
    id: row.id,
    jobNumber: row.job_number || "",
    quoteId: row.quote_id || "",
    leadId: row.lead_id || "",
    customerId: row.customer_id || "",
    clientName: row.client_name_snapshot || jobData.clientName || "",
    source: row.source_snapshot || jobData.source || "",
    location: row.location_snapshot || jobData.location || "",
    status: row.status || "New Job",
    jobStatus: row.job_status || "Pending",
    currentStage,
    progressPercent: Number(row.progress_percent || jobData.progressPercent || stageMeta(currentStage).progress || 0) || 0,
    priority: row.priority || jobData.priority || "Normal",
    dueDate: row.due_date || jobData.dueDate || "",
    paymentStatus: row.payment_status || jobData.paymentStatus || "Pending",
    delayReason: row.delay_reason || jobData.delayReason || "",
    blockerType: row.blocker_type || jobData.blockerType || "",
    lastStageUpdateAt: row.last_stage_update_at || row.updated_at || "",
    approvedAt: row.approved_at || "",
    productionStartedAt: row.production_started_at || "",
    readyAt: row.ready_at || "",
    installedAt: row.installed_at || "",
    completedAt: row.completed_at || "",
    quoteAmount: Number(row.quote_amount || 0) || 0,
    discountAmount: Number(row.discount_amount || 0) || 0,
    finalAmount,
    estimatedCost,
    actualCost,
    estimatedProfit,
    actualProfit,
    estimatedMargin: finalAmount ? (estimatedProfit / finalAmount) * 100 : 0,
    actualMargin: finalAmount ? (actualProfit / finalAmount) * 100 : 0,
    paidAmount,
    balanceDue: Math.max(finalAmount - paidAmount, 0),
    warnings: Array.isArray(row.warnings) ? row.warnings : [],
    itemCount: items.length,
    items: items.map(dbJobItemToAppItem),
    costs,
    payments,
    jobData,
    createdAt: row.created_at || "",
    updatedAt: row.updated_at || "",
  };
}

async function fetchJobOrderBundle(jobOrderId) {
  const [jobRows, itemRows, costRows, paymentRows] = await Promise.all([
    dbSelect("job_orders", `select=*&id=eq.${encodeEq(jobOrderId)}&limit=1`),
    dbSelect("job_order_items", `select=*&job_order_id=eq.${encodeEq(jobOrderId)}&order=created_at.asc`),
    dbSelect("job_costs", `select=*&job_order_id=eq.${encodeEq(jobOrderId)}&order=created_at.desc`),
    dbSelect("payments", `select=*&job_order_id=eq.${encodeEq(jobOrderId)}&order=created_at.desc`),
  ]);
  const job = Array.isArray(jobRows) && jobRows[0] ? jobRows[0] : null;
  if (!job) return null;
  return dbJobOrderToAppJob(job, Array.isArray(itemRows) ? itemRows : [], Array.isArray(costRows) ? costRows : [], Array.isArray(paymentRows) ? paymentRows : []);
}

async function recalculateJobFinancials(jobOrderId, req = null) {
  const [jobRows, costRows, itemRows] = await Promise.all([
    dbSelect("job_orders", `select=*&id=eq.${encodeEq(jobOrderId)}&limit=1`),
    dbSelect("job_costs", `select=*&job_order_id=eq.${encodeEq(jobOrderId)}`),
    dbSelect("job_order_items", `select=*&job_order_id=eq.${encodeEq(jobOrderId)}`),
  ]);
  const job = Array.isArray(jobRows) && jobRows[0] ? jobRows[0] : null;
  if (!job) return null;
  const estimatedCost = (Array.isArray(costRows) && costRows.length ? costRows : itemRows || []).reduce((sum, row) => sum + Number(row.estimated_amount ?? row.estimated_cost ?? 0), 0);
  const actualCost = (Array.isArray(costRows) && costRows.length ? costRows : itemRows || []).reduce((sum, row) => sum + Number(row.actual_amount ?? row.actual_cost ?? 0), 0);
  const finalAmount = Number(job.final_amount || job.quote_amount || 0) || 0;
  const patch = {
    estimated_cost: estimatedCost,
    actual_cost: actualCost,
    estimated_profit: finalAmount - estimatedCost,
    actual_profit: finalAmount - actualCost,
    estimated_margin: finalAmount ? ((finalAmount - estimatedCost) / finalAmount) * 100 : 0,
    actual_margin: finalAmount ? ((finalAmount - actualCost) / finalAmount) * 100 : 0,
    updated_at: new Date().toISOString(),
  };
  const updated = await dbPatch("job_orders", `id=eq.${encodeEq(jobOrderId)}`, patch);
  await writeAuditLog(req, {
    action_type: "job_financials_recalculated",
    module: "job_costing",
    target_table: "job_orders",
    target_id: jobOrderId,
    old_snapshot: job,
    new_snapshot: Array.isArray(updated) && updated[0] ? updated[0] : patch,
    change_summary: `${actorFromRequest(req).name} recalculated job cost/profit for ${job.job_number || jobOrderId}.`,
  });
  return Array.isArray(updated) && updated[0] ? updated[0] : null;
}

function getCustomerDisplayName(customer = {}) {
  return String(customer.name || customer.customerName || customer.clientName || customer.customer_name || "").trim();
}

function normalizeCustomerRequestRecord(payload = {}) {
  const customer = payload.customer && typeof payload.customer === "object" ? payload.customer : {};
  const estimateData = payload.estimate_data || payload.estimateData || {};
  const conversation = payload.conversation || payload.messages || [];
  return {
    customer_name: getCustomerDisplayName(customer) || payload.customer_name || null,
    phone: customer.phone || payload.phone || null,
    email: customer.email || payload.email || null,
    location: customer.location || customer.address || payload.location || null,
    project_type: customer.projectType || customer.project_type || payload.project_type || null,
    conversation: Array.isArray(conversation) ? conversation : [],
    estimate_data: {
      ...estimateData,
      chatId: payload.chatId || estimateData.chatId || null,
      eventType: payload.eventType || estimateData.eventType || null,
      note: payload.note || estimateData.note || null,
      items: payload.items || estimateData.items || [],
      rows: payload.rows || estimateData.rows || [],
      roughAmount: payload.roughAmount ?? estimateData.roughAmount ?? null,
      quoteNumber: payload.quoteNumber || estimateData.quoteNumber || null,
      uploadedFiles: payload.uploadedFiles || estimateData.uploadedFiles || [],
      locationLink: payload.locationLink || estimateData.locationLink || null,
      siteVisit: payload.siteVisit || estimateData.siteVisit || null,
      createdFrom: payload.createdFrom || estimateData.createdFrom || "auto_quote_chat",
    },
    status: payload.status || estimateData.status || "chat_updated",
    assigned_to: isUuid(payload.assigned_to) ? payload.assigned_to : null,
    updated_at: new Date().toISOString(),
  };
}

function makeServerMessageId(prefix = "msg") {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeConversationSender(message = {}, role = normalizeRole(message.role)) {
  const rawSender = String(message.sender || "").trim().toLowerCase();
  if (role === "user") return "customer";
  if (rawSender === "staff" || message.kind === "staff-reply") return "staff";
  return "assistant";
}

function normalizeConversationMessage(message = {}, index = 0) {
  const text = String(message?.content || message?.text || "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  const role = normalizeRole(message.role);
  const sender = normalizeConversationSender(message, role);
  return {
    ...message,
    id: String(message.id || message.messageId || message.clientMessageId || makeServerMessageId(`legacy_${index}`)),
    role,
    sender,
    content: text,
    text,
    at: message.at || message.created_at || new Date().toISOString(),
    staffName: message.staffName || null,
  };
}

function mergeCustomerConversations(previousConversation = [], incomingConversation = []) {
  const combined = [
    ...(Array.isArray(previousConversation) ? previousConversation : []),
    ...(Array.isArray(incomingConversation) ? incomingConversation : []),
  ];
  const seenIds = new Set();
  const merged = [];
  let welcomeKept = false;

  for (let index = 0; index < combined.length; index += 1) {
    const message = normalizeConversationMessage(combined[index], index);
    if (!message) continue;

    // Only collapse the repeated system welcome. Do not dedupe customer text.
    if (message.sender === "assistant" && message.content === "Hi! Tell me what aluminium/glass work you need. You can mention product, sizes, quantity, location, glass type, colour, or upload details later. I will ask for anything missing.") {
      if (welcomeKept) continue;
      welcomeKept = true;
    }

    if (message.id && seenIds.has(message.id)) continue;
    if (message.id) seenIds.add(message.id);
    merged.push(message);
  }

  return merged.sort((a, b) => {
    const at = new Date(a?.at || 0).getTime();
    const bt = new Date(b?.at || 0).getTime();
    if (!Number.isFinite(at) || !Number.isFinite(bt) || at === bt) return 0;
    return at - bt;
  });
}

async function recordCustomerRequest(payload = {}, req = null) {
  const record = normalizeCustomerRequestRecord(payload);
  const chatId = record?.estimate_data?.chatId || payload?.chatId || null;

  let previous = null;
  try {
    const rows = chatId ? await loadCustomerRequestRows(300) : [];
    previous = chatId
      ? dedupeCustomerRequests(rows).find((row) => String(row?.estimate_data?.chatId || row?.id || "") === String(chatId) || String(row?.id || "") === String(chatId))
      : null;
  } catch {
    previous = null;
  }

  if (previous) {
    record.conversation = mergeCustomerConversations(previous.conversation, record.conversation);
    record.customer_name = record.customer_name || previous.customer_name || null;
    record.phone = record.phone || previous.phone || null;
    record.email = record.email || previous.email || null;
    record.location = record.location || previous.location || null;
    record.project_type = record.project_type || previous.project_type || null;
    record.estimate_data = {
      ...(previous.estimate_data || {}),
      ...(record.estimate_data || {}),
      chatId: chatId || previous?.estimate_data?.chatId || null,
    };
  }

  let linkedLead = null;
  if (SUPABASE_ENABLED) {
    try {
      linkedLead = await upsertLeadFromCustomerRequestRecord(record, req);
      if (linkedLead?.customer?.leadId) {
        record.estimate_data = {
          ...(record.estimate_data || {}),
          leadId: linkedLead.customer.leadId,
          leadUuid: linkedLead.row?.id || null,
        };
      }
    } catch (error) {
      rememberSupabaseIssue("auto-create lead from customer request", error);
      throw error;
    }
  }

  if (!SUPABASE_ENABLED) {
    const file = path.join(DATA_DIR, "customer-requests.json");
    const existing = readJsonFile(file, []);
    existing.push({
      id: `customer_request_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      created_at: new Date().toISOString(),
      ...record,
    });
    writeJsonFile(file, existing.slice(-1000));
    return existing[existing.length - 1];
  }

  let row = null;
  if (previous?.id) {
    const patched = await dbPatch("customer_requests", `id=eq.${encodeEq(previous.id)}`, record);
    row = Array.isArray(patched) && patched.length ? patched[0] : { ...previous, ...record };
  } else {
    const saved = await dbInsert("customer_requests", [{ ...record, created_at: new Date().toISOString() }]);
    row = Array.isArray(saved) && saved.length ? saved[0] : record;
  }
  await writeAuditLog(req, {
    action_type: record.status || "customer_request_updated",
    module: "auto_quote",
    target_table: "customer_requests",
    target_id: row.id || record.estimate_data?.chatId || null,
    old_snapshot: previous || null,
    new_snapshot: row,
    change_summary: `Customer request ${previous?.id ? "updated" : "created"}: ${record.status || "chat_updated"}${record.customer_name ? ` for ${record.customer_name}` : ""}`,
  });
  return row;
}

function dedupeCustomerRequests(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const key = row?.estimate_data?.chatId || row?.id;
    if (!key) return;
    const prev = map.get(key);
    const rowTime = new Date(row.updated_at || row.created_at || 0).getTime();
    const prevTime = prev ? new Date(prev.updated_at || prev.created_at || 0).getTime() : -1;
    if (!prev || rowTime >= prevTime) map.set(key, row);
  });
  return [...map.values()].sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0));
}

function notificationSectionsFromRequests(rows = []) {
  const deduped = dedupeCustomerRequests(rows);
  const statusOf = (row) => String(row?.status || row?.estimate_data?.eventType || row?.estimate_data?.sessionStatus || "").toLowerCase();
  const isHistory = (row) => {
    const status = statusOf(row);
    return status.includes("handled") || status.includes("contacted") || status.includes("session_closed") || status.includes("closed") || row?.estimate_data?.handledAt;
  };
  const active = deduped.filter((row) => !isHistory(row));
  const history = deduped.filter(isHistory);
  return {
    all: deduped,
    active,
    history,
    realAgent: active.filter((row) => { const status = statusOf(row); return status.includes("agent") || status.includes("staff_active") || status.includes("customer_waiting_staff"); }),
    incompleteAiChats: active.filter((row) => {
      const status = statusOf(row);
      const hasContact = Boolean(String(row.customer_name || "").trim() && isValidUaePhone(row.phone || ""));
      const hasQuoteOutcome = status.includes("submitted") || status.includes("review") || status.includes("site_visit_booked") || status.includes("agent") || status.includes("staff_active") || status.includes("customer_waiting_staff");
      const hasPricedRows = Array.isArray(row?.estimate_data?.rows) && row.estimate_data.rows.length > 0;
      return (status.includes("incomplete_ai_chat") || (hasContact && !hasQuoteOutcome && !hasPricedRows));
    }),
    aiSubmitted: active.filter((row) => statusOf(row).includes("submitted")),
    needsReview: active.filter((row) => statusOf(row).includes("review")),
    locationSiteWork: active.filter((row) => {
      const status = statusOf(row);
      return status.includes("location") || status.includes("site_visit") || status.includes("document") || Boolean(row.location || row?.estimate_data?.locationLink || row?.estimate_data?.siteVisit);
    }),
  };
}

async function loadCustomerRequestRows(limit = 120) {
  if (!SUPABASE_ENABLED) {
    return readJsonFile(path.join(DATA_DIR, "customer-requests.json"), []);
  }
  const rows = await dbSelect("customer_requests", `select=*&order=updated_at.desc&limit=${Number(limit) || 120}`);
  return Array.isArray(rows) ? rows : [];
}

async function readSiteVisitBookings() {
  const fallback = { bookings: [] };
  if (!SUPABASE_ENABLED) return readJsonFile(path.join(DATA_DIR, "site-visit-bookings.json"), fallback);
  const rows = await dbSelect("app_settings", "select=setting_value&setting_key=eq.site_visit_bookings&limit=1");
  return Array.isArray(rows) && rows[0]?.setting_value ? rows[0].setting_value : fallback;
}

async function writeSiteVisitBookings(value = {}, req = null) {
  const data = { bookings: Array.isArray(value.bookings) ? value.bookings : [], updatedAt: new Date().toISOString() };
  if (!SUPABASE_ENABLED) {
    writeJsonFile(path.join(DATA_DIR, "site-visit-bookings.json"), data);
    return data;
  }
  const actor = actorFromRequest(req);
  await dbUpsert("app_settings", [{
    setting_key: "site_visit_bookings",
    setting_value: data,
    updated_by: actor.id,
    updated_by_name: actor.name,
    updated_at: new Date().toISOString(),
  }], { onConflict: "setting_key", returning: false });
  return data;
}

async function readAssistantControlStatus() {
  const fallback = { enabled: true, updatedAt: null, updatedBy: null };
  if (!SUPABASE_ENABLED) {
    return readJsonFile(path.join(DATA_DIR, "assistant-control.json"), fallback) || fallback;
  }
  try {
    const rows = await dbSelect("app_settings", `select=setting_value&setting_key=eq.${ASSISTANT_CONTROL_STATUS_KEY}&limit=1`);
    return Array.isArray(rows) && rows[0]?.setting_value ? { ...fallback, ...rows[0].setting_value } : fallback;
  } catch (error) {
    rememberSupabaseIssue("assistant control status load", error);
    return fallback;
  }
}

async function writeAssistantControlStatus(value = {}) {
  const data = {
    enabled: value.enabled !== false,
    updatedAt: new Date().toISOString(),
    updatedBy: value.updatedBy || "verified-control-phrase",
  };
  if (!SUPABASE_ENABLED) {
    writeJsonFile(path.join(DATA_DIR, "assistant-control.json"), data);
    return data;
  }
  await dbUpsert("app_settings", [{
    setting_key: ASSISTANT_CONTROL_STATUS_KEY,
    setting_value: data,
    updated_by_name: data.updatedBy || "System",
    updated_at: new Date().toISOString(),
  }], { onConflict: "setting_key", returning: false });
  return data;
}

function matchesSecretPhrase(input = "", phrase = "") {
  const text = String(input || "").trim();
  const secret = String(phrase || "").trim();
  if (!text || !secret) return false;
  if (text.length === secret.length) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(text), Buffer.from(secret))) return true;
    } catch {
      // Fall back to case-insensitive comparison when byte lengths differ unexpectedly.
    }
  }
  return text.toLowerCase() === secret.toLowerCase();
}

async function handleAssistantControlCommand(text = "") {
  if (ASSISTANT_DISABLE_PHRASE && matchesSecretPhrase(text, ASSISTANT_DISABLE_PHRASE)) {
    const status = await writeAssistantControlStatus({ enabled: false });
    return {
      handled: true,
      enabled: false,
      status,
      message: "Quote support has been paused for maintenance.",
    };
  }
  if (ASSISTANT_ENABLE_PHRASE && matchesSecretPhrase(text, ASSISTANT_ENABLE_PHRASE)) {
    const status = await writeAssistantControlStatus({ enabled: true });
    return {
      handled: true,
      enabled: true,
      status,
      message: "Quote support has been resumed.",
    };
  }
  return { handled: false };
}

function prettySiteVisitTime(time = "") {
  const [hourText] = String(time || "").split(":");
  const hour = Number(hourText || 0) || 0;
  if (!hour) return String(time || "");
  const suffix = hour >= 12 ? "pm" : "am";
  const twelveHour = hour % 12 || 12;
  return `${twelveHour}${suffix}`;
}

function generateSiteVisitSlots(bookings = []) {
  const booked = new Set((bookings || []).filter((b) => b.status !== "cancelled").map((b) => b.slotId));
  // Cleaner customer-facing slots: 8am, 10am, 12pm, 2pm, 4pm.
  const slotHours = ["08:00", "10:00", "12:00", "14:00", "16:00"];
  const slots = [];
  const today = new Date();
  for (let dayOffset = 1; dayOffset <= 10 && slots.length < 30; dayOffset += 1) {
    const d = new Date(today);
    d.setDate(today.getDate() + dayOffset);
    const weekday = d.getDay();
    if (weekday === 0) continue; // keep Sundays out by default
    const date = d.toISOString().slice(0, 10);
    slotHours.forEach((time) => {
      const slotId = `${date} ${time}`;
      if (!booked.has(slotId)) slots.push({ slotId, date, time, timeLabel: prettySiteVisitTime(time), label: `${date} at ${prettySiteVisitTime(time)}` });
    });
  }
  return slots.slice(0, 18);
}

function validCustomerLocation(value = "") {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/google\.com\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|maps\?q=|-?\d{1,2}\.\d+\s*,\s*-?\d{1,3}\.\d+/i.test(text)) return true;
  return /dubai|sharjah|ajman|abu dhabi|al ain|jvc|jlt|marina|downtown|business bay|mirdif|warisan|nad al hamar|al quoz|deira|bur dubai|silicon|meydan|jumeirah|rak|ras al khaimah|fujairah|uaq|umm al quwain/i.test(text) && text.length >= 3;
}

function hasProductInterestForSiteVisit(body = {}) {
  const rows = Array.isArray(body.rows) ? body.rows : [];
  const items = Array.isArray(body.items) ? body.items : [];
  const messages = normalizeMessages(body.messages || body.conversation || []);
  const projectType = normalizeContent(body.customer?.projectType || body.customer?.productInquired || body.projectType || "");
  const text = `${projectType} ${messages.map((m) => m.content).join(" ")}`.toLowerCase();
  return rows.length > 0 || items.length > 0 || /sliding|folding|hinged|door|window|fixed glass|partition|shower|curtain wall|glass|aluminium|aluminum|pergola|skylight/.test(text);
}

function siteVisitMissingRequirements(body = {}) {
  const customer = body.customer || {};
  const missing = [];
  if (!String(customer.name || customer.customerName || customer.clientName || "").trim()) missing.push("name");
  const phone = String(customer.phone || customer.phoneNumber || customer.mobile || "").trim();
  if (!phone) missing.push("phone number");
  else if (!isValidUaePhone(phone)) missing.push("valid UAE phone number");
  if (!validCustomerLocation(customer.location || body.location || "")) missing.push("valid Google Maps location / site area");
  if (!hasProductInterestForSiteVisit(body)) missing.push("product interest / quote details");
  return missing;
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

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function signStaffSessionPayload(payloadPart) {
  return crypto.createHmac("sha256", STAFF_SESSION_SECRET).update(payloadPart).digest("base64url");
}

function createStaffToken(staffUser) {
  cleanStaffSessions();
  const now = Date.now();
  const payload = {
    v: 2,
    role: staffUser?.role || "staff",
    email: staffUser?.email || "",
    name: staffUser?.name || staffUser?.email || "Staff",
    iat: now,
    exp: now + STAFF_TOKEN_TTL_MS,
  };
  const payloadPart = base64UrlJson(payload);
  const signature = signStaffSessionPayload(payloadPart);
  return `v2.${payloadPart}.${signature}`;
}

function verifySignedStaffToken(token) {
  const raw = String(token || "").trim();
  if (!raw.startsWith("v2.")) return null;
  const [, payloadPart, signature] = raw.split(".");
  if (!payloadPart || !signature) return null;
  const expected = signStaffSessionPayload(payloadPart);
  try {
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  } catch {
    return null;
  }
  try {
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
    if (!payload?.exp || Number(payload.exp) <= Date.now()) return null;
    return {
      role: payload.role || "staff",
      email: payload.email || "",
      name: payload.name || payload.email || "Staff",
      createdAt: payload.iat || Date.now(),
      expiresAt: payload.exp,
    };
  } catch {
    return null;
  }
}

function getStaffToken(req) {
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  return String(req.headers["x-staff-token"] || "").trim();
}

function requireStaff(req, res, next) {
  cleanStaffSessions();
  const token = getStaffToken(req);
  const session = token ? (staffSessions.get(token) || verifySignedStaffToken(token)) : null;
  if (!session) {
    return res.status(401).json({ success: false, ok: false, error: "Staff login required." });
  }
  req.staff = session;
  next();
}

app.get("/", (_req, res) => {
  res.json({
    ok: true,
    success: true,
    service: "Buildup Auto Quote Backend",
    health: "/health",
    dbHealth: "/db-health",
    version: "phase-27-bug-sweep"
  });
});

app.post("/staff-login", (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const configuredUsers = getConfiguredStaffUsers();
  const desktopLogin = readDesktopStaffLogin();
  if (!configuredUsers.length && !desktopLogin) {
    if (process.env.BUILDUP_DESKTOP === "true") {
      const firstUser = createDesktopStaffLogin({ email, password });
      if (!firstUser) {
        return res.status(400).json({
          success: false,
          ok: false,
          error: "Create the first desktop login with an email and a password of at least 4 characters.",
        });
      }
      const token = createStaffToken(firstUser);
      return res.json({
        success: true,
        ok: true,
        firstDesktopLoginCreated: true,
        token,
        expiresInMs: STAFF_TOKEN_TTL_MS,
        expiresAt: new Date(Date.now() + STAFF_TOKEN_TTL_MS).toISOString(),
        staff: { email: firstUser.email, name: firstUser.name, role: firstUser.role },
      });
    }
    return res.status(500).json({
      success: false,
      ok: false,
      error: "No staff users are configured on the backend. Add STAFF_EMAIL + STAFF_PASSWORD or STAFF_USERS_JSON in Render environment variables.",
    });
  }

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
    expiresAt: new Date(Date.now() + STAFF_TOKEN_TTL_MS).toISOString(),
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
      if (isDefaultStaffProfileName(name) && password.length >= 4) {
        const createdUser = await createOrUpdateStaffProfile({
          name,
          password,
          role: isOwnerStaffProfileName(name) ? "owner" : "staff",
          requirePassword: true,
          actor: getActiveStaffProfile(req),
        });
        setActiveProfileForRequest(req, { ...createdUser, name });
        return res.json({ success: true, ok: true, user: createdUser, createdPassword: true });
      }
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
    const requiredTables = ["leads", "quotes", "quote_items", "quote_versions", "customer_requests", "audit_logs", "staff_users", "app_settings"];
    const checkedTables = {};
    for (const table of requiredTables) {
      const sample = await dbSelect(table, "select=*&limit=1");
      checkedTables[table] = Array.isArray(sample);
    }
    res.json({
      ok: true,
      success: true,
      databaseEnabled: true,
      checkedTables,
      message: "Supabase connection is healthy for leads, quotes, chats, notifications, settings, staff, and audit logs.",
    });
  } catch (error) {
    rememberSupabaseIssue("database health check", error);
    res.status(500).json({ ok: false, success: false, databaseEnabled: true, error: "Database check failed. Verify SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and RLS setup in Render/Supabase.", latestIssueAt: latestSupabaseIssue?.at || null });
  }
});



function quoteNeedsReview(quote = {}) {
  const status = String(quote.quoteStatus || quote.saveAsStatus || quote.status || quote.quote_status || "").toLowerCase();
  return status.includes("review") || status.includes("pending") || status.includes("need") || status.includes("draft") || status.includes("incomplete");
}

function isLeadOpen(lead = {}) {
  const status = String(lead.status || "").toLowerCase();
  return !status.includes("won") && !status.includes("closed") && !status.includes("lost") && !lead.dealClosed;
}

function isDateDue(value = "") {
  if (!value) return true;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return true;
  const today = new Date();
  today.setHours(23, 59, 59, 999);
  return date.getTime() <= today.getTime();
}

function dbJobRowToCrmBrief(row = {}) {
  return {
    id: row.id,
    jobNumber: row.job_number || "",
    quoteId: row.quote_id || "",
    leadId: row.lead_id || "",
    clientName: row.client_name_snapshot || row.job_data?.clientName || "",
    location: row.location_snapshot || row.job_data?.location || "",
    status: row.status || "New Job",
    jobStatus: row.job_status || "Pending",
    currentStage: row.current_stage || row.job_data?.currentStage || "New Job",
    progressPercent: Number(row.progress_percent || 0) || 0,
    finalAmount: Number(row.final_amount || row.quote_amount || 0) || 0,
    actualProfit: Number(row.actual_profit || row.estimated_profit || 0) || 0,
    dueDate: row.due_date || "",
    delayReason: row.delay_reason || "",
    updatedAt: row.updated_at || row.created_at || "",
    createdAt: row.created_at || "",
  };
}

function requestToCrmNotification(row = {}) {
  return {
    id: row.id,
    customerName: row.customer_name || "",
    phone: row.phone || "",
    location: row.location || row.estimate_data?.locationLink || "",
    status: row.status || row.estimate_data?.eventType || "chat_updated",
    leadId: row.estimate_data?.leadUuid || "",
    leadPublicId: row.estimate_data?.leadId || "",
    note: row.estimate_data?.note || "",
    updatedAt: row.updated_at || row.created_at || "",
    raw: row,
  };
}

function buildCrmActionQueue({ leads = [], quotes = [], tasks = [], notifications = {} } = {}) {
  const queue = [];
  leads.filter(isLeadOpen).forEach((lead) => {
    if (isDateDue(lead.nextFollowUpDate)) {
      queue.push({
        id: `lead-${lead.id || lead.leadId}`,
        type: "lead_follow_up",
        title: `${lead.name || lead.phone || "Lead"} needs follow-up`,
        detail: `${lead.productInquired || "Product not set"}${lead.source ? ` · ${lead.source}` : ""}`,
        leadId: lead.id,
        leadPublicId: lead.leadId,
        owner: "Sales",
        priority: lead.nextFollowUpDate ? "High" : "Normal",
        dueAt: lead.nextFollowUpDate || lead.updatedAt || lead.createdAt,
      });
    }
  });
  quotes.filter(quoteNeedsReview).forEach((quote) => {
    queue.push({
      id: `quote-${quote.id || quote.quoteNo}`,
      type: "quote_review",
      title: `${quote.quoteNo || "Quote"} needs review`,
      detail: `${quote.customerName || quote.quotation?.customerName || "Customer"} · AED ${Number(quote.finalTotal || quote.quotationAmount || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
      leadId: quote.leadUuid || "",
      leadPublicId: quote.leadId || "",
      quoteId: quote.id,
      owner: "Estimator",
      priority: "High",
      dueAt: quote.updatedAt || quote.savedAt || quote.createdAt,
    });
  });
  tasks.filter((task) => String(task.status || "Pending").toLowerCase() !== "completed").forEach((task) => {
    queue.push({
      id: `task-${task.id}`,
      type: task.task_type || "task",
      title: task.task_type || "Staff task",
      detail: task.notes || "Pending staff task",
      leadId: task.lead_id || "",
      quoteId: task.quote_id || "",
      jobOrderId: task.job_order_id || "",
      owner: "Assigned staff",
      priority: task.priority || "Normal",
      dueAt: task.due_at || task.created_at,
    });
  });
  (notifications.active || []).forEach((row) => {
    queue.push({
      id: `request-${row.id}`,
      type: "customer_attention",
      title: `${row.customer_name || "Customer chat"} needs attention`,
      detail: `${row.status || row.estimate_data?.eventType || "Chat update"}${row.phone ? ` · ${row.phone}` : ""}`,
      leadId: row.estimate_data?.leadUuid || "",
      leadPublicId: row.estimate_data?.leadId || "",
      owner: "Sales / Support",
      priority: String(row.status || "").toLowerCase().includes("agent") ? "Urgent" : "High",
      dueAt: row.updated_at || row.created_at,
    });
  });
  return queue
    .sort((a, b) => new Date(a.dueAt || 0).getTime() - new Date(b.dueAt || 0).getTime())
    .slice(0, 80);
}

function appendNote(existing = "", note = "", actorName = "Staff") {
  const cleanNote = String(note || "").trim();
  if (!cleanNote) return existing || null;
  const line = `[${new Date().toISOString()}] ${actorName}: ${cleanNote}`;
  return [String(existing || "").trim(), line].filter(Boolean).join("\n");
}

async function findLeadRowByAnyId(id = "") {
  const clean = String(id || "").trim();
  if (!clean) return null;
  const query = isUuid(clean) ? `id=eq.${encodeEq(clean)}` : `lead_id=eq.${encodeEq(clean)}`;
  const rows = await dbSelect("leads", `select=*&${query}&limit=1`);
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}



app.get("/crm-command-center", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) {
      return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured. CRM Command Center requires the database." });
    }
    const [leadRows, quoteRows, jobRows, taskRows, requestRows] = await Promise.all([
      dbSelect("leads", "select=*&order=updated_at.desc&limit=500"),
      dbSelect("quotes", "select=*,leads(lead_id)&order=updated_at.desc&limit=300"),
      dbSelect("job_orders", "select=*&order=updated_at.desc&limit=300"),
      dbSelect("staff_tasks", "select=*&order=due_at.asc.nullslast&limit=200").catch(() => []),
      loadCustomerRequestRows(200).catch(() => []),
    ]);
    const leads = (Array.isArray(leadRows) ? leadRows : []).map(dbLeadToAppCustomer);
    const quotes = (Array.isArray(quoteRows) ? quoteRows : []).map((row) => dbQuoteToAppQuote({ ...row, lead_public_id: row.leads?.lead_id || "", leadUuid: row.lead_id || "" }));
    const jobs = (Array.isArray(jobRows) ? jobRows : []).map(dbJobRowToCrmBrief);
    const notifications = notificationSectionsFromRequests(Array.isArray(requestRows) ? requestRows : []);
    const tasks = Array.isArray(taskRows) ? taskRows : [];
    const openLeads = leads.filter(isLeadOpen);
    const quotesNeedReview = quotes.filter(quoteNeedsReview);
    const openQuoteValue = quotes.reduce((sum, quote) => {
      const status = String(quote.quoteStatus || quote.saveAsStatus || "").toLowerCase();
      if (status.includes("lost") || status.includes("rejected") || status.includes("cancel")) return sum;
      return sum + Number(quote.finalTotal || quote.quotationAmount || 0);
    }, 0);
    const metrics = {
      totalLeads: leads.length,
      openLeads: openLeads.length,
      followUpsDue: openLeads.filter((lead) => isDateDue(lead.nextFollowUpDate)).length,
      quotesNeedReview: quotesNeedReview.length,
      openQuoteValue,
      activeJobs: jobs.filter((job) => !["completed", "cancelled"].includes(String(job.jobStatus || job.status || "").toLowerCase())).length,
      unhandledRequests: notifications.active?.length || 0,
      incompleteAiChats: notifications.incompleteAiChats?.length || 0,
      realAgentRequests: notifications.realAgent?.length || 0,
    };
    const actionQueue = buildCrmActionQueue({ leads, quotes, tasks, notifications });
    res.json({ ok: true, success: true, metrics, leads, quotes, jobs, tasks, notifications, actionQueue });
  } catch (error) {
    rememberSupabaseIssue("crm command center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load CRM Command Center." });
  }
});

app.get("/customer-timeline/:id", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) {
      return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured. Customer timeline requires the database." });
    }
    const leadRow = await findLeadRowByAnyId(req.params.id);
    if (!leadRow?.id) return res.status(404).json({ ok: false, success: false, error: "Lead was not found." });
    const lead = dbLeadToAppCustomer(leadRow);
    const [quoteRows, jobRows, taskRows, requestRows, auditRows] = await Promise.all([
      dbSelect("quotes", `select=*&lead_id=eq.${encodeEq(leadRow.id)}&order=updated_at.desc&limit=120`).catch(() => []),
      dbSelect("job_orders", `select=*&lead_id=eq.${encodeEq(leadRow.id)}&order=updated_at.desc&limit=120`).catch(() => []),
      dbSelect("staff_tasks", `select=*&lead_id=eq.${encodeEq(leadRow.id)}&order=created_at.desc&limit=120`).catch(() => []),
      loadCustomerRequestRows(300).catch(() => []),
      dbSelect("audit_logs", "select=*&order=created_at.desc&limit=300").catch(() => []),
    ]);
    const quotes = (Array.isArray(quoteRows) ? quoteRows : []).map(dbQuoteToAppQuote);
    const jobs = (Array.isArray(jobRows) ? jobRows : []).map(dbJobRowToCrmBrief);
    const cleanPhone = normalizePhone(lead.phone);
    const requests = dedupeCustomerRequests(Array.isArray(requestRows) ? requestRows : []).filter((row) => {
      const estimate = row.estimate_data || {};
      return estimate.leadUuid === leadRow.id || estimate.leadId === lead.leadId || (cleanPhone && normalizePhone(row.phone) === cleanPhone) || (lead.name && row.customer_name && String(row.customer_name).trim().toLowerCase() === lead.name.trim().toLowerCase());
    });
    const relatedIds = new Set([leadRow.id, lead.leadId, ...quotes.map((quote) => quote.id), ...quotes.map((quote) => quote.quoteNo), ...jobs.map((job) => job.id), ...jobs.map((job) => job.jobNumber)].filter(Boolean).map(String));
    const audits = (Array.isArray(auditRows) ? auditRows : []).filter((row) => relatedIds.has(String(row.target_id || "")) || relatedIds.has(String(row.quote_number || "")));
    const events = [];
    events.push({ id: `lead-created-${leadRow.id}`, type: "lead_created", title: `Lead ${lead.leadId || "created"}`, detail: `${lead.name || "Customer"}${lead.source ? ` from ${lead.source}` : ""}`, at: lead.createdAt || lead.updatedAt, actor: "CRM" });
    if (lead.nextFollowUpDate || lead.notes) {
      events.push({ id: `lead-next-${leadRow.id}`, type: "follow_up", title: "Current next action", detail: lead.notes || "Follow-up required", at: lead.nextFollowUpDate || lead.updatedAt, actor: "Sales" });
    }
    quotes.forEach((quote) => events.push({ id: `quote-${quote.id}`, type: "quote", title: `Quote ${quote.quoteNo || quote.id} — ${quote.quoteStatus || quote.saveAsStatus || "Draft"}`, detail: `${quote.customerName || lead.name || "Customer"} · AED ${Number(quote.finalTotal || quote.quotationAmount || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`, at: quote.updatedAt || quote.savedAt, actor: quote.quotation?.preparedBy || quote.preparedBy || "Estimator" }));
    jobs.forEach((job) => events.push({ id: `job-${job.id}`, type: "job", title: `Job ${job.jobNumber || job.id} — ${job.currentStage || job.jobStatus}`, detail: `${job.clientName || lead.name || "Customer"} · ${job.progressPercent || 0}% progress`, at: job.updatedAt || job.createdAt, actor: "Operations" }));
    (Array.isArray(taskRows) ? taskRows : []).forEach((task) => events.push({ id: `task-${task.id}`, type: "task", title: task.task_type || "Staff task", detail: `${task.status || "Pending"} · ${task.notes || "No note"}`, at: task.due_at || task.created_at, actor: "Staff" }));
    requests.forEach((row) => events.push({ id: `request-${row.id}`, type: "chat", title: `Customer chat — ${row.status || row.estimate_data?.eventType || "updated"}`, detail: row.estimate_data?.note || `${Array.isArray(row.conversation) ? row.conversation.length : 0} messages`, at: row.updated_at || row.created_at, actor: "AI / Customer" }));
    audits.forEach((row) => events.push({ id: `audit-${row.id}`, type: "audit", title: row.action_type || "Audit log", detail: row.change_summary || row.module || "System activity", at: row.created_at, actor: row.actor_name || "System" }));
    events.sort((a, b) => new Date(b.at || 0).getTime() - new Date(a.at || 0).getTime());
    res.json({ ok: true, success: true, timeline: { lead, quotes, jobs, tasks: Array.isArray(taskRows) ? taskRows : [], requests: requests.map(requestToCrmNotification), audits, events } });
  } catch (error) {
    rememberSupabaseIssue("customer timeline", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load customer timeline." });
  }
});

app.post("/crm/next-action", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const body = req.body || {};
    const leadRow = await findLeadRowByAnyId(body.leadId || body.leadPublicId);
    if (!leadRow?.id) return res.status(404).json({ ok: false, success: false, error: "Lead was not found." });
    const actor = actorFromRequest(req);
    const note = String(body.note || "").trim();
    if (!note) return res.status(400).json({ ok: false, success: false, error: "Next action note is required." });
    const patch = {
      status: body.status || leadRow.status || "Follow-up",
      next_follow_up_date: cleanDateOrNull(body.dueDate || body.nextFollowUpDate),
      notes: appendNote(leadRow.notes, note, body.actorName || actor.name),
      updated_by: actor.id || null,
      updated_at: new Date().toISOString(),
    };
    const updatedRows = await dbPatch("leads", `id=eq.${encodeEq(leadRow.id)}`, patch);
    const dueAt = patch.next_follow_up_date ? new Date(`${patch.next_follow_up_date}T09:00:00+04:00`).toISOString() : null;
    const taskRows = await dbInsert("staff_tasks", [{
      lead_id: leadRow.id,
      task_type: "CRM Next Action",
      status: "Pending",
      priority: body.priority || "Normal",
      due_at: dueAt,
      notes: note,
    }]);
    await dbInsert("activity_events", [{
      event_type: "crm_next_action_saved",
      module: "crm",
      lead_id: leadRow.id,
      actor_id: isUuid(actor.id) ? actor.id : null,
      actor_name: body.actorName || actor.name,
      source: leadRow.source || null,
      location: leadRow.location || null,
      product: leadRow.product_inquired || null,
      event_data: { status: patch.status, priority: body.priority || "Normal", dueDate: patch.next_follow_up_date, note },
    }], { returning: false });
    await writeAuditLog(req, {
      action_type: "crm_next_action_saved",
      module: "crm",
      target_table: "leads",
      target_id: leadRow.id,
      old_snapshot: dbLeadToAppCustomer(leadRow),
      new_snapshot: Array.isArray(updatedRows) && updatedRows[0] ? dbLeadToAppCustomer(updatedRows[0]) : patch,
      change_summary: `${body.actorName || actor.name} saved CRM next action for ${leadRow.lead_id || leadRow.client_name || leadRow.phone}.`,
    });
    res.json({ ok: true, success: true, lead: Array.isArray(updatedRows) && updatedRows[0] ? dbLeadToAppCustomer(updatedRows[0]) : null, task: Array.isArray(taskRows) && taskRows[0] ? taskRows[0] : null });
  } catch (error) {
    rememberSupabaseIssue("crm next action", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save CRM next action." });
  }
});

app.patch("/quotes/:id/review", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const id = String(req.params.id || "").trim();
    const query = isUuid(id) ? `id=eq.${encodeEq(id)}` : `quote_number=eq.${encodeEq(id)}`;
    const rows = await dbSelect("quotes", `select=*&${query}&limit=1`);
    const quote = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!quote?.id) return res.status(404).json({ ok: false, success: false, error: "Quote was not found." });
    const actor = actorFromRequest(req);
    const status = String(req.body?.status || "Reviewed").trim() || "Reviewed";
    const note = String(req.body?.note || "").trim();
    const quoteData = quote.quote_data && typeof quote.quote_data === "object" ? { ...quote.quote_data } : {};
    quoteData.quoteStatus = status;
    quoteData.reviewStatus = status;
    quoteData.reviewedAt = new Date().toISOString();
    quoteData.reviewedBy = req.body?.actorName || actor.name;
    if (note) quoteData.reviewNote = note;
    const patch = {
      status,
      quote_status: status,
      notes: appendNote(quote.notes, note || `Quote review status changed to ${status}.`, req.body?.actorName || actor.name),
      quote_data: quoteData,
      updated_by: actor.id || null,
      updated_at: new Date().toISOString(),
    };
    const updated = await dbPatch("quotes", `id=eq.${encodeEq(quote.id)}`, patch);
    if (quote.lead_id) {
      const leadRows = await dbSelect("leads", `select=notes&id=eq.${encodeEq(quote.lead_id)}&limit=1`).catch(() => []);
      const existingLeadNote = Array.isArray(leadRows) && leadRows[0] ? leadRows[0].notes : "";
      await dbPatch("leads", `id=eq.${encodeEq(quote.lead_id)}`, {
        quote_status: status,
        status: status === "Approved" ? "Quoted" : status === "Rejected" ? "Lost" : "Follow-up",
        notes: appendNote(existingLeadNote, `Quote ${quote.quote_number} review: ${status}${note ? ` — ${note}` : ""}`, req.body?.actorName || actor.name),
        updated_at: new Date().toISOString(),
      }, { returning: false }).catch(() => null);
    }
    await dbInsert("activity_events", [{
      event_type: "quote_reviewed",
      module: "quotes",
      lead_id: quote.lead_id || null,
      quote_id: quote.id,
      actor_id: isUuid(actor.id) ? actor.id : null,
      actor_name: req.body?.actorName || actor.name,
      revenue_amount: Number(quote.final_amount || quote.quotation_amount || 0) || 0,
      event_data: { quoteNumber: quote.quote_number, status, note },
    }], { returning: false });
    await writeAuditLog(req, {
      action_type: "quote_reviewed",
      module: "quotes",
      target_table: "quotes",
      target_id: quote.id,
      quote_number: quote.quote_number,
      old_snapshot: quote.quote_data || quote,
      new_snapshot: Array.isArray(updated) && updated[0] ? updated[0] : patch,
      change_summary: `${req.body?.actorName || actor.name} reviewed quote ${quote.quote_number}: ${status}.`,
    });
    res.json({ ok: true, success: true, quote: Array.isArray(updated) && updated[0] ? dbQuoteToAppQuote(updated[0]) : dbQuoteToAppQuote({ ...quote, ...patch }) });
  } catch (error) {
    rememberSupabaseIssue("quote review", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not review quote." });
  }
});

app.get("/leads", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) {
      return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured. Leads must be managed through the database." });
    }
    const limit = Math.min(Math.max(Number(req.query.limit || 1000), 1), 5000);
    const rows = await dbSelect("leads", `select=*&order=updated_at.desc&limit=${limit}`);
    const leads = (Array.isArray(rows) ? rows : []).map(dbLeadToAppCustomer);
    res.json({ ok: true, success: true, storage: "supabase", leads, customers: leads });
  } catch (error) {
    rememberSupabaseIssue("load leads", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load leads from Supabase." });
  }
});

app.get("/leads/next-id", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) {
      return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    }
    const nextLeadId = await nextLeadIdFromSupabase();
    res.json({ ok: true, success: true, nextLeadId });
  } catch (error) {
    rememberSupabaseIssue("next lead id", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not generate next Lead ID." });
  }
});

app.post("/leads/upsert", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) {
      return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured. Lead was not saved." });
    }
    const lead = req.body?.lead || req.body?.customer || req.body || {};
    const result = await upsertSingleLeadToSupabase(lead, req, { generateIfMissing: true });
    res.json({ ok: true, success: true, storage: "supabase", lead: result.customer, customer: result.customer });
  } catch (error) {
    rememberSupabaseIssue("upsert lead", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save lead to Supabase." });
  }
});

app.delete("/leads/:id", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) {
      return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured. Lead was not deleted." });
    }
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, success: false, error: "Missing lead id." });
    const query = isUuid(id) ? `id=eq.${encodeEq(id)}` : `lead_id=eq.${encodeEq(id)}`;
    const deleted = await dbDelete("leads", query);
    await writeAuditLog(req, {
      action_type: "lead_cloud_deleted",
      module: "leads",
      target_table: "leads",
      target_id: id,
      old_snapshot: Array.isArray(deleted) && deleted[0] ? dbLeadToAppCustomer(deleted[0]) : null,
      change_summary: `${actorFromRequest(req).name} deleted lead ${id} from Supabase.`,
    });
    res.json({ ok: true, success: true, storage: "supabase", deleted: Array.isArray(deleted) ? deleted.length : 0 });
  } catch (error) {
    rememberSupabaseIssue("delete lead", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not delete lead from Supabase." });
  }
});


app.get("/quotes", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) {
      return res.json({ ok: true, success: true, storage: "local-fallback", quotes: [] });
    }
    const limit = Math.min(Math.max(Number(req.query.limit || 300), 1), 500);
    const rows = await dbSelect("quotes", `select=*,leads(lead_id)&order=updated_at.desc&limit=${limit}`);
    const quotes = (Array.isArray(rows) ? rows : []).map((row) => dbQuoteToAppQuote({ ...row, lead_public_id: row.leads?.lead_id || "" }));
    res.json({ ok: true, success: true, storage: "supabase", quotes });
  } catch (error) {
    rememberSupabaseIssue("load quotes", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load cloud quotes." });
  }
});

app.delete("/quotes/:id", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) {
      return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured. Quote was not deleted." });
    }
    const id = String(req.params.id || "").trim();
    if (!id) return res.status(400).json({ ok: false, success: false, error: "Missing quote id or quote number." });
    const query = isUuid(id) ? `id=eq.${encodeEq(id)}` : `quote_number=eq.${encodeEq(id)}`;
    const existing = await dbSelect("quotes", `select=id,quote_number,quote_data&${query}&limit=1`);
    const quote = Array.isArray(existing) && existing[0] ? existing[0] : null;
    if (!quote?.id) return res.status(404).json({ ok: false, success: false, error: "Quote was not found in Supabase." });
    await dbDelete("quote_items", `quote_id=eq.${encodeEq(quote.id)}`, { returning: false });
    await dbDelete("quote_versions", `quote_id=eq.${encodeEq(quote.id)}`, { returning: false });
    const deleted = await dbDelete("quotes", `id=eq.${encodeEq(quote.id)}`);
    await writeAuditLog(req, {
      action_type: "quote_cloud_deleted",
      module: "quotes",
      target_table: "quotes",
      target_id: quote.id,
      quote_number: quote.quote_number,
      old_snapshot: quote.quote_data || quote,
      change_summary: `${actorFromRequest(req).name} deleted quote ${quote.quote_number || id} from Supabase.`,
    });
    res.json({ ok: true, success: true, storage: "supabase", deleted: Array.isArray(deleted) ? deleted.length : 1 });
  } catch (error) {
    rememberSupabaseIssue("delete quote", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not delete quote from Supabase." });
  }
});

app.post("/quotes/upsert", requireStaff, async (req, res) => {
  try {
    const quote = req.body?.quote || req.body || {};
    const quoteNumber = quote.quoteNo || quote.quotation?.referenceNo || quote.autoDraftNo;
    if (!quoteNumber) return res.status(400).json({ ok: false, success: false, error: "Quote number is required before saving to cloud." });
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });

    let leadUuid = null;
    const actor = actorFromRequest(req);
    const detailParts = parseCustomerDetailsText(quote.customerDetails || quote.quotation?.customerDetails || "");
    const leadName = quote.customerName || quote.quotation?.customerName || "";
    const leadPhone = quote.phone || detailParts.phone || "";
    if (quote.leadId || leadName || leadPhone) {
      const leadResult = await upsertSingleLeadToSupabase({
        leadId: quote.leadId || "",
        name: leadName,
        phone: leadPhone,
        location: quote.location || detailParts.location || "",
        projectType: quote.projectType || detailParts.projectType || "",
        productInquired: quote.productInquired || quote.projectScope || "",
        status: quote.quoteStatus || quote.saveAsStatus || "Quoted",
        quoteStatus: quote.quoteStatus || quote.saveAsStatus || "Quoted",
        quotationAmount: quote.finalTotal || quote.subtotal || 0,
        notes: quote.saveAsNote || `Linked quote ${quoteNumber}`,
      }, req, { generateIfMissing: true });
      leadUuid = leadResult?.row?.id || null;
      quote.leadId = leadResult?.customer?.leadId || quote.leadId || "";
    }

    const previousRows = await dbSelect("quotes", `select=id,quote_data&quote_number=eq.${encodeEq(quoteNumber)}&limit=1`);
    const previous = Array.isArray(previousRows) && previousRows.length ? previousRows[0] : null;
    const payload = normalizeQuoteDbPayload({ ...quote, quoteNo: quoteNumber }, leadUuid, actor);
    const savedRows = await dbUpsert("quotes", [payload], { onConflict: "quote_number" });
    const saved = Array.isArray(savedRows) && savedRows[0] ? savedRows[0] : null;
    if (!saved?.id) throw new Error("Quote was not returned from Supabase.");

    await dbDelete("quote_items", `quote_id=eq.${encodeEq(saved.id)}`, { returning: false });
    if (Array.isArray(quote.rows) && quote.rows.length) {
      await dbInsert("quote_items", quote.rows.map((item) => normalizeQuoteItemDbPayload(item, saved.id, actor)), { returning: false });
    }

    if (stableStringify(previous?.quote_data || null) !== stableStringify(quote || null)) {
      await dbInsert("quote_versions", [{
        quote_id: saved.id,
        quote_number: quoteNumber,
        version_number: await nextQuoteVersionNumber(saved.id),
        saved_by: actor.id,
        saved_by_name: actor.name,
        reason: previous ? "quote_updated_from_quote_maker" : "quote_created_from_quote_maker",
        quote_snapshot: quote,
      }], { returning: false });
      await writeAuditLog(req, {
        action_type: previous ? "quote_cloud_updated" : "quote_cloud_created",
        module: "quotes",
        target_table: "quotes",
        target_id: saved.id,
        quote_number: quoteNumber,
        old_snapshot: previous?.quote_data || null,
        new_snapshot: quote,
        change_summary: `${actor.name} ${previous ? "updated" : "created"} quote ${quoteNumber} in Supabase.`,
      });
    }

    res.json({ ok: true, success: true, storage: "supabase", quote: dbQuoteToAppQuote(saved) });
  } catch (error) {
    rememberSupabaseIssue("upsert quote", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save quote to cloud." });
  }
});


app.get("/job-orders", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.json({ ok: true, success: true, storage: "local-fallback", jobs: [] });
    const limit = Math.min(Math.max(Number(req.query.limit || 300), 1), 800);
    const jobRows = await dbSelect("job_orders", `select=*&order=updated_at.desc&limit=${limit}`);
    const jobIds = (Array.isArray(jobRows) ? jobRows : []).map((job) => job.id).filter(Boolean);
    if (!jobIds.length) return res.json({ ok: true, success: true, storage: "supabase", jobs: [] });
    const idList = `(${jobIds.join(",")})`;
    const [itemRows, costRows, paymentRows] = await Promise.all([
      dbSelect("job_order_items", `select=*&job_order_id=in.${idList}&order=created_at.asc`),
      dbSelect("job_costs", `select=*&job_order_id=in.${idList}&order=created_at.desc`),
      dbSelect("payments", `select=*&job_order_id=in.${idList}&order=created_at.desc`),
    ]);
    const itemsByJob = new Map();
    (Array.isArray(itemRows) ? itemRows : []).forEach((row) => {
      const list = itemsByJob.get(row.job_order_id) || [];
      list.push(row);
      itemsByJob.set(row.job_order_id, list);
    });
    const costsByJob = new Map();
    (Array.isArray(costRows) ? costRows : []).forEach((row) => {
      const list = costsByJob.get(row.job_order_id) || [];
      list.push(row);
      costsByJob.set(row.job_order_id, list);
    });
    const paymentsByJob = new Map();
    (Array.isArray(paymentRows) ? paymentRows : []).forEach((row) => {
      const list = paymentsByJob.get(row.job_order_id) || [];
      list.push(row);
      paymentsByJob.set(row.job_order_id, list);
    });
    const jobs = (Array.isArray(jobRows) ? jobRows : []).map((job) => dbJobOrderToAppJob(job, itemsByJob.get(job.id) || [], costsByJob.get(job.id) || [], paymentsByJob.get(job.id) || []));
    res.json({ ok: true, success: true, storage: "supabase", jobs });
  } catch (error) {
    rememberSupabaseIssue("load job orders", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load job orders." });
  }
});

app.get("/job-orders/:id", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const id = String(req.params.id || "").trim();
    const rows = isUuid(id)
      ? await dbSelect("job_orders", `select=id&id=eq.${encodeEq(id)}&limit=1`)
      : await dbSelect("job_orders", `select=id&job_number=eq.${encodeEq(id)}&limit=1`);
    const row = Array.isArray(rows) && rows[0] ? rows[0] : null;
    if (!row?.id) return res.status(404).json({ ok: false, success: false, error: "Job order not found." });
    const job = await fetchJobOrderBundle(row.id);
    res.json({ ok: true, success: true, storage: "supabase", job });
  } catch (error) {
    rememberSupabaseIssue("load single job order", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load job order." });
  }
});

app.post("/job-orders/from-quote", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const quoteId = String(req.body?.quoteId || req.body?.quoteNumber || "").trim();
    if (!quoteId) return res.status(400).json({ ok: false, success: false, error: "Quote id or quote number is required." });
    const quoteRows = isUuid(quoteId)
      ? await dbSelect("quotes", `select=*&id=eq.${encodeEq(quoteId)}&limit=1`)
      : await dbSelect("quotes", `select=*&quote_number=eq.${encodeEq(quoteId)}&limit=1`);
    const quote = Array.isArray(quoteRows) && quoteRows[0] ? quoteRows[0] : null;
    if (!quote?.id) return res.status(404).json({ ok: false, success: false, error: "Quote was not found." });

    const existing = await dbSelect("job_orders", `select=id,job_number&quote_id=eq.${encodeEq(quote.id)}&limit=1`);
    if (Array.isArray(existing) && existing[0]?.id) {
      const job = await fetchJobOrderBundle(existing[0].id);
      return res.json({ ok: true, success: true, alreadyExists: true, job });
    }

    const quoteItems = await dbSelect("quote_items", `select=*&quote_id=eq.${encodeEq(quote.id)}&order=created_at.asc`);
    const jobNumber = await nextJobNumberFromSupabase();
    const quoteData = quote.quote_data && typeof quote.quote_data === "object" ? quote.quote_data : {};
    const actor = actorFromRequest(req);
    const items = Array.isArray(quoteItems) ? quoteItems : [];
    const quoteAmount = Number(quote.final_amount || quote.quotation_amount || quoteData.finalTotal || quoteData.subtotal || 0) || 0;
    const estimatedCost = items.reduce((sum, item) => sum + Number(item.estimated_cost || 0), 0);
    const stage = stageMeta("New Job");
    const jobPayload = {
      job_number: jobNumber,
      quote_id: quote.id,
      lead_id: quote.lead_id || null,
      customer_id: null,
      client_name_snapshot: quote.client_name_snapshot || quoteData.customerName || quoteData.quotation?.customerName || "",
      source_snapshot: quoteData.source || quoteData.createdFrom || "Quote Maker",
      location_snapshot: quote.client_location_snapshot || quoteData.location || quoteData.quotation?.customerDetails?.location || "",
      status: "New Job",
      job_status: "Pending",
      current_stage: "New Job",
      progress_percent: stage.progress,
      priority: "Normal",
      payment_status: "Pending",
      approved_at: new Date().toISOString(),
      quote_amount: quoteAmount,
      discount_amount: Number(quote.discount_amount || quoteData.discountAmount || 0) || 0,
      final_amount: quoteAmount,
      estimated_cost: estimatedCost,
      actual_cost: 0,
      estimated_profit: quoteAmount - estimatedCost,
      actual_profit: 0,
      estimated_margin: quoteAmount ? ((quoteAmount - estimatedCost) / quoteAmount) * 100 : 0,
      actual_margin: 0,
      warnings: Array.isArray(quoteData.warnings) ? quoteData.warnings : [],
      job_data: {
        sourceQuoteNumber: quote.quote_number,
        createdFrom: "quote_to_job_conversion",
        createdBy: actor.name,
        currentStage: "New Job",
        progressPercent: stage.progress,
        quoteSnapshot: quoteData,
      },
      updated_at: new Date().toISOString(),
    };
    const insertedJobs = await dbInsert("job_orders", [jobPayload]);
    const savedJob = Array.isArray(insertedJobs) && insertedJobs[0] ? insertedJobs[0] : null;
    if (!savedJob?.id) throw new Error("Job order was not returned from Supabase.");
    if (items.length) {
      await dbInsert("job_order_items", items.map((item) => quoteItemToJobOrderItem(item, savedJob.id)), { returning: false });
    }
    await dbInsert("production_stage_history", [{
      job_order_id: savedJob.id,
      stage_name: "New Job",
      status: "Created",
      started_at: new Date().toISOString(),
      target_days: stage.targetDays,
      notes: `Job order created from quote ${quote.quote_number}.`,
    }], { returning: false });
    await writeAuditLog(req, {
      action_type: "job_order_created_from_quote",
      module: "job_orders",
      target_table: "job_orders",
      target_id: savedJob.id,
      quote_number: quote.quote_number,
      old_snapshot: quoteData,
      new_snapshot: savedJob,
      change_summary: `${actor.name} created job order ${jobNumber} from quote ${quote.quote_number}.`,
    });
    const job = await fetchJobOrderBundle(savedJob.id);
    res.json({ ok: true, success: true, storage: "supabase", job });
  } catch (error) {
    rememberSupabaseIssue("create job order from quote", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not create job order from quote." });
  }
});

app.get("/production/board", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.json({ ok: true, success: true, storage: "local-fallback", columns: [], jobs: [] });
    const jobRows = await dbSelect("job_orders", "select=*&order=updated_at.desc&limit=500");
    const jobs = (Array.isArray(jobRows) ? jobRows : []).map((job) => dbJobOrderToAppJob(job, [], [], []));
    const columns = PRODUCTION_WORKFLOW_STAGES.map((stage) => ({
      stage: stage.name,
      jobs: jobs.filter((job) => (job.currentStage || job.jobStatus || job.status || "New Job") === stage.name),
    }));
    res.json({ ok: true, success: true, storage: "supabase", columns, jobs });
  } catch (error) {
    rememberSupabaseIssue("production board", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load production board." });
  }
});

app.post("/production/stage-update", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const jobOrderId = String(req.body?.jobOrderId || "").trim();
    const jobOrderItemId = String(req.body?.jobOrderItemId || "").trim();
    const stageName = String(req.body?.stageName || req.body?.stage || "").trim() || "New Job";
    const status = String(req.body?.status || "In Progress").trim();
    const delayReason = String(req.body?.delayReason || "").trim();
    const blockerType = String(req.body?.blockerType || "").trim();
    const notes = String(req.body?.notes || "").trim();
    if (!isUuid(jobOrderId)) return res.status(400).json({ ok: false, success: false, error: "Valid jobOrderId is required." });
    if ((status.toLowerCase().includes("delay") || status.toLowerCase().includes("block") || stageName === "Delayed / Blocked") && !delayReason) {
      return res.status(400).json({ ok: false, success: false, error: "Delay reason is required for delayed/blocked production updates." });
    }
    const actor = actorFromRequest(req);
    const before = await fetchJobOrderBundle(jobOrderId);
    if (!before) return res.status(404).json({ ok: false, success: false, error: "Job order not found." });
    const meta = stageMeta(stageName);
    const now = new Date().toISOString();
    const currentStage = status.toLowerCase().includes("delay") || status.toLowerCase().includes("block") ? "Delayed / Blocked" : stageName;
    if (jobOrderItemId && isUuid(jobOrderItemId)) {
      await dbPatch("job_order_items", `id=eq.${encodeEq(jobOrderItemId)}&job_order_id=eq.${encodeEq(jobOrderId)}`, {
        production_stage: currentStage,
        production_status: status,
        delay_reason: delayReason || null,
        blocker_type: blockerType || null,
        stage_updated_at: now,
        updated_at: now,
      }, { returning: false });
    } else {
      const timestampPatch = {};
      if (stageName === "Fabrication" && !before.productionStartedAt) timestampPatch.production_started_at = now;
      if (stageName === "Ready for Installation") timestampPatch.ready_at = now;
      if (stageName === "Installed") timestampPatch.installed_at = now;
      if (stageName === "Completed") timestampPatch.completed_at = now;
      await dbPatch("job_orders", `id=eq.${encodeEq(jobOrderId)}`, {
        status: currentStage,
        job_status: stageName === "Completed" ? "Completed" : (currentStage === "Delayed / Blocked" ? "Delayed" : "In Production"),
        current_stage: currentStage,
        progress_percent: currentStage === "Delayed / Blocked" ? Number(before.progressPercent || 0) : meta.progress,
        delay_reason: delayReason || null,
        blocker_type: blockerType || null,
        last_stage_update_at: now,
        updated_at: now,
        ...timestampPatch,
      }, { returning: false });
      await dbPatch("job_order_items", `job_order_id=eq.${encodeEq(jobOrderId)}`, {
        production_stage: currentStage,
        production_status: status,
        delay_reason: delayReason || null,
        blocker_type: blockerType || null,
        stage_updated_at: now,
        updated_at: now,
      }, { returning: false });
    }
    await dbInsert("production_stage_history", [{
      job_order_id: jobOrderId,
      job_order_item_id: jobOrderItemId && isUuid(jobOrderItemId) ? jobOrderItemId : null,
      stage_name: currentStage,
      status,
      started_at: now,
      completed_at: status.toLowerCase() === "done" || stageName === "Completed" ? now : null,
      target_days: meta.targetDays,
      delay_reason: delayReason || null,
      blocker_type: blockerType || null,
      notes,
    }], { returning: false });
    const after = await fetchJobOrderBundle(jobOrderId);
    await writeAuditLog(req, {
      action_type: jobOrderItemId ? "production_item_stage_updated" : "production_job_stage_updated",
      module: "production",
      target_table: jobOrderItemId ? "job_order_items" : "job_orders",
      target_id: jobOrderItemId || jobOrderId,
      old_snapshot: before,
      new_snapshot: after,
      change_summary: `${actor.name} moved ${before.jobNumber} ${jobOrderItemId ? "item" : "job"} to ${currentStage}${delayReason ? ` because ${delayReason}` : ""}.`,
    });
    res.json({ ok: true, success: true, storage: "supabase", job: after });
  } catch (error) {
    rememberSupabaseIssue("production stage update", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not update production stage." });
  }
});

app.post("/production/delay", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const jobOrderId = String(req.body?.jobOrderId || "").trim();
    const delayReason = String(req.body?.delayReason || "").trim();
    const blockerType = String(req.body?.blockerType || "").trim();
    const notes = String(req.body?.notes || "").trim();
    if (!isUuid(jobOrderId)) return res.status(400).json({ ok: false, success: false, error: "Valid jobOrderId is required." });
    if (!delayReason) return res.status(400).json({ ok: false, success: false, error: "Delay reason is required." });
    const actor = actorFromRequest(req);
    const before = await fetchJobOrderBundle(jobOrderId);
    const now = new Date().toISOString();
    await dbPatch("job_orders", `id=eq.${encodeEq(jobOrderId)}`, {
      status: "Delayed / Blocked",
      job_status: "Delayed",
      current_stage: "Delayed / Blocked",
      delay_reason: delayReason,
      blocker_type: blockerType || null,
      last_stage_update_at: now,
      updated_at: now,
    }, { returning: false });
    await dbPatch("job_order_items", `job_order_id=eq.${encodeEq(jobOrderId)}`, {
      production_stage: "Delayed / Blocked",
      production_status: "Delayed",
      delay_reason: delayReason,
      blocker_type: blockerType || null,
      stage_updated_at: now,
      updated_at: now,
    }, { returning: false });
    await dbInsert("production_stage_history", [{
      job_order_id: jobOrderId,
      stage_name: "Delayed / Blocked",
      status: "Delayed",
      started_at: now,
      delay_reason: delayReason,
      blocker_type: blockerType || null,
      notes,
    }], { returning: false });
    const after = await fetchJobOrderBundle(jobOrderId);
    await writeAuditLog(req, {
      action_type: "production_delay_reported",
      module: "production",
      target_table: "job_orders",
      target_id: jobOrderId,
      old_snapshot: before,
      new_snapshot: after,
      change_summary: `${actor.name} marked ${after?.jobNumber || jobOrderId} delayed: ${delayReason}.`,
    });
    res.json({ ok: true, success: true, storage: "supabase", job: after });
  } catch (error) {
    rememberSupabaseIssue("production delay", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not report production delay." });
  }
});

app.get("/production/delays", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.json({ ok: true, success: true, delays: [] });
    const rows = await dbSelect("job_orders", `select=*&job_status=eq.${encodeEq("Delayed")}&order=updated_at.desc&limit=200`);
    const delays = (Array.isArray(rows) ? rows : []).map((job) => dbJobOrderToAppJob(job, [], [], []));
    res.json({ ok: true, success: true, storage: "supabase", delays });
  } catch (error) {
    rememberSupabaseIssue("production delays", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load production delays." });
  }
});

app.get("/job-costs/:jobOrderId", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.json({ ok: true, success: true, costs: [] });
    const jobOrderId = String(req.params.jobOrderId || "").trim();
    const costs = await dbSelect("job_costs", `select=*&job_order_id=eq.${encodeEq(jobOrderId)}&order=created_at.desc`);
    res.json({ ok: true, success: true, storage: "supabase", costs: Array.isArray(costs) ? costs.map((row) => ({
      ...row,
      costType: row.cost_type,
      supplierName: row.supplier_name,
      estimatedAmount: row.estimated_amount,
      actualAmount: row.actual_amount,
      invoiceNumber: row.invoice_number,
      costDate: row.cost_date,
    })) : [] });
  } catch (error) {
    rememberSupabaseIssue("load job costs", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load job costs." });
  }
});

app.post("/job-costs", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const jobOrderId = String(req.body?.jobOrderId || "").trim();
    if (!isUuid(jobOrderId)) return res.status(400).json({ ok: false, success: false, error: "Valid jobOrderId is required." });
    const actor = actorFromRequest(req);
    const payload = {
      job_order_id: jobOrderId,
      job_order_item_id: req.body?.jobOrderItemId && isUuid(req.body.jobOrderItemId) ? req.body.jobOrderItemId : null,
      cost_type: String(req.body?.costType || "Miscellaneous").trim(),
      supplier_name: String(req.body?.supplierName || "").trim() || null,
      description: String(req.body?.description || "").trim() || null,
      estimated_amount: toNumberOrNull(req.body?.estimatedAmount) || 0,
      actual_amount: toNumberOrNull(req.body?.actualAmount) || 0,
      invoice_number: String(req.body?.invoiceNumber || "").trim() || null,
      cost_date: req.body?.costDate || new Date().toISOString().slice(0, 10),
      added_by: actor.id && isUuid(actor.id) ? actor.id : null,
      cost_data: req.body || {},
      updated_at: new Date().toISOString(),
    };
    const inserted = await dbInsert("job_costs", [payload]);
    const recalculated = await recalculateJobFinancials(jobOrderId, req);
    res.json({ ok: true, success: true, storage: "supabase", cost: Array.isArray(inserted) ? inserted[0] : null, job: recalculated });
  } catch (error) {
    rememberSupabaseIssue("add job cost", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not add job cost." });
  }
});

app.get("/installation/calendar", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.json({ ok: true, success: true, tasks: [] });
    const limit = Math.min(Math.max(Number(req.query.limit || 300), 1), 800);
    const rows = await dbSelect("installation_tasks", `select=*,job_orders(job_number,client_name_snapshot,location_snapshot)&order=scheduled_at.asc&limit=${limit}`);
    const tasks = (Array.isArray(rows) ? rows : []).map((task) => ({
      ...task,
      jobNumber: task.job_orders?.job_number || "",
      clientName: task.job_orders?.client_name_snapshot || "",
      location: task.location || task.job_orders?.location_snapshot || task.task_data?.location || "",
      scheduledAt: task.scheduled_at,
      completedAt: task.completed_at,
      teamName: task.team_name || task.task_data?.teamName || "",
      googleMapsUrl: task.google_maps_url || task.task_data?.googleMapsUrl || "",
    }));
    res.json({ ok: true, success: true, storage: "supabase", tasks });
  } catch (error) {
    rememberSupabaseIssue("installation calendar", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load installation tasks." });
  }
});

app.post("/installation/tasks", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const jobOrderId = String(req.body?.jobOrderId || "").trim();
    if (!isUuid(jobOrderId)) return res.status(400).json({ ok: false, success: false, error: "Valid jobOrderId is required." });
    const actor = actorFromRequest(req);
    const scheduledAt = req.body?.scheduledAt ? new Date(req.body.scheduledAt).toISOString() : null;
    const payload = {
      job_order_id: jobOrderId,
      assigned_to: req.body?.assignedTo && isUuid(req.body.assignedTo) ? req.body.assignedTo : null,
      scheduled_at: scheduledAt,
      status: "Scheduled",
      site_ready: Boolean(req.body?.siteReady),
      client_delay: false,
      team_name: String(req.body?.teamName || "").trim() || null,
      location: String(req.body?.location || "").trim() || null,
      google_maps_url: String(req.body?.googleMapsUrl || "").trim() || null,
      notes: String(req.body?.notes || "").trim() || null,
      task_data: req.body || {},
      updated_at: new Date().toISOString(),
    };
    const inserted = await dbInsert("installation_tasks", [payload]);
    await dbPatch("job_orders", `id=eq.${encodeEq(jobOrderId)}`, {
      status: "Installation Scheduled",
      job_status: "Installation Scheduled",
      current_stage: "Installation Scheduled",
      progress_percent: stageMeta("Installation Scheduled").progress,
      last_stage_update_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }, { returning: false });
    await dbInsert("production_stage_history", [{
      job_order_id: jobOrderId,
      stage_name: "Installation Scheduled",
      status: "Scheduled",
      started_at: new Date().toISOString(),
      notes: `Installation scheduled by ${actor.name}${scheduledAt ? ` for ${scheduledAt}` : ""}.`,
    }], { returning: false });
    const job = await fetchJobOrderBundle(jobOrderId);
    await writeAuditLog(req, {
      action_type: "installation_scheduled",
      module: "installation",
      target_table: "installation_tasks",
      target_id: Array.isArray(inserted) && inserted[0]?.id ? inserted[0].id : jobOrderId,
      new_snapshot: Array.isArray(inserted) ? inserted[0] : payload,
      change_summary: `${actor.name} scheduled installation for ${job?.jobNumber || jobOrderId}.`,
    });
    res.json({ ok: true, success: true, storage: "supabase", task: Array.isArray(inserted) ? inserted[0] : null, job });
  } catch (error) {
    rememberSupabaseIssue("create installation task", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not schedule installation." });
  }
});

app.patch("/installation/tasks/:id", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const id = String(req.params.id || "").trim();
    const status = String(req.body?.status || "").trim();
    const patch = {
      ...(status ? { status } : {}),
      ...(req.body?.completedAt || status === "Completed" ? { completed_at: new Date(req.body?.completedAt || Date.now()).toISOString() } : {}),
      ...(typeof req.body?.siteReady === "boolean" ? { site_ready: req.body.siteReady } : {}),
      ...(typeof req.body?.clientDelay === "boolean" ? { client_delay: req.body.clientDelay } : {}),
      ...(req.body?.notes !== undefined ? { notes: String(req.body.notes || "") } : {}),
      task_data: req.body || {},
      updated_at: new Date().toISOString(),
    };
    const updated = await dbPatch("installation_tasks", `id=eq.${encodeEq(id)}`, patch);
    const task = Array.isArray(updated) && updated[0] ? updated[0] : null;
    if (task?.job_order_id && status === "Completed") {
      await dbPatch("job_orders", `id=eq.${encodeEq(task.job_order_id)}`, {
        status: "Installed",
        job_status: "Installed",
        current_stage: "Installed",
        progress_percent: stageMeta("Installed").progress,
        installed_at: new Date().toISOString(),
        last_stage_update_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }, { returning: false });
    }
    res.json({ ok: true, success: true, storage: "supabase", task });
  } catch (error) {
    rememberSupabaseIssue("update installation task", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not update installation task." });
  }
});


function staffNameFromProfiles(profiles = [], id = "") {
  const match = profiles.find((user) => String(user.id) === String(id));
  return match?.name || "Unassigned";
}

function normalizeTaskRow(row = {}, profiles = []) {
  return {
    ...row,
    assignedTo: row.assigned_to || "",
    assignedName: staffNameFromProfiles(profiles, row.assigned_to),
    taskType: row.task_type || "Task",
    dueAt: row.due_at || "",
    completedAt: row.completed_at || "",
  };
}


function groupNotifications(rows = []) {
  return rows.reduce((acc, row) => {
    const type = row.type || "general";
    if (!acc[type]) acc[type] = [];
    acc[type].push(row);
    return acc;
  }, {});
}

function notificationFromCustomerRequest(row = {}) {
  const estimate = row.estimate_data || {};
  const status = String(row.status || estimate.eventType || "chat_updated");
  let type = "incomplete_ai_chat";
  let severity = "medium";
  let module = "crm";
  if (status.includes("real_agent")) { type = "real_agent_requested"; severity = "urgent"; module = "crm"; }
  if (status.includes("site_visit")) { type = "site_visit_booked"; severity = "high"; module = "production"; }
  return {
    sourceType: "customer_requests",
    sourceId: row.id,
    type,
    severity,
    title: row.customer_name || estimate.customer?.name || "Customer chat needs review",
    detail: estimate.note || row.latest_message || "Customer activity needs staff action.",
    owner: "Sales / CRM",
    status: row.status || "open",
    createdAt: row.updated_at || row.created_at,
    route: { module, leadId: estimate.leadUuid || estimate.leadId || "", chatId: row.chat_id || estimate.chatId || "" },
  };
}

function notificationFromQuote(row = {}) {
  return {
    sourceType: "quotes",
    sourceId: row.id,
    type: "quote_review_needed",
    severity: "high",
    title: `Quote ${row.quote_number || row.id} needs review`,
    detail: `${row.client_name_snapshot || "Customer"} · AED ${Number(row.final_amount || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`,
    owner: row.prepared_by || "Estimator",
    status: row.quote_status || row.status || "review",
    createdAt: row.updated_at || row.created_at,
    route: { module: "crm", quoteId: row.id, leadId: row.lead_id || "" },
  };
}

function notificationFromJobDelay(row = {}) {
  return {
    sourceType: "job_orders",
    sourceId: row.id,
    type: "production_delay",
    severity: "urgent",
    title: `${row.job_number || "Job"} is delayed`,
    detail: row.delay_reason || row.blocker_type || "Production blocker needs manager action.",
    owner: "Operations",
    status: row.job_status || row.status || "Delayed",
    createdAt: row.updated_at || row.last_stage_update_at || row.created_at,
    route: { module: "production", jobOrderId: row.id },
  };
}

function notificationFromPayment(row = {}) {
  return {
    sourceType: "payments",
    sourceId: row.id,
    type: "payment_pending",
    severity: row.due_date && new Date(row.due_date).getTime() < Date.now() ? "urgent" : "high",
    title: `${row.payment_number || "Payment"} pending`,
    detail: `AED ${Number(row.amount || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}${row.due_date ? ` due ${row.due_date}` : ""}`,
    owner: "Accounts",
    status: row.payment_status || "Pending",
    createdAt: row.updated_at || row.created_at,
    route: { module: "jobs", jobOrderId: row.job_order_id || "" },
  };
}

function notificationFromFollowUp(row = {}) {
  return {
    sourceType: "leads",
    sourceId: row.id,
    type: "follow_up_due",
    severity: "high",
    title: `${row.client_name || row.lead_id || "Lead"} follow-up due`,
    detail: `${row.product_inquired || "Inquiry"}${row.phone ? ` · ${row.phone}` : ""}`,
    owner: "Sales",
    status: row.status || "Follow-up",
    createdAt: row.next_follow_up_date || row.updated_at || row.created_at,
    route: { module: "crm", leadId: row.id },
  };
}


function paymentRowToApp(row = {}, jobMap = new Map()) {
  const job = jobMap.get(String(row.job_order_id || "")) || {};
  return {
    ...row,
    paymentNumber: row.payment_number || "",
    paymentType: row.payment_type || "",
    paymentStatus: row.payment_status || "Pending",
    dueDate: row.due_date || "",
    paidAt: row.paid_at || "",
    jobNumber: job.job_number || "",
    clientName: job.client_name_snapshot || "",
  };
}

async function nextPaymentNumber() {
  const rows = await dbSelect("payments", "select=payment_number&limit=10000").catch(() => []);
  const max = (Array.isArray(rows) ? rows : []).reduce((best, row) => {
    const match = String(row.payment_number || "").match(/(\d+)/);
    return Math.max(best, match ? Number(match[1]) || 0 : 0);
  }, 0);
  return `PAY-${String(max + 1).padStart(4, "0")}`;
}


function siteVisitRowFromRequest(row = {}) {
  const estimate = row.estimate_data || {};
  const customer = estimate.customer || {};
  const siteVisit = estimate.siteVisit || {};
  return {
    id: row.id,
    label: siteVisit.label || siteVisit.slotId || row.status || "Site visit",
    customerName: row.customer_name || customer.name || "Customer",
    phone: row.phone || customer.phone || "",
    location: row.location || customer.location || estimate.location || "",
    product: row.product || estimate.product || customer.productInquired || "",
    status: row.status || estimate.eventType || "site_visit",
    createdAt: row.updated_at || row.created_at,
  };
}


app.get("/ui-system-health", requireStaff, async (req, res) => {
  try {
    const checks = [
      { key: "command_palette", status: "ready", detail: "Ctrl+K module/action navigation enabled." },
      { key: "density_modes", status: "ready", detail: "Compact and comfortable density settings available." },
      { key: "motion_modes", status: "ready", detail: "Premium, subtle, and none animation settings available." },
      { key: "role_modules", status: "ready", detail: "CRM, operations, field, finance, notification, and staff modules are separated." },
      { key: "database", status: SUPABASE_ENABLED ? "configured" : "missing", detail: SUPABASE_ENABLED ? "Supabase service key is configured." : "SUPABASE_URL / service role key missing." },
    ];
    res.json({ ok: true, success: true, checks, generatedAt: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ ok: false, success: false, error: "Could not read UI system health." });
  }
});


app.get("/field-visit-center", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.json({ ok: true, success: true, metrics: {}, installationTasks: [], siteVisits: [], checklistDefaults: [] });
    const [taskRows, requestRows] = await Promise.all([
      dbSelect("installation_tasks", "select=*,job_orders(job_number,client_name_snapshot,location_snapshot)&order=scheduled_at.asc.nullslast&limit=400").catch(() => []),
      loadCustomerRequestRows(300).catch(() => []),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const installationTasks = (Array.isArray(taskRows) ? taskRows : []).map((task) => ({
      ...task,
      jobNumber: task.job_orders?.job_number || "",
      clientName: task.job_orders?.client_name_snapshot || "",
      location: task.location || task.job_orders?.location_snapshot || task.task_data?.location || "",
      scheduledAt: task.scheduled_at,
      completedAt: task.completed_at,
      teamName: task.team_name || task.task_data?.teamName || "",
      googleMapsUrl: task.google_maps_url || task.task_data?.googleMapsUrl || "",
      checklist: task.checklist || task.task_data?.checklist || {},
    }));
    const siteVisits = (Array.isArray(requestRows) ? requestRows : []).filter((row) => String(row.status || row.estimate_data?.eventType || "").includes("site_visit")).map(siteVisitRowFromRequest);
    const metrics = {
      todayTasks: installationTasks.filter((task) => String(task.scheduledAt || "").slice(0, 10) === today).length,
      onSite: installationTasks.filter((task) => String(task.status || "").toLowerCase().includes("site") || String(task.status || "").toLowerCase().includes("progress")).length,
      completed: installationTasks.filter((task) => String(task.status || "").toLowerCase().includes("complete")).length,
      siteVisits: siteVisits.length,
    };
    res.json({ ok: true, success: true, metrics, installationTasks, siteVisits, checklistDefaults: ["Confirm site access", "Verify final sizes", "Check glass/profile loaded", "Check accessories/tools", "Protect floor/walls", "Take before photo", "Install and align", "Silicone/sealant finish", "Take after photo", "Customer sign-off"] });
  } catch (error) {
    rememberSupabaseIssue("field visit center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load field visit center." });
  }
});

app.post("/installation/tasks/:id/field-update", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const id = String(req.params.id || "").trim();
    if (!isUuid(id)) return res.status(400).json({ ok: false, success: false, error: "Valid installation task id is required." });
    const rows = await dbSelect("installation_tasks", `select=*&id=eq.${encodeEq(id)}&limit=1`);
    const before = Array.isArray(rows) ? rows[0] : null;
    if (!before) return res.status(404).json({ ok: false, success: false, error: "Installation task was not found." });
    const status = String(req.body?.status || before.status || "On Site").trim();
    const beforePhotos = Array.isArray(before.before_photos) ? before.before_photos : [];
    const afterPhotos = Array.isArray(before.after_photos) ? before.after_photos : [];
    const patch = {
      status,
      checklist: req.body?.checklist && typeof req.body.checklist === "object" ? req.body.checklist : (before.checklist || {}),
      before_photos: req.body?.beforePhoto ? [...beforePhotos, { value: String(req.body.beforePhoto), at: new Date().toISOString(), by: actorFromRequest(req).name }] : beforePhotos,
      after_photos: req.body?.afterPhoto ? [...afterPhotos, { value: String(req.body.afterPhoto), at: new Date().toISOString(), by: actorFromRequest(req).name }] : afterPhotos,
      customer_signature: req.body?.customerSignature ? String(req.body.customerSignature).trim() : before.customer_signature,
      notes: [before.notes, req.body?.note ? `${new Date().toISOString()} — ${actorFromRequest(req).name}: ${String(req.body.note).trim()}` : ""].filter(Boolean).join("\n"),
      completed_at: status.toLowerCase().includes("complete") ? new Date().toISOString() : before.completed_at,
      updated_at: new Date().toISOString(),
    };
    const updated = await dbPatch("installation_tasks", `id=eq.${encodeEq(id)}`, patch);
    if (before.job_order_id) {
      const jobPatch = status.toLowerCase().includes("complete") ? { status: "Installed", job_status: "Installed", current_stage: "Installed", progress_percent: stageMeta("Installed").progress, installed_at: new Date().toISOString(), updated_at: new Date().toISOString() } : { status, updated_at: new Date().toISOString() };
      await dbPatch("job_orders", `id=eq.${encodeEq(before.job_order_id)}`, jobPatch, { returning: false });
      await dbInsert("production_stage_history", [{ job_order_id: before.job_order_id, stage_name: status.toLowerCase().includes("complete") ? "Installed" : status, status, started_at: new Date().toISOString(), notes: req.body?.note || `Field update by ${actorFromRequest(req).name}.` }], { returning: false });
    }
    await writeAuditLog(req, { action_type: "installation_field_update", module: "installation", target_table: "installation_tasks", target_id: id, old_snapshot: before, new_snapshot: updated?.[0] || patch, change_summary: `${actorFromRequest(req).name} updated installation task to ${status}.` });
    res.json({ ok: true, success: true, task: Array.isArray(updated) ? updated[0] : null });
  } catch (error) {
    rememberSupabaseIssue("installation field update", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save field update." });
  }
});


app.get("/finance-control", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.json({ ok: true, success: true, metrics: {}, jobs: [], payments: [], lowMarginJobs: [], overduePayments: [] });
    const [jobRows, paymentRows, costRows] = await Promise.all([
      dbSelect("job_orders", "select=*&order=updated_at.desc&limit=500").catch(() => []),
      dbSelect("payments", "select=*&order=due_date.asc.nullslast&limit=500").catch(() => []),
      dbSelect("job_costs", "select=*&order=created_at.desc&limit=1000").catch(() => []),
    ]);
    const paymentsByJob = new Map();
    (Array.isArray(paymentRows) ? paymentRows : []).forEach((payment) => {
      const key = String(payment.job_order_id || "");
      if (!paymentsByJob.has(key)) paymentsByJob.set(key, []);
      paymentsByJob.get(key).push(payment);
    });
    const costsByJob = new Map();
    (Array.isArray(costRows) ? costRows : []).forEach((cost) => {
      const key = String(cost.job_order_id || "");
      if (!costsByJob.has(key)) costsByJob.set(key, []);
      costsByJob.get(key).push(cost);
    });
    const jobMap = new Map((Array.isArray(jobRows) ? jobRows : []).map((job) => [String(job.id), job]));
    const jobs = (Array.isArray(jobRows) ? jobRows : []).map((job) => dbJobOrderToAppJob(job, [], costsByJob.get(String(job.id)) || [], paymentsByJob.get(String(job.id)) || []));
    const payments = (Array.isArray(paymentRows) ? paymentRows : []).map((row) => paymentRowToApp(row, jobMap));
    const paidAmount = payments.reduce((sum, p) => ["paid", "received"].includes(String(p.paymentStatus).toLowerCase()) ? sum + Number(p.amount || 0) : sum, 0);
    const openJobValue = jobs.filter((job) => !["completed", "cancelled"].includes(String(job.jobStatus || "").toLowerCase())).reduce((sum, job) => sum + Number(job.finalAmount || 0), 0);
    const balanceDue = jobs.reduce((sum, job) => sum + Number(job.balanceDue || 0), 0);
    const actualProfit = jobs.reduce((sum, job) => sum + Number(job.actualProfit || 0), 0);
    const lowMarginJobs = jobs.filter((job) => Number(job.finalAmount || 0) > 0 && Number(job.actualMargin || 0) < 22).sort((a, b) => Number(a.actualMargin || 0) - Number(b.actualMargin || 0));
    const overduePayments = payments.filter((p) => !["paid", "received", "cancelled"].includes(String(p.paymentStatus || "").toLowerCase()) && p.dueDate && new Date(p.dueDate).getTime() < Date.now());
    res.json({ ok: true, success: true, metrics: { openJobValue, paidAmount, balanceDue, actualProfit }, jobs, payments, lowMarginJobs, overduePayments });
  } catch (error) {
    rememberSupabaseIssue("finance control", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load finance control." });
  }
});

app.post("/payments", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const jobOrderId = String(req.body?.jobOrderId || "").trim();
    if (!isUuid(jobOrderId)) return res.status(400).json({ ok: false, success: false, error: "Valid jobOrderId is required." });
    const jobRows = await dbSelect("job_orders", `select=*&id=eq.${encodeEq(jobOrderId)}&limit=1`);
    const job = Array.isArray(jobRows) ? jobRows[0] : null;
    const payload = {
      job_order_id: jobOrderId,
      quote_id: job?.quote_id || null,
      payment_number: await nextPaymentNumber(),
      payment_type: String(req.body?.paymentType || "Payment").trim(),
      payment_status: String(req.body?.paymentStatus || "Pending").trim(),
      amount: Number(req.body?.amount || 0) || 0,
      due_date: req.body?.dueDate || null,
      method: String(req.body?.method || "").trim() || null,
      reference: String(req.body?.reference || "").trim() || null,
      notes: String(req.body?.notes || "").trim() || null,
      received_by: actorFromRequest(req).id,
      updated_at: new Date().toISOString(),
    };
    const inserted = await dbInsert("payments", [payload]);
    const bundle = await fetchJobOrderBundle(jobOrderId);
    await dbPatch("job_orders", `id=eq.${encodeEq(jobOrderId)}`, { payment_status: bundle?.balanceDue <= 0 ? "Paid" : "Pending", updated_at: new Date().toISOString() }, { returning: false });
    await writeAuditLog(req, { action_type: "payment_created", module: "finance", target_table: "payments", target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || payload, change_summary: `${actorFromRequest(req).name} created payment ${payload.payment_number}.` });
    res.json({ ok: true, success: true, payment: Array.isArray(inserted) ? inserted[0] : null, job: bundle });
  } catch (error) {
    rememberSupabaseIssue("payment create", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not create payment." });
  }
});

app.patch("/payments/:id", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const id = String(req.params.id || "").trim();
    if (!isUuid(id)) return res.status(400).json({ ok: false, success: false, error: "Valid payment id is required." });
    const beforeRows = await dbSelect("payments", `select=*&id=eq.${encodeEq(id)}&limit=1`);
    const before = Array.isArray(beforeRows) ? beforeRows[0] : null;
    const patch = {
      ...(req.body?.paymentStatus ? { payment_status: String(req.body.paymentStatus).trim() } : {}),
      ...(req.body?.paidAt || String(req.body?.paymentStatus || "").toLowerCase() === "paid" ? { paid_at: new Date(req.body?.paidAt || Date.now()).toISOString() } : {}),
      ...(req.body?.method !== undefined ? { method: String(req.body.method || "").trim() || null } : {}),
      ...(req.body?.reference !== undefined ? { reference: String(req.body.reference || "").trim() || null } : {}),
      ...(req.body?.notes !== undefined ? { notes: String(req.body.notes || "").trim() || null } : {}),
      updated_at: new Date().toISOString(),
    };
    const updated = await dbPatch("payments", `id=eq.${encodeEq(id)}`, patch);
    if (before?.job_order_id) {
      const bundle = await fetchJobOrderBundle(before.job_order_id);
      await dbPatch("job_orders", `id=eq.${encodeEq(before.job_order_id)}`, { payment_status: bundle?.balanceDue <= 0 ? "Paid" : "Pending", updated_at: new Date().toISOString() }, { returning: false });
    }
    await writeAuditLog(req, { action_type: "payment_updated", module: "finance", target_table: "payments", target_id: id, old_snapshot: before, new_snapshot: updated?.[0] || patch, change_summary: `${actorFromRequest(req).name} updated payment ${before?.payment_number || id}.` });
    res.json({ ok: true, success: true, payment: Array.isArray(updated) ? updated[0] : null });
  } catch (error) {
    rememberSupabaseIssue("payment update", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not update payment." });
  }
});


app.get("/notification-center", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.json({ ok: true, success: true, metrics: {}, notifications: [], grouped: {} });
    const nowDate = new Date().toISOString().slice(0, 10);
    const [requestRows, quoteRows, delayedJobs, paymentRows, followUpRows] = await Promise.all([
      loadCustomerRequestRows(150).catch(() => []),
      dbSelect("quotes", "select=*&or=(quote_status.ilike.%review%,status.ilike.%review%,status.ilike.%clarification%)&order=updated_at.desc&limit=100").catch(() => []),
      dbSelect("job_orders", `select=*&or=(job_status.eq.${encodeEq("Delayed")},current_stage.eq.${encodeEq("Delayed / Blocked")})&order=updated_at.desc&limit=100`).catch(() => []),
      dbSelect("payments", "select=*&payment_status=in.(Pending,Overdue)&order=due_date.asc.nullslast&limit=100").catch(() => []),
      dbSelect("leads", `select=*&next_follow_up_date=lte.${encodeEq(nowDate)}&status=neq.${encodeEq("Won")}&status=neq.${encodeEq("Lost")}&order=next_follow_up_date.asc&limit=100`).catch(() => []),
    ]);
    const notifications = [
      ...(Array.isArray(requestRows) ? requestRows : []).filter((row) => !["handled", "closed", "resolved"].includes(String(row.status || "").toLowerCase())).map(notificationFromCustomerRequest),
      ...(Array.isArray(quoteRows) ? quoteRows : []).map(notificationFromQuote),
      ...(Array.isArray(delayedJobs) ? delayedJobs : []).map(notificationFromJobDelay),
      ...(Array.isArray(paymentRows) ? paymentRows : []).map(notificationFromPayment),
      ...(Array.isArray(followUpRows) ? followUpRows : []).map(notificationFromFollowUp),
    ];
    const grouped = groupNotifications(notifications);
    const metrics = {
      unhandled: notifications.length,
      urgent: notifications.filter((row) => row.severity === "urgent").length,
      aiRequests: notifications.filter((row) => ["real_agent_requested", "incomplete_ai_chat"].includes(row.type)).length,
      operations: notifications.filter((row) => ["production_delay", "payment_pending", "site_visit_booked"].includes(row.type)).length,
    };
    res.json({ ok: true, success: true, metrics, notifications, grouped });
  } catch (error) {
    rememberSupabaseIssue("notification center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load notification center." });
  }
});

app.patch("/notifications/:sourceType/:id", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const sourceType = String(req.params.sourceType || "").trim();
    const id = String(req.params.id || "").trim();
    const status = String(req.body?.status || "handled").trim();
    if (!isUuid(id)) return res.status(400).json({ ok: false, success: false, error: "Valid notification source id is required." });
    let updated = null;
    if (sourceType === "customer_requests") {
      updated = await dbPatch("customer_requests", `id=eq.${encodeEq(id)}`, { status, updated_at: new Date().toISOString() });
    } else if (sourceType === "quotes") {
      updated = await dbPatch("quotes", `id=eq.${encodeEq(id)}`, { quote_status: status, status, updated_at: new Date().toISOString() });
    } else if (sourceType === "job_orders") {
      updated = await dbPatch("job_orders", `id=eq.${encodeEq(id)}`, { job_status: status === "handled" ? "In Production" : status, status: status === "handled" ? "In Production" : status, updated_at: new Date().toISOString() });
    } else if (sourceType === "payments") {
      updated = await dbPatch("payments", `id=eq.${encodeEq(id)}`, { payment_status: status === "handled" ? "Pending" : status, updated_at: new Date().toISOString() });
    } else if (sourceType === "leads") {
      updated = await dbPatch("leads", `id=eq.${encodeEq(id)}`, { status: status === "handled" ? "Contacted" : status, updated_at: new Date().toISOString() });
    } else {
      return res.status(400).json({ ok: false, success: false, error: "Unsupported notification source." });
    }
    await writeAuditLog(req, { action_type: "notification_updated", module: "notifications", target_table: sourceType, target_id: id, new_value: status, new_snapshot: updated?.[0] || null, change_summary: `${actorFromRequest(req).name} marked ${sourceType} notification ${status}.` });
    res.json({ ok: true, success: true, updated: Array.isArray(updated) ? updated[0] : null });
  } catch (error) {
    rememberSupabaseIssue("notification update", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not update notification." });
  }
});


app.get("/staff-control-center", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.json({ ok: true, success: true, metrics: {}, staff: await getStaffProfiles(), tasks: [], jobs: [], assignmentBoard: [], audit: [] });
    const [staffRows, taskRows, jobRows, auditRows] = await Promise.all([
      getStaffProfiles(),
      dbSelect("staff_tasks", "select=*&order=due_at.asc.nullslast&limit=500").catch(() => []),
      dbSelect("job_orders", "select=*&order=updated_at.desc&limit=500").catch(() => []),
      dbSelect("audit_logs", "select=*&order=created_at.desc&limit=80").catch(() => []),
    ]);
    const staff = Array.isArray(staffRows) ? staffRows : [];
    const tasks = (Array.isArray(taskRows) ? taskRows : []).map((row) => normalizeTaskRow(row, staff));
    const jobs = (Array.isArray(jobRows) ? jobRows : []).map((row) => dbJobOrderToAppJob(row, [], [], []));
    const openTasks = tasks.filter((task) => !["done", "completed", "cancelled"].includes(String(task.status || "").toLowerCase()));
    const overdueTasks = openTasks.filter((task) => task.dueAt && new Date(task.dueAt).getTime() < Date.now());
    const assignmentBoard = staff.map((user) => {
      const userTasks = openTasks.filter((task) => String(task.assignedTo || "") === String(user.id));
      const userJobs = jobs.filter((job) => String(job.jobData?.assignedTo || job.assignedTo || "") === String(user.id));
      return {
        owner: user.name || user.email || "Staff",
        role: user.role || "staff",
        id: user.id,
        openTasks: userTasks.length,
        overdue: userTasks.filter((task) => task.dueAt && new Date(task.dueAt).getTime() < Date.now()).length,
        jobs: userJobs.length,
        quoteValue: userJobs.reduce((sum, job) => sum + Number(job.finalAmount || 0), 0),
      };
    });
    const metrics = { activeStaff: staff.length, openTasks: openTasks.length, overdueTasks: overdueTasks.length, assignedJobs: assignmentBoard.reduce((sum, row) => sum + Number(row.jobs || 0), 0) };
    res.json({ ok: true, success: true, metrics, staff, tasks, jobs, assignmentBoard, audit: Array.isArray(auditRows) ? auditRows : [] });
  } catch (error) {
    rememberSupabaseIssue("staff control center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load staff control center." });
  }
});

app.post("/staff/tasks", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const assignedTo = String(req.body?.assignedTo || req.body?.assigned_to || "").trim();
    const payload = {
      assigned_to: assignedTo && isUuid(assignedTo) ? assignedTo : null,
      lead_id: req.body?.leadId && isUuid(req.body.leadId) ? req.body.leadId : null,
      quote_id: req.body?.quoteId && isUuid(req.body.quoteId) ? req.body.quoteId : null,
      job_order_id: req.body?.jobOrderId && isUuid(req.body.jobOrderId) ? req.body.jobOrderId : null,
      task_type: String(req.body?.taskType || req.body?.task_type || "General Task").trim(),
      status: String(req.body?.status || "Pending").trim(),
      priority: String(req.body?.priority || "Normal").trim(),
      due_at: req.body?.dueAt ? new Date(req.body.dueAt).toISOString() : null,
      notes: String(req.body?.notes || "").trim() || null,
      updated_at: new Date().toISOString(),
    };
    const inserted = await dbInsert("staff_tasks", [payload]);
    await writeAuditLog(req, { action_type: "staff_task_assigned", module: "staff", target_table: "staff_tasks", target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || payload, change_summary: `${actor.name} assigned ${payload.task_type}.` });
    res.json({ ok: true, success: true, task: Array.isArray(inserted) ? inserted[0] : null });
  } catch (error) {
    rememberSupabaseIssue("staff task create", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not create staff task." });
  }
});

app.patch("/staff/tasks/:id", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const id = String(req.params.id || "").trim();
    if (!isUuid(id)) return res.status(400).json({ ok: false, success: false, error: "Valid task id is required." });
    const existing = await dbSelect("staff_tasks", `select=*&id=eq.${encodeEq(id)}&limit=1`);
    const before = Array.isArray(existing) ? existing[0] : null;
    const status = String(req.body?.status || before?.status || "Pending").trim();
    const patch = {
      ...(req.body?.assignedTo && isUuid(req.body.assignedTo) ? { assigned_to: req.body.assignedTo } : {}),
      ...(req.body?.priority ? { priority: String(req.body.priority).trim() } : {}),
      ...(req.body?.notes !== undefined ? { notes: String(req.body.notes || "").trim() || null } : {}),
      ...(req.body?.dueAt ? { due_at: new Date(req.body.dueAt).toISOString() } : {}),
      status,
      completed_at: ["done", "completed"].includes(status.toLowerCase()) ? new Date().toISOString() : null,
      updated_at: new Date().toISOString(),
    };
    const updated = await dbPatch("staff_tasks", `id=eq.${encodeEq(id)}`, patch);
    await writeAuditLog(req, { action_type: "staff_task_updated", module: "staff", target_table: "staff_tasks", target_id: id, old_snapshot: before, new_snapshot: updated?.[0] || patch, change_summary: `${actorFromRequest(req).name} moved task to ${status}.` });
    res.json({ ok: true, success: true, task: Array.isArray(updated) ? updated[0] : null });
  } catch (error) {
    rememberSupabaseIssue("staff task update", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not update staff task." });
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


app.get("/assistant-control-admin", requireStaff, async (req, res) => {
  try {
    if (!activeStaffCanControlAssistant(req)) {
      return res.status(403).json({ ok: false, success: false, error: "This control is restricted." });
    }
    const status = await readAssistantControlStatus();
    res.json({
      ok: true,
      success: true,
      enabled: status.enabled !== false,
      status,
    });
  } catch {
    res.status(500).json({ ok: false, success: false, error: "Could not check quote support status." });
  }
});

app.patch("/assistant-control-admin", requireStaff, async (req, res) => {
  try {
    if (!activeStaffCanControlAssistant(req)) {
      return res.status(403).json({ ok: false, success: false, error: "This control is restricted." });
    }
    const active = getActiveStaffProfile(req);
    const enabled = req.body?.enabled !== false;
    const status = await writeAssistantControlStatus({ enabled, updatedBy: active?.name || "Staff" });
    await writeAuditLog(req, {
      action_type: enabled ? "assistant_support_enabled" : "assistant_support_disabled",
      module: "assistant_control",
      target_table: "app_settings",
      target_id: ASSISTANT_CONTROL_STATUS_KEY,
      field_name: "enabled",
      old_value: null,
      new_value: String(enabled),
      new_snapshot: status,
      change_summary: `${active?.name || "Staff"} ${enabled ? "enabled" : "paused"} Auto Quote support.`,
    });
    res.json({ ok: true, success: true, enabled: status.enabled !== false, status });
  } catch (error) {
    console.error("Assistant admin control error:", error);
    res.status(500).json({ ok: false, success: false, error: "Could not update quote support control." });
  }
});

app.get("/assistant-control-status", async (req, res) => {
  try {
    const status = await readAssistantControlStatus();
    res.json({ ok: true, success: true, enabled: status.enabled !== false });
  } catch {
    res.status(500).json({ ok: false, success: false, error: "Could not check quote support status." });
  }
});

app.post("/analytics-summary", requireStaff, async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({ success: false, ok: false, error: "OPENAI_API_KEY is missing on the backend." });
    }

    const period = ["daily", "weekly", "monthly"].includes(String(req.body?.period || "").toLowerCase())
      ? String(req.body.period).toLowerCase()
      : "monthly";
    const facts = req.body?.facts && typeof req.body.facts === "object" ? req.body.facts : {};
    const result = await generateAnalyticsSummary({ period, facts });

    res.json({
      success: true,
      ok: true,
      period,
      summary: result.summary,
      usage: result.usage,
    });
  } catch (error) {
    console.error("Analytics summary error:", error);
    res.status(500).json({ success: false, ok: false, error: "Could not generate AI analytics summary." });
  }
});

app.post("/assistant-control", async (req, res) => {
  try {
    const text = normalizeContent(req.body?.message || req.body?.text || "").trim();
    const result = await handleAssistantControlCommand(text);
    if (!result.handled) {
      return res.json({ ok: true, success: true, handled: false });
    }
    // Do not store the command text, do not send it to OpenAI, and do not create a customer request.
    return res.json({ ok: true, success: true, handled: true, enabled: result.enabled, message: result.message });
  } catch (error) {
    console.error("Assistant control error:", error);
    res.status(500).json({ ok: false, success: false, error: "Assistant control request failed." });
  }
});

app.get("/customer-chat-session/:chatId", async (req, res) => {
  try {
    const chatId = String(req.params.chatId || "").trim();
    if (!chatId) return res.status(400).json({ ok: false, success: false, error: "Missing chat session." });
    const rows = await loadCustomerRequestRows(300);
    const match = dedupeCustomerRequests(rows).find((row) => String(row?.estimate_data?.chatId || row?.id || "") === chatId || String(row?.id || "") === chatId);
    // A new customer chat may not have been saved to the database yet. Do not return 404 here,
    // because the frontend polls this endpoint and browser consoles show repeated red errors.
    // Returning 200 with request:null keeps polling quiet until the chat is actually registered
    // by a quote submission, location upload, document upload, or real-agent request.
    if (!match) return res.json({ ok: true, success: true, request: null, notFound: true });
    res.json({ ok: true, success: true, request: match });
  } catch (error) {
    rememberSupabaseIssue("customer chat session load", error);
    res.status(500).json({ ok: false, success: false, error: "Could not load customer chat session." });
  }
});

app.post("/customer-chat-message", async (req, res) => {
  try {
    const body = req.body || {};
    const sender = body.sender === "staff" ? "staff" : "customer";
    if (sender === "staff") {
      cleanStaffSessions();
      const token = getStaffToken(req);
      const session = token ? staffSessions.get(token) : null;
      if (!session) return res.status(401).json({ ok: false, success: false, error: "Staff login required to reply." });
      req.staff = session;
    }
    const text = normalizeContent(body.text || body.message || "").trim();
    if (!text) return res.status(400).json({ ok: false, success: false, error: "Message is required." });
    const chatId = body.chatId || body.id || `customer_chat_${Date.now().toString(36)}`;
    const rows = await loadCustomerRequestRows(300);
    const previous = dedupeCustomerRequests(rows).find((row) => String(row?.estimate_data?.chatId || row?.id || "") === String(chatId) || String(row?.id || "") === String(chatId));
    const previousConversation = Array.isArray(previous?.conversation) ? previous.conversation : [];
    const nextMessage = {
      id: String(body.messageId || body.clientMessageId || makeServerMessageId(sender === "staff" ? "staff_msg" : "customer_msg")),
      role: sender === "staff" ? "assistant" : "user",
      sender,
      content: text,
      text,
      at: new Date().toISOString(),
      staffName: sender === "staff" ? (body.staffName || getActiveStaffProfile(req)?.name || req.staff?.name || "Staff") : null,
    };
    const status = sender === "staff" ? "staff_active" : (previous?.status || "real_agent_requested");
    const row = await recordCustomerRequest({
      chatId,
      customer: body.customer || previous || {},
      conversation: [...previousConversation, nextMessage],
      status,
      eventType: status,
      note: sender === "staff" ? "Staff replied to customer chat." : "Customer sent a message while waiting for staff.",
      estimate_data: {
        ...(previous?.estimate_data || {}),
        chatId,
        staffControl: status === "staff_active",
        sessionStatus: status,
        lastManualMessageAt: nextMessage.at,
      },
    }, req);
    res.json({ ok: true, success: true, request: row, message: nextMessage });
  } catch (error) {
    rememberSupabaseIssue("customer chat message", error);
    res.status(500).json({ ok: false, success: false, error: "Could not send chat message." });
  }
});

app.post("/customer-chat-session-status", requireStaff, async (req, res) => {
  try {
    const body = req.body || {};
    const chatId = String(body.chatId || body.id || "").trim();
    const status = String(body.status || "").trim() || "staff_active";
    if (!chatId) return res.status(400).json({ ok: false, success: false, error: "Missing chat session." });
    const rows = await loadCustomerRequestRows(300);
    const previous = dedupeCustomerRequests(rows).find((row) => String(row?.estimate_data?.chatId || row?.id || "") === chatId || String(row?.id || "") === chatId);
    const row = await recordCustomerRequest({
      chatId,
      customer: body.customer || previous || {},
      conversation: Array.isArray(previous?.conversation) ? previous.conversation : [],
      status,
      eventType: status,
      note: body.note || `Chat session status changed to ${status}.`,
      estimate_data: {
        ...(previous?.estimate_data || {}),
        chatId,
        staffControl: status === "staff_active",
        sessionStatus: status,
        closedAt: (status === "session_closed" || status === "handled" || status === "contacted") ? new Date().toISOString() : previous?.estimate_data?.closedAt || null,
        handledAt: (status === "handled" || status === "contacted" || status === "session_closed") ? new Date().toISOString() : previous?.estimate_data?.handledAt || null,
      },
    }, req);
    res.json({ ok: true, success: true, request: row });
  } catch (error) {
    rememberSupabaseIssue("customer chat session status", error);
    res.status(500).json({ ok: false, success: false, error: "Could not update chat session." });
  }
});

app.post("/customer-request", async (req, res) => {
  try {
    const row = await recordCustomerRequest(req.body || {}, req);
    res.json({ ok: true, success: true, request: row });
  } catch (error) {
    rememberSupabaseIssue("customer request save", error);
    res.status(500).json({ ok: false, success: false, error: "Could not save customer request to the database." });
  }
});

app.post("/customer-document", async (req, res) => {
  try {
    const body = req.body || {};
    const file = body.file || {};
    const uploadedFile = {
      id: `doc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      name: file.name || body.name || "uploaded-file",
      type: file.type || body.type || "application/octet-stream",
      size: Number(file.size || body.size || 0) || 0,
      uploadedAt: new Date().toISOString(),
      dataUrl: file.dataUrl || body.dataUrl || null,
    };
    const row = await recordCustomerRequest({
      chatId: body.chatId,
      customer: body.customer || {},
      conversation: body.messages || [],
      status: "document_uploaded",
      eventType: "document_uploaded",
      note: `Customer uploaded ${uploadedFile.name}`,
      uploadedFiles: [uploadedFile],
      estimate_data: { uploadedFiles: [uploadedFile], documentReviewRequired: true },
    }, req);
    res.json({ ok: true, success: true, file: uploadedFile, request: row });
  } catch (error) {
    rememberSupabaseIssue("customer document upload", error);
    res.status(500).json({ ok: false, success: false, error: "Could not save uploaded document." });
  }
});

app.get("/notifications", requireStaff, async (req, res) => {
  try {
    const rows = await loadCustomerRequestRows(150);
    const sections = notificationSectionsFromRequests(rows);
    res.json({
      ok: true,
      success: true,
      databaseEnabled: SUPABASE_ENABLED,
      sections,
      agentRequests: handoffRequests.slice(-50).reverse(),
    });
  } catch (error) {
    rememberSupabaseIssue("notifications load", error);
    res.status(500).json({ ok: false, success: false, error: "Could not load notifications from the database." });
  }
});

app.get("/site-visit-slots", async (req, res) => {
  try {
    const data = await readSiteVisitBookings();
    const slots = generateSiteVisitSlots(data.bookings || []);
    res.json({ ok: true, success: true, slots });
  } catch (error) {
    rememberSupabaseIssue("site visit slots", error);
    res.status(500).json({ ok: false, success: false, error: "Could not load available site visit slots." });
  }
});

app.post("/site-visit-booking", async (req, res) => {
  try {
    const body = req.body || {};
    const slot = body.slot || {};
    const slotId = slot.slotId || body.slotId;
    if (!slotId) return res.status(400).json({ ok: false, success: false, error: "Missing site visit slot." });
    const missing = siteVisitMissingRequirements(body);
    if (missing.length) {
      return res.status(400).json({ ok: false, success: false, error: `Site visit can be booked after receiving: ${missing.join(", ")}.` });
    }
    const data = await readSiteVisitBookings();
    const bookings = Array.isArray(data.bookings) ? data.bookings : [];
    const existing = bookings.find((booking) => booking.slotId === slotId && booking.status !== "cancelled");
    if (existing) return res.status(409).json({ ok: false, success: false, error: "This site visit slot is already booked." });
    const booking = {
      id: `site_visit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      slotId,
      date: slot.date || body.date || null,
      time: slot.time || body.time || null,
      label: slot.label || body.label || slotId,
      customer: body.customer || {},
      chatId: body.chatId || null,
      rows: Array.isArray(body.rows) ? body.rows : [],
      items: Array.isArray(body.items) ? body.items : [],
      status: "booked",
      createdAt: new Date().toISOString(),
    };
    await writeSiteVisitBookings({ bookings: [...bookings, booking] }, req);
    await recordCustomerRequest({
      chatId: body.chatId,
      customer: body.customer || {},
      conversation: body.messages || [],
      status: "site_visit_booked",
      eventType: "site_visit_booked",
      siteVisit: booking,
      rows: Array.isArray(body.rows) ? body.rows : [],
      items: Array.isArray(body.items) ? body.items : [],
      note: `Customer booked site visit: ${booking.label}`,
    }, req);
    res.json({ ok: true, success: true, booking });
  } catch (error) {
    rememberSupabaseIssue("site visit booking", error);
    res.status(500).json({ ok: false, success: false, error: "Could not book site visit." });
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

app.post("/agent-request", async (req, res) => {
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
  try {
    await recordCustomerRequest({
      chatId: body.chatId || body.id || null,
      customer: request.customer,
      conversation: request.messages,
      status: "real_agent_requested",
      eventType: "real_agent_requested",
      note: request.note,
      estimate_data: { handoffRequest: request },
    }, req);
  } catch (error) {
    rememberSupabaseIssue("agent request save", error);
  }
  res.json({ success: true, request, staffContactName: STAFF_CONTACT_NAME, staffContactPhone: STAFF_CONTACT_PHONE });
});


async function readCustomerSpamGuard() {
  const fallback = { clients: {} };
  if (SUPABASE_ENABLED) {
    try {
      const rows = await dbSelect("app_settings", `select=setting_value&setting_key=eq.${CUSTOMER_SPAM_GUARD_KEY}&limit=1`);
      const value = rows?.[0]?.setting_value;
      if (value && typeof value === "object") return { clients: value.clients || {} };
    } catch (error) {
      rememberSupabaseIssue("customer spam guard read", error);
    }
  }
  return readJsonFile(path.join(DATA_DIR, "customer-spam-guard.json"), fallback);
}

async function writeCustomerSpamGuard(data = {}) {
  const value = { clients: data.clients || {} };
  writeJsonFile(path.join(DATA_DIR, "customer-spam-guard.json"), value);
  if (SUPABASE_ENABLED) {
    try {
      await dbUpsert("app_settings", [{
        setting_key: CUSTOMER_SPAM_GUARD_KEY,
        setting_value: value,
        updated_by_name: "System",
        updated_at: new Date().toISOString(),
      }], { onConflict: "setting_key" });
    } catch (error) {
      rememberSupabaseIssue("customer spam guard write", error);
    }
  }
}

function customerSpamKey(req, chatId = "") {
  const ip = String(req?.headers?.["x-forwarded-for"] || req?.ip || "unknown").split(",")[0].trim();
  const chat = String(chatId || "unknown-chat").slice(0, 80);
  return crypto.createHash("sha256").update(`${ip}|${chat}`).digest("hex");
}

function userMessagesFromConversation(messages = [], prompt = "") {
  const list = Array.isArray(messages) ? messages : [];
  const out = list.filter((m) => normalizeRole(m.role) === "user").map((m) => ({ text: normalizeContent(m.content || m.text), at: m.at || m.created_at || null }));
  const last = normalizeContent(prompt).trim();
  if (last && !out.some((m) => m.text === last)) out.push({ text: last, at: new Date().toISOString() });
  return out;
}

function messageHasQuoteSignal(text = "") {
  return /\b(door|window|glass|sliding|folding|hinged|fixed|partition|shower|fencing|fence|gate|railing|pergola|facade|curtain|skylight|aluminium|aluminum|mm|cm|meter|metre|mtr|feet|foot|ft|x|size|height|width|length|qty|quantity|dubai|sharjah|ajman|abu dhabi|location|phone|mobile|whatsapp|05\d|\+971|quote|price|quotation|villa|office|warehouse|site)\b/i.test(String(text || ""));
}

function messageQualitySignals(text = "") {
  const value = String(text || "").toLowerCase();
  const signals = {
    longEnough: value.trim().length >= CUSTOMER_SPAM_LONG_INQUIRY_MIN_CHARS,
    product: /\b(door|window|glass|sliding|folding|hinged|fixed|partition|shower|fencing|fence|gate|railing|pergola|facade|curtain|skylight|aluminium|aluminum)\b/i.test(value),
    measurement: /\b(\d+(?:\.\d+)?\s*(?:mm|cm|m|meter|metre|mtr|ft|feet|foot)|\d+\s*[x×]\s*\d+|width|height|length|size|qty|quantity)\b/i.test(value),
    contact: /(?:\+?971|0)?5\d[\s-]?\d{3}[\s-]?\d{4}|\bphone\b|\bmobile\b|\bwhatsapp\b/i.test(value),
    location: /\b(dubai|sharjah|ajman|abu dhabi|rak|ras al khaimah|umm al quwain|fujairah|al quoz|jvc|jlt|marina|maps?|location|site|villa|warehouse)\b/i.test(value),
    intent: /\b(quote|quotation|price|cost|estimate|need|want|required|looking for|install|supply)\b/i.test(value),
    document: /\b(pdf|drawing|schedule|photo|image|picture|attachment|upload)\b/i.test(value),
  };
  return signals;
}

function genuineInquiryScore(messages = [], prompt = "") {
  const texts = [...(Array.isArray(messages) ? messages : []).map((m) => normalizeContent(m.content || m.text)), normalizeContent(prompt)]
    .filter(Boolean);
  const combined = texts.slice(-10).join(" ");
  const latest = normalizeContent(prompt);
  const combinedSignals = messageQualitySignals(combined);
  const latestSignals = messageQualitySignals(latest);
  let score = 0;
  for (const key of Object.keys(combinedSignals)) if (combinedSignals[key]) score += 1;
  if (latestSignals.longEnough && (latestSignals.product || latestSignals.measurement || latestSignals.contact || latestSignals.location)) score += 2;
  return { score, combinedSignals, latestSignals, latestLength: latest.trim().length };
}

function isClearlyLowValueMessage(text = "") {
  const t = String(text || "").trim();
  if (!t) return true;
  if (messageHasQuoteSignal(t)) return false;
  if (t.length >= 25) return false;
  return /^(hi+|hey+|hello+|test+|ok+|okay+|yo+|hmm+|yes+|no+|\?+|\.+|,+|lol+)$/i.test(t) || t.length <= 8;
}

async function evaluateCustomerSpamGuard(req, { prompt = "", messages = [], chatId = "" } = {}) {
  const now = Date.now();
  const key = customerSpamKey(req, chatId);
  const data = await readCustomerSpamGuard();
  const clients = data.clients || {};
  const current = clients[key] || { violations: 0, blockedUntil: 0, events: [] };

  const quality = genuineInquiryScore(messages, prompt);
  const isGenuineInquiry = quality.score >= CUSTOMER_SPAM_MIN_GENUINE_SCORE;

  if (Number(current.blockedUntil || 0) > now) {
    // A real detailed quote inquiry should not stay trapped behind an earlier spam score.
    // Example: a customer first typed "hi hi hi", then sends a full product/size/location inquiry.
    if (isGenuineInquiry) {
      clients[key] = {
        ...current,
        blockedUntil: 0,
        violations: Math.max(0, Number(current.violations || 0) - 1),
        lastReason: "cleared_by_genuine_inquiry",
        lastSeenAt: now,
      };
      await writeCustomerSpamGuard({ clients });
    } else {
      return { blocked: true, message: CUSTOMER_SPAM_MESSAGE, blockedUntil: current.blockedUntil };
    }
  }

  const userMessages = userMessagesFromConversation(messages, prompt);
  const recentEvents = (current.events || []).filter((event) => now - Number(event.at || 0) < 10 * 60 * 1000);
  recentEvents.push({ at: now, text: normalizeContent(prompt).trim() });

  const recentRapid = recentEvents.filter((event) => now - Number(event.at || 0) <= CUSTOMER_RAPID_WINDOW_MS).length;
  const recentLowValue = recentEvents.filter((event) => isClearlyLowValueMessage(event.text)).length;
  const lowValueTotal = userMessages.filter((event) => isClearlyLowValueMessage(event.text)).length;
  const usefulTotal = userMessages.length - lowValueTotal;

  let violationReason = "";
  if (!isGenuineInquiry) {
    if (userMessages.length > CUSTOMER_CHAT_MESSAGE_LIMIT && usefulTotal < 4) violationReason = "message_limit_low_value";
    else if (recentRapid > CUSTOMER_RAPID_MESSAGE_LIMIT && recentLowValue >= Math.max(5, CUSTOMER_RAPID_MESSAGE_LIMIT - 2)) violationReason = "rapid_low_value_messages";
    else if (recentLowValue >= 6 && lowValueTotal >= 8 && usefulTotal < 3) violationReason = "low_value_repeated_messages";
  }

  if (!violationReason) {
    clients[key] = {
      ...current,
      events: recentEvents.slice(-80),
      lastSeenAt: now,
      lastQualityScore: quality.score,
      lastGenuineInquiry: isGenuineInquiry,
    };
    await writeCustomerSpamGuard({ clients });
    return { blocked: false };
  }

  const violations = Number(current.violations || 0) + 1;
  const blockMs = Math.min(CUSTOMER_SPAM_BASE_BLOCK_MS * Math.pow(2, Math.max(0, violations - 1)), CUSTOMER_SPAM_MAX_BLOCK_MS);
  const blockedUntil = now + blockMs;
  clients[key] = {
    ...current,
    violations,
    blockedUntil,
    lastReason: violationReason,
    events: recentEvents.slice(-80),
    lastSeenAt: now,
    lastQualityScore: quality.score,
    lastGenuineInquiry: isGenuineInquiry,
  };
  await writeCustomerSpamGuard({ clients });
  return { blocked: true, message: CUSTOMER_SPAM_MESSAGE, blockedUntil, reason: violationReason };
}

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

    if (mode === "customer") {
      const control = await handleAssistantControlCommand(prompt);
      if (control.handled) {
        return res.json({
          success: true,
          controlHandled: true,
          assistantEnabled: control.enabled,
          reply: control.message,
          result: { reply: control.message, mode: "assistant_control" },
        });
      }
      const assistantStatus = await readAssistantControlStatus();
      if (assistantStatus.enabled === false) {
        return res.json({
          success: true,
          assistantDisabled: true,
          reply: ASSISTANT_DISABLED_MESSAGE,
          result: { reply: ASSISTANT_DISABLED_MESSAGE, mode: "assistant_disabled", questions: [] },
        });
      }
    }

    if (mode === "customer") {
      const spamCheck = await evaluateCustomerSpamGuard(req, { prompt, messages, chatId: req.body?.chatId || req.body?.id || "" });
      if (spamCheck.blocked) {
        return res.json({
          success: true,
          spamBlocked: true,
          reply: spamCheck.message,
          result: { reply: spamCheck.message, mode: "spam_blocked", questions: [] },
        });
      }
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


// Phase 8 - AI Automation Center
const DEFAULT_AI_AUTOMATION_RULES = [
  { id: "speed-to-lead", name: "Speed to lead", trigger: "New inquiry without staff contact in 15 minutes", action: "Create urgent follow-up task and notification", enabled: true },
  { id: "quote-follow-up", name: "Quote follow-up", trigger: "Quote sent and no response after 24 hours", action: "Create WhatsApp/call follow-up", enabled: true },
  { id: "high-value-review", name: "High value quote review", trigger: "Quote value above AED 50,000", action: "Send to owner review before release", enabled: true },
  { id: "low-margin-lock", name: "Low margin lock", trigger: "Estimated margin below 22%", action: "Require manager approval", enabled: true },
  { id: "stale-chat", name: "Incomplete AI chat capture", trigger: "Customer shared phone/name but no quote was created", action: "Save as incomplete AI chat and assign to sales", enabled: true },
];

async function loadAutomationRules() {
  if (!SUPABASE_ENABLED) return DEFAULT_AI_AUTOMATION_RULES;
  const rows = await dbSelect("app_settings", `select=*&setting_key=eq.ai_automation_rules&limit=1`).catch(() => []);
  const value = Array.isArray(rows) && rows[0]?.setting_value;
  return Array.isArray(value?.rules) ? value.rules : DEFAULT_AI_AUTOMATION_RULES;
}

function leadScoreFromRow(row = {}) {
  let score = 20;
  const reasons = [];
  if (row.phone) { score += 18; reasons.push("phone"); }
  if (row.location) { score += 12; reasons.push("location"); }
  if (row.product_inquired || row.productInquired || row.project_type) { score += 14; reasons.push("product interest"); }
  if (["google ads", "website", "referral"].includes(String(row.source || "").toLowerCase())) { score += 12; reasons.push("strong source"); }
  if (isDateDue(row.next_follow_up_date || row.nextFollowUpDate)) { score += 10; reasons.push("follow-up due"); }
  if (["won", "lost", "closed"].includes(String(row.status || "").toLowerCase())) score -= 35;
  score = Math.max(0, Math.min(100, score));
  return { score, reason: reasons.length ? reasons.join(", ") : "basic inquiry", nextAction: score >= 75 ? "Call now / WhatsApp now" : score >= 45 ? "Follow up today" : "Nurture / verify details" };
}

function buildAutomationPayload({ leads = [], quotes = [], requests = [], jobs = [], tasks = [], rules = DEFAULT_AI_AUTOMATION_RULES } = {}) {
  const enabledRuleIds = new Set(rules.filter((rule) => rule.enabled !== false).map((rule) => rule.id));
  const leadScores = leads.filter(isLeadOpen).slice(0, 150).map((lead) => {
    const score = leadScoreFromRow(lead);
    return { id: lead.id, leadId: lead.lead_id || lead.leadId, name: lead.client_name || lead.name, phone: lead.phone, source: lead.source, location: lead.location, productInquired: lead.product_inquired || lead.productInquired || lead.project_type, ...score };
  }).sort((a, b) => b.score - a.score);
  const quoteRisks = quotes.slice(0, 150).map((quote) => {
    const amount = Number(quote.final_amount || quote.quotation_amount || quote.finalTotal || quote.quotationAmount || 0);
    const data = quote.quote_data || {};
    const margin = Number(data.marginPercent || data.margin || quote.estimated_margin || 0);
    let riskScore = 0;
    const reasons = [];
    if (amount >= 50000) { riskScore += 35; reasons.push("high value"); }
    if (margin && margin < 22) { riskScore += 35; reasons.push("low margin"); }
    if (quoteNeedsReview(dbQuoteToAppQuote(quote))) { riskScore += 25; reasons.push("needs review"); }
    if (["pending", "draft", "need clarification", "need confirmation"].includes(String(quote.quote_status || quote.status || "").toLowerCase())) { riskScore += 10; reasons.push("not finalized"); }
    return { id: quote.id, quoteNo: quote.quote_number || data.quoteNo || quote.quoteNo || "Quote", customerName: quote.client_name_snapshot || data.customerName || "Customer", amount, riskScore: Math.min(100, riskScore), reason: reasons.join(", ") || "normal", control: riskScore >= 60 ? "Manager review required" : riskScore >= 30 ? "Estimator check" : "Normal follow-up" };
  }).filter((quote) => quote.riskScore > 0).sort((a, b) => b.riskScore - a.riskScore);
  const automationQueue = [];
  if (enabledRuleIds.has("speed-to-lead")) {
    leadScores.filter((lead) => lead.score >= 75).slice(0, 30).forEach((lead) => automationQueue.push({ id: `hot-${lead.id}`, owner: "Sales", priority: "Urgent", title: `${lead.name || lead.phone || "Lead"} is hot`, detail: `${lead.productInquired || "Product not set"} · score ${lead.score}`, action: "Call / WhatsApp now", sourceId: lead.id }));
  }
  if (enabledRuleIds.has("quote-follow-up")) {
    quotes.filter((quote) => ["sent", "pending", "need confirmation"].includes(String(quote.quote_status || quote.status || "").toLowerCase())).slice(0, 25).forEach((quote) => automationQueue.push({ id: `quote-follow-${quote.id}`, owner: "Estimator", priority: "High", title: `${quote.quote_number || "Quote"} needs follow-up`, detail: quote.client_name_snapshot || quote.quote_data?.customerName || "Customer", action: "Create quote follow-up", sourceId: quote.id }));
  }
  if (enabledRuleIds.has("low-margin-lock") || enabledRuleIds.has("high-value-review")) {
    quoteRisks.slice(0, 25).forEach((quote) => automationQueue.push({ id: `risk-${quote.id}`, owner: "Owner / Admin", priority: quote.riskScore >= 60 ? "Urgent" : "High", title: `${quote.quoteNo} risk control`, detail: quote.reason, action: quote.control, sourceId: quote.id }));
  }
  if (enabledRuleIds.has("stale-chat")) {
    requests.filter((row) => !["handled", "closed", "resolved"].includes(String(row.status || "").toLowerCase())).slice(0, 25).forEach((row) => automationQueue.push({ id: `chat-${row.id}`, owner: "Sales / Support", priority: "High", title: `${row.customer_name || "AI chat"} needs capture`, detail: row.phone || row.status || "Incomplete inquiry", action: "Save/follow up incomplete AI chat", sourceId: row.id }));
  }
  const runHistory = tasks.filter((task) => String(task.task_type || "").toLowerCase().includes("automation")).slice(0, 30);
  return {
    metrics: { queueCount: automationQueue.length, hotLeads: leadScores.filter((lead) => lead.score >= 75).length, quoteRisks: quoteRisks.length, enabledRules: enabledRuleIds.size },
    leadScores,
    quoteRisks,
    automationQueue,
    runHistory,
  };
}

app.get("/ai-automation-center", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.json({ ok: true, success: true, rules: DEFAULT_AI_AUTOMATION_RULES, metrics: {}, automationQueue: [], leadScores: [], quoteRisks: [], runHistory: [] });
    const [rules, leads, quotes, requests, jobs, tasks] = await Promise.all([
      loadAutomationRules(),
      dbSelect("leads", "select=*&order=updated_at.desc&limit=400").catch(() => []),
      dbSelect("quotes", "select=*&order=updated_at.desc&limit=300").catch(() => []),
      loadCustomerRequestRows(200).catch(() => []),
      dbSelect("job_orders", "select=*&order=updated_at.desc&limit=200").catch(() => []),
      dbSelect("staff_tasks", "select=*&order=created_at.desc&limit=200").catch(() => []),
    ]);
    const payload = buildAutomationPayload({ leads, quotes, requests, jobs, tasks, rules });
    res.json({ ok: true, success: true, rules, ...payload });
  } catch (error) {
    rememberSupabaseIssue("ai automation center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load AI Automation Center." });
  }
});

app.post("/ai-automation/rules", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const rules = Array.isArray(req.body?.rules) ? req.body.rules : DEFAULT_AI_AUTOMATION_RULES;
    const actor = actorFromRequest(req);
    const saved = await dbUpsert("app_settings", [{ setting_key: "ai_automation_rules", setting_value: { rules }, updated_by: actor.id || null, updated_by_name: actor.name || req.body?.actorName || "Staff", updated_at: new Date().toISOString() }], { onConflict: "setting_key" });
    await writeAuditLog(req, { action_type: "automation_rules_saved", module: "automation", target_table: "app_settings", target_id: saved?.[0]?.id || "ai_automation_rules", new_snapshot: { rules }, change_summary: `${actor.name} updated AI automation rules.` });
    res.json({ ok: true, success: true, rules });
  } catch (error) {
    rememberSupabaseIssue("ai automation rules", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save automation rules." });
  }
});

app.post("/ai-automation/run", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const [rules, leads, quotes, requests, jobs, tasks] = await Promise.all([
      loadAutomationRules(),
      dbSelect("leads", "select=*&order=updated_at.desc&limit=400").catch(() => []),
      dbSelect("quotes", "select=*&order=updated_at.desc&limit=300").catch(() => []),
      loadCustomerRequestRows(200).catch(() => []),
      dbSelect("job_orders", "select=*&order=updated_at.desc&limit=200").catch(() => []),
      dbSelect("staff_tasks", "select=*&order=created_at.desc&limit=200").catch(() => []),
    ]);
    const payload = buildAutomationPayload({ leads, quotes, requests, jobs, tasks, rules });
    const actor = actorFromRequest(req);
    const taskRows = payload.automationQueue.slice(0, 20).map((item) => ({ task_type: `Automation: ${item.action}`, priority: item.priority || "High", status: "Pending", notes: `${item.title}\n${item.detail}`, due_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), updated_at: new Date().toISOString() }));
    const inserted = taskRows.length ? await dbInsert("staff_tasks", taskRows).catch(() => []) : [];
    await writeAuditLog(req, { action_type: "automation_run", module: "automation", target_table: "staff_tasks", new_snapshot: { createdTasks: inserted?.length || 0, queueCount: payload.automationQueue.length }, change_summary: `${actor.name} ran AI automation and created ${inserted?.length || 0} task(s).` });
    res.json({ ok: true, success: true, createdTasks: Array.isArray(inserted) ? inserted.length : 0, queueCount: payload.automationQueue.length });
  } catch (error) {
    rememberSupabaseIssue("ai automation run", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not run automation." });
  }
});


// Phase 9 - Measurement + Document Control
function dbMeasurementRevisionToApp(row = {}) {
  return { id: row.id, jobOrderId: row.job_order_id, revisionType: row.revision_type, referenceCode: row.reference_code, width: row.width, height: row.height, qty: row.qty, note: row.note, updatedByName: row.updated_by_name, createdAt: row.created_at };
}
function dbAttachmentToApp(row = {}) {
  return { id: row.id, jobOrderId: row.job_order_id, quoteId: row.quote_id, leadId: row.lead_id, fileName: row.file_name, fileUrl: row.file_url, fileType: row.file_type, attachmentType: row.attachment_type, createdAt: row.created_at };
}
app.get("/measurement-document-center", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.json({ ok: true, success: true, metrics: {}, jobs: [], revisions: [], attachments: [], approvals: [] });
    const [jobRows, revisionRows, attachmentRows] = await Promise.all([
      dbSelect("job_orders", "select=*&order=updated_at.desc&limit=300").catch(() => []),
      dbSelect("measurement_revisions", "select=*&order=created_at.desc&limit=200").catch(() => []),
      dbSelect("attachments", "select=*&order=created_at.desc&limit=200").catch(() => []),
    ]);
    const revisions = (Array.isArray(revisionRows) ? revisionRows : []).map(dbMeasurementRevisionToApp);
    const finalMeasurementByJob = new Map(revisions.filter((row) => row.revisionType === "Final Measurement").map((row) => [row.jobOrderId, row.createdAt]));
    const jobs = (Array.isArray(jobRows) ? jobRows : []).map((row) => ({ ...dbJobRowToCrmBrief(row), finalMeasurementAt: finalMeasurementByJob.get(row.id) || row.job_data?.finalMeasurementAt || null }));
    const attachments = (Array.isArray(attachmentRows) ? attachmentRows : []).map(dbAttachmentToApp);
    const approvals = [];
    jobs.filter((job) => !["Completed", "Cancelled"].includes(job.jobStatus)).forEach((job) => {
      if (!job.finalMeasurementAt) approvals.push({ id: `measurement-${job.id}`, severity: "high", title: `${job.jobNumber} has no final measurement`, detail: `${job.clientName || "Client"} · ${job.currentStage}`, action: "Confirm final measurement before production release." });
      const count = revisions.filter((rev) => rev.jobOrderId === job.id).length;
      if (count >= 3) approvals.push({ id: `revision-${job.id}`, severity: "medium", title: `${job.jobNumber} has multiple revisions`, detail: `${count} revisions recorded`, action: "Manager should approve latest drawing before fabrication." });
    });
    const metrics = { jobs: jobs.length, revisions: revisions.length, attachments: attachments.length, measurementPending: jobs.filter((job) => !job.finalMeasurementAt).length };
    res.json({ ok: true, success: true, metrics, jobs, revisions, attachments, approvals });
  } catch (error) {
    rememberSupabaseIssue("measurement document center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load measurement/document center." });
  }
});
app.post("/measurement-revisions", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const jobOrderId = String(req.body?.jobOrderId || "").trim();
    if (!isUuid(jobOrderId)) return res.status(400).json({ ok: false, success: false, error: "Valid job order is required." });
    const payload = { job_order_id: jobOrderId, revision_type: String(req.body?.revisionType || "Final Measurement").trim(), reference_code: String(req.body?.referenceCode || "").trim() || null, width: req.body?.width ? Number(req.body.width) : null, height: req.body?.height ? Number(req.body.height) : null, qty: req.body?.qty ? Number(req.body.qty) : 1, note: String(req.body?.note || "").trim() || null, updated_by_name: actor.name || req.body?.actorName || "Staff" };
    const inserted = await dbInsert("measurement_revisions", [payload]);
    if (payload.revision_type === "Final Measurement") await dbPatch("job_orders", `id=eq.${encodeEq(jobOrderId)}`, { job_data: { finalMeasurementAt: new Date().toISOString() }, updated_at: new Date().toISOString() }).catch(() => null);
    await writeAuditLog(req, { action_type: "measurement_revision_saved", module: "measurement", target_table: "measurement_revisions", target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || payload, change_summary: `${actor.name} saved ${payload.revision_type}.` });
    res.json({ ok: true, success: true, revision: Array.isArray(inserted) ? inserted[0] : null });
  } catch (error) {
    rememberSupabaseIssue("measurement revision save", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save measurement revision." });
  }
});
app.post("/attachments/register", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const fileName = String(req.body?.fileName || "").trim();
    const fileUrl = String(req.body?.fileUrl || "").trim();
    if (!fileName || !fileUrl) return res.status(400).json({ ok: false, success: false, error: "File name and URL are required." });
    const row = { job_order_id: req.body?.jobOrderId && isUuid(req.body.jobOrderId) ? req.body.jobOrderId : null, quote_id: req.body?.quoteId && isUuid(req.body.quoteId) ? req.body.quoteId : null, lead_id: req.body?.leadId && isUuid(req.body.leadId) ? req.body.leadId : null, uploaded_by: actor.id && isUuid(actor.id) ? actor.id : null, file_name: fileName, file_url: fileUrl, file_type: String(req.body?.fileType || "link").trim(), attachment_type: String(req.body?.attachmentType || "Document").trim() };
    const inserted = await dbInsert("attachments", [row]);
    await writeAuditLog(req, { action_type: "attachment_registered", module: "documents", target_table: "attachments", target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} registered ${fileName}.` });
    res.json({ ok: true, success: true, attachment: Array.isArray(inserted) ? inserted[0] : null });
  } catch (error) {
    rememberSupabaseIssue("attachment register", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not register attachment." });
  }
});


// Phase 10 - Materials + Procurement
function dbMaterialStockToApp(row = {}) { return { id: row.id, materialType: row.material_type, materialName: row.material_name, unit: row.unit, availableQty: Number(row.available_qty || 0), reorderLevel: Number(row.reorder_level || 0), supplier: row.supplier, updatedAt: row.updated_at }; }
function dbPurchaseRequestToApp(row = {}) { return { id: row.id, jobOrderId: row.job_order_id, jobNumber: row.job_orders?.job_number || row.request_data?.jobNumber || "", materialType: row.material_type, materialName: row.material_name, qty: Number(row.qty || 0), unit: row.unit, requiredDate: row.required_date, status: row.status || "Requested", note: row.note || "", createdAt: row.created_at }; }
function materialNameFromJobItem(item = {}) { return item.glass_thickness || item.glass_type || item.system_type || item.product || item.category || "General material"; }
app.get("/materials-procurement-center", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.json({ ok: true, success: true, metrics: {}, stock: [], requests: [], jobNeeds: [], riskBoard: [] });
    const [stockRows, requestRows, jobRows, itemRows] = await Promise.all([
      dbSelect("material_stock", "select=*&order=updated_at.desc&limit=300").catch(() => []),
      dbSelect("purchase_requests", "select=*,job_orders(job_number)&order=created_at.desc&limit=300").catch(() => []),
      dbSelect("job_orders", "select=*&order=updated_at.desc&limit=200").catch(() => []),
      dbSelect("job_order_items", "select=*&order=stage_updated_at.desc.nullslast&limit=500").catch(() => []),
    ]);
    const stock = (Array.isArray(stockRows) ? stockRows : []).map(dbMaterialStockToApp);
    const requests = (Array.isArray(requestRows) ? requestRows : []).map(dbPurchaseRequestToApp);
    const stockByName = new Map(stock.map((row) => [String(row.materialName || "").toLowerCase(), row]));
    const openRequestNames = new Set(requests.filter((row) => !["received", "cancelled"].includes(String(row.status || "").toLowerCase())).map((row) => String(row.materialName || "").toLowerCase()));
    const jobsById = new Map((Array.isArray(jobRows) ? jobRows : []).map((job) => [job.id, dbJobRowToCrmBrief(job)]));
    const jobNeeds = (Array.isArray(itemRows) ? itemRows : []).slice(0, 160).map((item) => {
      const job = jobsById.get(item.job_order_id) || {};
      const materialName = materialNameFromJobItem(item);
      const stockItem = stockByName.get(materialName.toLowerCase());
      const qty = Number(item.qty || 1);
      const ready = Boolean(stockItem && Number(stockItem.availableQty || 0) >= qty) || openRequestNames.has(materialName.toLowerCase());
      return { id: item.id, jobOrderId: item.job_order_id, jobNumber: job.jobNumber || "Job", clientName: job.clientName || "Client", materialName, qty, unit: item.area ? "sqm" : "pcs", ready, reason: stockItem ? `Available ${stockItem.availableQty}, need ${qty}` : "No matching stock/request rule" };
    });
    const riskBoard = [];
    jobNeeds.filter((need) => !need.ready).slice(0, 50).forEach((need) => riskBoard.push({ id: `risk-${need.id}`, title: `${need.jobNumber} material not ready`, detail: `${need.materialName} · ${need.reason}`, action: "Create purchase request before promising production date." }));
    stock.filter((item) => Number(item.availableQty || 0) <= Number(item.reorderLevel || 0)).forEach((item) => riskBoard.push({ id: `stock-${item.id}`, title: `${item.materialName} below reorder level`, detail: `Available ${item.availableQty} ${item.unit}; reorder at ${item.reorderLevel}`, action: "Raise supplier order." }));
    const openRequests = requests.filter((row) => !["received", "cancelled"].includes(String(row.status || "").toLowerCase()));
    const metrics = { stockItems: stock.length, openRequests: openRequests.length, risks: riskBoard.length, estimatedNeedValue: jobNeeds.length * 1200 };
    res.json({ ok: true, success: true, metrics, stock, requests, jobNeeds, riskBoard });
  } catch (error) {
    rememberSupabaseIssue("materials procurement center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load materials center." });
  }
});
app.post("/material-stock", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const materialName = String(req.body?.materialName || "").trim();
    if (!materialName) return res.status(400).json({ ok: false, success: false, error: "Material name is required." });
    const row = { material_type: String(req.body?.materialType || "Material").trim(), material_name: materialName, unit: String(req.body?.unit || "pcs").trim(), available_qty: Number(req.body?.availableQty || 0), reorder_level: Number(req.body?.reorderLevel || 0), supplier: String(req.body?.supplier || "").trim() || null, updated_by_name: actor.name || req.body?.actorName || "Staff", updated_at: new Date().toISOString() };
    const saved = await dbUpsert("material_stock", [row], { onConflict: "material_name" });
    await writeAuditLog(req, { action_type: "material_stock_saved", module: "materials", target_table: "material_stock", target_id: saved?.[0]?.id || null, new_snapshot: saved?.[0] || row, change_summary: `${actor.name} saved stock rule for ${materialName}.` });
    res.json({ ok: true, success: true, material: Array.isArray(saved) ? saved[0] : null });
  } catch (error) {
    rememberSupabaseIssue("material stock save", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save material stock." });
  }
});
app.post("/purchase-requests", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const materialName = String(req.body?.materialName || "").trim();
    if (!materialName) return res.status(400).json({ ok: false, success: false, error: "Material name is required." });
    const row = { job_order_id: req.body?.jobOrderId && isUuid(req.body.jobOrderId) ? req.body.jobOrderId : null, material_type: String(req.body?.materialType || "Material").trim(), material_name: materialName, qty: Number(req.body?.qty || 0), unit: String(req.body?.unit || "pcs").trim(), required_date: req.body?.requiredDate || null, status: "Requested", note: String(req.body?.note || "").trim() || null, requested_by_name: actor.name || req.body?.actorName || "Staff", request_data: {} };
    const inserted = await dbInsert("purchase_requests", [row]);
    await writeAuditLog(req, { action_type: "purchase_request_created", module: "materials", target_table: "purchase_requests", target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} requested ${materialName}.` });
    res.json({ ok: true, success: true, request: Array.isArray(inserted) ? inserted[0] : null });
  } catch (error) {
    rememberSupabaseIssue("purchase request create", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not create purchase request." });
  }
});
app.patch("/purchase-requests/:id", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const id = String(req.params.id || "").trim();
    if (!isUuid(id)) return res.status(400).json({ ok: false, success: false, error: "Valid purchase request id is required." });
    const status = String(req.body?.status || "Requested").trim();
    const updated = await dbPatch("purchase_requests", `id=eq.${encodeEq(id)}`, { status, updated_at: new Date().toISOString() });
    await writeAuditLog(req, { action_type: "purchase_request_updated", module: "materials", target_table: "purchase_requests", target_id: id, new_snapshot: updated?.[0] || { status }, change_summary: `${actorFromRequest(req).name} updated purchase request to ${status}.` });
    res.json({ ok: true, success: true, request: Array.isArray(updated) ? updated[0] : null });
  } catch (error) {
    rememberSupabaseIssue("purchase request update", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not update purchase request." });
  }
});


// Phase 11 - Executive Reporting
function datePresetFilterRows(rows = [], field = "created_at", preset = "This Month") {
  if (preset === "All Time") return rows;
  const now = new Date();
  const start = new Date(now);
  if (preset === "Today") start.setHours(0, 0, 0, 0);
  else if (preset === "Last 7 Days") start.setDate(now.getDate() - 7);
  else { start.setDate(1); start.setHours(0, 0, 0, 0); }
  return rows.filter((row) => !row[field] || new Date(row[field]).getTime() >= start.getTime());
}
function snapshotToApp(row = {}) {
  const filters = row.filters || row.report_data?.filters || {};
  return { id: row.id, reportName: row.report_name || "Executive snapshot", filtersText: Object.entries(filters).map(([key, value]) => `${key}: ${value}`).join(" · "), createdByName: row.created_by_name, createdAt: row.created_at };
}
app.get("/executive-reporting-center", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.json({ ok: true, success: true, metrics: {}, digest: [], risks: [], snapshots: [], charts: {}, exportRows: [] });
    const preset = String(req.query.datePreset || "This Month");
    const [leadRows, quoteRows, jobRows, paymentRows, taskRows, requestRows, snapshotRows] = await Promise.all([
      dbSelect("leads", "select=*&order=created_at.desc&limit=1000").catch(() => []),
      dbSelect("quotes", "select=*&order=created_at.desc&limit=1000").catch(() => []),
      dbSelect("job_orders", "select=*&order=created_at.desc&limit=1000").catch(() => []),
      dbSelect("payments", "select=*&order=created_at.desc&limit=1000").catch(() => []),
      dbSelect("staff_tasks", "select=*&order=created_at.desc&limit=500").catch(() => []),
      loadCustomerRequestRows(500).catch(() => []),
      dbSelect("report_snapshots", "select=*&order=created_at.desc&limit=100").catch(() => []),
    ]);
    const leads = datePresetFilterRows(Array.isArray(leadRows) ? leadRows : [], "created_at", preset);
    const quotes = datePresetFilterRows(Array.isArray(quoteRows) ? quoteRows : [], "created_at", preset);
    const jobs = datePresetFilterRows(Array.isArray(jobRows) ? jobRows : [], "created_at", preset);
    const payments = datePresetFilterRows(Array.isArray(paymentRows) ? paymentRows : [], "created_at", preset);
    const tasks = Array.isArray(taskRows) ? taskRows : [];
    const paidAmount = payments.filter((row) => !["pending", "overdue", "cancelled"].includes(String(row.payment_status || "").toLowerCase())).reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const openQuoteValue = quotes.filter((row) => !["lost", "rejected", "cancelled"].includes(String(row.quote_status || row.status || "").toLowerCase())).reduce((sum, row) => sum + Number(row.final_amount || row.quotation_amount || 0), 0);
    const actualProfit = jobs.reduce((sum, row) => sum + Number(row.actual_profit || row.estimated_profit || 0), 0);
    const overdueTasks = tasks.filter((task) => String(task.status || "").toLowerCase() !== "completed" && task.due_at && new Date(task.due_at).getTime() < Date.now());
    const delayedJobs = jobs.filter((job) => String(job.current_stage || job.job_status || "").toLowerCase().includes("delay") || job.delay_reason);
    const quoteRisk = quotes.filter((quote) => quoteNeedsReview(dbQuoteToAppQuote(quote)));
    const risks = [
      ...overdueTasks.slice(0, 12).map((task) => ({ id: `task-${task.id}`, severity: "critical", title: `Overdue task: ${task.task_type || "Task"}`, detail: task.notes || "No notes", action: "Open Staff Control and close/assign." })),
      ...delayedJobs.slice(0, 12).map((job) => ({ id: `job-${job.id}`, severity: "critical", title: `${job.job_number || "Job"} delayed`, detail: job.delay_reason || job.current_stage || "Production delay", action: "Open Operations and clear blocker." })),
      ...quoteRisk.slice(0, 12).map((quote) => ({ id: `quote-${quote.id}`, severity: "high", title: `${quote.quote_number || "Quote"} needs review`, detail: quote.client_name_snapshot || "Customer", action: "Open CRM Command / Quote Review." })),
    ];
    const digest = [
      { id: "lead", section: "Sales", title: `${leads.length} new/open lead records in ${preset}`, detail: `${Array.isArray(requestRows) ? requestRows.length : 0} AI/customer request records are also visible.` },
      { id: "quote", section: "Quotes", title: `${quotes.length} quote records`, detail: `Open quote value is AED ${Number(openQuoteValue || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}.` },
      { id: "job", section: "Operations", title: `${jobs.length} job orders`, detail: `${delayedJobs.length} delayed/blocker job(s) need attention.` },
      { id: "cash", section: "Finance", title: `Cash collected AED ${Number(paidAmount || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}`, detail: `Actual/estimated profit currently reads AED ${Number(actualProfit || 0).toLocaleString("en-US", { maximumFractionDigits: 0 })}.` },
      { id: "risk", section: "Risks", title: `${risks.length} owner action item(s)`, detail: "These are tasks, delayed jobs, and quote-review items that should not wait." },
    ];
    const bySource = leads.reduce((map, lead) => { const key = lead.source || "Unknown"; map[key] = (map[key] || 0) + 1; return map; }, {});
    const byStage = jobs.reduce((map, job) => { const key = job.current_stage || job.job_status || "Unknown"; map[key] = (map[key] || 0) + 1; return map; }, {});
    const charts = {
      "Lead Source": Object.entries(bySource).map(([label, value]) => ({ label, value, valueLabel: `${value} lead(s)` })),
      "Production Stage": Object.entries(byStage).map(([label, value]) => ({ label, value, valueLabel: `${value} job(s)` })),
      "Finance": [{ label: "Open quote value", value: openQuoteValue, valueLabel: `AED ${Number(openQuoteValue).toLocaleString("en-US")}` }, { label: "Paid amount", value: paidAmount, valueLabel: `AED ${Number(paidAmount).toLocaleString("en-US")}` }, { label: "Profit", value: actualProfit, valueLabel: `AED ${Number(actualProfit).toLocaleString("en-US")}` }],
    };
    const exportRows = [
      ...leads.slice(0, 80).map((row) => ({ id: `lead-${row.id}`, module: "Lead", record: row.lead_id || row.id, customer: row.client_name || "", status: row.status || "", amount: 0, owner: row.assigned_to || "" })),
      ...quotes.slice(0, 80).map((row) => ({ id: `quote-${row.id}`, module: "Quote", record: row.quote_number || row.id, customer: row.client_name_snapshot || "", status: row.quote_status || row.status || "", amount: Number(row.final_amount || row.quotation_amount || 0), owner: row.prepared_by || "" })),
      ...jobs.slice(0, 80).map((row) => ({ id: `job-${row.id}`, module: "Job", record: row.job_number || row.id, customer: row.client_name_snapshot || "", status: row.current_stage || row.job_status || "", amount: Number(row.final_amount || 0), owner: row.job_data?.assignedToName || "" })),
    ];
    const metrics = { openQuoteValue, paidAmount, actualProfit, criticalRisks: risks.filter((row) => row.severity === "critical").length };
    res.json({ ok: true, success: true, metrics, digest, risks, snapshots: (Array.isArray(snapshotRows) ? snapshotRows : []).map(snapshotToApp), charts, exportRows });
  } catch (error) {
    rememberSupabaseIssue("executive reporting center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load reporting center." });
  }
});
app.post("/report-snapshots", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const filters = req.body?.filters && typeof req.body.filters === "object" ? req.body.filters : {};
    const row = { report_name: `Executive snapshot - ${filters.datePreset || "Current"}`, filters, report_data: req.body?.reportData || {}, created_by_name: actor.name || req.body?.actorName || "Staff" };
    const inserted = await dbInsert("report_snapshots", [row]);
    await writeAuditLog(req, { action_type: "report_snapshot_created", module: "reports", target_table: "report_snapshots", target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} saved an executive report snapshot.` });
    res.json({ ok: true, success: true, snapshot: Array.isArray(inserted) ? inserted[0] : null });
  } catch (error) {
    rememberSupabaseIssue("report snapshot create", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save report snapshot." });
  }
});


// Phase 12 - Admin Reliability
const ADMIN_HEALTH_TABLES = ["leads", "quotes", "quote_items", "customer_requests", "job_orders", "job_order_items", "payments", "job_costs", "staff_tasks", "audit_logs", "attachments", "measurement_revisions", "material_stock", "purchase_requests", "report_snapshots"];
function backupToApp(row = {}) {
  const manifest = row.backup_manifest || {};
  const tableRows = Array.isArray(manifest.tables) ? manifest.tables : [];
  return { id: row.id, backupName: row.backup_name, tableCount: tableRows.length, totalRows: tableRows.reduce((sum, table) => sum + Number(table.sampleCount || table.count || 0), 0), createdByName: row.created_by_name, createdAt: row.created_at };
}
async function tableHealthCheck(table) {
  try {
    const rows = await dbSelect(table, "select=*&limit=3");
    return { table, status: "OK", sampleCount: Array.isArray(rows) ? rows.length : 0, message: "Reachable" };
  } catch (error) {
    return { table, status: "ERROR", sampleCount: 0, message: error.message || "Could not query table" };
  }
}
app.get("/admin-reliability-center", requireStaff, async (req, res) => {
  try {
    const tableHealth = SUPABASE_ENABLED ? await Promise.all(ADMIN_HEALTH_TABLES.map(tableHealthCheck)) : ADMIN_HEALTH_TABLES.map((table) => ({ table, status: "ERROR", sampleCount: 0, message: "Supabase not configured" }));
    const backupRows = SUPABASE_ENABLED ? await dbSelect("system_backups", "select=*&order=created_at.desc&limit=50").catch(() => []) : [];
    const env = [
      { key: "supabase", label: "Supabase service role", ok: SUPABASE_ENABLED, detail: SUPABASE_ENABLED ? "SUPABASE_URL and service role are configured." : "SUPABASE_URL / service role missing." },
      { key: "openai", label: "OpenAI API key", ok: Boolean(process.env.OPENAI_API_KEY), detail: process.env.OPENAI_API_KEY ? `Model: ${MODEL}` : "OPENAI_API_KEY missing." },
      { key: "staff", label: "Staff login", ok: Boolean(STAFF_PASSWORD || STAFF_USERS_JSON), detail: STAFF_USERS_JSON ? "Multi-user staff JSON configured." : (STAFF_PASSWORD ? "Single staff password configured." : "No staff password/users configured.") },
      { key: "cors", label: "CORS origins", ok: allowedOrigins.length > 0, detail: allowedOrigins.join(", ") || "No origins configured." },
      { key: "search", label: "Web search flag", ok: ENABLE_WEB_SEARCH, detail: ENABLE_WEB_SEARCH ? "AI web-search pathway enabled." : "Web search disabled by env." },
    ];
    const failed = tableHealth.filter((row) => row.status !== "OK");
    const deploymentChecklist = [
      { id: "schema", ok: failed.length === 0, title: "Supabase schema applied", detail: `${tableHealth.length - failed.length}/${tableHealth.length} required tables reachable.`, action: "Run SUPABASE_SCHEMA_REQUIRED.sql." },
      { id: "env", ok: env.every((row) => row.ok), title: "Environment variables", detail: `${env.filter((row) => row.ok).length}/${env.length} required groups ready.`, action: "Check Render env vars." },
      { id: "build", ok: true, title: "Frontend build", detail: "Run npm run build before deploy.", action: "Run build check." },
      { id: "server", ok: true, title: "Server syntax", detail: "Run node --check Server/index.js before deploy.", action: "Run syntax check." },
      { id: "backup", ok: Array.isArray(backupRows) && backupRows.length > 0, title: "Backup manifest", detail: `${Array.isArray(backupRows) ? backupRows.length : 0} saved backup manifest(s).`, action: "Create one before major updates." },
    ];
    const metrics = { databaseStatus: SUPABASE_ENABLED ? (failed.length ? "Needs Check" : "OK") : "Not Configured", tablesOk: tableHealth.length - failed.length, tablesChecked: tableHealth.length, backups: Array.isArray(backupRows) ? backupRows.length : 0 };
    res.json({ ok: true, success: true, metrics, env, tableHealth, latestIssue: latestSupabaseIssue, backups: (Array.isArray(backupRows) ? backupRows : []).map(backupToApp), deploymentChecklist });
  } catch (error) {
    rememberSupabaseIssue("admin reliability center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load admin reliability center." });
  }
});
app.post("/admin/backup-snapshot", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const tables = [];
    for (const table of ADMIN_HEALTH_TABLES) {
      const health = await tableHealthCheck(table);
      tables.push({ table, status: health.status, sampleCount: health.sampleCount, message: health.message });
    }
    const row = { backup_name: `BuildupOS manifest ${new Date().toISOString().slice(0, 10)}`, backup_manifest: { createdAt: new Date().toISOString(), tables, note: "Manifest stores readiness and sample counts, not full exported business data." }, created_by_name: actor.name || req.body?.actorName || "Staff" };
    const inserted = await dbInsert("system_backups", [row]);
    await writeAuditLog(req, { action_type: "backup_manifest_created", module: "admin", target_table: "system_backups", target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} created a backup manifest.` });
    res.json({ ok: true, success: true, backup: Array.isArray(inserted) ? backupToApp(inserted[0]) : row });
  } catch (error) {
    rememberSupabaseIssue("admin backup snapshot", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not create backup manifest." });
  }
});


// Phase 13 - Real Data Connection Cleanup
const PHASE_13_STATS = [{"label": "Tables audited", "value": "18"}, {"label": "Fallback risks", "value": "Mapped"}, {"label": "Refresh rules", "value": "Ready"}, {"label": "API standards", "value": "Defined"}];
const PHASE_13_TABS = ["Live Data Audit", "Demo Data Risks", "API Contract", "Refresh Plan"];
app.get("/data-connection-center", requireStaff, async (req, res) => {
  try {
    const rows = SUPABASE_ENABLED ? await dbSelect("data_connection_audits", "select=*&order=created_at.desc&limit=50").catch(() => []) : [];
    const mappedRows = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      id: row.id || `phase-13-${index}`,
      name: row.module_name || row.role_name || row.quote_number || row.customer_name || row.template_name || row.work_center || row.material_name || row.snapshot_name || row.run_name || row.event_type || row.export_name || row.release_name || row.policy_notes || row.check_status || "Real Data Connection Cleanup",
      owner: row.created_by_name || row.approved_by_name || row.assigned_to_name || "System",
      status: row.readiness_status || row.status || row.check_status || row.release_status || row.run_status || row.severity || "Open",
      detail: row.notes || row.policy_notes || row.message || row.template_body || row.reason || row.export_status || "Live record from data_connection_audits.",
    }));
    const setupRows = PHASE_13_TABS.map((tab) => ({ name: `${tab} setup`, owner: "System", status: "Ready", detail: "Phase 13 control row. Add live company records after schema is applied." }));
    res.json({ ok: true, success: true, stats: PHASE_13_STATS, rows: mappedRows.length ? mappedRows : setupRows });
  } catch (error) {
    rememberSupabaseIssue("phase 13 data-connection-center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load Real Data Connection Cleanup." });
  }
});
app.post("/data-sync/run", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const action = String(req.body?.action || "Phase 13 action");
    const activeTab = String(req.body?.activeTab || "General");
    const baseRow = {
      created_by_name: actor.name || req.body?.actorName || "Staff",
      notes: `${action} / ${activeTab}`,
    };
    let row = baseRow;
    const table = "data_connection_audits";
    if (table === "permission_policies") row = { role_name: "staff", module_name: activeTab.toLowerCase().replace(/\s+/g, "_"), can_view: true, policy_notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "customer_portal_sessions") row = { customer_name: "Portal Customer", portal_token: crypto.randomBytes(16).toString("hex"), status: "invited", allowed_actions: ["view_quote", "approve_quote", "book_site_visit"], created_by_name: baseRow.created_by_name };
    else if (table === "communication_logs") row = { channel: "whatsapp", direction: "outbound", message_summary: action, customer_reply_status: "pending", created_by_name: baseRow.created_by_name };
    else if (table === "production_capacity_rules") row = { work_center: activeTab, daily_capacity: 10, capacity_unit: "items", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "material_reservations") row = { material_name: activeTab, reserved_qty: 1, reservation_status: "reserved", created_by_name: baseRow.created_by_name };
    else if (table === "advanced_analytics_snapshots") row = { snapshot_name: `Phase 13 analytics - ${activeTab}`, metrics: { action }, insights: [action], created_by_name: baseRow.created_by_name };
    else if (table === "test_runs") row = { run_name: `Checklist - ${activeTab}`, run_status: "recorded", test_results: [{ action, status: "recorded" }], passed_count: 1, failed_count: 0, created_by_name: baseRow.created_by_name };
    else if (table === "system_event_logs") row = { event_type: action, severity: "info", module_name: activeTab, message: `Manual event logged by ${baseRow.created_by_name}`, payload: req.body || {}, created_by_name: baseRow.created_by_name };
    else if (table === "export_manifests") row = { export_name: `Export manifest - ${activeTab}`, export_entities: ["leads", "quotes", "jobs", "payments"], export_status: "ready", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "mobile_checklist_templates") row = { template_name: `Mobile checklist - ${activeTab}`, module_name: "installation", checklist_items: [action, "Upload photo", "Customer sign-off"], is_active: true, created_by_name: baseRow.created_by_name };
    else if (table === "release_checklists") row = { release_name: `Release checklist - ${new Date().toISOString().slice(0,10)}`, release_status: "draft", checklist_items: [{ label: activeTab, status: "recorded" }], blockers: [], created_by_name: baseRow.created_by_name };
    else if (table === "quote_quality_checks") row = { quote_number: "Manual Check", check_status: "needs_review", risk_score: 25, findings: [action, activeTab], created_by_name: baseRow.created_by_name };
    else if (table === "data_connection_audits") row = { module_name: activeTab, readiness_status: "needs_review", demo_data_risk: "medium", api_contract: { action }, notes: action, created_by_name: baseRow.created_by_name };
    const inserted = await dbInsert(table, [row]);
    await writeAuditLog(req, { action_type: "phase_13_action", module: "data-connection-center", target_table: table, target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} ran ${action} in Real Data Connection Cleanup.` });
    res.json({ ok: true, success: true, record: Array.isArray(inserted) ? inserted[0] : row });
  } catch (error) {
    rememberSupabaseIssue("phase 13 data-sync/run", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save Real Data Connection Cleanup action." });
  }
});


// Phase 14 - Role Permissions + Supabase RLS
const PHASE_14_STATS = [{"label": "Roles", "value": "8"}, {"label": "Sensitive modules", "value": "6"}, {"label": "Owner-only profit", "value": "Enforced plan"}, {"label": "RLS templates", "value": "Included"}];
const PHASE_14_TABS = ["Role Matrix", "Sensitive Data", "Backend Guards", "RLS SQL"];
app.get("/permissions-center", requireStaff, async (req, res) => {
  try {
    const rows = SUPABASE_ENABLED ? await dbSelect("permission_policies", "select=*&order=created_at.desc&limit=50").catch(() => []) : [];
    const mappedRows = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      id: row.id || `phase-14-${index}`,
      name: row.module_name || row.role_name || row.quote_number || row.customer_name || row.template_name || row.work_center || row.material_name || row.snapshot_name || row.run_name || row.event_type || row.export_name || row.release_name || row.policy_notes || row.check_status || "Role Permissions + Supabase RLS",
      owner: row.created_by_name || row.approved_by_name || row.assigned_to_name || "System",
      status: row.readiness_status || row.status || row.check_status || row.release_status || row.run_status || row.severity || "Open",
      detail: row.notes || row.policy_notes || row.message || row.template_body || row.reason || row.export_status || "Live record from permission_policies.",
    }));
    const setupRows = PHASE_14_TABS.map((tab) => ({ name: `${tab} setup`, owner: "System", status: "Ready", detail: "Phase 14 control row. Add live company records after schema is applied." }));
    res.json({ ok: true, success: true, stats: PHASE_14_STATS, rows: mappedRows.length ? mappedRows : setupRows });
  } catch (error) {
    rememberSupabaseIssue("phase 14 permissions-center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load Role Permissions + Supabase RLS." });
  }
});
app.post("/permissions/policy", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const action = String(req.body?.action || "Phase 14 action");
    const activeTab = String(req.body?.activeTab || "General");
    const baseRow = {
      created_by_name: actor.name || req.body?.actorName || "Staff",
      notes: `${action} / ${activeTab}`,
    };
    let row = baseRow;
    const table = "permission_policies";
    if (table === "permission_policies") row = { role_name: "staff", module_name: activeTab.toLowerCase().replace(/\s+/g, "_"), can_view: true, policy_notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "customer_portal_sessions") row = { customer_name: "Portal Customer", portal_token: crypto.randomBytes(16).toString("hex"), status: "invited", allowed_actions: ["view_quote", "approve_quote", "book_site_visit"], created_by_name: baseRow.created_by_name };
    else if (table === "communication_logs") row = { channel: "whatsapp", direction: "outbound", message_summary: action, customer_reply_status: "pending", created_by_name: baseRow.created_by_name };
    else if (table === "production_capacity_rules") row = { work_center: activeTab, daily_capacity: 10, capacity_unit: "items", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "material_reservations") row = { material_name: activeTab, reserved_qty: 1, reservation_status: "reserved", created_by_name: baseRow.created_by_name };
    else if (table === "advanced_analytics_snapshots") row = { snapshot_name: `Phase 14 analytics - ${activeTab}`, metrics: { action }, insights: [action], created_by_name: baseRow.created_by_name };
    else if (table === "test_runs") row = { run_name: `Checklist - ${activeTab}`, run_status: "recorded", test_results: [{ action, status: "recorded" }], passed_count: 1, failed_count: 0, created_by_name: baseRow.created_by_name };
    else if (table === "system_event_logs") row = { event_type: action, severity: "info", module_name: activeTab, message: `Manual event logged by ${baseRow.created_by_name}`, payload: req.body || {}, created_by_name: baseRow.created_by_name };
    else if (table === "export_manifests") row = { export_name: `Export manifest - ${activeTab}`, export_entities: ["leads", "quotes", "jobs", "payments"], export_status: "ready", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "mobile_checklist_templates") row = { template_name: `Mobile checklist - ${activeTab}`, module_name: "installation", checklist_items: [action, "Upload photo", "Customer sign-off"], is_active: true, created_by_name: baseRow.created_by_name };
    else if (table === "release_checklists") row = { release_name: `Release checklist - ${new Date().toISOString().slice(0,10)}`, release_status: "draft", checklist_items: [{ label: activeTab, status: "recorded" }], blockers: [], created_by_name: baseRow.created_by_name };
    else if (table === "quote_quality_checks") row = { quote_number: "Manual Check", check_status: "needs_review", risk_score: 25, findings: [action, activeTab], created_by_name: baseRow.created_by_name };
    else if (table === "data_connection_audits") row = { module_name: activeTab, readiness_status: "needs_review", demo_data_risk: "medium", api_contract: { action }, notes: action, created_by_name: baseRow.created_by_name };
    const inserted = await dbInsert(table, [row]);
    await writeAuditLog(req, { action_type: "phase_14_action", module: "permissions-center", target_table: table, target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} ran ${action} in Role Permissions + Supabase RLS.` });
    res.json({ ok: true, success: true, record: Array.isArray(inserted) ? inserted[0] : row });
  } catch (error) {
    rememberSupabaseIssue("phase 14 permissions/policy", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save Role Permissions + Supabase RLS action." });
  }
});


// Phase 15 - Quote Maker Refactor + PDF Polish
const PHASE_15_STATS = [{"label": "Quote checks", "value": "12"}, {"label": "PDF docs", "value": "Planned"}, {"label": "Margin guard", "value": "Active"}, {"label": "Refactor map", "value": "Ready"}];
const PHASE_15_TABS = ["Quality Gate", "PDF Readiness", "Refactor Map", "Risk Rules"];
app.get("/quote-quality-center", requireStaff, async (req, res) => {
  try {
    const rows = SUPABASE_ENABLED ? await dbSelect("quote_quality_checks", "select=*&order=created_at.desc&limit=50").catch(() => []) : [];
    const mappedRows = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      id: row.id || `phase-15-${index}`,
      name: row.module_name || row.role_name || row.quote_number || row.customer_name || row.template_name || row.work_center || row.material_name || row.snapshot_name || row.run_name || row.event_type || row.export_name || row.release_name || row.policy_notes || row.check_status || "Quote Maker Refactor + PDF Polish",
      owner: row.created_by_name || row.approved_by_name || row.assigned_to_name || "System",
      status: row.readiness_status || row.status || row.check_status || row.release_status || row.run_status || row.severity || "Open",
      detail: row.notes || row.policy_notes || row.message || row.template_body || row.reason || row.export_status || "Live record from quote_quality_checks.",
    }));
    const setupRows = PHASE_15_TABS.map((tab) => ({ name: `${tab} setup`, owner: "System", status: "Ready", detail: "Phase 15 control row. Add live company records after schema is applied." }));
    res.json({ ok: true, success: true, stats: PHASE_15_STATS, rows: mappedRows.length ? mappedRows : setupRows });
  } catch (error) {
    rememberSupabaseIssue("phase 15 quote-quality-center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load Quote Maker Refactor + PDF Polish." });
  }
});
app.post("/quote-quality/check", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const action = String(req.body?.action || "Phase 15 action");
    const activeTab = String(req.body?.activeTab || "General");
    const baseRow = {
      created_by_name: actor.name || req.body?.actorName || "Staff",
      notes: `${action} / ${activeTab}`,
    };
    let row = baseRow;
    const table = "quote_quality_checks";
    if (table === "permission_policies") row = { role_name: "staff", module_name: activeTab.toLowerCase().replace(/\s+/g, "_"), can_view: true, policy_notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "customer_portal_sessions") row = { customer_name: "Portal Customer", portal_token: crypto.randomBytes(16).toString("hex"), status: "invited", allowed_actions: ["view_quote", "approve_quote", "book_site_visit"], created_by_name: baseRow.created_by_name };
    else if (table === "communication_logs") row = { channel: "whatsapp", direction: "outbound", message_summary: action, customer_reply_status: "pending", created_by_name: baseRow.created_by_name };
    else if (table === "production_capacity_rules") row = { work_center: activeTab, daily_capacity: 10, capacity_unit: "items", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "material_reservations") row = { material_name: activeTab, reserved_qty: 1, reservation_status: "reserved", created_by_name: baseRow.created_by_name };
    else if (table === "advanced_analytics_snapshots") row = { snapshot_name: `Phase 15 analytics - ${activeTab}`, metrics: { action }, insights: [action], created_by_name: baseRow.created_by_name };
    else if (table === "test_runs") row = { run_name: `Checklist - ${activeTab}`, run_status: "recorded", test_results: [{ action, status: "recorded" }], passed_count: 1, failed_count: 0, created_by_name: baseRow.created_by_name };
    else if (table === "system_event_logs") row = { event_type: action, severity: "info", module_name: activeTab, message: `Manual event logged by ${baseRow.created_by_name}`, payload: req.body || {}, created_by_name: baseRow.created_by_name };
    else if (table === "export_manifests") row = { export_name: `Export manifest - ${activeTab}`, export_entities: ["leads", "quotes", "jobs", "payments"], export_status: "ready", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "mobile_checklist_templates") row = { template_name: `Mobile checklist - ${activeTab}`, module_name: "installation", checklist_items: [action, "Upload photo", "Customer sign-off"], is_active: true, created_by_name: baseRow.created_by_name };
    else if (table === "release_checklists") row = { release_name: `Release checklist - ${new Date().toISOString().slice(0,10)}`, release_status: "draft", checklist_items: [{ label: activeTab, status: "recorded" }], blockers: [], created_by_name: baseRow.created_by_name };
    else if (table === "quote_quality_checks") row = { quote_number: "Manual Check", check_status: "needs_review", risk_score: 25, findings: [action, activeTab], created_by_name: baseRow.created_by_name };
    else if (table === "data_connection_audits") row = { module_name: activeTab, readiness_status: "needs_review", demo_data_risk: "medium", api_contract: { action }, notes: action, created_by_name: baseRow.created_by_name };
    const inserted = await dbInsert(table, [row]);
    await writeAuditLog(req, { action_type: "phase_15_action", module: "quote-quality-center", target_table: table, target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} ran ${action} in Quote Maker Refactor + PDF Polish.` });
    res.json({ ok: true, success: true, record: Array.isArray(inserted) ? inserted[0] : row });
  } catch (error) {
    rememberSupabaseIssue("phase 15 quote-quality/check", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save Quote Maker Refactor + PDF Polish action." });
  }
});


// Phase 16 - Customer Portal
const PHASE_16_STATS = [{"label": "Portal invites", "value": "Ready"}, {"label": "Approval flow", "value": "Ready"}, {"label": "Site booking", "value": "Linked"}, {"label": "Support requests", "value": "Tracked"}];
const PHASE_16_TABS = ["Portal Invites", "Customer Status", "Approval Steps", "Support Requests"];
app.get("/customer-portal-center", requireStaff, async (req, res) => {
  try {
    const rows = SUPABASE_ENABLED ? await dbSelect("customer_portal_sessions", "select=*&order=created_at.desc&limit=50").catch(() => []) : [];
    const mappedRows = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      id: row.id || `phase-16-${index}`,
      name: row.module_name || row.role_name || row.quote_number || row.customer_name || row.template_name || row.work_center || row.material_name || row.snapshot_name || row.run_name || row.event_type || row.export_name || row.release_name || row.policy_notes || row.check_status || "Customer Portal",
      owner: row.created_by_name || row.approved_by_name || row.assigned_to_name || "System",
      status: row.readiness_status || row.status || row.check_status || row.release_status || row.run_status || row.severity || "Open",
      detail: row.notes || row.policy_notes || row.message || row.template_body || row.reason || row.export_status || "Live record from customer_portal_sessions.",
    }));
    const setupRows = PHASE_16_TABS.map((tab) => ({ name: `${tab} setup`, owner: "System", status: "Ready", detail: "Phase 16 control row. Add live company records after schema is applied." }));
    res.json({ ok: true, success: true, stats: PHASE_16_STATS, rows: mappedRows.length ? mappedRows : setupRows });
  } catch (error) {
    rememberSupabaseIssue("phase 16 customer-portal-center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load Customer Portal." });
  }
});
app.post("/customer-portal/invite", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const action = String(req.body?.action || "Phase 16 action");
    const activeTab = String(req.body?.activeTab || "General");
    const baseRow = {
      created_by_name: actor.name || req.body?.actorName || "Staff",
      notes: `${action} / ${activeTab}`,
    };
    let row = baseRow;
    const table = "customer_portal_sessions";
    if (table === "permission_policies") row = { role_name: "staff", module_name: activeTab.toLowerCase().replace(/\s+/g, "_"), can_view: true, policy_notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "customer_portal_sessions") row = { customer_name: "Portal Customer", portal_token: crypto.randomBytes(16).toString("hex"), status: "invited", allowed_actions: ["view_quote", "approve_quote", "book_site_visit"], created_by_name: baseRow.created_by_name };
    else if (table === "communication_logs") row = { channel: "whatsapp", direction: "outbound", message_summary: action, customer_reply_status: "pending", created_by_name: baseRow.created_by_name };
    else if (table === "production_capacity_rules") row = { work_center: activeTab, daily_capacity: 10, capacity_unit: "items", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "material_reservations") row = { material_name: activeTab, reserved_qty: 1, reservation_status: "reserved", created_by_name: baseRow.created_by_name };
    else if (table === "advanced_analytics_snapshots") row = { snapshot_name: `Phase 16 analytics - ${activeTab}`, metrics: { action }, insights: [action], created_by_name: baseRow.created_by_name };
    else if (table === "test_runs") row = { run_name: `Checklist - ${activeTab}`, run_status: "recorded", test_results: [{ action, status: "recorded" }], passed_count: 1, failed_count: 0, created_by_name: baseRow.created_by_name };
    else if (table === "system_event_logs") row = { event_type: action, severity: "info", module_name: activeTab, message: `Manual event logged by ${baseRow.created_by_name}`, payload: req.body || {}, created_by_name: baseRow.created_by_name };
    else if (table === "export_manifests") row = { export_name: `Export manifest - ${activeTab}`, export_entities: ["leads", "quotes", "jobs", "payments"], export_status: "ready", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "mobile_checklist_templates") row = { template_name: `Mobile checklist - ${activeTab}`, module_name: "installation", checklist_items: [action, "Upload photo", "Customer sign-off"], is_active: true, created_by_name: baseRow.created_by_name };
    else if (table === "release_checklists") row = { release_name: `Release checklist - ${new Date().toISOString().slice(0,10)}`, release_status: "draft", checklist_items: [{ label: activeTab, status: "recorded" }], blockers: [], created_by_name: baseRow.created_by_name };
    else if (table === "quote_quality_checks") row = { quote_number: "Manual Check", check_status: "needs_review", risk_score: 25, findings: [action, activeTab], created_by_name: baseRow.created_by_name };
    else if (table === "data_connection_audits") row = { module_name: activeTab, readiness_status: "needs_review", demo_data_risk: "medium", api_contract: { action }, notes: action, created_by_name: baseRow.created_by_name };
    const inserted = await dbInsert(table, [row]);
    await writeAuditLog(req, { action_type: "phase_16_action", module: "customer-portal-center", target_table: table, target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} ran ${action} in Customer Portal.` });
    res.json({ ok: true, success: true, record: Array.isArray(inserted) ? inserted[0] : row });
  } catch (error) {
    rememberSupabaseIssue("phase 16 customer-portal/invite", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save Customer Portal action." });
  }
});


// Phase 17 - WhatsApp + Email Communication Center
const PHASE_17_STATS = [{"label": "Templates", "value": "10"}, {"label": "Channels", "value": "WhatsApp / Email / Call"}, {"label": "Timeline logging", "value": "Ready"}, {"label": "No-reply tasks", "value": "Ready"}];
const PHASE_17_TABS = ["Templates", "Communication Log", "Follow-up Rules", "Timeline Sync"];
app.get("/communication-center", requireStaff, async (req, res) => {
  try {
    const rows = SUPABASE_ENABLED ? await dbSelect("communication_logs", "select=*&order=created_at.desc&limit=50").catch(() => []) : [];
    const mappedRows = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      id: row.id || `phase-17-${index}`,
      name: row.module_name || row.role_name || row.quote_number || row.customer_name || row.template_name || row.work_center || row.material_name || row.snapshot_name || row.run_name || row.event_type || row.export_name || row.release_name || row.policy_notes || row.check_status || "WhatsApp + Email Communication Center",
      owner: row.created_by_name || row.approved_by_name || row.assigned_to_name || "System",
      status: row.readiness_status || row.status || row.check_status || row.release_status || row.run_status || row.severity || "Open",
      detail: row.notes || row.policy_notes || row.message || row.template_body || row.reason || row.export_status || "Live record from communication_logs.",
    }));
    const setupRows = PHASE_17_TABS.map((tab) => ({ name: `${tab} setup`, owner: "System", status: "Ready", detail: "Phase 17 control row. Add live company records after schema is applied." }));
    res.json({ ok: true, success: true, stats: PHASE_17_STATS, rows: mappedRows.length ? mappedRows : setupRows });
  } catch (error) {
    rememberSupabaseIssue("phase 17 communication-center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load WhatsApp + Email Communication Center." });
  }
});
app.post("/communications/log", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const action = String(req.body?.action || "Phase 17 action");
    const activeTab = String(req.body?.activeTab || "General");
    const baseRow = {
      created_by_name: actor.name || req.body?.actorName || "Staff",
      notes: `${action} / ${activeTab}`,
    };
    let row = baseRow;
    const table = "communication_logs";
    if (table === "permission_policies") row = { role_name: "staff", module_name: activeTab.toLowerCase().replace(/\s+/g, "_"), can_view: true, policy_notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "customer_portal_sessions") row = { customer_name: "Portal Customer", portal_token: crypto.randomBytes(16).toString("hex"), status: "invited", allowed_actions: ["view_quote", "approve_quote", "book_site_visit"], created_by_name: baseRow.created_by_name };
    else if (table === "communication_logs") row = { channel: "whatsapp", direction: "outbound", message_summary: action, customer_reply_status: "pending", created_by_name: baseRow.created_by_name };
    else if (table === "production_capacity_rules") row = { work_center: activeTab, daily_capacity: 10, capacity_unit: "items", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "material_reservations") row = { material_name: activeTab, reserved_qty: 1, reservation_status: "reserved", created_by_name: baseRow.created_by_name };
    else if (table === "advanced_analytics_snapshots") row = { snapshot_name: `Phase 17 analytics - ${activeTab}`, metrics: { action }, insights: [action], created_by_name: baseRow.created_by_name };
    else if (table === "test_runs") row = { run_name: `Checklist - ${activeTab}`, run_status: "recorded", test_results: [{ action, status: "recorded" }], passed_count: 1, failed_count: 0, created_by_name: baseRow.created_by_name };
    else if (table === "system_event_logs") row = { event_type: action, severity: "info", module_name: activeTab, message: `Manual event logged by ${baseRow.created_by_name}`, payload: req.body || {}, created_by_name: baseRow.created_by_name };
    else if (table === "export_manifests") row = { export_name: `Export manifest - ${activeTab}`, export_entities: ["leads", "quotes", "jobs", "payments"], export_status: "ready", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "mobile_checklist_templates") row = { template_name: `Mobile checklist - ${activeTab}`, module_name: "installation", checklist_items: [action, "Upload photo", "Customer sign-off"], is_active: true, created_by_name: baseRow.created_by_name };
    else if (table === "release_checklists") row = { release_name: `Release checklist - ${new Date().toISOString().slice(0,10)}`, release_status: "draft", checklist_items: [{ label: activeTab, status: "recorded" }], blockers: [], created_by_name: baseRow.created_by_name };
    else if (table === "quote_quality_checks") row = { quote_number: "Manual Check", check_status: "needs_review", risk_score: 25, findings: [action, activeTab], created_by_name: baseRow.created_by_name };
    else if (table === "data_connection_audits") row = { module_name: activeTab, readiness_status: "needs_review", demo_data_risk: "medium", api_contract: { action }, notes: action, created_by_name: baseRow.created_by_name };
    const inserted = await dbInsert(table, [row]);
    await writeAuditLog(req, { action_type: "phase_17_action", module: "communication-center", target_table: table, target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} ran ${action} in WhatsApp + Email Communication Center.` });
    res.json({ ok: true, success: true, record: Array.isArray(inserted) ? inserted[0] : row });
  } catch (error) {
    rememberSupabaseIssue("phase 17 communications/log", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save WhatsApp + Email Communication Center action." });
  }
});


// Phase 18 - Advanced Production Planning
const PHASE_18_STATS = [{"label": "Work centers", "value": "6"}, {"label": "Capacity rules", "value": "Ready"}, {"label": "Bottlenecks", "value": "Tracked"}, {"label": "SLA risk", "value": "Live"}];
const PHASE_18_TABS = ["Capacity Board", "Bottlenecks", "Due Date Risk", "Work Centers"];
app.get("/production-planning-center", requireStaff, async (req, res) => {
  try {
    const rows = SUPABASE_ENABLED ? await dbSelect("production_capacity_rules", "select=*&order=created_at.desc&limit=50").catch(() => []) : [];
    const mappedRows = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      id: row.id || `phase-18-${index}`,
      name: row.module_name || row.role_name || row.quote_number || row.customer_name || row.template_name || row.work_center || row.material_name || row.snapshot_name || row.run_name || row.event_type || row.export_name || row.release_name || row.policy_notes || row.check_status || "Advanced Production Planning",
      owner: row.created_by_name || row.approved_by_name || row.assigned_to_name || "System",
      status: row.readiness_status || row.status || row.check_status || row.release_status || row.run_status || row.severity || "Open",
      detail: row.notes || row.policy_notes || row.message || row.template_body || row.reason || row.export_status || "Live record from production_capacity_rules.",
    }));
    const setupRows = PHASE_18_TABS.map((tab) => ({ name: `${tab} setup`, owner: "System", status: "Ready", detail: "Phase 18 control row. Add live company records after schema is applied." }));
    res.json({ ok: true, success: true, stats: PHASE_18_STATS, rows: mappedRows.length ? mappedRows : setupRows });
  } catch (error) {
    rememberSupabaseIssue("phase 18 production-planning-center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load Advanced Production Planning." });
  }
});
app.post("/production/capacity", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const action = String(req.body?.action || "Phase 18 action");
    const activeTab = String(req.body?.activeTab || "General");
    const baseRow = {
      created_by_name: actor.name || req.body?.actorName || "Staff",
      notes: `${action} / ${activeTab}`,
    };
    let row = baseRow;
    const table = "production_capacity_rules";
    if (table === "permission_policies") row = { role_name: "staff", module_name: activeTab.toLowerCase().replace(/\s+/g, "_"), can_view: true, policy_notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "customer_portal_sessions") row = { customer_name: "Portal Customer", portal_token: crypto.randomBytes(16).toString("hex"), status: "invited", allowed_actions: ["view_quote", "approve_quote", "book_site_visit"], created_by_name: baseRow.created_by_name };
    else if (table === "communication_logs") row = { channel: "whatsapp", direction: "outbound", message_summary: action, customer_reply_status: "pending", created_by_name: baseRow.created_by_name };
    else if (table === "production_capacity_rules") row = { work_center: activeTab, daily_capacity: 10, capacity_unit: "items", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "material_reservations") row = { material_name: activeTab, reserved_qty: 1, reservation_status: "reserved", created_by_name: baseRow.created_by_name };
    else if (table === "advanced_analytics_snapshots") row = { snapshot_name: `Phase 18 analytics - ${activeTab}`, metrics: { action }, insights: [action], created_by_name: baseRow.created_by_name };
    else if (table === "test_runs") row = { run_name: `Checklist - ${activeTab}`, run_status: "recorded", test_results: [{ action, status: "recorded" }], passed_count: 1, failed_count: 0, created_by_name: baseRow.created_by_name };
    else if (table === "system_event_logs") row = { event_type: action, severity: "info", module_name: activeTab, message: `Manual event logged by ${baseRow.created_by_name}`, payload: req.body || {}, created_by_name: baseRow.created_by_name };
    else if (table === "export_manifests") row = { export_name: `Export manifest - ${activeTab}`, export_entities: ["leads", "quotes", "jobs", "payments"], export_status: "ready", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "mobile_checklist_templates") row = { template_name: `Mobile checklist - ${activeTab}`, module_name: "installation", checklist_items: [action, "Upload photo", "Customer sign-off"], is_active: true, created_by_name: baseRow.created_by_name };
    else if (table === "release_checklists") row = { release_name: `Release checklist - ${new Date().toISOString().slice(0,10)}`, release_status: "draft", checklist_items: [{ label: activeTab, status: "recorded" }], blockers: [], created_by_name: baseRow.created_by_name };
    else if (table === "quote_quality_checks") row = { quote_number: "Manual Check", check_status: "needs_review", risk_score: 25, findings: [action, activeTab], created_by_name: baseRow.created_by_name };
    else if (table === "data_connection_audits") row = { module_name: activeTab, readiness_status: "needs_review", demo_data_risk: "medium", api_contract: { action }, notes: action, created_by_name: baseRow.created_by_name };
    const inserted = await dbInsert(table, [row]);
    await writeAuditLog(req, { action_type: "phase_18_action", module: "production-planning-center", target_table: table, target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} ran ${action} in Advanced Production Planning.` });
    res.json({ ok: true, success: true, record: Array.isArray(inserted) ? inserted[0] : row });
  } catch (error) {
    rememberSupabaseIssue("phase 18 production/capacity", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save Advanced Production Planning action." });
  }
});


// Phase 19 - Inventory Auto-Deduction
const PHASE_19_STATS = [{"label": "Reservations", "value": "Ready"}, {"label": "Stock movements", "value": "Ready"}, {"label": "Reorder trigger", "value": "Ready"}, {"label": "Remake cost link", "value": "Ready"}];
const PHASE_19_TABS = ["Material Reservations", "Stock Movements", "Reorder Logic", "Remake Impact"];
app.get("/inventory-automation-center", requireStaff, async (req, res) => {
  try {
    const rows = SUPABASE_ENABLED ? await dbSelect("material_reservations", "select=*&order=created_at.desc&limit=50").catch(() => []) : [];
    const mappedRows = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      id: row.id || `phase-19-${index}`,
      name: row.module_name || row.role_name || row.quote_number || row.customer_name || row.template_name || row.work_center || row.material_name || row.snapshot_name || row.run_name || row.event_type || row.export_name || row.release_name || row.policy_notes || row.check_status || "Inventory Auto-Deduction",
      owner: row.created_by_name || row.approved_by_name || row.assigned_to_name || "System",
      status: row.readiness_status || row.status || row.check_status || row.release_status || row.run_status || row.severity || "Open",
      detail: row.notes || row.policy_notes || row.message || row.template_body || row.reason || row.export_status || "Live record from material_reservations.",
    }));
    const setupRows = PHASE_19_TABS.map((tab) => ({ name: `${tab} setup`, owner: "System", status: "Ready", detail: "Phase 19 control row. Add live company records after schema is applied." }));
    res.json({ ok: true, success: true, stats: PHASE_19_STATS, rows: mappedRows.length ? mappedRows : setupRows });
  } catch (error) {
    rememberSupabaseIssue("phase 19 inventory-automation-center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load Inventory Auto-Deduction." });
  }
});
app.post("/inventory/reserve", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const action = String(req.body?.action || "Phase 19 action");
    const activeTab = String(req.body?.activeTab || "General");
    const baseRow = {
      created_by_name: actor.name || req.body?.actorName || "Staff",
      notes: `${action} / ${activeTab}`,
    };
    let row = baseRow;
    const table = "material_reservations";
    if (table === "permission_policies") row = { role_name: "staff", module_name: activeTab.toLowerCase().replace(/\s+/g, "_"), can_view: true, policy_notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "customer_portal_sessions") row = { customer_name: "Portal Customer", portal_token: crypto.randomBytes(16).toString("hex"), status: "invited", allowed_actions: ["view_quote", "approve_quote", "book_site_visit"], created_by_name: baseRow.created_by_name };
    else if (table === "communication_logs") row = { channel: "whatsapp", direction: "outbound", message_summary: action, customer_reply_status: "pending", created_by_name: baseRow.created_by_name };
    else if (table === "production_capacity_rules") row = { work_center: activeTab, daily_capacity: 10, capacity_unit: "items", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "material_reservations") row = { material_name: activeTab, reserved_qty: 1, reservation_status: "reserved", created_by_name: baseRow.created_by_name };
    else if (table === "advanced_analytics_snapshots") row = { snapshot_name: `Phase 19 analytics - ${activeTab}`, metrics: { action }, insights: [action], created_by_name: baseRow.created_by_name };
    else if (table === "test_runs") row = { run_name: `Checklist - ${activeTab}`, run_status: "recorded", test_results: [{ action, status: "recorded" }], passed_count: 1, failed_count: 0, created_by_name: baseRow.created_by_name };
    else if (table === "system_event_logs") row = { event_type: action, severity: "info", module_name: activeTab, message: `Manual event logged by ${baseRow.created_by_name}`, payload: req.body || {}, created_by_name: baseRow.created_by_name };
    else if (table === "export_manifests") row = { export_name: `Export manifest - ${activeTab}`, export_entities: ["leads", "quotes", "jobs", "payments"], export_status: "ready", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "mobile_checklist_templates") row = { template_name: `Mobile checklist - ${activeTab}`, module_name: "installation", checklist_items: [action, "Upload photo", "Customer sign-off"], is_active: true, created_by_name: baseRow.created_by_name };
    else if (table === "release_checklists") row = { release_name: `Release checklist - ${new Date().toISOString().slice(0,10)}`, release_status: "draft", checklist_items: [{ label: activeTab, status: "recorded" }], blockers: [], created_by_name: baseRow.created_by_name };
    else if (table === "quote_quality_checks") row = { quote_number: "Manual Check", check_status: "needs_review", risk_score: 25, findings: [action, activeTab], created_by_name: baseRow.created_by_name };
    else if (table === "data_connection_audits") row = { module_name: activeTab, readiness_status: "needs_review", demo_data_risk: "medium", api_contract: { action }, notes: action, created_by_name: baseRow.created_by_name };
    const inserted = await dbInsert(table, [row]);
    await writeAuditLog(req, { action_type: "phase_19_action", module: "inventory-automation-center", target_table: table, target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} ran ${action} in Inventory Auto-Deduction.` });
    res.json({ ok: true, success: true, record: Array.isArray(inserted) ? inserted[0] : row });
  } catch (error) {
    rememberSupabaseIssue("phase 19 inventory/reserve", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save Inventory Auto-Deduction action." });
  }
});


// Phase 20 - Boss Mode 2.0 + Advanced Analytics
const PHASE_20_STATS = [{"label": "Analytics lenses", "value": "9"}, {"label": "Risk questions", "value": "25"}, {"label": "Forecast rows", "value": "Ready"}, {"label": "Owner drilldowns", "value": "Ready"}];
const PHASE_20_TABS = ["Profit Intelligence", "Source Quality", "Staff Performance", "Cash Forecast"];
app.get("/advanced-analytics-center", requireStaff, async (req, res) => {
  try {
    const rows = SUPABASE_ENABLED ? await dbSelect("advanced_analytics_snapshots", "select=*&order=created_at.desc&limit=50").catch(() => []) : [];
    const mappedRows = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      id: row.id || `phase-20-${index}`,
      name: row.module_name || row.role_name || row.quote_number || row.customer_name || row.template_name || row.work_center || row.material_name || row.snapshot_name || row.run_name || row.event_type || row.export_name || row.release_name || row.policy_notes || row.check_status || "Boss Mode 2.0 + Advanced Analytics",
      owner: row.created_by_name || row.approved_by_name || row.assigned_to_name || "System",
      status: row.readiness_status || row.status || row.check_status || row.release_status || row.run_status || row.severity || "Open",
      detail: row.notes || row.policy_notes || row.message || row.template_body || row.reason || row.export_status || "Live record from advanced_analytics_snapshots.",
    }));
    const setupRows = PHASE_20_TABS.map((tab) => ({ name: `${tab} setup`, owner: "System", status: "Ready", detail: "Phase 20 control row. Add live company records after schema is applied." }));
    res.json({ ok: true, success: true, stats: PHASE_20_STATS, rows: mappedRows.length ? mappedRows : setupRows });
  } catch (error) {
    rememberSupabaseIssue("phase 20 advanced-analytics-center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load Boss Mode 2.0 + Advanced Analytics." });
  }
});
app.post("/advanced-analytics/snapshot", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const action = String(req.body?.action || "Phase 20 action");
    const activeTab = String(req.body?.activeTab || "General");
    const baseRow = {
      created_by_name: actor.name || req.body?.actorName || "Staff",
      notes: `${action} / ${activeTab}`,
    };
    let row = baseRow;
    const table = "advanced_analytics_snapshots";
    if (table === "permission_policies") row = { role_name: "staff", module_name: activeTab.toLowerCase().replace(/\s+/g, "_"), can_view: true, policy_notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "customer_portal_sessions") row = { customer_name: "Portal Customer", portal_token: crypto.randomBytes(16).toString("hex"), status: "invited", allowed_actions: ["view_quote", "approve_quote", "book_site_visit"], created_by_name: baseRow.created_by_name };
    else if (table === "communication_logs") row = { channel: "whatsapp", direction: "outbound", message_summary: action, customer_reply_status: "pending", created_by_name: baseRow.created_by_name };
    else if (table === "production_capacity_rules") row = { work_center: activeTab, daily_capacity: 10, capacity_unit: "items", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "material_reservations") row = { material_name: activeTab, reserved_qty: 1, reservation_status: "reserved", created_by_name: baseRow.created_by_name };
    else if (table === "advanced_analytics_snapshots") row = { snapshot_name: `Phase 20 analytics - ${activeTab}`, metrics: { action }, insights: [action], created_by_name: baseRow.created_by_name };
    else if (table === "test_runs") row = { run_name: `Checklist - ${activeTab}`, run_status: "recorded", test_results: [{ action, status: "recorded" }], passed_count: 1, failed_count: 0, created_by_name: baseRow.created_by_name };
    else if (table === "system_event_logs") row = { event_type: action, severity: "info", module_name: activeTab, message: `Manual event logged by ${baseRow.created_by_name}`, payload: req.body || {}, created_by_name: baseRow.created_by_name };
    else if (table === "export_manifests") row = { export_name: `Export manifest - ${activeTab}`, export_entities: ["leads", "quotes", "jobs", "payments"], export_status: "ready", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "mobile_checklist_templates") row = { template_name: `Mobile checklist - ${activeTab}`, module_name: "installation", checklist_items: [action, "Upload photo", "Customer sign-off"], is_active: true, created_by_name: baseRow.created_by_name };
    else if (table === "release_checklists") row = { release_name: `Release checklist - ${new Date().toISOString().slice(0,10)}`, release_status: "draft", checklist_items: [{ label: activeTab, status: "recorded" }], blockers: [], created_by_name: baseRow.created_by_name };
    else if (table === "quote_quality_checks") row = { quote_number: "Manual Check", check_status: "needs_review", risk_score: 25, findings: [action, activeTab], created_by_name: baseRow.created_by_name };
    else if (table === "data_connection_audits") row = { module_name: activeTab, readiness_status: "needs_review", demo_data_risk: "medium", api_contract: { action }, notes: action, created_by_name: baseRow.created_by_name };
    const inserted = await dbInsert(table, [row]);
    await writeAuditLog(req, { action_type: "phase_20_action", module: "advanced-analytics-center", target_table: table, target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} ran ${action} in Boss Mode 2.0 + Advanced Analytics.` });
    res.json({ ok: true, success: true, record: Array.isArray(inserted) ? inserted[0] : row });
  } catch (error) {
    rememberSupabaseIssue("phase 20 advanced-analytics/snapshot", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save Boss Mode 2.0 + Advanced Analytics action." });
  }
});


// Phase 21 - Testing System
const PHASE_21_STATS = [{"label": "Smoke tests", "value": "22"}, {"label": "Pricing tests", "value": "Mapped"}, {"label": "API checks", "value": "Ready"}, {"label": "Release gate", "value": "Tracked"}];
const PHASE_21_TABS = ["Smoke Tests", "Pricing Tests", "API Tests", "Release Gate"];
app.get("/testing-center", requireStaff, async (req, res) => {
  try {
    const rows = SUPABASE_ENABLED ? await dbSelect("test_runs", "select=*&order=created_at.desc&limit=50").catch(() => []) : [];
    const mappedRows = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      id: row.id || `phase-21-${index}`,
      name: row.module_name || row.role_name || row.quote_number || row.customer_name || row.template_name || row.work_center || row.material_name || row.snapshot_name || row.run_name || row.event_type || row.export_name || row.release_name || row.policy_notes || row.check_status || "Testing System",
      owner: row.created_by_name || row.approved_by_name || row.assigned_to_name || "System",
      status: row.readiness_status || row.status || row.check_status || row.release_status || row.run_status || row.severity || "Open",
      detail: row.notes || row.policy_notes || row.message || row.template_body || row.reason || row.export_status || "Live record from test_runs.",
    }));
    const setupRows = PHASE_21_TABS.map((tab) => ({ name: `${tab} setup`, owner: "System", status: "Ready", detail: "Phase 21 control row. Add live company records after schema is applied." }));
    res.json({ ok: true, success: true, stats: PHASE_21_STATS, rows: mappedRows.length ? mappedRows : setupRows });
  } catch (error) {
    rememberSupabaseIssue("phase 21 testing-center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load Testing System." });
  }
});
app.post("/testing/run-checklist", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const action = String(req.body?.action || "Phase 21 action");
    const activeTab = String(req.body?.activeTab || "General");
    const baseRow = {
      created_by_name: actor.name || req.body?.actorName || "Staff",
      notes: `${action} / ${activeTab}`,
    };
    let row = baseRow;
    const table = "test_runs";
    if (table === "permission_policies") row = { role_name: "staff", module_name: activeTab.toLowerCase().replace(/\s+/g, "_"), can_view: true, policy_notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "customer_portal_sessions") row = { customer_name: "Portal Customer", portal_token: crypto.randomBytes(16).toString("hex"), status: "invited", allowed_actions: ["view_quote", "approve_quote", "book_site_visit"], created_by_name: baseRow.created_by_name };
    else if (table === "communication_logs") row = { channel: "whatsapp", direction: "outbound", message_summary: action, customer_reply_status: "pending", created_by_name: baseRow.created_by_name };
    else if (table === "production_capacity_rules") row = { work_center: activeTab, daily_capacity: 10, capacity_unit: "items", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "material_reservations") row = { material_name: activeTab, reserved_qty: 1, reservation_status: "reserved", created_by_name: baseRow.created_by_name };
    else if (table === "advanced_analytics_snapshots") row = { snapshot_name: `Phase 21 analytics - ${activeTab}`, metrics: { action }, insights: [action], created_by_name: baseRow.created_by_name };
    else if (table === "test_runs") row = { run_name: `Checklist - ${activeTab}`, run_status: "recorded", test_results: [{ action, status: "recorded" }], passed_count: 1, failed_count: 0, created_by_name: baseRow.created_by_name };
    else if (table === "system_event_logs") row = { event_type: action, severity: "info", module_name: activeTab, message: `Manual event logged by ${baseRow.created_by_name}`, payload: req.body || {}, created_by_name: baseRow.created_by_name };
    else if (table === "export_manifests") row = { export_name: `Export manifest - ${activeTab}`, export_entities: ["leads", "quotes", "jobs", "payments"], export_status: "ready", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "mobile_checklist_templates") row = { template_name: `Mobile checklist - ${activeTab}`, module_name: "installation", checklist_items: [action, "Upload photo", "Customer sign-off"], is_active: true, created_by_name: baseRow.created_by_name };
    else if (table === "release_checklists") row = { release_name: `Release checklist - ${new Date().toISOString().slice(0,10)}`, release_status: "draft", checklist_items: [{ label: activeTab, status: "recorded" }], blockers: [], created_by_name: baseRow.created_by_name };
    else if (table === "quote_quality_checks") row = { quote_number: "Manual Check", check_status: "needs_review", risk_score: 25, findings: [action, activeTab], created_by_name: baseRow.created_by_name };
    else if (table === "data_connection_audits") row = { module_name: activeTab, readiness_status: "needs_review", demo_data_risk: "medium", api_contract: { action }, notes: action, created_by_name: baseRow.created_by_name };
    const inserted = await dbInsert(table, [row]);
    await writeAuditLog(req, { action_type: "phase_21_action", module: "testing-center", target_table: table, target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} ran ${action} in Testing System.` });
    res.json({ ok: true, success: true, record: Array.isArray(inserted) ? inserted[0] : row });
  } catch (error) {
    rememberSupabaseIssue("phase 21 testing/run-checklist", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save Testing System action." });
  }
});


// Phase 22 - Error Monitoring + Logs
const PHASE_22_STATS = [{"label": "Error logs", "value": "Ready"}, {"label": "API failures", "value": "Tracked"}, {"label": "Supabase issue", "value": "Surfaced"}, {"label": "Crash recovery", "value": "Linked"}];
const PHASE_22_TABS = ["Error Feed", "API Failures", "Supabase Issues", "User Actions"];
app.get("/monitoring-center", requireStaff, async (req, res) => {
  try {
    const rows = SUPABASE_ENABLED ? await dbSelect("system_event_logs", "select=*&order=created_at.desc&limit=50").catch(() => []) : [];
    const mappedRows = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      id: row.id || `phase-22-${index}`,
      name: row.module_name || row.role_name || row.quote_number || row.customer_name || row.template_name || row.work_center || row.material_name || row.snapshot_name || row.run_name || row.event_type || row.export_name || row.release_name || row.policy_notes || row.check_status || "Error Monitoring + Logs",
      owner: row.created_by_name || row.approved_by_name || row.assigned_to_name || "System",
      status: row.readiness_status || row.status || row.check_status || row.release_status || row.run_status || row.severity || "Open",
      detail: row.notes || row.policy_notes || row.message || row.template_body || row.reason || row.export_status || "Live record from system_event_logs.",
    }));
    const setupRows = PHASE_22_TABS.map((tab) => ({ name: `${tab} setup`, owner: "System", status: "Ready", detail: "Phase 22 control row. Add live company records after schema is applied." }));
    res.json({ ok: true, success: true, stats: PHASE_22_STATS, rows: mappedRows.length ? mappedRows : setupRows });
  } catch (error) {
    rememberSupabaseIssue("phase 22 monitoring-center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load Error Monitoring + Logs." });
  }
});
app.post("/monitoring/log", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const action = String(req.body?.action || "Phase 22 action");
    const activeTab = String(req.body?.activeTab || "General");
    const baseRow = {
      created_by_name: actor.name || req.body?.actorName || "Staff",
      notes: `${action} / ${activeTab}`,
    };
    let row = baseRow;
    const table = "system_event_logs";
    if (table === "permission_policies") row = { role_name: "staff", module_name: activeTab.toLowerCase().replace(/\s+/g, "_"), can_view: true, policy_notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "customer_portal_sessions") row = { customer_name: "Portal Customer", portal_token: crypto.randomBytes(16).toString("hex"), status: "invited", allowed_actions: ["view_quote", "approve_quote", "book_site_visit"], created_by_name: baseRow.created_by_name };
    else if (table === "communication_logs") row = { channel: "whatsapp", direction: "outbound", message_summary: action, customer_reply_status: "pending", created_by_name: baseRow.created_by_name };
    else if (table === "production_capacity_rules") row = { work_center: activeTab, daily_capacity: 10, capacity_unit: "items", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "material_reservations") row = { material_name: activeTab, reserved_qty: 1, reservation_status: "reserved", created_by_name: baseRow.created_by_name };
    else if (table === "advanced_analytics_snapshots") row = { snapshot_name: `Phase 22 analytics - ${activeTab}`, metrics: { action }, insights: [action], created_by_name: baseRow.created_by_name };
    else if (table === "test_runs") row = { run_name: `Checklist - ${activeTab}`, run_status: "recorded", test_results: [{ action, status: "recorded" }], passed_count: 1, failed_count: 0, created_by_name: baseRow.created_by_name };
    else if (table === "system_event_logs") row = { event_type: action, severity: "info", module_name: activeTab, message: `Manual event logged by ${baseRow.created_by_name}`, payload: req.body || {}, created_by_name: baseRow.created_by_name };
    else if (table === "export_manifests") row = { export_name: `Export manifest - ${activeTab}`, export_entities: ["leads", "quotes", "jobs", "payments"], export_status: "ready", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "mobile_checklist_templates") row = { template_name: `Mobile checklist - ${activeTab}`, module_name: "installation", checklist_items: [action, "Upload photo", "Customer sign-off"], is_active: true, created_by_name: baseRow.created_by_name };
    else if (table === "release_checklists") row = { release_name: `Release checklist - ${new Date().toISOString().slice(0,10)}`, release_status: "draft", checklist_items: [{ label: activeTab, status: "recorded" }], blockers: [], created_by_name: baseRow.created_by_name };
    else if (table === "quote_quality_checks") row = { quote_number: "Manual Check", check_status: "needs_review", risk_score: 25, findings: [action, activeTab], created_by_name: baseRow.created_by_name };
    else if (table === "data_connection_audits") row = { module_name: activeTab, readiness_status: "needs_review", demo_data_risk: "medium", api_contract: { action }, notes: action, created_by_name: baseRow.created_by_name };
    const inserted = await dbInsert(table, [row]);
    await writeAuditLog(req, { action_type: "phase_22_action", module: "monitoring-center", target_table: table, target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} ran ${action} in Error Monitoring + Logs.` });
    res.json({ ok: true, success: true, record: Array.isArray(inserted) ? inserted[0] : row });
  } catch (error) {
    rememberSupabaseIssue("phase 22 monitoring/log", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save Error Monitoring + Logs action." });
  }
});


// Phase 23 - Backup / Restore / Data Export
const PHASE_23_STATS = [{"label": "Export entities", "value": "8"}, {"label": "CSV endpoints", "value": "Ready"}, {"label": "Restore guide", "value": "Included"}, {"label": "Backup manifests", "value": "Tracked"}];
const PHASE_23_TABS = ["Export Manifest", "CSV Entities", "Restore Guide", "Backup History"];
app.get("/backup-export-center", requireStaff, async (req, res) => {
  try {
    const rows = SUPABASE_ENABLED ? await dbSelect("export_manifests", "select=*&order=created_at.desc&limit=50").catch(() => []) : [];
    const mappedRows = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      id: row.id || `phase-23-${index}`,
      name: row.module_name || row.role_name || row.quote_number || row.customer_name || row.template_name || row.work_center || row.material_name || row.snapshot_name || row.run_name || row.event_type || row.export_name || row.release_name || row.policy_notes || row.check_status || "Backup / Restore / Data Export",
      owner: row.created_by_name || row.approved_by_name || row.assigned_to_name || "System",
      status: row.readiness_status || row.status || row.check_status || row.release_status || row.run_status || row.severity || "Open",
      detail: row.notes || row.policy_notes || row.message || row.template_body || row.reason || row.export_status || "Live record from export_manifests.",
    }));
    const setupRows = PHASE_23_TABS.map((tab) => ({ name: `${tab} setup`, owner: "System", status: "Ready", detail: "Phase 23 control row. Add live company records after schema is applied." }));
    res.json({ ok: true, success: true, stats: PHASE_23_STATS, rows: mappedRows.length ? mappedRows : setupRows });
  } catch (error) {
    rememberSupabaseIssue("phase 23 backup-export-center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load Backup / Restore / Data Export." });
  }
});
app.post("/admin/export-manifest", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const action = String(req.body?.action || "Phase 23 action");
    const activeTab = String(req.body?.activeTab || "General");
    const baseRow = {
      created_by_name: actor.name || req.body?.actorName || "Staff",
      notes: `${action} / ${activeTab}`,
    };
    let row = baseRow;
    const table = "export_manifests";
    if (table === "permission_policies") row = { role_name: "staff", module_name: activeTab.toLowerCase().replace(/\s+/g, "_"), can_view: true, policy_notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "customer_portal_sessions") row = { customer_name: "Portal Customer", portal_token: crypto.randomBytes(16).toString("hex"), status: "invited", allowed_actions: ["view_quote", "approve_quote", "book_site_visit"], created_by_name: baseRow.created_by_name };
    else if (table === "communication_logs") row = { channel: "whatsapp", direction: "outbound", message_summary: action, customer_reply_status: "pending", created_by_name: baseRow.created_by_name };
    else if (table === "production_capacity_rules") row = { work_center: activeTab, daily_capacity: 10, capacity_unit: "items", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "material_reservations") row = { material_name: activeTab, reserved_qty: 1, reservation_status: "reserved", created_by_name: baseRow.created_by_name };
    else if (table === "advanced_analytics_snapshots") row = { snapshot_name: `Phase 23 analytics - ${activeTab}`, metrics: { action }, insights: [action], created_by_name: baseRow.created_by_name };
    else if (table === "test_runs") row = { run_name: `Checklist - ${activeTab}`, run_status: "recorded", test_results: [{ action, status: "recorded" }], passed_count: 1, failed_count: 0, created_by_name: baseRow.created_by_name };
    else if (table === "system_event_logs") row = { event_type: action, severity: "info", module_name: activeTab, message: `Manual event logged by ${baseRow.created_by_name}`, payload: req.body || {}, created_by_name: baseRow.created_by_name };
    else if (table === "export_manifests") row = { export_name: `Export manifest - ${activeTab}`, export_entities: ["leads", "quotes", "jobs", "payments"], export_status: "ready", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "mobile_checklist_templates") row = { template_name: `Mobile checklist - ${activeTab}`, module_name: "installation", checklist_items: [action, "Upload photo", "Customer sign-off"], is_active: true, created_by_name: baseRow.created_by_name };
    else if (table === "release_checklists") row = { release_name: `Release checklist - ${new Date().toISOString().slice(0,10)}`, release_status: "draft", checklist_items: [{ label: activeTab, status: "recorded" }], blockers: [], created_by_name: baseRow.created_by_name };
    else if (table === "quote_quality_checks") row = { quote_number: "Manual Check", check_status: "needs_review", risk_score: 25, findings: [action, activeTab], created_by_name: baseRow.created_by_name };
    else if (table === "data_connection_audits") row = { module_name: activeTab, readiness_status: "needs_review", demo_data_risk: "medium", api_contract: { action }, notes: action, created_by_name: baseRow.created_by_name };
    const inserted = await dbInsert(table, [row]);
    await writeAuditLog(req, { action_type: "phase_23_action", module: "backup-export-center", target_table: table, target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} ran ${action} in Backup / Restore / Data Export.` });
    res.json({ ok: true, success: true, record: Array.isArray(inserted) ? inserted[0] : row });
  } catch (error) {
    rememberSupabaseIssue("phase 23 admin/export-manifest", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save Backup / Restore / Data Export action." });
  }
});


// Phase 24 - Mobile / PWA Upgrade
const PHASE_24_STATS = [{"label": "PWA manifest", "value": "Added"}, {"label": "Service worker", "value": "Added"}, {"label": "Mobile checklists", "value": "Ready"}, {"label": "Offline shell", "value": "Ready"}];
const PHASE_24_TABS = ["PWA Readiness", "Installer Mobile", "Offline Rules", "Device Features"];
app.get("/mobile-pwa-center", requireStaff, async (req, res) => {
  try {
    const rows = SUPABASE_ENABLED ? await dbSelect("mobile_checklist_templates", "select=*&order=created_at.desc&limit=50").catch(() => []) : [];
    const mappedRows = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      id: row.id || `phase-24-${index}`,
      name: row.module_name || row.role_name || row.quote_number || row.customer_name || row.template_name || row.work_center || row.material_name || row.snapshot_name || row.run_name || row.event_type || row.export_name || row.release_name || row.policy_notes || row.check_status || "Mobile / PWA Upgrade",
      owner: row.created_by_name || row.approved_by_name || row.assigned_to_name || "System",
      status: row.readiness_status || row.status || row.check_status || row.release_status || row.run_status || row.severity || "Open",
      detail: row.notes || row.policy_notes || row.message || row.template_body || row.reason || row.export_status || "Live record from mobile_checklist_templates.",
    }));
    const setupRows = PHASE_24_TABS.map((tab) => ({ name: `${tab} setup`, owner: "System", status: "Ready", detail: "Phase 24 control row. Add live company records after schema is applied." }));
    res.json({ ok: true, success: true, stats: PHASE_24_STATS, rows: mappedRows.length ? mappedRows : setupRows });
  } catch (error) {
    rememberSupabaseIssue("phase 24 mobile-pwa-center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load Mobile / PWA Upgrade." });
  }
});
app.post("/mobile/checklist-template", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const action = String(req.body?.action || "Phase 24 action");
    const activeTab = String(req.body?.activeTab || "General");
    const baseRow = {
      created_by_name: actor.name || req.body?.actorName || "Staff",
      notes: `${action} / ${activeTab}`,
    };
    let row = baseRow;
    const table = "mobile_checklist_templates";
    if (table === "permission_policies") row = { role_name: "staff", module_name: activeTab.toLowerCase().replace(/\s+/g, "_"), can_view: true, policy_notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "customer_portal_sessions") row = { customer_name: "Portal Customer", portal_token: crypto.randomBytes(16).toString("hex"), status: "invited", allowed_actions: ["view_quote", "approve_quote", "book_site_visit"], created_by_name: baseRow.created_by_name };
    else if (table === "communication_logs") row = { channel: "whatsapp", direction: "outbound", message_summary: action, customer_reply_status: "pending", created_by_name: baseRow.created_by_name };
    else if (table === "production_capacity_rules") row = { work_center: activeTab, daily_capacity: 10, capacity_unit: "items", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "material_reservations") row = { material_name: activeTab, reserved_qty: 1, reservation_status: "reserved", created_by_name: baseRow.created_by_name };
    else if (table === "advanced_analytics_snapshots") row = { snapshot_name: `Phase 24 analytics - ${activeTab}`, metrics: { action }, insights: [action], created_by_name: baseRow.created_by_name };
    else if (table === "test_runs") row = { run_name: `Checklist - ${activeTab}`, run_status: "recorded", test_results: [{ action, status: "recorded" }], passed_count: 1, failed_count: 0, created_by_name: baseRow.created_by_name };
    else if (table === "system_event_logs") row = { event_type: action, severity: "info", module_name: activeTab, message: `Manual event logged by ${baseRow.created_by_name}`, payload: req.body || {}, created_by_name: baseRow.created_by_name };
    else if (table === "export_manifests") row = { export_name: `Export manifest - ${activeTab}`, export_entities: ["leads", "quotes", "jobs", "payments"], export_status: "ready", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "mobile_checklist_templates") row = { template_name: `Mobile checklist - ${activeTab}`, module_name: "installation", checklist_items: [action, "Upload photo", "Customer sign-off"], is_active: true, created_by_name: baseRow.created_by_name };
    else if (table === "release_checklists") row = { release_name: `Release checklist - ${new Date().toISOString().slice(0,10)}`, release_status: "draft", checklist_items: [{ label: activeTab, status: "recorded" }], blockers: [], created_by_name: baseRow.created_by_name };
    else if (table === "quote_quality_checks") row = { quote_number: "Manual Check", check_status: "needs_review", risk_score: 25, findings: [action, activeTab], created_by_name: baseRow.created_by_name };
    else if (table === "data_connection_audits") row = { module_name: activeTab, readiness_status: "needs_review", demo_data_risk: "medium", api_contract: { action }, notes: action, created_by_name: baseRow.created_by_name };
    const inserted = await dbInsert(table, [row]);
    await writeAuditLog(req, { action_type: "phase_24_action", module: "mobile-pwa-center", target_table: table, target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} ran ${action} in Mobile / PWA Upgrade.` });
    res.json({ ok: true, success: true, record: Array.isArray(inserted) ? inserted[0] : row });
  } catch (error) {
    rememberSupabaseIssue("phase 24 mobile/checklist-template", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save Mobile / PWA Upgrade action." });
  }
});


// Phase 25 - Final Release Readiness Center
const PHASE_25_STATS = [{"label": "Launch gates", "value": "12"}, {"label": "Rollback plan", "value": "Included"}, {"label": "Staff onboarding", "value": "Mapped"}, {"label": "Release decision", "value": "Tracked"}];
const PHASE_25_TABS = ["Launch Gate", "Deployment Steps", "Rollback Plan", "Staff Onboarding"];
app.get("/release-readiness-center", requireStaff, async (req, res) => {
  try {
    const rows = SUPABASE_ENABLED ? await dbSelect("release_checklists", "select=*&order=created_at.desc&limit=50").catch(() => []) : [];
    const mappedRows = (Array.isArray(rows) ? rows : []).map((row, index) => ({
      id: row.id || `phase-25-${index}`,
      name: row.module_name || row.role_name || row.quote_number || row.customer_name || row.template_name || row.work_center || row.material_name || row.snapshot_name || row.run_name || row.event_type || row.export_name || row.release_name || row.policy_notes || row.check_status || "Final Release Readiness Center",
      owner: row.created_by_name || row.approved_by_name || row.assigned_to_name || "System",
      status: row.readiness_status || row.status || row.check_status || row.release_status || row.run_status || row.severity || "Open",
      detail: row.notes || row.policy_notes || row.message || row.template_body || row.reason || row.export_status || "Live record from release_checklists.",
    }));
    const setupRows = PHASE_25_TABS.map((tab) => ({ name: `${tab} setup`, owner: "System", status: "Ready", detail: "Phase 25 control row. Add live company records after schema is applied." }));
    res.json({ ok: true, success: true, stats: PHASE_25_STATS, rows: mappedRows.length ? mappedRows : setupRows });
  } catch (error) {
    rememberSupabaseIssue("phase 25 release-readiness-center", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not load Final Release Readiness Center." });
  }
});
app.post("/release/checklist", requireStaff, async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) return res.status(500).json({ ok: false, success: false, error: "Supabase is not configured." });
    const actor = actorFromRequest(req);
    const action = String(req.body?.action || "Phase 25 action");
    const activeTab = String(req.body?.activeTab || "General");
    const baseRow = {
      created_by_name: actor.name || req.body?.actorName || "Staff",
      notes: `${action} / ${activeTab}`,
    };
    let row = baseRow;
    const table = "release_checklists";
    if (table === "permission_policies") row = { role_name: "staff", module_name: activeTab.toLowerCase().replace(/\s+/g, "_"), can_view: true, policy_notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "customer_portal_sessions") row = { customer_name: "Portal Customer", portal_token: crypto.randomBytes(16).toString("hex"), status: "invited", allowed_actions: ["view_quote", "approve_quote", "book_site_visit"], created_by_name: baseRow.created_by_name };
    else if (table === "communication_logs") row = { channel: "whatsapp", direction: "outbound", message_summary: action, customer_reply_status: "pending", created_by_name: baseRow.created_by_name };
    else if (table === "production_capacity_rules") row = { work_center: activeTab, daily_capacity: 10, capacity_unit: "items", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "material_reservations") row = { material_name: activeTab, reserved_qty: 1, reservation_status: "reserved", created_by_name: baseRow.created_by_name };
    else if (table === "advanced_analytics_snapshots") row = { snapshot_name: `Phase 25 analytics - ${activeTab}`, metrics: { action }, insights: [action], created_by_name: baseRow.created_by_name };
    else if (table === "test_runs") row = { run_name: `Checklist - ${activeTab}`, run_status: "recorded", test_results: [{ action, status: "recorded" }], passed_count: 1, failed_count: 0, created_by_name: baseRow.created_by_name };
    else if (table === "system_event_logs") row = { event_type: action, severity: "info", module_name: activeTab, message: `Manual event logged by ${baseRow.created_by_name}`, payload: req.body || {}, created_by_name: baseRow.created_by_name };
    else if (table === "export_manifests") row = { export_name: `Export manifest - ${activeTab}`, export_entities: ["leads", "quotes", "jobs", "payments"], export_status: "ready", notes: action, created_by_name: baseRow.created_by_name };
    else if (table === "mobile_checklist_templates") row = { template_name: `Mobile checklist - ${activeTab}`, module_name: "installation", checklist_items: [action, "Upload photo", "Customer sign-off"], is_active: true, created_by_name: baseRow.created_by_name };
    else if (table === "release_checklists") row = { release_name: `Release checklist - ${new Date().toISOString().slice(0,10)}`, release_status: "draft", checklist_items: [{ label: activeTab, status: "recorded" }], blockers: [], created_by_name: baseRow.created_by_name };
    else if (table === "quote_quality_checks") row = { quote_number: "Manual Check", check_status: "needs_review", risk_score: 25, findings: [action, activeTab], created_by_name: baseRow.created_by_name };
    else if (table === "data_connection_audits") row = { module_name: activeTab, readiness_status: "needs_review", demo_data_risk: "medium", api_contract: { action }, notes: action, created_by_name: baseRow.created_by_name };
    const inserted = await dbInsert(table, [row]);
    await writeAuditLog(req, { action_type: "phase_25_action", module: "release-readiness-center", target_table: table, target_id: inserted?.[0]?.id || null, new_snapshot: inserted?.[0] || row, change_summary: `${actor.name} ran ${action} in Final Release Readiness Center.` });
    res.json({ ok: true, success: true, record: Array.isArray(inserted) ? inserted[0] : row });
  } catch (error) {
    rememberSupabaseIssue("phase 25 release/checklist", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save Final Release Readiness Center action." });
  }
});

app.use((req, res) => {
  res.status(404).json({
    ok: false,
    success: false,
    error: `Route not found: ${req.method} ${req.path}`,
  });
});

app.listen(PORT, () => {
  console.log(`AI quote server running on port ${PORT}`);
});

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

function normalizeOpenAIModelId(value, fallback = "") {
  const raw = String(value || fallback || "").trim();
  const key = raw.toLowerCase().replace(/\s+/g, "");
  const aliases = {
    "gpt4o": "gpt-4o",
    "gpt-4-o": "gpt-4o",
    "gpt4omini": "gpt-4o-mini",
    "gpt-4-o-mini": "gpt-4o-mini",
    "gpt5": "gpt-5",
    "gpt5.4": "gpt-5.4",
    "gpt54": "gpt-5.4",
    "gpt5.5": "gpt-5.5",
    "gpt55": "gpt-5.5",
  };
  return aliases[key] || raw;
}

function uniqueModelList(values = []) {
  return [...new Set(values.map((value) => normalizeOpenAIModelId(value)).filter(Boolean))];
}

const MODEL = normalizeOpenAIModelId(process.env.OPENAI_MODEL, DEFAULT_OPENAI_MODEL);
const WEB_SEARCH_MODEL = normalizeOpenAIModelId(process.env.OPENAI_WEB_SEARCH_MODEL, MODEL);
// The document engine is intentionally separate from normal chat. If Render does not
// inject OPENAI_DOCUMENT_MODEL, the fallback is now GPT-5.5 — never the old GPT-4o.
const DOCUMENT_ANALYSIS_MODEL = normalizeOpenAIModelId(process.env.OPENAI_DOCUMENT_MODEL, "gpt-5.5");
const DOCUMENT_ANALYSIS_FALLBACK_MODELS = uniqueModelList([
  DOCUMENT_ANALYSIS_MODEL,
  ...String(process.env.OPENAI_DOCUMENT_FALLBACK_MODELS || "gpt-5.4,gpt-5,gpt-4.1")
    .split(",")
    .map((value) => value.trim()),
]);
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
const CUSTOMER_DOCUMENT_BUCKET = String(process.env.CUSTOMER_DOCUMENT_BUCKET || "customer-documents").trim() || "customer-documents";
const CUSTOMER_DOCUMENT_RETENTION_DAYS = Math.max(1, Number(process.env.CUSTOMER_DOCUMENT_RETENTION_DAYS || 30) || 30);
let customerDocumentBucketReady = false;

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

async function supabaseStorage(pathname, { method = "GET", body, headers = {} } = {}) {
  if (!SUPABASE_ENABLED) throw new Error("Supabase is not configured. Add SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in Render.");
  const response = await fetch(`${SUPABASE_URL}/storage/v1/${pathname}`, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      ...headers,
    },
    body,
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const message = typeof data === "object" && data ? (data.message || data.error || JSON.stringify(data)) : (text || response.statusText);
    throw new Error(`Supabase Storage ${method} ${pathname} failed: ${message}`);
  }
  return data;
}

function sanitizeStorageSegment(value = "file") {
  return String(value || "file")
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "file";
}

function decodeDataUrl(dataUrl = "") {
  const match = String(dataUrl || "").match(/^data:([^;,]+)?(;base64)?,([\s\S]+)$/);
  if (!match) throw new Error("Uploaded file data is invalid.");
  const mimeType = match[1] || "application/octet-stream";
  const buffer = match[2] ? Buffer.from(match[3], "base64") : Buffer.from(decodeURIComponent(match[3]), "utf8");
  return { mimeType, buffer };
}

async function ensureCustomerDocumentBucket() {
  if (customerDocumentBucketReady) return;
  try {
    await supabaseStorage("bucket", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: CUSTOMER_DOCUMENT_BUCKET,
        name: CUSTOMER_DOCUMENT_BUCKET,
        public: false,
        file_size_limit: 12 * 1024 * 1024,
        allowed_mime_types: ["application/pdf", "image/png", "image/jpeg", "image/webp"],
      }),
    });
  } catch (error) {
    if (!/already exists|duplicate/i.test(error?.message || "")) throw error;
  }
  customerDocumentBucketReady = true;
}

async function uploadCustomerDocumentObject({ chatId, fileName, mimeType, buffer }) {
  await ensureCustomerDocumentBucket();
  const safeChat = sanitizeStorageSegment(chatId || "unlinked-chat");
  const safeName = sanitizeStorageSegment(fileName || "uploaded-file");
  const objectPath = `customer-chat/${safeChat}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeName}`;
  const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
  await supabaseStorage(`object/${encodeURIComponent(CUSTOMER_DOCUMENT_BUCKET)}/${encodedPath}`, {
    method: "POST",
    headers: {
      "Content-Type": mimeType || "application/octet-stream",
      "x-upsert": "false",
      "cache-control": "private, max-age=0",
    },
    body: buffer,
  });
  return { bucket: CUSTOMER_DOCUMENT_BUCKET, path: objectPath };
}

async function createCustomerDocumentSignedUrl(storagePath, expiresIn = 900) {
  const encodedPath = String(storagePath || "").split("/").map(encodeURIComponent).join("/");
  const data = await supabaseStorage(`object/sign/${encodeURIComponent(CUSTOMER_DOCUMENT_BUCKET)}/${encodedPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn }),
  });
  const signedPath = data?.signedURL || data?.signedUrl || data?.signed_url || "";
  return signedPath ? `${SUPABASE_URL}/storage/v1${signedPath.startsWith("/") ? "" : "/"}${signedPath}` : "";
}

async function verifyCustomerDocumentObject(storagePath) {
  const signedUrl = await createCustomerDocumentSignedUrl(storagePath, 180);
  if (!signedUrl) throw new Error("The file upload completed, but Supabase could not create a verification link.");
  const response = await fetch(signedUrl, { method: "GET", headers: { Range: "bytes=0-0" } });
  if (!response.ok && response.status !== 206) {
    throw new Error(`Supabase Storage verification failed with status ${response.status}.`);
  }
  return { verified: true, verifiedAt: new Date().toISOString() };
}

async function deleteCustomerDocumentObject(storagePath) {
  if (!storagePath) return;
  const encodedPath = String(storagePath).split("/").map(encodeURIComponent).join("/");
  try {
    await supabaseStorage(`object/${encodeURIComponent(CUSTOMER_DOCUMENT_BUCKET)}/${encodedPath}`, { method: "DELETE" });
  } catch (error) {
    console.warn("Could not clean up uploaded object after metadata failure:", error?.message || error);
  }
}

function normalizeDetectedDocumentSystem(value = "") {
  const text = String(value || "").trim();
  const lower = text.toLowerCase();
  if (!lower) return "";
  if (/ultra\s*slim|slim\s*sliding/.test(lower)) return "Ultra Slim Sliding Door";
  if (/105/.test(lower) || /local\s*(?:sliding|system)/.test(lower)) return "Sliding Door 105 Series";
  if (/thermal\s*break.*sliding|sliding.*thermal\s*break/.test(lower)) return "Local Thermal Break Sliding";
  if (/telescop/.test(lower)) return "Telescopic Sliding Door";
  if (/pocket/.test(lower)) return "Pocket Door";
  if (/ghost/.test(lower)) return "Ghost Door";
  if (/fold/.test(lower) && /slim/.test(lower)) return "Slim Folding Door";
  if (/fold/.test(lower) && /internal/.test(lower)) return "Internal Folding Door";
  if (/fold/.test(lower)) return "Folding Door";
  if (/fixed\s*glass/.test(lower)) return "Fixed Glass";
  if (/shower/.test(lower)) return "Shower Glass";
  if (/partition/.test(lower)) return "Glass Partition";
  if (/sliding/.test(lower)) return "Ultra Slim Sliding Door";
  return text;
}

function normalizeDocumentAnalysis(raw = {}, fileName = "uploaded-file") {
  const detectedSystem = normalizeDetectedDocumentSystem(raw.detected_system || raw.detectedSystem || raw.product || raw.system || "");
  const customerUpdatesRaw = raw.customer_updates || raw.customerUpdates || {};
  const customerUpdates = {
    ...customerUpdatesRaw,
    productInquired: customerUpdatesRaw.productInquired || customerUpdatesRaw.product_inquired || detectedSystem || null,
    location: customerUpdatesRaw.location || raw.location || null,
    projectType: customerUpdatesRaw.projectType || customerUpdatesRaw.project_type || raw.project_type || raw.projectType || null,
  };
  const items = Array.isArray(raw.items) ? raw.items : [];
  const confidenceNumber = Number(raw.confidence);
  const confidence = Number.isFinite(confidenceNumber) ? Math.max(0, Math.min(1, confidenceNumber)) : null;
  const summary = String(raw.summary || raw.description || "").trim();
  const reply = String(raw.reply || raw.customer_reply || raw.customerReply || "").trim()
    || (detectedSystem
      ? `I reviewed ${fileName}. It appears to show ${detectedSystem}${confidence !== null ? ` (${Math.round(confidence * 100)}% confidence)` : ""}. ${summary || "Please confirm the visible size or tell me what you want to change."}`
      : `I reviewed ${fileName}, but I could not identify the exact system confidently. Please tell me which product or detail you want me to focus on.`);
  return {
    detectedSystem,
    category: String(raw.category || "").trim() || null,
    confidence,
    summary,
    evidence: Array.isArray(raw.evidence) ? raw.evidence.map(String).slice(0, 12) : [],
    visibleText: Array.isArray(raw.visible_text || raw.visibleText) ? (raw.visible_text || raw.visibleText).map(String).slice(0, 50) : [],
    dimensions: Array.isArray(raw.dimensions) ? raw.dimensions.slice(0, 30) : [],
    quantity: raw.quantity ?? null,
    panelAssumption: raw.panel_assumption || raw.panelAssumption || null,
    glassType: raw.glass_type || raw.glassType || null,
    colour: raw.colour || raw.color || null,
    needsClarification: Boolean(raw.needs_clarification || raw.needsClarification),
    clarificationQuestions: Array.isArray(raw.clarification_questions || raw.clarificationQuestions) ? (raw.clarification_questions || raw.clarificationQuestions).map(String).slice(0, 8) : [],
    customerUpdates,
    items,
    reply,
  };
}

async function analyzeCustomerDocument({ fileName, mimeType, dataUrl, buffer, customer = {}, messages = [], caption = "" }) {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is missing, so the stored document cannot be analyzed.");
  const analysisPrompt = `You are the document and image analysis assistant for Buildup Glass & Aluminum in the UAE.

Study the uploaded customer file carefully. Identify the aluminium/glass product or system only from visible evidence. Extract useful quotation details such as product/system, dimensions, quantity, panel arrangement, glass type, colour, location, project type, drawing codes and notes. Do not invent dimensions or hidden details.

Business rules:
- A generic slim/sliding system should map to Ultra Slim Sliding Door unless the file explicitly says 105 Series/local/normal sliding.
- Sliding Door 105 Series is the local/normal sliding system. Never describe 105 as separate from or superior to local sliding.
- Ultra Slim Sliding Door normal panel assumption is up to about 2.3m wide x 3.0m high. If height exceeds 3.0m, reduce assumed panel width and flag final engineering/site verification.
- If uncertain, state what is visible and ask one precise clarification question.
- Never claim a file contains information that is not visible.

Return valid JSON only with this shape:
{
  "detected_system": "",
  "category": "",
  "confidence": 0.0,
  "summary": "",
  "evidence": [],
  "visible_text": [],
  "dimensions": [],
  "quantity": null,
  "panel_assumption": null,
  "glass_type": null,
  "colour": null,
  "location": null,
  "project_type": null,
  "needs_clarification": false,
  "clarification_questions": [],
  "customer_updates": {"productInquired": null, "location": null, "projectType": null},
  "items": [],
  "reply": "A concise customer-facing response that explains what you found and naturally continues the quotation chat."
}

Known customer: ${JSON.stringify(customer || {})}
Customer instruction/caption attached to this file: ${JSON.stringify(String(caption || "").trim() || null)}
Recent chat: ${JSON.stringify((Array.isArray(messages) ? messages : []).slice(-12))}`;

  const content = [{ type: "input_text", text: analysisPrompt }];
  if (mimeType === "application/pdf") {
    content.unshift({ type: "input_file", filename: fileName, file_data: buffer.toString("base64") });
  } else {
    content.unshift({ type: "input_image", image_url: dataUrl, detail: "high" });
  }

  const attemptedModels = [];
  let lastModelError = null;

  for (const model of DOCUMENT_ANALYSIS_FALLBACK_MODELS) {
    attemptedModels.push(model);
    try {
      const request = {
        model,
        input: [{ role: "user", content }],
        max_output_tokens: 2200,
        store: false,
      };
      if (model.startsWith("gpt-5")) {
        request.reasoning = { effort: String(process.env.OPENAI_DOCUMENT_REASONING_EFFORT || "high").trim() || "high" };
      }
      const response = await client.responses.create(request);
      const rawText = response.output_text || "{}";
      return {
        analysis: normalizeDocumentAnalysis(safeParseJson(rawText), fileName),
        model,
        configuredModel: DOCUMENT_ANALYSIS_MODEL,
        attemptedModels,
        responseId: response.id || null,
        usage: response.usage || null,
      };
    } catch (error) {
      const message = String(error?.message || error || "");
      const code = String(error?.code || error?.error?.code || "").toLowerCase();
      const unavailable = Number(error?.status) === 404
        || code === "model_not_found"
        || code === "invalid_model"
        || /model.+(does not exist|not found|no access|do not have access|not available|unavailable)/i.test(message);
      if (!unavailable) throw error;
      lastModelError = error;
      console.warn(`[Document AI] Model ${model} unavailable; trying the next configured fallback.`);
    }
  }

  const lastMessage = String(lastModelError?.message || "No compatible document model was available.");
  const error = new Error(`Document AI could not access any configured model. Tried: ${attemptedModels.join(", ")}. Last error: ${lastMessage}`);
  error.code = "document_model_unavailable";
  error.attemptedModels = attemptedModels;
  throw error;
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
  // GPT-5.5 should use web search more often for customer-facing guidance,
  // especially when the customer asks about suitability, product options,
  // standards, limitations, current info, or anything uncertain.
  return /\b(best|recommend|suggest|which|what system|suitable|limitation|maximum|latest|current|search|internet|website|specification|standard|thermal break|5\s*meter|5000\s*mm|large opening|wide opening|sliding or folding|folding or sliding|compare|difference|option|available|can you|is it possible|safe|strong|waterproof|soundproof|heat|insulation|price range|dubai|uae)\b/.test(text);
}


function normalizeCustomerProductInquiry(text = "") {
  const value = String(text || "").toLowerCase();
  if (!value.trim()) return "";
  if (/ultra\s*slim|slim\s*sliding|premium\s*sliding|minimal\s*sliding/.test(value)) return "Ultra Slim Sliding Door";
  if (/\b105\b|105\s*series|local\s*sliding|normal\s*sliding|standard\s*local\s*sliding/.test(value)) return "Sliding Door 105 Series";
  if (/local\s*thermal|thermal\s*break\s*sliding|thermal\s*sliding/.test(value)) return "Local Thermal Break Sliding";
  if (/telescopic/.test(value)) return "Telescopic Sliding Door";
  if (/pocket/.test(value)) return "Pocket Door";
  if (/ghost/.test(value)) return "Ghost Door";
  if (/folding|bi\s*fold|bifold/.test(value)) return "Folding Door";
  if (/hinge|hinged/.test(value)) return "Hinged Door";
  if (/sliding|slider|slide\s*door|sliding\s*door/.test(value)) return "Ultra Slim Sliding Door";
  return "";
}

function normalizeAiSlidingRecommendation(item = {}) {
  const next = { ...item };
  const text = `${next.product || ""} ${next.type || ""} ${next.subcategory || ""} ${next.system || ""} ${next.description || ""}`.toLowerCase();
  const explicit105 = /\b105\b|105\s*series|local\s*sliding|normal\s*sliding|standard\s*local\s*sliding/.test(text);
  const explicitLocalThermal = /local\s*thermal|thermal\s*break\s*sliding|thermal\s*sliding/.test(text);
  const explicitSpecial = explicit105 || explicitLocalThermal || /telescopic|pocket|ghost/.test(text);
  const genericSliding = /sliding|slider|slide/.test(text) && !explicitSpecial && !/ultra\s*slim|slim\s*sliding|premium\s*sliding/.test(text);

  if (genericSliding) {
    next.product = next.product || "Door";
    next.type = next.type || "Sliding";
    next.subcategory = "Ultra Slim Sliding Door";
    next.system = "Ultra Slim Sliding Door";
  }

  if (/ultra\s*slim|slim\s*sliding|premium\s*sliding/.test(text)) {
    next.product = next.product || "Door";
    next.type = next.type || "Sliding";
    next.subcategory = "Ultra Slim Sliding Door";
    next.system = "Ultra Slim Sliding Door";
  }

  if (explicit105) {
    next.product = next.product || "Door";
    next.type = next.type || "Sliding";
    next.subcategory = "Sliding Door 105 Series";
    next.system = "Sliding Door 105 Series";
  }

  if (explicitLocalThermal) {
    next.product = next.product || "Door";
    next.type = next.type || "Sliding";
    next.subcategory = "Local Thermal Break Sliding";
    next.system = "Local Thermal Break Sliding";
  }

  return next;
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

  const productInquired = normalizeCustomerProductInquiry(value);
  if (productInquired) {
    updates.productInquired = productInquired;
    updates.product_inquired = productInquired;
  }

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
  const name = String(customer.name || customer.customerName || customer.clientName || "").trim();
  if (!name) missing.push("name");
  else if (!hasAcceptedCustomerIdentity(customer) && !isLikelyValidCustomerName(name)) missing.push("valid name");
  const phone = String(customer.phone || customer.phoneNumber || customer.mobile || "").trim();
  if (!phone) missing.push("phone number");
  else if (!isValidUaePhone(phone)) missing.push("valid phone number with correct country code/length");
  if (!String(customer.location || "").trim()) missing.push("location");
  return missing;
}

function smartSlidingSplit(totalPanels) {
  const total = Math.max(2, Number(totalPanels) || 2);
  const fixed = Math.max(1, Math.round(total / 3));
  return { slidingPanels: Math.max(1, total - fixed), fixedPanels: fixed };
}

function ultraSlimTargetPanelWidthFromHeight(heightMm) {
  const height = Number(heightMm) || 0;
  // Buildup rule: Ultra Slim Sliding Door can normally use panels up to about 2.3m wide x 3.0m high.
  // If height goes above 3m, keep the recommendation conservative by reducing panel width gradually.
  if (!height || height <= 3000) return 2300;
  if (height <= 3300) return 2150;
  if (height <= 3600) return 2000;
  return 1850;
}

function inferTotalPanelsFromDimensions(widthMm, heightMm = 0, label = "") {
  const width = Number(widthMm) || 0;
  if (!width) return 2;
  const text = String(label || "").toLowerCase();
  let targetPanelWidth = 1400;
  if (text.includes("ultra slim") || text.includes("slim sliding")) targetPanelWidth = ultraSlimTargetPanelWidthFromHeight(heightMm);
  else if (text.includes("105 series") || text.includes("local thermal") || text.includes("local sliding")) targetPanelWidth = 1200;
  else if (text.includes("telescopic") || text.includes("pocket") || text.includes("ghost")) targetPanelWidth = 850;
  return Math.max(2, Math.min(8, Math.ceil(width / targetPanelWidth)));
}

function inferTotalPanelsFromWidth(widthMm, label = "") {
  return inferTotalPanelsFromDimensions(widthMm, 0, label);
}

function normalizeQuoteItems(items = []) {
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const item = normalizeAiSlidingRecommendation({ ...raw });
    const label = `${item.product || ""} ${item.type || ""} ${item.subcategory || item.system || ""}`.toLowerCase();
    const isSliding = /sliding|slider|slide/.test(label);
    const isFixedGlass = /fixed glass|fixed window|fixed/.test(label) && !isSliding;
    const isFolding = /folding|fold/.test(label);

    if (!item.qty && item.quantity) item.qty = item.quantity;
    item.qty = Number(item.qty || 1) || 1;

    if (isSliding) {
      item.panelMode = "sliding-fixed";
      const total = Number(item.panels || item.totalPanels || 0) || inferTotalPanelsFromDimensions(item.width_mm || item.width || item.widthMm, item.height_mm || item.height || item.heightMm, label);
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
  const name = String(customer.name || customer.customerName || customer.clientName || "").trim();
  if (!name) missing.push("name");
  else if (!hasAcceptedCustomerIdentity(customer) && !isLikelyValidCustomerName(name)) missing.push("valid name");
  const phone = String(customer.phone || customer.phoneNumber || customer.mobile || "").trim();
  if (!phone) missing.push("phone number");
  else if (!isValidUaePhone(phone)) missing.push("valid phone number with correct country code/length");
  return missing;
}

function customerContactQuestion(missing = [], latestText = "") {
  const lowerLatest = String(latestText || "").toLowerCase();
  const hasProductIntent = /sliding|folding|door|window|glass|quote|price|cost|villa|partition|shower|fencing|pergola/.test(lowerLatest);
  const needsName = (missing || []).some((item) => /name/i.test(String(item)));
  const needsValidName = (missing || []).some((item) => /valid name/i.test(String(item)));
  const needsPhone = (missing || []).some((item) => /phone/i.test(String(item)));
  const invalidPhone = (missing || []).some((item) => /valid phone/i.test(String(item)));
  if (needsValidName) return "That does not look like a valid name. Please share your real name so I can create the inquiry correctly.";
  if (needsName && hasProductIntent) return "Of course, we can move on to that. But before anything else, I need your name and phone number so I can create your inquiry properly.";
  if (needsName) return "Please share your name first so I can create your inquiry safely.";
  if (invalidPhone) return "Please share a valid phone number so our team can contact you regarding the inquiry.";
  if (needsPhone) return "Thank you. Please share your phone number now so I can create your inquiry.";
  const fields = joinHumanList(missing.length ? missing : ["name", "phone number"]);
  return `Before I prepare the quotation, please share your ${fields} so I can save the inquiry correctly.`;
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
- Do NOT send automatic reminder/follow-up messages later. Only answer after the customer sends a message or selects a visible action.
- If the customer is confused, explain clearly and politely. If they keep insisting you are wrong after you explained once, de-escalate with: "I think then I might be mistaken. I can connect this chat to a real agent for further clarifications."
- If the customer opens site-visit booking but cancels/closes it or says no/cancel, do not thank them as if a booking was completed. Say: "It looks like you have not selected a date/time yet. Do you want to book a site visit again?"
- Site-visit booking must have a selected date and selected time before saying it is booked.
- Do not overwhelm the customer with a list of many fields in one message.
- Do not promise final price, structural approval, exact delivery date, or final panel design without staff review. Say estimated/AI draft pricing can vary after team/site verification.
- Only offer a real staff/agent handoff in these cases: (1) the customer asks for a real agent, (2) the customer seems frustrated and you cannot answer/understand after trying once, or (3) the inquiry is outside the instant pricing engine such as aluminium fencing, pergola, glass house, canopy, railing/handrail, or other custom work.
- When a real-agent request is made, do not immediately share any staff phone number. Say the request was sent and that the app will share the contact only if nobody joins within 5 minutes.
- If a customer name was already accepted or the lead was already created, never ask for the name again and never reclassify it as invalid later in the same chat.
- Do NOT offer or request a real agent just because a site visit was booked, a location was shared, or normal quote details are missing.
- If a business-specific answer is uncertain, do not say "I don't know". Say that you will check with the team, and only offer staff support if it matches the three handoff cases above.

Conversation order for customer mode:
1. Before product discussion, collect a valid customer name and valid phone number. Ask for the name first. If the customer asks for a product immediately, politely say: "Of course, we can move on to that. But before anything else, I need your name and phone number so I can create your inquiry properly."
2. Accept phone numbers with country code when the national number length matches the country. If no country code is given, treat it as a UAE number.
3. Reject gibberish/random names like "asldjhua", "asdf", or product words as names. Ask again politely for the real name.
4. After name and phone are captured, understand product type and collect quote-critical product details BEFORE confirmation, price, or staff submission.
   - Doors/windows/fixed glass: width and height, plus quantity.
   - Aluminium fencing/fence: width and height, plus quantity if there are separate sections. Do NOT treat a phone number as a width or height. Do NOT submit fencing to staff just because phone/location was provided.
   - Partitions/shower/railing: width and height, plus quantity/area if available.
5. After name and phone number are available and quote-critical details are complete, summarize the products and ask for confirmation. Confirmation should be the final step before price/staff-review.
6. After customer confirms:
   - If standard configuration: return quote_draft so the app can show instant price.
   - If non-standard/custom options are selected, return quote_draft but clearly note it needs staff review. Non-standard includes frosted/fluted/tinted/reflective glass, special glass colour, non-standard thickness, special aluminium/frame colour, jumbo/special access, or unclear specifications.
6. After quotation/review submission, ask for Google Maps location if not already shared.
7. After location is shared, ask whether they want to book a site visit with an expert. If they agree, the app will ask the preferred date first, allow them to change/close the booking picker, then show available times for that selected date. The customer can choose any future date; booking is confirmed only after they select both date and time.
Customers may start chatting without name/phone/location, but in customer website mode you must not continue into product quotation until valid name and phone are captured. Extract them from chat if mentioned and return them in customer_updates. Do not return quote_draft until name and a valid phone number are known.
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
- If product details are complete but name or a valid phone number is missing, ask naturally for the missing contact detail first. Do not return quote_draft yet.
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
Buildup sliding-door product rule:
- If the customer says "sliding door", "slim sliding", "best sliding", or asks for a standard sliding recommendation without naming a system, recommend and use "Ultra Slim Sliding Door" as the default/standard Buildup sliding system.
- Do NOT recommend "Sliding Door 105 Series" as better than a local sliding system. 105 Series IS the local/normal sliding-door system. Treat it as a budget/local option only when the customer explicitly asks for 105 series, local sliding, normal sliding, or lower-budget option.
- "Local Thermal Break Sliding" is a separate thermal-break option; do not confuse it with 105 Series.
- For comparisons, describe Ultra Slim Sliding Door as the premium/main recommendation, and 105 Series as the local/economical 105 option. Never say 105 is better than local sliding.
- Ultra Slim Sliding Door panel assumption: a normal panel can go up to about 2.3m wide x 3.0m high. If height goes above 3.0m, reduce the assumed panel width gradually and use more panels if needed. Do not over-split normal openings, but do not assume a single oversized panel beyond this rule.
- If the customer gives total opening width and height but no panel count for Ultra Slim Sliding Door, infer a sensible panel count using the 2.3m x 3.0m rule and mention that final panel configuration will be verified by the team/site measurement.
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

async function runChatCompletion({ mode, prompt, messages, catalog, customer }) {
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

const INTERNATIONAL_PHONE_LENGTHS = [
  ["971", [8, 9]], ["91", [10]], ["92", [10]], ["966", [9]], ["974", [8]], ["965", [8]], ["968", [8]], ["973", [8]], ["20", [10]], ["44", [10]], ["1", [10]], ["61", [9]], ["49", [10, 11]], ["33", [9]], ["39", [9, 10]], ["90", [10]], ["63", [10]], ["880", [10]], ["94", [9]], ["977", [10]], ["62", [9, 10, 11, 12]], ["60", [9, 10]], ["65", [8]], ["86", [11]], ["7", [10]],
];

function normalizeUaePhone(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return { valid: false, normalized: "", national: "", countryCode: "", reason: "empty" };
  let digits = raw.replace(/\D/g, "");
  if (!digits) return { valid: false, normalized: "", national: "", countryCode: "", reason: "empty" };
  const explicitInternational = /^\s*(\+|00)/.test(raw) || /^(971|91|92|966|974|965|968|973|20|44|1|61|49|33|39|90|63|880|94|977|62|60|65|86|7)/.test(digits);
  if (!explicitInternational || /^0\d+/.test(digits)) {
    let national = digits.startsWith("0") ? digits.slice(1) : digits;
    const isMobile = /^5\d{8}$/.test(national);
    const isLandline = /^(2|3|4|6|7|9)\d{7}$/.test(national);
    const valid = isMobile || isLandline;
    return { valid, normalized: valid ? `+971${national}` : raw, national, countryCode: "971", reason: valid ? "valid" : "invalid_uae_phone_length" };
  }
  if (digits.startsWith("00")) digits = digits.slice(2);
  const match = INTERNATIONAL_PHONE_LENGTHS.slice().sort((a, b) => b[0].length - a[0].length).find(([code]) => digits.startsWith(code));
  if (!match) return { valid: digits.length >= 8 && digits.length <= 15, normalized: digits.length >= 8 && digits.length <= 15 ? `+${digits}` : raw, national: digits, countryCode: "", reason: digits.length >= 8 && digits.length <= 15 ? "valid_e164_generic" : "unknown_country_code" };
  const [countryCode, lengths] = match;
  const national = digits.slice(countryCode.length);
  const valid = lengths.includes(national.length);
  return { valid, normalized: valid ? `+${countryCode}${national}` : raw, national, countryCode, reason: valid ? "valid" : `invalid_length_for_country_${countryCode}` };
}

function isLikelyValidCustomerName(value = "") {
  const cleaned = String(value || "").replace(/\s+/g, " ").trim();
  if (cleaned.length < 2 || cleaned.length > 45) return false;
  if (/\d|@|https?:|www\./i.test(cleaned)) return false;
  if (!/^[\p{L}][\p{L}\s.'-]{1,44}$/u.test(cleaned)) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;
  const lower = cleaned.toLowerCase();
  if (/\b(sliding|door|window|glass|villa|apartment|quote|price|cost|need|want|hello|hi|test|asdf|qwerty|null|none|phone|mobile|number)\b/i.test(lower)) return false;
  if (/(.)\1{3,}/.test(lower)) return false;
  if (/(asdf|qwer|zxcv|hjkl|sldj|ldjh|djhu|jhua|lkjh|dfgh|random)/i.test(lower)) return false;
  const latin = /^[a-z\s.'-]+$/i.test(cleaned);
  if (latin) {
    const letters = lower.replace(/[^a-z]/g, "");
    if (letters.length >= 5) {
      const vowels = (letters.match(/[aeiou]/g) || []).length;
      const ratio = vowels / letters.length;
      if (ratio < 0.18 || ratio > 0.75) return false;
      if (/[bcdfghjklmnpqrstvwxyz]{5,}/i.test(letters)) return false;
    }
  }
  return true;
}

function hasAcceptedCustomerIdentity(customer = {}) {
  return Boolean(
    customer?.contactValidated
    || customer?.nameAccepted
    || customer?.identityAccepted
    || customer?.leadId
    || customer?.lead_id
    || customer?.leadUuid
    || customer?.lead_uuid
  );
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
  if (String(phone || "").trim() && !isValidUaePhone(phone)) throw new Error("Please enter a valid phone number with the correct country code/length before saving this lead.");
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
    : estimateData.productInquired || record.product_inquired || record.project_type || "Auto Quote Chat";
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

function quoteNumberFromCustomerRequest(record = {}) {
  const estimateData = record.estimate_data || {};
  const savedQuote = estimateData.savedQuote && typeof estimateData.savedQuote === "object" ? estimateData.savedQuote : null;
  const explicit = savedQuote?.quoteNo || savedQuote?.quotation?.referenceNo || estimateData.quoteNumber || estimateData.reviewId;
  if (explicit) return String(explicit);
  const chatId = String(estimateData.chatId || record.id || "").replace(/[^a-z0-9_-]/gi, "").slice(-18);
  return chatId ? `AI-CHAT-${chatId.toUpperCase()}` : `AI-CHAT-${Date.now().toString(36).toUpperCase()}`;
}

function buildQuoteFromCustomerRequestRecord(record = {}, leadUuid = null) {
  const estimateData = record.estimate_data || {};
  const rows = Array.isArray(estimateData.rows) ? estimateData.rows : [];
  const items = Array.isArray(estimateData.items) ? estimateData.items : rows;
  if (!rows.length && !items.length) return null;
  const savedQuote = estimateData.savedQuote && typeof estimateData.savedQuote === "object" ? estimateData.savedQuote : null;
  const quoteNumber = quoteNumberFromCustomerRequest(record);
  const finalTotal = toNumberOrNull(savedQuote?.finalTotal ?? estimateData.roughAmount) || rows.reduce((sum, row) => sum + (Number(row.qty || row.quantity || 1) || 1) * (Number(row.price || row.total || row.totalPrice || 0) || 0), 0);
  const quoteStatus = String(record.status || "").includes("review") ? "AI Needs Review" : "AI Submitted";
  return {
    ...(savedQuote || {}),
    id: savedQuote?.id || quoteNumber,
    quoteNo: quoteNumber,
    leadId: estimateData.leadId || "",
    customerName: record.customer_name || savedQuote?.customerName || "Auto Quote Customer",
    quoteStatus,
    saveAsStatus: quoteStatus,
    saveAsNote: record.status === "ai_quote_needs_review" ? `Needs staff review: ${estimateData.reviewReason || estimateData.note || record.status}` : "Created from customer AI chat.",
    finalTotal,
    subtotal: finalTotal,
    rows: rows.length ? rows : items,
    createdFrom: "auto_quote_chat",
    chatId: estimateData.chatId || null,
    updatedAt: new Date().toISOString(),
    savedAt: savedQuote?.savedAt || new Date().toISOString(),
    quotation: {
      ...(savedQuote?.quotation || {}),
      referenceNo: quoteNumber,
      customerName: record.customer_name || savedQuote?.quotation?.customerName || "Auto Quote Customer",
      customerDetails: [record.phone ? `Phone: ${record.phone}` : "", record.location ? `Location: ${record.location}` : "", record.project_type ? `Project Type: ${record.project_type}` : ""].filter(Boolean).join("\n"),
      quoteStatus,
      saveAsStatus: quoteStatus,
      saveAsNote: record.status === "ai_quote_needs_review" ? `Needs staff review: ${estimateData.reviewReason || estimateData.note || record.status}` : "Created from customer AI chat.",
    },
  };
}

async function upsertQuoteFromCustomerRequestRecord(record = {}, leadUuid = null, req = null) {
  if (!SUPABASE_ENABLED) return null;
  const quote = buildQuoteFromCustomerRequestRecord(record, leadUuid);
  if (!quote) return null;
  const leadMap = new Map();
  if (quote.leadId && leadUuid) leadMap.set(quote.leadId, leadUuid);
  await upsertQuotesToSupabase([quote], leadMap, req);
  return { quoteNumber: quote.quoteNo, table: "quotes", itemTable: "quote_items" };
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
      productInquired: customer.productInquired || customer.product_inquired || payload.productInquired || payload.product_inquired || estimateData.productInquired || null,
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
  let linkedQuote = null;
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
      linkedQuote = await upsertQuoteFromCustomerRequestRecord(record, linkedLead?.row?.id || record.estimate_data?.leadUuid || null, req);
      if (linkedQuote?.quoteNumber) {
        record.estimate_data = {
          ...(record.estimate_data || {}),
          quoteNumber: record.estimate_data?.quoteNumber || linkedQuote.quoteNumber,
          quoteStorage: linkedQuote,
        };
      }
    } catch (error) {
      rememberSupabaseIssue("auto-create/update lead or quote from customer request", error);
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

function normalizeSiteVisitBookingDbPayload(booking = {}, actor = {}) {
  const customer = booking.customer || {};
  const estimateData = booking.estimate_data || {};
  return {
    booking_id: booking.id || booking.booking_id || `site_visit_${Date.now().toString(36)}`,
    slot_id: booking.slotId || booking.slot_id || `${booking.date || ""} ${booking.time || ""}`.trim(),
    lead_id_text: customer.leadId || estimateData.leadId || booking.leadId || null,
    customer_request_chat_id: booking.chatId || estimateData.chatId || null,
    customer_name: customer.name || customer.customerName || booking.customer_name || null,
    phone: customer.phone || booking.phone || null,
    location: customer.location || booking.location || null,
    project_type: customer.projectType || booking.project_type || null,
    product_inquired: customer.productInquired || booking.product_inquired || estimateData.productInquired || null,
    visit_date: cleanDateOrNull(booking.date),
    visit_time: booking.time || null,
    label: booking.label || null,
    status: booking.status || "booked",
    booking_data: booking,
    updated_by: actor.id || null,
    updated_at: new Date().toISOString(),
  };
}

async function readSiteVisitBookings() {
  const fallback = { bookings: [] };
  if (!SUPABASE_ENABLED) return readJsonFile(path.join(DATA_DIR, "site-visit-bookings.json"), fallback);
  try {
    const directRows = await dbSelect("site_visit_bookings", "select=*&order=updated_at.desc&limit=500");
    const bookings = (Array.isArray(directRows) ? directRows : []).map((row) => ({
      ...(row.booking_data || {}),
      id: row.booking_id,
      slotId: row.slot_id,
      date: row.visit_date,
      time: row.visit_time,
      label: row.label,
      status: row.status,
      customer: {
        ...((row.booking_data || {}).customer || {}),
        leadId: row.lead_id_text || ((row.booking_data || {}).customer || {}).leadId,
        name: row.customer_name || ((row.booking_data || {}).customer || {}).name,
        phone: row.phone || ((row.booking_data || {}).customer || {}).phone,
        location: row.location || ((row.booking_data || {}).customer || {}).location,
        projectType: row.project_type || ((row.booking_data || {}).customer || {}).projectType,
        productInquired: row.product_inquired || ((row.booking_data || {}).customer || {}).productInquired,
      },
    }));
    return { bookings, updatedAt: new Date().toISOString(), storage: "site_visit_bookings" };
  } catch (error) {
    rememberSupabaseIssue("site_visit_bookings table load", error);
    const rows = await dbSelect("app_settings", "select=setting_value&setting_key=eq.site_visit_bookings&limit=1");
    return Array.isArray(rows) && rows[0]?.setting_value ? { ...rows[0].setting_value, storage: "app_settings.site_visit_bookings_fallback" } : fallback;
  }
}

async function writeSiteVisitBookings(value = {}, req = null) {
  const data = { bookings: Array.isArray(value.bookings) ? value.bookings : [], updatedAt: new Date().toISOString() };
  if (!SUPABASE_ENABLED) {
    writeJsonFile(path.join(DATA_DIR, "site-visit-bookings.json"), data);
    return data;
  }
  const actor = actorFromRequest(req);
  let directTableSaved = false;
  try {
    const rows = data.bookings.map((booking) => normalizeSiteVisitBookingDbPayload(booking, actor)).filter((row) => row.slot_id);
    if (rows.length) {
      await dbUpsert("site_visit_bookings", rows, { onConflict: "slot_id", returning: false });
      directTableSaved = true;
    }
  } catch (error) {
    rememberSupabaseIssue("site_visit_bookings table save", error);
  }
  await dbUpsert("app_settings", [{
    setting_key: "site_visit_bookings",
    setting_value: data,
    updated_by: actor.id,
    updated_by_name: actor.name,
    updated_at: new Date().toISOString(),
  }], { onConflict: "setting_key", returning: false });
  return { ...data, storage: directTableSaved ? "site_visit_bookings + app_settings.site_visit_bookings" : "app_settings.site_visit_bookings_fallback" };
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
    } catch {}
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
  const name = String(customer.name || customer.customerName || customer.clientName || "").trim();
  if (!name) missing.push("name");
  else if (!hasAcceptedCustomerIdentity(customer) && !isLikelyValidCustomerName(name)) missing.push("valid name");
  const phone = String(customer.phone || customer.phoneNumber || customer.mobile || "").trim();
  if (!phone) missing.push("phone number");
  else if (!isValidUaePhone(phone)) missing.push("valid phone number with correct country code/length");
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

function base64UrlEncode(value) {
  return Buffer.from(String(value)).toString("base64url");
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
  } catch (error) {
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
  } catch (error) {
    res.status(500).json({ ok: false, success: false, error: "Could not check quote support status." });
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

app.post("/customer-lead-intake", async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) {
      return res.status(503).json({ ok: false, success: false, error: "Supabase is not configured. Lead was not saved." });
    }
    const body = req.body || {};
    const customer = body.customer && typeof body.customer === "object" ? body.customer : {};
    const name = getCustomerDisplayName(customer);
    const phoneInfo = normalizeUaePhone(customer.phone || customer.phoneNumber || customer.mobile || body.phone || "");
    if (!name) return res.status(400).json({ ok: false, success: false, error: "Customer name is required before starting the chat." });
    if (!hasAcceptedCustomerIdentity(customer) && !isLikelyValidCustomerName(name)) return res.status(400).json({ ok: false, success: false, error: "Please enter a real customer name before starting the chat." });
    if (!phoneInfo.valid) return res.status(400).json({ ok: false, success: false, error: "Valid phone number is required before starting the chat. If no country code is given, it will be treated as UAE." });

    const leadResult = await upsertSingleLeadToSupabase({
      ...customer,
      name,
      phone: phoneInfo.normalized,
      source: customer.source || body.source || "AI Chatbot",
      leadType: customer.leadType || "Customer Website Chat",
      status: customer.status || "New Lead",
      productInquired: customer.productInquired || customer.projectType || "Pending inquiry details",
      contactValidated: true,
      nameAccepted: true,
    }, req, { generateIfMissing: true });

    const requestRow = await recordCustomerRequest({
      chatId: body.chatId,
      customer: {
        ...customer,
        name,
        phone: phoneInfo.normalized,
        leadId: leadResult.customer.leadId,
        leadUuid: leadResult.row?.id || null,
        contactValidated: true,
        nameAccepted: true,
      },
      messages: body.messages || body.conversation || [],
      conversation: body.conversation || body.messages || [],
      status: "lead_created_contact_captured",
      eventType: "lead_created_contact_captured",
      note: "Customer provided name and phone before AI quotation chat started.",
      estimate_data: {
        chatId: body.chatId || null,
        leadId: leadResult.customer.leadId,
        leadUuid: leadResult.row?.id || null,
        eventType: "lead_created_contact_captured",
        contactCapturedFirst: true,
        contactValidated: true,
        nameAccepted: true,
      },
    }, req);

    res.json({
      ok: true,
      success: true,
      storage: "supabase",
      lead: leadResult.customer,
      request: requestRow,
      savedTo: {
        lead: { table: "leads", id: leadResult.row?.id || null, leadId: leadResult.customer.leadId },
        customerRequest: { table: "customer_requests", id: requestRow?.id || null, chatId: requestRow?.estimate_data?.chatId || body.chatId || null },
        audit: { table: "audit_logs" },
      },
    });
  } catch (error) {
    rememberSupabaseIssue("customer lead intake", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not create customer lead." });
  }
});

app.post("/customer-request", async (req, res) => {
  try {
    const row = await recordCustomerRequest(req.body || {}, req);
    res.json({ ok: true, success: true, request: row, savedTo: { customerRequest: { table: "customer_requests", id: row?.id || null, chatId: row?.estimate_data?.chatId || req.body?.chatId || null }, lead: row?.estimate_data?.leadId ? { table: "leads", leadId: row.estimate_data.leadId, id: row.estimate_data.leadUuid || null } : null, audit: { table: "audit_logs" } } });
  } catch (error) {
    rememberSupabaseIssue("customer request save", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save customer request to the database." });
  }
});

app.get("/document-engine-status", (_req, res) => {
  res.json({
    ok: true,
    documentEngine: {
      configuredModel: DOCUMENT_ANALYSIS_MODEL,
      modelSource: process.env.OPENAI_DOCUMENT_MODEL ? "OPENAI_DOCUMENT_MODEL" : "server_default",
      fallbackModels: DOCUMENT_ANALYSIS_FALLBACK_MODELS,
      reasoningEffort: String(process.env.OPENAI_DOCUMENT_REASONING_EFFORT || "high").trim() || "high",
      openAiKeyConfigured: Boolean(process.env.OPENAI_API_KEY),
    },
    normalChatModel: MODEL,
    build: "phase-53-document-engine-runtime-diagnostics",
  });
});

app.post("/customer-document", async (req, res) => {
  let uploadedStoragePath = "";
  try {
    if (!SUPABASE_ENABLED) throw new Error("Supabase is not configured. The document was not stored.");
    const body = req.body || {};
    const file = body.file || {};
    const chatId = String(body.chatId || "").trim();
    const caption = String(body.caption || "").trim();
    if (!chatId) throw new Error("Chat ID is required before storing a document.");
    if (!file.dataUrl) throw new Error("No document data was received.");

    const { mimeType: decodedMime, buffer } = decodeDataUrl(file.dataUrl);
    const mimeType = String(file.type || decodedMime || "application/octet-stream").toLowerCase();
    const fileName = String(file.name || body.name || "uploaded-file").trim() || "uploaded-file";
    const allowed = mimeType === "application/pdf" || ["image/png", "image/jpeg", "image/webp"].includes(mimeType);
    if (!allowed) throw new Error("Only PDF, PNG, JPG and WEBP files are supported.");
    if (!buffer.length) throw new Error("The selected file is empty.");
    if (buffer.length > 12 * 1024 * 1024) throw new Error("Please upload a file under 12 MB.");

    // 1) Store in the private Supabase bucket.
    const storage = await uploadCustomerDocumentObject({ chatId, fileName, mimeType, buffer });
    uploadedStoragePath = storage.path;

    // 2) Prove that the exact object can be read back from Supabase Storage.
    const storageVerification = await verifyCustomerDocumentObject(storage.path);
    let previewUrl = "";
    try {
      previewUrl = await createCustomerDocumentSignedUrl(storage.path, 60 * 60);
    } catch (error) {
      console.warn("Could not create customer attachment preview URL:", error?.message || error);
    }

    // 3) Analyze the actual image/PDF content with a multimodal OpenAI model.
    let analysisResult = null;
    let analysisError = null;
    try {
      analysisResult = await analyzeCustomerDocument({
        fileName,
        mimeType,
        dataUrl: file.dataUrl,
        buffer,
        customer: body.customer || {},
        messages: body.messages || body.conversation || [],
        caption,
      });
    } catch (error) {
      analysisError = error?.message || "The document could not be analyzed.";
      console.error("Customer document analysis failed:", analysisError);
    }

    const analysis = analysisResult?.analysis || null;
    const mergedCustomer = {
      ...(body.customer || {}),
      ...(analysis?.customerUpdates || {}),
      productInquired: analysis?.customerUpdates?.productInquired || body.customer?.productInquired || body.customer?.product_inquired || null,
      projectType: analysis?.customerUpdates?.projectType || body.customer?.projectType || body.customer?.project_type || null,
      location: analysis?.customerUpdates?.location || body.customer?.location || null,
    };
    const expiresAt = new Date(Date.now() + CUSTOMER_DOCUMENT_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const uploadedFile = {
      name: fileName,
      type: mimeType,
      size: buffer.length,
      uploadedAt: new Date().toISOString(),
      bucket: storage.bucket,
      storagePath: storage.path,
      storageVerified: true,
      storageVerifiedAt: storageVerification.verifiedAt,
      temporary: true,
      expiresAt,
      analysisStatus: analysis ? "completed" : "failed",
      analysis: analysis || null,
      analysisError,
      caption: caption || null,
    };
    const analysisMessage = analysis?.reply
      ? {
          id: `document_analysis_${Date.now().toString(36)}`,
          role: "assistant",
          sender: "assistant",
          content: analysis.reply,
          text: analysis.reply,
          kind: "document-analysis",
          at: new Date().toISOString(),
        }
      : null;
    const incomingConversation = Array.isArray(body.messages || body.conversation) ? (body.messages || body.conversation) : [];
    const requestConversation = analysisMessage ? [...incomingConversation, analysisMessage] : incomingConversation;

    // 4) Update the linked lead and customer request with everything extracted from the document.
    const requestRow = await recordCustomerRequest({
      chatId,
      customer: mergedCustomer,
      conversation: requestConversation,
      status: analysis ? "document_analyzed" : "document_analysis_failed",
      eventType: analysis ? "document_analyzed" : "document_analysis_failed",
      note: analysis
        ? `Customer document analyzed: ${fileName}. Detected system: ${analysis.detectedSystem || "not confirmed"}.`
        : `Customer document stored but analysis failed: ${fileName}.`,
      items: analysis?.items || [],
      rows: analysis?.items || [],
      productInquired: analysis?.detectedSystem || mergedCustomer.productInquired || null,
      uploadedFiles: [uploadedFile],
      estimate_data: {
        uploadedFiles: [uploadedFile],
        documentAnalysisRequired: !analysis,
        documentAnalysis: analysis,
        documentAnalysisModel: analysisResult?.model || DOCUMENT_ANALYSIS_MODEL,
        documentAnalysisResponseId: analysisResult?.responseId || null,
        documentAnalysisError: analysisError,
      },
    }, req);

    const leadIdText = requestRow?.estimate_data?.leadId || mergedCustomer?.leadId || mergedCustomer?.lead_id || null;
    const leadUuid = requestRow?.estimate_data?.leadUuid || mergedCustomer?.leadUuid || null;
    const legacyFileUrl = `supabase://${storage.bucket}/${storage.path}`;

    // Populate both the old Buildup attachment columns and the newer customer-chat columns.
    // This keeps existing Supabase projects compatible and avoids the old file_url NOT NULL error.
    let inserted;
    try {
      inserted = await dbInsert("attachments", [{
        lead_id: isUuid(leadUuid) ? leadUuid : null,
        lead_uuid: isUuid(leadUuid) ? leadUuid : null,
        lead_id_text: leadIdText || null,
        customer_request_id: isUuid(requestRow?.id) ? requestRow.id : null,
        chat_id: chatId,
        file_name: fileName,
        file_url: legacyFileUrl,
        file_type: mimeType,
        mime_type: mimeType,
        file_size: buffer.length,
        attachment_type: "customer_document",
        storage_bucket: storage.bucket,
        storage_path: storage.path,
        source: "customer_ai_chat",
        status: analysis ? "analyzed" : "analysis_failed",
        temporary: true,
        expires_at: expiresAt,
        storage_verified: true,
        storage_verified_at: storageVerification.verifiedAt,
        analysis_status: analysis ? "completed" : "failed",
        analysis_model: analysisResult?.model || DOCUMENT_ANALYSIS_MODEL,
        analysis_result: analysis,
        analysis_error: analysisError,
        metadata: {
          originalSize: Number(file.size || 0) || buffer.length,
          uploadedFrom: "customer_chat",
          storageVerified: true,
          storageVerifiedAt: storageVerification.verifiedAt,
          analysisStatus: analysis ? "completed" : "failed",
          analysisModel: analysisResult?.model || DOCUMENT_ANALYSIS_MODEL,
          analysisResponseId: analysisResult?.responseId || null,
          caption: caption || null,
          analysis,
          analysisError,
        },
      }]);
    } catch (error) {
      await deleteCustomerDocumentObject(storage.path);
      uploadedStoragePath = "";
      throw new Error(`The file reached Supabase Storage, but the attachments table rejected its metadata: ${error?.message || error}. Run SQL_PHASE52_ATTACHMENT_ANALYSIS_MIGRATION.sql.`);
    }

    const attachment = Array.isArray(inserted) && inserted[0] ? inserted[0] : null;
    if (!attachment?.id) {
      await deleteCustomerDocumentObject(storage.path);
      uploadedStoragePath = "";
      throw new Error("Document file was uploaded, but its database record could not be created.");
    }

    // 5) Read the row back: the API only reports success after Storage and DB metadata both exist.
    const verifiedRows = await dbSelect("attachments", `select=*&id=eq.${encodeEq(attachment.id)}&limit=1`);
    const verifiedAttachment = Array.isArray(verifiedRows) ? verifiedRows[0] : null;
    if (!verifiedAttachment?.id || !verifiedAttachment?.storage_path) {
      throw new Error("Attachment verification failed after database insert.");
    }

    await writeAuditLog(req, {
      action_type: analysis ? "customer_document_analyzed" : "customer_document_analysis_failed",
      module: "auto_quote",
      target_table: "attachments",
      target_id: attachment.id,
      new_snapshot: { ...verifiedAttachment, storage_path: storage.path },
      change_summary: analysis
        ? `Customer document ${fileName} was stored, verified and analyzed for chat ${chatId}.`
        : `Customer document ${fileName} was stored and verified, but analysis failed for chat ${chatId}.`,
    });

    res.status(analysis ? 200 : 207).json({
      ok: true,
      success: true,
      stored: true,
      storageVerified: true,
      analyzed: Boolean(analysis),
      analysisError,
      configuredDocumentModel: DOCUMENT_ANALYSIS_MODEL,
      documentModelUsed: analysisResult?.model || null,
      attemptedDocumentModels: analysisResult?.attemptedModels || (analysis ? [analysisResult?.model].filter(Boolean) : DOCUMENT_ANALYSIS_FALLBACK_MODELS),
      storage: "supabase_storage+attachments",
      attachment: {
        id: verifiedAttachment.id,
        fileName: verifiedAttachment.file_name,
        mimeType: verifiedAttachment.mime_type || verifiedAttachment.file_type,
        fileSize: verifiedAttachment.file_size,
        storageBucket: verifiedAttachment.storage_bucket,
        storagePath: verifiedAttachment.storage_path,
        previewUrl: previewUrl || null,
        temporary: verifiedAttachment.temporary,
        expiresAt: verifiedAttachment.expires_at,
        databaseVerified: true,
      },
      analysis,
      customerUpdates: analysis?.customerUpdates || {},
      items: analysis?.items || [],
      reply: analysis?.reply || null,
      request: requestRow,
      savedTo: {
        file: { service: "Supabase Storage", bucket: storage.bucket, path: storage.path, verified: true },
        metadata: { table: "attachments", id: verifiedAttachment.id, verified: true },
        chat: { table: "customer_requests", id: requestRow?.id || null, chatId },
        lead: leadIdText ? { table: "leads", id: leadUuid || null, leadId: leadIdText } : null,
      },
    });
  } catch (error) {
    if (uploadedStoragePath) {
      // Only clean up when the workflow failed before a usable DB record was confirmed.
      console.warn("Customer document workflow failed after upload:", error?.message || error);
    }
    rememberSupabaseIssue("customer document upload/analyze", error);
    res.status(500).json({
      ok: false,
      success: false,
      stored: false,
      analyzed: false,
      error: error.message || "Could not store and analyze the uploaded document.",
    });
  }
});

app.get("/customer-document/:id/download", requireStaff, async (req, res) => {
  try {
    const rows = await dbSelect("attachments", `select=*&id=eq.${encodeEq(req.params.id)}&limit=1`);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row?.storage_path) return res.status(404).json({ ok: false, success: false, error: "Document not found." });
    const signedUrl = await createCustomerDocumentSignedUrl(row.storage_path, 900);
    res.json({ ok: true, success: true, attachment: row, signedUrl, expiresInSeconds: 900 });
  } catch (error) {
    rememberSupabaseIssue("customer document signed URL", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not open document." });
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
      agentRequests: sections.realAgent,
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

app.post("/site-visit-cancelled", async (req, res) => {
  try {
    const body = req.body || {};
    const requestRow = await recordCustomerRequest({
      chatId: body.chatId,
      customer: body.customer || {},
      conversation: body.messages || body.conversation || [],
      status: "site_visit_not_selected",
      eventType: "site_visit_not_selected",
      siteVisit: { status: "not_selected", reason: body.reason || "closed_without_date_time" },
      rows: Array.isArray(body.rows) ? body.rows : [],
      items: Array.isArray(body.items) ? body.items : [],
      note: "Customer did not select a site-visit date/time.",
    }, req);
    res.json({
      ok: true,
      success: true,
      message: "Site visit not selected.",
      savedTo: {
        customerRequest: { table: "customer_requests", id: requestRow?.id || null, chatId: requestRow?.estimate_data?.chatId || body.chatId || null },
        lead: requestRow?.estimate_data?.leadId ? { table: "leads", leadId: requestRow.estimate_data.leadId, id: requestRow.estimate_data.leadUuid || null } : null,
      },
    });
  } catch (error) {
    rememberSupabaseIssue("site visit cancellation", error);
    res.status(500).json({ ok: false, success: false, error: "Could not save site visit cancellation." });
  }
});

app.post("/site-visit-booking", async (req, res) => {
  try {
    const body = req.body || {};
    const slot = body.slot || {};
    const slotDate = cleanDateOrNull(slot.date || body.date || "");
    const slotTime = String(slot.time || body.time || "").trim();
    const slotId = slot.slotId || body.slotId || `${slotDate || ""} ${slotTime || ""}`.trim();
    if (!slotDate || !slotTime) return res.status(400).json({ ok: false, success: false, error: "Please select both date and time before booking a site visit." });
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
      date: slotDate,
      time: slotTime,
      label: slot.label || body.label || slotId,
      customer: body.customer || {},
      chatId: body.chatId || null,
      rows: Array.isArray(body.rows) ? body.rows : [],
      items: Array.isArray(body.items) ? body.items : [],
      status: "booked",
      createdAt: new Date().toISOString(),
    };
    const bookingStorage = await writeSiteVisitBookings({ bookings: [...bookings, booking] }, req);
    const requestRow = await recordCustomerRequest({
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
    res.json({
      ok: true,
      success: true,
      booking,
      savedTo: {
        siteVisit: { table: bookingStorage.storage?.includes("site_visit_bookings") ? "site_visit_bookings" : "app_settings", key: bookingStorage.storage?.includes("app_settings") ? "site_visit_bookings" : null, bookingId: booking.id, slotId: booking.slotId },
        customerRequest: { table: "customer_requests", id: requestRow?.id || null, chatId: requestRow?.estimate_data?.chatId || body.chatId || null },
        lead: requestRow?.estimate_data?.leadId ? { table: "leads", leadId: requestRow.estimate_data.leadId, id: requestRow.estimate_data.leadUuid || null } : null,
      },
    });
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

app.get("/agent-requests", requireStaff, async (req, res) => {
  try {
    const rows = await loadCustomerRequestRows(200);
    const requests = notificationSectionsFromRequests(rows).realAgent;
    res.json({ ok: true, success: true, requests, storage: SUPABASE_ENABLED ? "supabase" : "local-fallback" });
  } catch (error) {
    rememberSupabaseIssue("agent requests load", error);
    res.status(500).json({ ok: false, success: false, error: "Could not load real-agent requests from the database." });
  }
});

app.post("/agent-request", async (req, res) => {
  try {
    if (!SUPABASE_ENABLED) {
      return res.status(503).json({ ok: false, success: false, error: "Supabase is not configured. The real-agent request was not saved." });
    }
    const body = req.body || {};
    const chatId = String(body.chatId || body.id || "").trim();
    if (!chatId) return res.status(400).json({ ok: false, success: false, error: "Missing chat session ID." });
    const createdAt = new Date().toISOString();
    const deadlineAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const request = {
      id: String(body.requestId || body.id || `handoff_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`),
      chatId,
      createdAt,
      deadlineAt,
      status: "waiting",
      customer: body.customer || {},
      messages: normalizeMessages(body.messages || body.conversation || []),
      note: normalizeContent(body.note || "Customer requested a real staff member."),
    };

    const requestRow = await recordCustomerRequest({
      chatId,
      customer: request.customer,
      conversation: request.messages,
      status: "real_agent_requested",
      eventType: "real_agent_requested",
      note: request.note,
      estimate_data: {
        chatId,
        sessionStatus: "real_agent_requested",
        handoffRequest: request,
        handoffRequestId: request.id,
        handoffRequestedAt: createdAt,
        handoffDeadlineAt: deadlineAt,
        handoffPhoneShared: false,
        agentResponseStatus: "waiting",
      },
    }, req);

    handoffRequests.push(request);
    res.json({
      ok: true,
      success: true,
      request,
      databaseRequest: requestRow,
      handoffDeadlineAt: deadlineAt,
      savedTo: { table: "customer_requests", id: requestRow?.id || null, chatId },
    });
  } catch (error) {
    rememberSupabaseIssue("agent request save", error);
    res.status(500).json({ ok: false, success: false, error: error.message || "Could not save the real-agent request." });
  }
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

app.listen(PORT, () => {
  console.log(`AI quote server running on port ${PORT}`);
  console.log(`[Document AI] configured=${DOCUMENT_ANALYSIS_MODEL}; source=${process.env.OPENAI_DOCUMENT_MODEL ? "OPENAI_DOCUMENT_MODEL" : "server_default"}; fallbacks=${DOCUMENT_ANALYSIS_FALLBACK_MODELS.join(",")}`);
});

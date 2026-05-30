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

function normalizeStaffProfileName(value = "") {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\w/g, (char) => char.toUpperCase());
}

function staffProfileIdFromName(name = "") {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || `user-${Date.now().toString(36)}`;
}

function hashStaffProfilePassword(password = "") {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(String(password), salt, 100000, 64, "sha512").toString("hex");
  return { salt, hash };
}

function verifyStaffProfilePassword(password = "", profile = {}) {
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

function getStaffProfiles() {
  const stored = readStoredStaffProfiles();
  const byName = new Map();

  DEFAULT_STAFF_PROFILE_NAMES.forEach((name) => {
    const cleanName = normalizeStaffProfileName(name);
    byName.set(cleanName.toLowerCase(), {
      id: staffProfileIdFromName(cleanName),
      name: cleanName,
      defaultUser: true,
      hasPassword: false,
    });
  });

  stored.forEach((profile) => {
    const cleanName = normalizeStaffProfileName(profile?.name);
    if (!cleanName) return;
    byName.set(cleanName.toLowerCase(), {
      id: profile.id || staffProfileIdFromName(cleanName),
      name: cleanName,
      defaultUser: DEFAULT_STAFF_PROFILE_NAMES.some((item) => item.toLowerCase() === cleanName.toLowerCase()),
      hasPassword: Boolean(profile.passwordHash && profile.salt),
      createdAt: profile.createdAt || null,
      updatedAt: profile.updatedAt || null,
    });
  });

  return Array.from(byName.values()).sort((a, b) => {
    const ai = DEFAULT_STAFF_PROFILE_NAMES.findIndex((name) => name.toLowerCase() === a.name.toLowerCase());
    const bi = DEFAULT_STAFF_PROFILE_NAMES.findIndex((name) => name.toLowerCase() === b.name.toLowerCase());
    if (ai >= 0 || bi >= 0) return (ai >= 0 ? ai : 999) - (bi >= 0 ? bi : 999);
    return a.name.localeCompare(b.name);
  });
}

function findStoredStaffProfile(name = "") {
  const cleanName = normalizeStaffProfileName(name);
  if (!cleanName) return null;
  return readStoredStaffProfiles().find((profile) => String(profile?.name || "").trim().toLowerCase() === cleanName.toLowerCase()) || null;
}

function createOrUpdateStaffProfile({ name, password }) {
  const cleanName = normalizeStaffProfileName(name);
  const cleanPassword = String(password || "");
  if (!cleanName) throw new Error("Staff user name is required.");
  if (cleanPassword.length < 4) throw new Error("Staff user password must be at least 4 characters.");

  const profiles = readStoredStaffProfiles();
  const now = new Date().toISOString();
  const existingIndex = profiles.findIndex((profile) => String(profile?.name || "").trim().toLowerCase() === cleanName.toLowerCase());
  const { salt, hash } = hashStaffProfilePassword(cleanPassword);
  const nextProfile = {
    id: existingIndex >= 0 ? (profiles[existingIndex].id || staffProfileIdFromName(cleanName)) : `${staffProfileIdFromName(cleanName)}-${Date.now().toString(36)}`,
    name: cleanName,
    passwordHash: hash,
    salt,
    createdAt: existingIndex >= 0 ? profiles[existingIndex].createdAt || now : now,
    updatedAt: now,
  };

  if (existingIndex >= 0) profiles[existingIndex] = nextProfile;
  else profiles.push(nextProfile);
  saveStoredStaffProfiles(profiles);
  return { id: nextProfile.id, name: nextProfile.name };
}

function setActiveProfileForRequest(req, user) {
  const token = getStaffToken(req);
  const session = token ? staffSessions.get(token) : null;
  if (session && user?.name) {
    session.activeUser = { id: user.id || staffProfileIdFromName(user.name), name: user.name };
    staffSessions.set(token, session);
  }
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
              role: String(user?.role || "staff").trim() || "staff",
            });
          }
        });
      }
    } catch (error) {
      console.error("Invalid STAFF_USERS_JSON:", error.message);
    }
  }

  if (STAFF_EMAIL && STAFF_PASSWORD) {
    users.push({ email: STAFF_EMAIL, password: STAFF_PASSWORD, name: STAFF_EMAIL, role: "staff" });
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

app.get("/staff-users", requireStaff, (req, res) => {
  res.json({ success: true, ok: true, users: getStaffProfiles() });
});

app.post("/staff-users/login", requireStaff, (req, res) => {
  const name = normalizeStaffProfileName(req.body?.name);
  const password = String(req.body?.password || "");
  const profile = findStoredStaffProfile(name);

  if (!profile || !profile.passwordHash) {
    return res.status(404).json({ success: false, ok: false, error: "This staff user does not have a password yet. Create the password first." });
  }

  if (!verifyStaffProfilePassword(password, profile)) {
    return res.status(401).json({ success: false, ok: false, error: "Incorrect user password." });
  }

  const user = { id: profile.id || staffProfileIdFromName(profile.name), name: profile.name };
  setActiveProfileForRequest(req, user);
  res.json({ success: true, ok: true, user });
});

app.post("/staff-users", requireStaff, (req, res) => {
  try {
    const user = createOrUpdateStaffProfile({ name: req.body?.name, password: req.body?.password });
    setActiveProfileForRequest(req, user);
    res.json({ success: true, ok: true, user, users: getStaffProfiles() });
  } catch (error) {
    res.status(400).json({ success: false, ok: false, error: error.message || "Could not create staff user." });
  }
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    message: "AI quote server is running",
    model: MODEL,
    webSearchEnabled: ENABLE_WEB_SEARCH,
    webSearchModel: WEB_SEARCH_MODEL,
  });
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

app.post("/local-backup", requireStaff, (req, res) => {
  const payload = req.body || {};
  const headerUserName = String(req.headers["x-staff-user"] || "").trim();
  const headerUserId = String(req.headers["x-staff-user-id"] || "").trim();
  const snapshot = {
    ...payload,
    actor: req.staff?.activeUser || (headerUserName ? { id: headerUserId || staffProfileIdFromName(headerUserName), name: headerUserName } : null),
    backendSavedAt: new Date().toISOString(),
  };
  writeJsonFile(LOCAL_BACKUP_FILE, snapshot);
  res.json({ ok: true, success: true, file: LOCAL_BACKUP_FILE, savedAt: snapshot.backendSavedAt });
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

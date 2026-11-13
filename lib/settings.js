// Portal settings (non-secret config in app_settings) and admin recipients.
// Moved verbatim from index.js.
const { log } = require("./log");
const { queryAsync } = require("./db");

// ── Settings (non-secret config, editable in the portal) ──────────────────────
// Secrets and infrastructure (DB, mail credentials, JWT/admin secrets, Shopify
// and Semaphore keys, CORS origins, URLs) live ONLY in .env and are never
// stored in the DB or sent to the portal. Everyday operating config lives here:
// a value saved from the portal's Settings tab wins, else the env var of the
// same meaning (so existing .env values keep working until someone saves),
// else the default.
const EMAIL_LIST_RE = /^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/;

const SETTINGS = {
  admin_email: {
    group: "Notifications", label: "Admin notification email", type: "email",
    env: "ADMIN_EMAIL", default: "",
    help: "Gets a copy of every application, contact message and return request.",
  },
  admin_cc: {
    group: "Notifications", label: "CC", type: "email_list",
    env: "ADMIN_CC", default: "",
    help: "Optional. Separate several addresses with commas.",
  },
  email_blast_delay_ms: {
    group: "Email blasts", label: "Pause between emails (ms)", type: "number", min: 0, max: 10000,
    env: "BLAST_SEND_DELAY_MS", default: 300,
    help: "Keep within your Brevo plan's sending rate.",
  },
  sms_shipping_enabled: {
    group: "SMS", label: "Text customers when their order ships", type: "boolean",
    env: "SMS_SHIPPING_ENABLED", default: true,
    help: "Needs SEMAPHORE_API_KEY in the server .env.",
  },
  sms_sender_name: {
    group: "SMS", label: "Sender name", type: "sender_name",
    env: "SEMAPHORE_SENDER_NAME", default: "",
    help: "Must be approved in Semaphore first. Blank uses Semaphore's default sender.",
  },
  chat_alert_recipients: {
    group: "Chat", label: "Chat alert recipients", type: "email_list",
    env: "CHAT_ALERT_RECIPIENTS", default: "",
    help: "Get an email when a chat starts or goes unanswered.",
  },
  sms_blast_delay_ms: {
    group: "SMS", label: "Pause between blast texts (ms)", type: "number", min: 0, max: 10000,
    env: "SMS_BLAST_DELAY_MS", default: 600,
    help: "Spacing between texts in an SMS blast.",
  },
};

// Env-only values the portal may report as set / missing, never their contents.
const SECRET_ENV_STATUS = [
  ["SEMAPHORE_API_KEY", "Semaphore API key (SMS)"],
  ["SHOPIFY_CLIENT_SECRET", "Shopify client secret (API + webhook signatures)"],
  ["SHOPIFY_WEBHOOK_SECRET", "Shopify webhook secret (only for webhooks made in Shopify admin)"],
  ["BREVO_PASS", "Brevo SMTP key (email)"],
  ["DASHBOARD_JWT_SECRET", "Dashboard JWT secret"],
  ["CHAT_AGENT_SECRET", "Chat service shared secret"],
  ["CHAT_API_URL", "Chat service URL"],
];

let settingsCache = {}; // key → raw string from app_settings

function parseSetting(def, raw) {
  if (raw === undefined || raw === null) return def.default;
  const str = String(raw).trim();
  switch (def.type) {
    case "boolean":
      return str === "" ? def.default : str.toLowerCase() !== "false";
    case "number": {
      const n = parseFloat(str);
      return Number.isFinite(n) ? Math.min(def.max, Math.max(def.min, n)) : def.default;
    }
    default:
      return str;
  }
}

function settingSource(key) {
  if (Object.prototype.hasOwnProperty.call(settingsCache, key)) return "saved";
  return process.env[SETTINGS[key].env] !== undefined ? "env" : "default";
}

function getSetting(key) {
  const def = SETTINGS[key];
  if (!def) throw new Error(`Unknown setting ${key}`);
  const source = settingSource(key);
  if (source === "saved") return parseSetting(def, settingsCache[key]);
  if (source === "env") return parseSetting(def, process.env[def.env]);
  return def.default;
}

// Returns { value } as the string to store, or { error }.
function validateSetting(def, input) {
  const str = typeof input === "string" ? input.trim() : input;
  switch (def.type) {
    case "boolean":
      if (typeof input !== "boolean") return { error: "must be on or off" };
      return { value: input ? "true" : "false" };
    case "number": {
      const n = typeof str === "number" ? str : parseFloat(str);
      if (!Number.isFinite(n) || n < def.min || n > def.max) return { error: `must be ${def.min}–${def.max}` };
      return { value: String(n) };
    }
    case "email":
      if (str && !EMAIL_LIST_RE.test(str)) return { error: "must be an email address" };
      return { value: str || "" };
    case "email_list": {
      const list = String(str || "").split(",").map((e) => e.trim()).filter(Boolean);
      const bad = list.filter((e) => !EMAIL_LIST_RE.test(e));
      if (bad.length) return { error: `invalid address: ${bad.join(", ")}` };
      return { value: list.join(",") };
    }
    case "sender_name":
      if (str && !/^[A-Za-z0-9 ]{1,11}$/.test(str)) return { error: "must be 1–11 letters, numbers or spaces" };
      return { value: str || "" };
    default:
      return { error: "unsupported" };
  }
}

async function ensureSettingsTable() {
  try {
    await queryAsync(
      `CREATE TABLE IF NOT EXISTS app_settings (
         setting_key VARCHAR(64) PRIMARY KEY,
         setting_value TEXT NULL,
         updated_by VARCHAR(120) NULL,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
       )`,
    );
    await loadSettings();
    log("info", "migration_settings_table_ready", { saved: Object.keys(settingsCache).length });
  } catch (err) {
    log("error", "migration_settings_table_failed", { message: err.message });
  }
}

async function loadSettings() {
  const rows = await queryAsync("SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?)", [
    Object.keys(SETTINGS),
  ]);
  const next = {};
  for (const r of rows) if (r.setting_value !== null) next[r.setting_key] = r.setting_value;
  settingsCache = next;
}

function adminRecipients() {
  const cc = getSetting("admin_cc");
  return { to: getSetting("admin_email"), cc: cc ? cc.split(",") : [] };
}

function adminName(req) {
  return req.admin && req.admin.sub ? `staff #${req.admin.sub}` : "admin";
}

module.exports = { EMAIL_LIST_RE, SETTINGS, SECRET_ENV_STATUS, settingsCache, parseSetting, settingSource, getSetting, validateSetting, ensureSettingsTable, loadSettings, adminRecipients, adminName };

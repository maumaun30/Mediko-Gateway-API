require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const multer = require("multer");
const nodemailer = require("nodemailer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const {
  verifyChatEventSignature, chatDeepLink, buildStaffAlertMail, validateChatEvent, maskId, redactPath, legacyChatRedirect,
  productHandleFromUrl, productToPreview,
} = require("./lib/chat");

const app = express();
app.set("trust proxy", 1);

// TESTING_MODE bypasses rate limiter, time trap, and cooldown checks on form
// endpoints so you can submit repeatedly during local/staging testing.
// NEVER enable this in production.
const TESTING_MODE = String(process.env.TESTING_MODE || "").toLowerCase() === "true";
if (TESTING_MODE) {
  console.warn(
    "⚠️  TESTING_MODE is ON — rate limit, time trap, and cooldown are disabled.",
  );
}

// ── Structured logger ─────────────────────────────────────────────────────────
function log(level, event, data = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...data,
    }),
  );
}

// ── CORS ──────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

const corsMiddleware = cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      log("warn", "cors_blocked", { origin });
      callback(new Error("Not allowed by CORS Policy"));
    }
  },
  methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-key", "Authorization"],
  optionsSuccessStatus: 200,
});

// The unsubscribe page posts its form back to this host, which isn't in
// ALLOWED_ORIGINS. That route is token-guarded and credential-free, so skip CORS.
// /internal/chat-events is server-to-server (HMAC-signed), so it skips CORS too.
app.use((req, res, next) =>
  req.path === "/api/unsubscribe" || req.path === "/internal/chat-events"
    ? next()
    : corsMiddleware(req, res, next),
);

// Shopify webhooks need the raw body for HMAC verification, so this route is
// mounted before the global JSON parser. Handler lives in the SMS section below.
app.post(
  "/webhooks/shopify/fulfillments-create",
  express.raw({ type: "application/json", limit: "1mb" }),
  handleFulfillmentCreateWebhook,
);

// Chat service events are HMAC-signed over the raw body, so mount before the
// global JSON parser. Handler lives in the Chat section below.
app.post(
  "/internal/chat-events",
  express.raw({ type: "application/json", limit: "256kb" }),
  handleChatEvent,
);

app.use(express.json({ limit: "1mb" }));

// ── Health check (for uptime monitors) ────────────────────────────────────────
// Mounted before the request logger so monitor pings don't flood the logs.
// 200 when the process and DB answer; 503 when the DB is down or slow, so the
// monitor alerts on both a dead server and a dead database. Express serves
// HEAD from this GET handler too. Only failures are logged.
const HEALTH_DB_TIMEOUT_MS = 3000;

app.get("/health", async (_req, res) => {
  res.set("Cache-Control", "no-store");
  const started = Date.now();
  let timer;
  try {
    await Promise.race([
      queryAsync("SELECT 1"),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("DB ping timed out")), HEALTH_DB_TIMEOUT_MS);
      }),
    ]);
    res.json({ status: "ok", db: "ok", dbMs: Date.now() - started, uptimeSec: Math.round(process.uptime()) });
  } catch (err) {
    log("error", "health_check_failed", { message: err.message });
    res.status(503).json({ status: "error", db: "down" });
  } finally {
    clearTimeout(timer);
  }
});

// ── Request logger middleware ─────────────────────────────────────────────────
app.use((req, _res, next) => {
  log("info", "request_received", {
    method: req.method,
    path: redactPath(req.path), // chat session ids (/chats/<id>) are credentials
    ip: req.ip,
  });
  next();
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
const { ipKeyGenerator } = rateLimit;

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { error: "Too many attempts. Please try again after 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req),
  skip: () => TESTING_MODE,
  handler(req, res, _next, options) {
    log("warn", "rate_limit_hit", { ip: req.ip });
    res.status(options.statusCode).json(options.message);
  },
});

// ── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: "./uploads/",
  filename: (_req, file, cb) =>
    cb(null, `ID-${Date.now()}${path.extname(file.originalname)}`),
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed!"), false);
    }
  },
});

const returnsStorage = multer.diskStorage({
  destination: "./uploads/",
  filename: (_req, file, cb) =>
    cb(null, `RET-${Date.now()}-${crypto.randomBytes(3).toString("hex")}${path.extname(file.originalname)}`),
});

const returnsUpload = multer({
  storage: returnsStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed!"), false);
    }
  },
});

// ── Image optimizer client ────────────────────────────────────────────────────
// Posts the file to the optimizer service, polls until ready, downloads the
// converted bytes, writes them next to the original (with a .webp extension by
// default), then deletes the original. Returns the new on-disk path. Callers
// should fall back to the original path on throw.
async function optimizeImage(filePath, { format = "webp", width = 1200 } = {}) {
  const baseUrl = process.env.IMAGE_OPTIMIZER_URL;
  if (!baseUrl) throw new Error("IMAGE_OPTIMIZER_URL not set");

  const fileBuffer = await fs.promises.readFile(filePath);
  const filename = path.basename(filePath);

  const form = new FormData();
  form.append("files", new Blob([fileBuffer]), filename);
  const uploadRes = await fetch(
    `${baseUrl}/images/upload?format=${format}&width=${width}`,
    { method: "POST", body: form },
  );
  if (!uploadRes.ok) throw new Error(`upload ${uploadRes.status}`);
  const { jobs } = await uploadRes.json();
  const jobId = jobs[0].id;

  const pollStart = Date.now();
  while (true) {
    if (Date.now() - pollStart > 60_000) throw new Error("poll timeout");
    await new Promise((r) => setTimeout(r, 1500));
    const s = await fetch(`${baseUrl}/images/status/${jobId}`);
    if (!s.ok) throw new Error(`status ${s.status}`);
    const job = await s.json();
    if (job.status === "ready") break;
    if (job.status === "failed" || job.status === "expired") {
      throw new Error(`job ${job.status}: ${job.error_message || ""}`);
    }
  }

  const dl = await fetch(`${baseUrl}/images/download/${jobId}`);
  if (!dl.ok) throw new Error(`download ${dl.status}`);
  const buf = Buffer.from(await dl.arrayBuffer());

  const dir = path.dirname(filePath);
  const stem = path.basename(filePath, path.extname(filePath));
  const newPath = path.join(dir, `${stem}.${format}`);
  await fs.promises.writeFile(newPath, buf);
  if (newPath !== filePath) {
    await fs.promises.unlink(filePath).catch(() => {});
  }
  return newPath;
}

// ── Database ──────────────────────────────────────────────────────────────────
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

db.getConnection((err, conn) => {
  if (err) {
    log("error", "db_connection_failed", { message: err.message });
  } else {
    log("info", "db_connected");
    conn.release();
    // ensureStatusColumn();
    ensureSettingsTable();
    ensureTemplatesTable();
    ensureContactTable();
    ensureReturnsTable();
    ensureBlastTables();
    ensureSmsTable();
    ensureSmsBlastTables();
  }
});

function ensureColumnFor(table, name, definition) {
  db.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [process.env.DB_NAME, table, name],
    (err, rows) => {
      if (err) {
        log("error", "migration_check_failed", { table, column: name, message: err.message });
        return;
      }
      if (rows[0].c > 0) return;
      db.query(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`, (alterErr) => {
        if (alterErr) {
          log("error", "migration_failed", { table, column: name, message: alterErr.message });
        } else {
          log("info", "migration_applied", { table, column: name });
        }
      });
    },
  );
}

function ensureColumn(name, definition) {
  ensureColumnFor("applications", name, definition);
}

function ensureStatusColumn() {
  ensureColumn("status", "ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending'");
  ensureColumn("discount_code", "VARCHAR(64) NULL");
  ensureColumn("discount_price_rule_id", "BIGINT NULL");
  ensureColumn("rejection_reason", "TEXT NULL");
  ensureColumn("discount_code_id", "BIGINT NULL");
  ensureColumn("discount_node_gid", "VARCHAR(255) NULL");
  ensureColumn("assigned_order_gid", "VARCHAR(255) NULL");
  ensureColumn("assigned_order_name", "VARCHAR(64) NULL");
  ensureColumn("assigned_tag", "VARCHAR(8) NULL");
  ensureColumn("assigned_customer_gid", "VARCHAR(255) NULL");
  ensureColumn("refunded_at", "DATETIME NULL");
  ensureColumn("refunded_by", "VARCHAR(120) NULL");
  // ensureColumnFor("return_requests", "rejection_reason", "TEXT NULL");
}

function ensureContactTable() {
  db.query(
    `CREATE TABLE IF NOT EXISTS contact_submissions (
       id INT AUTO_INCREMENT PRIMARY KEY,
       full_name VARCHAR(255) NOT NULL,
       email_address VARCHAR(255) NOT NULL,
       contact_number VARCHAR(32) NOT NULL,
       message TEXT NOT NULL,
       status ENUM('pending','resolved') NOT NULL DEFAULT 'pending',
       metadata TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_contact_email (email_address),
       INDEX idx_contact_created (created_at)
     )`,
    (err) => {
      if (err) log("error", "migration_contact_table_failed", { message: err.message });
      else log("info", "migration_contact_table_ready");
    },
  );
}

function ensureReturnsTable() {
  db.query(
    `CREATE TABLE IF NOT EXISTS return_requests (
       id INT AUTO_INCREMENT PRIMARY KEY,
       full_name VARCHAR(255) NOT NULL,
       email_address VARCHAR(255) NOT NULL,
       contact_number VARCHAR(32) NOT NULL,
       order_number VARCHAR(64) NOT NULL,
       items_to_return TEXT NOT NULL,
       reason TEXT NOT NULL,
       image_paths TEXT,
       status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
       rejection_reason TEXT NULL,
       metadata TEXT,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_returns_email (email_address),
       INDEX idx_returns_order (order_number),
       INDEX idx_returns_created (created_at)
     )`,
    (err) => {
      if (err) log("error", "migration_returns_table_failed", { message: err.message });
      else {
        log("info", "migration_returns_table_ready");
        ensureStatusColumn();
      }
    },
  );
}

// ── Helpers: queryAsync + requireAdmin ────────────────────────────────────────
const queryAsync = (sql, params) =>
  new Promise((resolve, reject) =>
    db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))),
  );

// ── Admin auth (Shopify session token → dashboard JWT) ────────────────────────
// The portal only runs embedded in the Shopify admin. App Bridge gives it a
// Shopify session token: a JWT signed HS256 with this app's client secret,
// valid ~60s. POST /api/auth/shopify verifies that token and exchanges it for
// a short-lived dashboard JWT, which every admin route checks via requireAdmin.
const DASHBOARD_JWT = { issuer: "mediko-gateway", audience: "mediko-admin", ttlSec: 15 * 60 };

// Client ID is public (it's in shopify.app.toml); env wins if set.
function shopifyClientId() {
  if (process.env.SHOPIFY_CLIENT_ID) return process.env.SHOPIFY_CLIENT_ID;
  try {
    const toml = fs.readFileSync(path.join(__dirname, "shopify.app.toml"), "utf8");
    const m = toml.match(/^client_id\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// No fallback: without a real secret, admin auth is off rather than forgeable.
function dashboardSecret() {
  const s = process.env.DASHBOARD_JWT_SECRET;
  return s && s.length >= 32 ? s : null;
}

if (!dashboardSecret()) {
  log("error", "dashboard_jwt_secret_missing", {
    hint: "Set DASHBOARD_JWT_SECRET (32+ random characters). Admin routes return 503 until then.",
  });
}

// Returns the verified payload or throws. Follows Shopify's checks: HS256
// signature with the client secret, exp/nbf, aud = client ID, iss and dest on
// the same host. Also pins dest to this store so no other shop's token works.
function verifyShopifySessionToken(token) {
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  const clientId = shopifyClientId();
  if (!secret || !clientId) throw new Error("Shopify app credentials not configured");

  const payload = jwt.verify(token, secret, {
    algorithms: ["HS256"],
    audience: clientId,
    clockTolerance: 5, // seconds of clock skew
  });
  const destHost = new URL(payload.dest).hostname;
  const issHost = new URL(payload.iss).hostname;
  if (destHost !== issHost) throw new Error("iss/dest mismatch");
  const shop = String(process.env.SHOPIFY_SHOP_DOMAIN || "").toLowerCase();
  if (!shop || destHost.toLowerCase() !== shop) throw new Error("token is for another shop");
  if (!payload.sub) throw new Error("token has no user");
  return payload;
}

// Accepts either credential:
// - a Shopify session token, which App Bridge v4 attaches to every fetch() to
//   this domain automatically (the redesigned portal relies on this), or
// - a dashboard JWT from POST /api/auth/shopify (older portal builds).
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }
  const token = authHeader.slice(7);

  const secret = dashboardSecret();
  if (secret) {
    try {
      req.admin = jwt.verify(token, secret, {
        algorithms: ["HS256"],
        issuer: DASHBOARD_JWT.issuer,
        audience: DASHBOARD_JWT.audience,
      });
      return next();
    } catch {
      /* not a dashboard JWT — try a Shopify session token */
    }
  }
  try {
    const shopify = verifyShopifySessionToken(token);
    req.admin = { sub: String(shopify.sub), shop: new URL(shopify.dest).hostname, sid: shopify.sid };
    return next();
  } catch (err) {
    log("warn", "admin_token_rejected", { reason: err.message, path: redactPath(req.path), ip: req.ip });
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

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

// ── /api/settings (admin) ─────────────────────────────────────────────────────
app.get("/api/settings", requireAdmin, (_req, res) => {
  res.json({
    settings: Object.entries(SETTINGS).map(([key, def]) => ({
      key,
      group: def.group,
      label: def.label,
      help: def.help,
      type: def.type,
      min: def.min,
      max: def.max,
      env: def.env,
      value: getSetting(key),
      source: settingSource(key),
    })),
    secrets: SECRET_ENV_STATUS.map(([name, label]) => ({ name, label, set: Boolean(process.env[name]) })),
  });
});

app.put("/api/settings", requireAdmin, async (req, res) => {
  const values = req.body && typeof req.body.values === "object" ? req.body.values : null;
  if (!values || !Object.keys(values).length) return res.status(400).json({ error: "Nothing to save." });

  const updates = [];
  const errors = [];
  for (const [key, input] of Object.entries(values)) {
    const def = SETTINGS[key];
    if (!def) {
      errors.push(`${key}: unknown setting`);
      continue;
    }
    const result = validateSetting(def, input);
    if (result.error) errors.push(`${def.label} ${result.error}`);
    else updates.push([key, result.value]);
  }
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });

  try {
    for (const [key, value] of updates) {
      await queryAsync(
        `INSERT INTO app_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
        [key, value, adminName(req)],
      );
    }
    await loadSettings();
    log("info", "settings_saved", { keys: updates.map(([k]) => k), ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    log("error", "settings_save_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});


// ── Mailer ────────────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  auth: {
    user: process.env.BREVO_USER,
    pass: process.env.BREVO_PASS,
  },
});

transporter.verify((err) => {
  if (err) {
    log("error", "mailer_verify_failed", { message: err.message });
  } else {
    log("info", "mailer_ready");
  }
});

// Helper: send email and log result
async function sendApplicationEmails(application, reqFiles, metadataStr) {
  const {
    full_name,
    email_address,
    id_number,
    birthday,
    contact_number,
    insertId,
  } = application;

  let meta = {};
  try {
    // metadataStr must match what is passed in the call
    meta =
      typeof metadataStr === "string" ? JSON.parse(metadataStr) : metadataStr;
  } catch (e) {
    meta = { error: "Could not parse metadata" };
  }

  const attachments = reqFiles
    ? reqFiles.map((f) => ({
        filename: f.originalname,
        path: f.path,
      }))
    : [];

  const received = renderEmail("application_received", recordVars("application", { ...application, id: insertId }));
  const applicantMail = {
    from: `"Mediko.ph" <${process.env.MAIL_FROM}>`,
    to: email_address,
    subject: received.subject,
    text: received.text,
    html: received.html,
  };

  const adminMail = {
    from: `"Mediko Gateway" <${process.env.MAIL_FROM}>`,
    ...adminRecipients(),
    subject: `[Mediko] New application #${insertId} — ${full_name}`,
    attachments: attachments,
    html: `
      <h3 style="color: #2c3e50;">New discount application received</h3>
      <table border="1" style="border-collapse: collapse; width: 100%; max-width: 600px; font-family: sans-serif;">
        <tr style="background-color: #f8f9fa;"><td style="padding: 8px; width: 150px;"><strong>App ID</strong></td><td style="padding: 8px;">#${insertId}</td></tr>
        <tr><td style="padding: 8px;"><strong>Name</strong></td><td style="padding: 8px;">${full_name}</td></tr>
        <tr><td style="padding: 8px;"><strong>Birthday</strong></td><td style="padding: 8px;">${birthday}</td></tr>
        <tr><td style="padding: 8px;"><strong>Contact No.</strong></td><td style="padding: 8px;">${contact_number}</td></tr>
        <tr><td style="padding: 8px;"><strong>Email</strong></td><td style="padding: 8px;">${email_address}</td></tr>
        <tr><td style="padding: 8px;"><strong>ID Number</strong></td><td style="padding: 8px;">${id_number}</td></tr>
      </table>

      <h4 style="margin-bottom: 5px; margin-top: 20px;">Technical Metadata:</h4>
      <table border="1" style="border-collapse: collapse; width: 100%; max-width: 600px; font-family: sans-serif; font-size: 12px; color: #555;">
        <tr><td style="padding: 6px; width: 150px;"><strong>IP Address</strong></td><td style="padding: 6px;">${meta.ip || "N/A"}</td></tr>
        <tr><td style="padding: 6px;"><strong>Origin</strong></td><td style="padding: 6px;">${meta.origin || "N/A"}</td></tr>
        <tr><td style="padding: 6px;"><strong>Browser Agent</strong></td><td style="padding: 6px;">${meta.user_agent || "N/A"}</td></tr>
        <tr><td style="padding: 6px;"><strong>Referer</strong></td><td style="padding: 6px;">${meta.referer || "N/A"}</td></tr>
      </table>
    `,
  };

  try {
    await Promise.all([
      transporter.sendMail(applicantMail),
      transporter.sendMail(adminMail),
    ]);
    log("info", "emails_sent", { appId: insertId });
  } catch (err) {
    log("error", "email_send_failed", {
      appId: insertId,
      message: err.message,
    });
  }
}

// ── Shopify Admin API ─────────────────────────────────────────────────────────
// Upstream failures here answer 500, not 502: Cloudflare fronts this app and
// replaces a 502 body with its own HTML error page, so the JSON never lands.
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";

// Refresh this long before a minted token actually expires, so a request never
// races the expiry.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function clientCredentialsConfigured() {
  return Boolean(
    process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET,
  );
}

function shopifyConfigured() {
  return Boolean(
    process.env.SHOPIFY_SHOP_DOMAIN &&
      (process.env.SHOPIFY_ADMIN_TOKEN || clientCredentialsConfigured()),
  );
}

// Tokens from the client credentials grant last 24 hours, so they cannot be
// pasted into .env and left alone. Mint on demand and cache until just before
// expiry. A static SHOPIFY_ADMIN_TOKEN still wins when one is set.
let _tokenCache = { token: null, expiresAt: 0 };
let _tokenInFlight = null;

async function mintAdminToken() {
  const res = await fetch(
    `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      }),
    },
  );

  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) {
    const err = new Error(
      `Shopify token request failed (${res.status})${json?.error ? `: ${json.error}` : ""}`,
    );
    err.status = res.status;
    throw err;
  }

  // expires_in is seconds; fall back to an hour if Shopify ever omits it.
  const ttlMs = (Number(json.expires_in) || 3600) * 1000;
  _tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + ttlMs,
  };

  log("info", "shopify_token_minted", {
    expires_in: json.expires_in ?? null,
    scope: json.scope ?? null,
  });

  return _tokenCache.token;
}

async function getAdminToken() {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  if (!clientCredentialsConfigured()) {
    throw new Error(
      "No Shopify credentials. Set SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.",
    );
  }

  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return _tokenCache.token;
  }

  // Concurrent callers share one mint rather than stampeding the token endpoint.
  if (!_tokenInFlight) {
    _tokenInFlight = mintAdminToken().finally(() => {
      _tokenInFlight = null;
    });
  }
  return _tokenInFlight;
}

function invalidateAdminToken() {
  _tokenCache = { token: null, expiresAt: 0 };
}

async function shopifyGraphQL(query, variables = {}, { retryOn401 = true } = {}) {
  const url = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": await getAdminToken(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json().catch(() => null);

  // A minted token can be revoked before its stated expiry. Drop it and mint a
  // fresh one once, rather than failing every call until the cache ages out.
  if (res.status === 401 && retryOn401 && !process.env.SHOPIFY_ADMIN_TOKEN) {
    log("warn", "shopify_token_rejected", { retrying: true });
    invalidateAdminToken();
    return shopifyGraphQL(query, variables, { retryOn401: false });
  }

  if (!res.ok || !json) {
    const err = new Error(`Shopify ${res.status}`);
    err.status = res.status;
    throw err;
  }
  if (Array.isArray(json.errors) && json.errors.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data;
}

function throwIfUserErrors(userErrors, op) {
  if (Array.isArray(userErrors) && userErrors.length) {
    const msg = userErrors
      .map((e) => `${(e.field || []).join(".")}: ${e.message}`)
      .join("; ");
    throw new Error(`${op}: ${msg}`);
  }
}

// ── Shopify order tagging (Senior/PWD) ────────────────────────────────────────
const ORDER_TAGS = ["PWD", "SC"];
// Refunds are a second, independent axis: an order stays PWD or SC and gains
// this tag once management has processed the refund by hand in Shopify.
const REFUND_TAG = "REFUNDED";

// Search terms are interpolated into a Shopify query string, where a quote or
// backslash would break out of it. Neither carries meaning in a search, so drop
// them rather than escaping.
function sanitizeSearchTerm(term) {
  return String(term).replace(/["\\]/g, " ").trim();
}

// Without a search term, lists the applicant's own orders by email. With one,
// hands it to Shopify's default order search, which spans order name, email
// and customer name — an applicant's discount may sit on an order placed under
// someone else's address.
async function listOrders({ email, search }) {
  const term =
    typeof search === "string" ? sanitizeSearchTerm(search).slice(0, 100) : "";
  const q = term ? term : `email:"${sanitizeSearchTerm(email)}"`;

  const data = await shopifyGraphQL(
    `query customerOrders($q: String!) {
       orders(first: 20, query: $q, sortKey: CREATED_AT, reverse: true) {
         edges {
           node {
             id
             name
             email
             createdAt
             tags
             displayFinancialStatus
             customer { id displayName }
             currentTotalPriceSet { shopMoney { amount currencyCode } }
           }
         }
       }
     }`,
    { q },
  );

  return (data?.orders?.edges || []).map(({ node }) => ({
    gid: node.id,
    name: node.name,
    email: node.email || null,
    customer_gid: node.customer?.id || null,
    customer_name: node.customer?.displayName || null,
    created_at: node.createdAt,
    tags: node.tags || [],
    financial_status: node.displayFinancialStatus,
    total: node.currentTotalPriceSet?.shopMoney?.amount || null,
    currency: node.currentTotalPriceSet?.shopMoney?.currencyCode || null,
  }));
}

async function addShopifyTag(gid, tag) {
  const data = await shopifyGraphQL(
    `mutation addTags($id: ID!, $tags: [String!]!) {
       tagsAdd(id: $id, tags: $tags) {
         node { id }
         userErrors { field message }
       }
     }`,
    { id: gid, tags: [tag] },
  );
  throwIfUserErrors(data?.tagsAdd?.userErrors, "tagsAdd");
}

async function removeShopifyTag(gid, tag) {
  const data = await shopifyGraphQL(
    `mutation removeTags($id: ID!, $tags: [String!]!) {
       tagsRemove(id: $id, tags: $tags) {
         node { id }
         userErrors { field message }
       }
     }`,
    { id: gid, tags: [tag] },
  );
  throwIfUserErrors(data?.tagsRemove?.userErrors, "tagsRemove");
}

// One Shopify customer can back several applications (a household sharing an
// email, a re-application). Only strip their tag once no other row still needs
// it, otherwise unassigning one application silently downgrades the others.
async function untagCustomerIfUnused(id, customerGid, tag) {
  if (!customerGid || !tag) return;
  try {
    const rows = await queryAsync(
      `SELECT COUNT(*) AS c FROM applications
        WHERE assigned_customer_gid = ? AND assigned_tag = ? AND id <> ?`,
      [customerGid, tag, id],
    );
    if (rows[0].c > 0) {
      log("info", "customer_untag_skipped", { id, customerGid, tag, others: rows[0].c });
      return;
    }
    await removeShopifyTag(customerGid, tag);
  } catch (e) {
    log("warn", "customer_untag_failed", { id, customerGid, tag, message: e.message });
  }
}

// ── Approval email ────────────────────────────────────────────────────────────
// ── Contact / Returns email helpers ───────────────────────────────────────────
function metaTable(meta) {
  return `
    <h4 style="margin-bottom: 5px; margin-top: 20px;">Technical Metadata:</h4>
    <table border="1" style="border-collapse: collapse; width: 100%; max-width: 600px; font-family: sans-serif; font-size: 12px; color: #555;">
      <tr><td style="padding: 6px; width: 150px;"><strong>IP Address</strong></td><td style="padding: 6px;">${meta.ip || "N/A"}</td></tr>
      <tr><td style="padding: 6px;"><strong>Origin</strong></td><td style="padding: 6px;">${meta.origin || "N/A"}</td></tr>
      <tr><td style="padding: 6px;"><strong>Browser Agent</strong></td><td style="padding: 6px;">${meta.user_agent || "N/A"}</td></tr>
      <tr><td style="padding: 6px;"><strong>Referer</strong></td><td style="padding: 6px;">${meta.referer || "N/A"}</td></tr>
    </table>
  `;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function sendContactEmails(submission, metadataStr) {
  const { id, full_name, email_address, contact_number, message } = submission;
  let meta = {};
  try {
    meta = typeof metadataStr === "string" ? JSON.parse(metadataStr) : metadataStr || {};
  } catch {
    meta = {};
  }

  const received = renderEmail("contact_received", recordVars("contact", submission));
  const userMail = {
    from: `"Mediko.ph" <${process.env.MAIL_FROM}>`,
    to: email_address,
    subject: received.subject,
    text: received.text,
    html: received.html,
  };

  const adminMail = {
    from: `"Mediko Gateway" <${process.env.MAIL_FROM}>`,
    ...adminRecipients(),
    subject: `[Mediko] New contact message #${id} — ${full_name}`,
    html: `
      <h3 style="color: #2c3e50;">New contact message</h3>
      <table border="1" style="border-collapse: collapse; width: 100%; max-width: 600px; font-family: sans-serif;">
        <tr style="background-color: #f8f9fa;"><td style="padding: 8px; width: 150px;"><strong>Message ID</strong></td><td style="padding: 8px;">#${id}</td></tr>
        <tr><td style="padding: 8px;"><strong>Name</strong></td><td style="padding: 8px;">${escapeHtml(full_name)}</td></tr>
        <tr><td style="padding: 8px;"><strong>Email</strong></td><td style="padding: 8px;">${escapeHtml(email_address)}</td></tr>
        <tr><td style="padding: 8px;"><strong>Contact No.</strong></td><td style="padding: 8px;">${escapeHtml(contact_number)}</td></tr>
        <tr><td style="padding: 8px; vertical-align: top;"><strong>Message</strong></td><td style="padding: 8px;"><pre style="white-space: pre-wrap; font-family: inherit; margin: 0;">${escapeHtml(message)}</pre></td></tr>
      </table>
      ${metaTable(meta)}
    `,
  };

  try {
    await Promise.all([
      transporter.sendMail(userMail),
      transporter.sendMail(adminMail),
    ]);
    log("info", "contact_emails_sent", { id });
  } catch (err) {
    log("error", "contact_email_failed", { id, message: err.message });
  }
}

async function sendReturnEmails(returnReq, files, metadataStr) {
  const {
    id,
    full_name,
    email_address,
    contact_number,
    order_number,
    items_to_return,
    reason,
  } = returnReq;

  let meta = {};
  try {
    meta = typeof metadataStr === "string" ? JSON.parse(metadataStr) : metadataStr || {};
  } catch {
    meta = {};
  }

  const attachments = files
    ? files.map((f) => ({ filename: f.originalname, path: f.path }))
    : [];

  const received = renderEmail("return_received", recordVars("return", returnReq));
  const userMail = {
    from: `"Mediko.ph" <${process.env.MAIL_FROM}>`,
    to: email_address,
    subject: received.subject,
    text: received.text,
    html: received.html,
  };

  const adminMail = {
    from: `"Mediko Gateway" <${process.env.MAIL_FROM}>`,
    ...adminRecipients(),
    subject: `[Mediko] New return request #${id} — ${full_name}`,
    attachments,
    html: `
      <h3 style="color: #2c3e50;">New return / refund request received</h3>
      <table border="1" style="border-collapse: collapse; width: 100%; max-width: 600px; font-family: sans-serif;">
        <tr style="background-color: #f8f9fa;"><td style="padding: 8px; width: 150px;"><strong>Request ID</strong></td><td style="padding: 8px;">#${id}</td></tr>
        <tr><td style="padding: 8px;"><strong>Name</strong></td><td style="padding: 8px;">${escapeHtml(full_name)}</td></tr>
        <tr><td style="padding: 8px;"><strong>Email</strong></td><td style="padding: 8px;">${escapeHtml(email_address)}</td></tr>
        <tr><td style="padding: 8px;"><strong>Contact No.</strong></td><td style="padding: 8px;">${escapeHtml(contact_number)}</td></tr>
        <tr><td style="padding: 8px;"><strong>Order Number</strong></td><td style="padding: 8px;">${escapeHtml(order_number)}</td></tr>
        <tr><td style="padding: 8px; vertical-align: top;"><strong>Items</strong></td><td style="padding: 8px;"><pre style="white-space: pre-wrap; font-family: inherit; margin: 0;">${escapeHtml(items_to_return)}</pre></td></tr>
        <tr><td style="padding: 8px; vertical-align: top;"><strong>Reason</strong></td><td style="padding: 8px;"><pre style="white-space: pre-wrap; font-family: inherit; margin: 0;">${escapeHtml(reason)}</pre></td></tr>
        <tr><td style="padding: 8px;"><strong>Attachments</strong></td><td style="padding: 8px;">${attachments.length} image(s)</td></tr>
      </table>
      ${metaTable(meta)}
    `,
  };

  try {
    await Promise.all([
      transporter.sendMail(userMail),
      transporter.sendMail(adminMail),
    ]);
    log("info", "return_emails_sent", { id });
  } catch (err) {
    log("error", "return_email_failed", { id, message: err.message });
  }
}

app.use("/view-uploads", express.static(path.join(__dirname, "uploads")));

// ── POST /api/apply ───────────────────────────────────────────────────────────
app.post(
  "/api/apply",
  submitLimiter,
  upload.array("id_photos", 2),
  (req, res) => {
    // Capture metadata
    const metadata = JSON.stringify({
      ip: req.ip,
      user_agent: req.get("User-Agent"),
      referer: req.get("Referer") || "Direct",
      origin: req.get("Origin") || "Unknown",
      language: req.get("Accept-Language"),
    });

    const { full_name, birthday, contact_number, email_address, id_number } =
      req.body;

    const now = Date.now();
    const formLoadedAt = parseInt(req.body.form_loaded_at, 10);

    log("info", "apply_attempt", { email: email_address, ip: req.ip });

    // 1. Validation
    if (!full_name || full_name.trim().length < 3) {
      log("warn", "validation_failed", { field: "full_name", ip: req.ip });
      return res.status(400).json({ error: "Invalid full name." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email_address)) {
      log("warn", "validation_failed", { field: "email_address", ip: req.ip });
      return res.status(400).json({ error: "Invalid email address." });
    }
    if (!/^(\+639|09)\d{9}$/.test(contact_number.replace(/[\s\-]/g, ""))) {
      log("warn", "validation_failed", { field: "contact_number", ip: req.ip });
      return res
        .status(400)
        .json({ error: "Invalid Philippine contact number." });
    }
    if (!id_number || id_number.trim().length < 6) {
      log("warn", "validation_failed", { field: "id_number", ip: req.ip });
      return res.status(400).json({ error: "Invalid ID number." });
    }
    if (!req.files || req.files.length === 0) {
      log("warn", "validation_failed", { field: "id_photos", ip: req.ip });
      return res.status(400).json({ error: "ID photo(s) are required." });
    }

    // 2. Time trap
    if (!TESTING_MODE && (!formLoadedAt || now - formLoadedAt < 3000)) {
      log("warn", "time_trap_triggered", { ip: req.ip });
      return res.status(200).json({ success: true }); // Silent reject
    }

    // 3. Honeypot
    const dynamicHp = Object.keys(req.body).find((k) => k.startsWith("hp_"));
    if (dynamicHp && req.body[dynamicHp]) {
      log("warn", "honeypot_triggered", { ip: req.ip, field: dynamicHp });
      return res.status(200).json({ success: true }); // Silent reject
    }

    // 4. Cooldown — prevent duplicate submissions from same email
    const cooldownSql = `
      SELECT id FROM applications
      WHERE email_address = ?
        AND id_number = ?
        AND created_at > DATE_SUB(NOW(), INTERVAL 2 MINUTE)
      LIMIT 1
    `;
    const cooldownParams = [email_address, id_number];
    const runCooldown = (cb) =>
      TESTING_MODE ? cb(null, []) : db.query(cooldownSql, cooldownParams, cb);

    runCooldown((err, rows) => {
      if (err) {
        log("error", "db_cooldown_check_failed", { message: err.message });
        return res.status(500).json({ error: "Database error." });
      }

      if (rows.length > 0) {
        log("info", "duplicate_ignored", { email: email_address });
        return res.status(200).json({
          success: true,
          message:
            "We already received this application. No need to submit again!",
        });
      }

      // 5. Insert
      const photoPaths = req.files
        ? req.files.map((f) => f.path).join(",")
        : "";

      const insertSql = `
      INSERT INTO applications 
        (full_name, birthday, contact_number, email_address, id_number, id_photo_path, metadata) 
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;

      db.query(
        insertSql,
        [
          full_name,
          birthday,
          contact_number,
          email_address,
          id_number,
          photoPaths,
          metadata,
        ],
        (err, result) => {
          if (err) {
            log("error", "db_insert_failed", {
              message: err.message,
              email: email_address,
            });
            return res
              .status(500)
              .json({ error: "Failed to save application." });
          }

          log("info", "application_saved", {
            appId: result.insertId,
            email: email_address,
            ip: req.ip,
            photoCount: req.files.length,
          });

          // Respond immediately — don't wait for email
          res.json({
            success: true,
            message:
              "Application submitted successfully! Please check your email for confirmation.",
            id: result.insertId,
          });

          // Send emails (originals attached), then optimize on disk and update
          // the row's path. Email goes out before originals are deleted.
          (async () => {
            await sendApplicationEmails(
              {
                full_name,
                email_address,
                id_number,
                birthday,
                contact_number,
                insertId: result.insertId,
              },
              req.files,
              metadata,
            );

            const finalPaths = [];
            for (const f of req.files) {
              try {
                finalPaths.push(await optimizeImage(f.path));
              } catch (err) {
                log("error", "apply_optimize_failed", {
                  appId: result.insertId,
                  file: f.path,
                  message: err.message,
                });
                finalPaths.push(f.path);
              }
            }

            try {
              await queryAsync(
                "UPDATE applications SET id_photo_path = ? WHERE id = ?",
                [finalPaths.join(","), result.insertId],
              );
            } catch (err) {
              log("error", "apply_path_update_failed", {
                appId: result.insertId,
                message: err.message,
              });
            }
          })();
        },
      );
    });
  },
);

// ── POST /api/contact ─────────────────────────────────────────────────────────
app.post("/api/contact", submitLimiter, express.json(), async (req, res) => {
  const metadata = JSON.stringify({
    ip: req.ip,
    user_agent: req.get("User-Agent"),
    referer: req.get("Referer") || "Direct",
    origin: req.get("Origin") || "Unknown",
    language: req.get("Accept-Language"),
  });

  const { full_name, email_address, contact_number, message } = req.body;
  const now = Date.now();
  const formLoadedAt = parseInt(req.body.form_loaded_at, 10);

  log("info", "contact_attempt", { email: email_address, ip: req.ip });

  if (!full_name || full_name.trim().length < 3) {
    return res.status(400).json({ error: "Invalid full name." });
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email_address || "")) {
    return res.status(400).json({ error: "Invalid email address." });
  }
  if (!/^(\+639|09)\d{9}$/.test((contact_number || "").replace(/[\s\-]/g, ""))) {
    return res.status(400).json({ error: "Invalid Philippine contact number." });
  }
  if (!message || message.trim().length < 10) {
    return res.status(400).json({ error: "Message must be at least 10 characters." });
  }
  if (message.length > 5000) {
    return res.status(400).json({ error: "Message is too long (max 5000 characters)." });
  }

  if (!TESTING_MODE && (!formLoadedAt || now - formLoadedAt < 3000)) {
    log("warn", "time_trap_triggered", { ip: req.ip, route: "contact" });
    return res.status(200).json({ success: true });
  }

  const dynamicHp = Object.keys(req.body).find((k) => k.startsWith("hp_"));
  if (dynamicHp && req.body[dynamicHp]) {
    log("warn", "honeypot_triggered", { ip: req.ip, route: "contact" });
    return res.status(200).json({ success: true });
  }

  try {
    if (!TESTING_MODE) {
      const dup = await queryAsync(
        `SELECT id FROM contact_submissions
           WHERE email_address = ?
             AND created_at > DATE_SUB(NOW(), INTERVAL 2 MINUTE)
           LIMIT 1`,
        [email_address],
      );
      if (dup.length) {
        log("info", "contact_duplicate_ignored", { email: email_address });
        return res.status(200).json({
          success: true,
          message: "We already received your message. We'll be in touch soon!",
        });
      }
    }

    const result = await queryAsync(
      `INSERT INTO contact_submissions
         (full_name, email_address, contact_number, message, metadata)
       VALUES (?, ?, ?, ?, ?)`,
      [full_name, email_address, contact_number, message, metadata],
    );

    log("info", "contact_saved", {
      id: result.insertId,
      email: email_address,
      ip: req.ip,
    });

    res.json({
      success: true,
      message: "Message sent! Please check your email for confirmation.",
      id: result.insertId,
    });

    sendContactEmails(
      {
        id: result.insertId,
        full_name,
        email_address,
        contact_number,
        message,
      },
      metadata,
    );
  } catch (err) {
    log("error", "contact_insert_failed", {
      message: err.message,
      email: email_address,
    });
    res.status(500).json({ error: "Failed to save message." });
  }
});

// ── POST /api/returns ─────────────────────────────────────────────────────────
app.post(
  "/api/returns",
  submitLimiter,
  returnsUpload.array("attachments", 5),
  async (req, res) => {
    const metadata = JSON.stringify({
      ip: req.ip,
      user_agent: req.get("User-Agent"),
      referer: req.get("Referer") || "Direct",
      origin: req.get("Origin") || "Unknown",
      language: req.get("Accept-Language"),
    });

    const {
      full_name,
      email_address,
      contact_number,
      order_number,
      items_to_return,
      reason,
    } = req.body;

    const now = Date.now();
    const formLoadedAt = parseInt(req.body.form_loaded_at, 10);

    log("info", "return_attempt", { email: email_address, ip: req.ip });

    if (!full_name || full_name.trim().length < 3) {
      return res.status(400).json({ error: "Invalid full name." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email_address || "")) {
      return res.status(400).json({ error: "Invalid email address." });
    }
    if (!/^(\+639|09)\d{9}$/.test((contact_number || "").replace(/[\s\-]/g, ""))) {
      return res.status(400).json({ error: "Invalid Philippine contact number." });
    }
    if (!order_number || order_number.trim().length < 3) {
      return res.status(400).json({ error: "Invalid order number." });
    }
    if (!items_to_return || items_to_return.trim().length < 2) {
      return res.status(400).json({ error: "Please list the items to return." });
    }
    if (!reason || reason.trim().length < 5) {
      return res.status(400).json({ error: "Please provide a reason." });
    }
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "At least one image attachment is required." });
    }

    if (!TESTING_MODE && (!formLoadedAt || now - formLoadedAt < 3000)) {
      log("warn", "time_trap_triggered", { ip: req.ip, route: "returns" });
      return res.status(200).json({ success: true });
    }

    const dynamicHp = Object.keys(req.body).find((k) => k.startsWith("hp_"));
    if (dynamicHp && req.body[dynamicHp]) {
      log("warn", "honeypot_triggered", { ip: req.ip, route: "returns" });
      return res.status(200).json({ success: true });
    }

    try {
      if (!TESTING_MODE) {
        const dup = await queryAsync(
          `SELECT id FROM return_requests
             WHERE email_address = ?
               AND order_number = ?
               AND created_at > DATE_SUB(NOW(), INTERVAL 2 MINUTE)
             LIMIT 1`,
          [email_address, order_number],
        );
        if (dup.length) {
          log("info", "return_duplicate_ignored", { email: email_address });
          return res.status(200).json({
            success: true,
            message: "We already received this request. No need to submit again!",
          });
        }
      }

      const imagePaths = req.files.map((f) => f.path).join(",");

      const result = await queryAsync(
        `INSERT INTO return_requests
           (full_name, email_address, contact_number, order_number, items_to_return, reason, image_paths, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          full_name,
          email_address,
          contact_number,
          order_number,
          items_to_return,
          reason,
          imagePaths,
          metadata,
        ],
      );

      log("info", "return_saved", {
        id: result.insertId,
        email: email_address,
        ip: req.ip,
        attachmentCount: req.files.length,
      });

      res.json({
        success: true,
        message: "Return request submitted! Please check your email for confirmation.",
        id: result.insertId,
      });

      (async () => {
        await sendReturnEmails(
          {
            id: result.insertId,
            full_name,
            email_address,
            contact_number,
            order_number,
            items_to_return,
            reason,
          },
          req.files,
          metadata,
        );

        const finalPaths = [];
        for (const f of req.files) {
          try {
            finalPaths.push(await optimizeImage(f.path));
          } catch (err) {
            log("error", "return_optimize_failed", {
              returnId: result.insertId,
              file: f.path,
              message: err.message,
            });
            finalPaths.push(f.path);
          }
        }

        try {
          await queryAsync(
            "UPDATE return_requests SET image_paths = ? WHERE id = ?",
            [finalPaths.join(","), result.insertId],
          );
        } catch (err) {
          log("error", "return_path_update_failed", {
            returnId: result.insertId,
            message: err.message,
          });
        }
      })();
    } catch (err) {
      log("error", "return_insert_failed", {
        message: err.message,
        email: email_address,
      });
      res.status(500).json({ error: "Failed to save return request." });
    }
  },
);

// ── GET /api/submissions ──────────────────────────────────────────────────────
app.get("/api/submissions", requireAdmin, (req, res) => {

  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;

  const search = (req.query.search || "").trim();
  const dateFrom = (req.query.date_from || "").trim();
  const dateTo = (req.query.date_to || "").trim();

  const whereClauses = [];
  const whereParams = [];

  if (search) {
    whereClauses.push(
      "(full_name LIKE ? OR email_address LIKE ? OR id_number LIKE ?)",
    );
    const like = `%${search}%`;
    whereParams.push(like, like, like);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
    whereClauses.push("created_at >= ?");
    whereParams.push(`${dateFrom} 00:00:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    whereClauses.push("created_at <= ?");
    whereParams.push(`${dateTo} 23:59:59`);
  }
  if (["pending", "approved", "rejected", "resolved"].includes(req.query.status)) {
    whereClauses.push("status = ?");
    whereParams.push(req.query.status);
  }

  const whereSql = whereClauses.length
    ? ` WHERE ${whereClauses.join(" AND ")}`
    : "";

  db.query(
    `SELECT COUNT(*) AS total FROM applications${whereSql}`,
    whereParams,
    (countErr, countResult) => {
      if (countErr) {
        log("error", "db_count_failed", { message: countErr.message });
        return res.status(500).json({ error: countErr.message });
      }

      const totalItems = countResult[0].total;

      db.query(
        `SELECT * FROM applications${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
        [...whereParams, limit, offset],
        (err, results) => {
          if (err) {
            log("error", "db_select_failed", { message: err.message });
            return res.status(500).json({ error: err.message });
          }

          log("info", "submissions_listed", {
            page,
            limit,
            totalItems,
            search: search || null,
            date_from: dateFrom || null,
            date_to: dateTo || null,
            ip: req.ip,
          });

          res.status(200).json({
            metadata: {
              total_items: totalItems,
              total_pages: Math.ceil(totalItems / limit),
              current_page: page,
            },
            data: results,
          });
        },
      );
    },
  );
});

// ── PATCH /api/submissions/:id/status ────────────────────────────────────────
// ── Message templates (customer emails + SMS) ─────────────────────────────────
// Wording lives here as defaults and can be overridden from the portal's
// Templates page (message_templates table). Syntax:
//   {{var}}        replaced with the value
//   [[ ... ]]      optional part: dropped when any {{var}} inside it is empty
//   blank line     new paragraph (email); **bold** works in emails
// Everything is HTML-escaped before formatting, so templates can't inject markup.
const SIGNOFF = "Stay healthy!\n**Mediko.ph Team**";
const TEMPLATES = {
  application_received: {
    group: "Senior/PWD", name: "Application received", channel: "email",
    vars: ["name", "first_name", "id_number", "reference_id"],
    subject: "Application received — Mediko.ph",
    body: `Hello {{name}},

We have received your application for the Senior Citizen / PWD discount.

**What happens next?**
Please wait for a Mediko representative to reach out to you via email, SMS or call. Standard processing time is **3 to 5 business days**.

ID number: {{id_number}}
Reference ID: #{{reference_id}}

${SIGNOFF}`,
  },
  application_approved: {
    group: "Senior/PWD", name: "Application approved", channel: "email",
    vars: ["name", "first_name", "id_number", "reference_id"],
    subject: "Your Mediko.ph Senior/PWD application is approved",
    body: `Hello {{name}},

Good news — your Senior Citizen / PWD application on Mediko.ph has been **approved**.

If you have any questions, just reply to this email.

${SIGNOFF}`,
  },
  application_rejected: {
    group: "Senior/PWD", name: "Application rejected", channel: "email",
    vars: ["name", "first_name", "id_number", "reference_id", "reason"],
    subject: "Update on your Mediko.ph Senior/PWD application",
    body: `Hello {{name}},

Thank you for applying for the Senior Citizen / PWD discount on Mediko.ph.

After reviewing your submission, we are unable to approve your application at this time.
[[
**Reason:** {{reason}}
]]
If you believe this was a mistake or need help, please reply to this email and we'll be happy to assist.

Reference ID: #{{reference_id}}

${SIGNOFF}`,
  },
  application_approved_sms: {
    group: "Senior/PWD", name: "Application approved (SMS)", channel: "sms",
    vars: ["first_name", "reference_id"],
    body: "Mediko: Hi {{first_name}}, your Senior/PWD application is approved. Thank you for choosing Mediko.ph!",
  },
  application_rejected_sms: {
    group: "Senior/PWD", name: "Application rejected (SMS)", channel: "sms",
    vars: ["first_name", "reference_id"],
    body: "Mediko: Hi {{first_name}}, we couldn't approve your Senior/PWD application. Please check your email for details.",
  },
  return_received: {
    group: "Returns", name: "Return request received", channel: "email",
    vars: ["name", "first_name", "order", "items", "reference_id"],
    subject: "Return request received #{{reference_id}} — Mediko.ph",
    body: `Hello {{name}},

We've received your return request for order **{{order}}**.

**What happens next?**
A Mediko representative will review your request and reach out with next steps. Standard processing time is **3 to 5 business days**.

Reference ID: #{{reference_id}}
Order: {{order}}
Items: {{items}}

${SIGNOFF}`,
  },
  return_approved: {
    group: "Returns", name: "Return approved", channel: "email",
    vars: ["name", "first_name", "order", "items", "reference_id"],
    subject: "Your return request #{{reference_id}} has been approved",
    body: `Hello {{name}},

Good news — your return request for order **{{order}}** has been **approved**.

A Mediko representative will reach out shortly with shipping and refund instructions.

Reference ID: #{{reference_id}}

Thank you,
**Mediko.ph Team**`,
  },
  return_rejected: {
    group: "Returns", name: "Return rejected", channel: "email",
    vars: ["name", "first_name", "order", "items", "reference_id", "reason"],
    subject: "Update on your return request #{{reference_id}} — Mediko.ph",
    body: `Hello {{name}},

Thank you for submitting a return request for order **{{order}}**.

After reviewing your request, we are unable to approve this return at this time.
[[
**Reason:** {{reason}}
]]
If you have questions or believe this was made in error, please reply to this email.

Reference ID: #{{reference_id}}

Thank you,
**Mediko.ph Team**`,
  },
  return_approved_sms: {
    group: "Returns", name: "Return approved (SMS)", channel: "sms",
    vars: ["first_name", "order", "reference_id"],
    body: "Mediko: Hi {{first_name}}, your return request for order {{order}} is approved. We'll email you the next steps.",
  },
  return_rejected_sms: {
    group: "Returns", name: "Return rejected (SMS)", channel: "sms",
    vars: ["first_name", "order", "reference_id"],
    body: "Mediko: Hi {{first_name}}, your return request for order {{order}} wasn't approved. Please check your email for details.",
  },
  chat_reply_customer: {
    group: "Chat", name: "Chat reply (customer offline)", channel: "email",
    vars: ["name", "first_name", "messages", "link"],
    subject: "Sumagot na po ang Mediko Support",
    body: `Hello {{first_name}},

Sumagot na po ang Mediko Support sa inyong mensahe:

{{messages}}

Para magpatuloy sa chat, buksan po ito: {{link}}

${SIGNOFF}`,
  },
  contact_received: {
    group: "Messages", name: "Message received", channel: "email",
    vars: ["name", "first_name", "message", "reference_id"],
    subject: "We've received your message — Mediko.ph",
    body: `Hello {{name}},

Thanks for reaching out. We've received your message and a Mediko representative will get back to you within **1–2 business days**.

**Your message:**
{{message}}

Reference ID: #{{reference_id}}

${SIGNOFF}`,
  },
  shipping_sms: {
    group: "Shipping", name: "Order shipped (SMS)", channel: "sms",
    vars: ["order", "courier", "tracking", "link"],
    body: "Mediko: Your order {{order}} has shipped[[ via {{courier}}]].[[ Tracking no: {{tracking}}.]][[ Track: {{link}}]]",
  },
};

const TEMPLATE_LIMITS = { subject: 200, email: 10000, sms: 459 };
let templateCache = {}; // key → { subject, body } saved overrides

async function ensureTemplatesTable() {
  try {
    await queryAsync(
      `CREATE TABLE IF NOT EXISTS message_templates (
         template_key VARCHAR(64) PRIMARY KEY,
         subject TEXT NULL,
         body TEXT NOT NULL,
         updated_by VARCHAR(120) NULL,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
       )`,
    );
    await loadTemplates();
    log("info", "migration_templates_table_ready", { saved: Object.keys(templateCache).length });
  } catch (err) {
    log("error", "migration_templates_table_failed", { message: err.message });
  }
}

async function loadTemplates() {
  const rows = await queryAsync("SELECT template_key, subject, body FROM message_templates");
  const next = {};
  for (const r of rows) if (TEMPLATES[r.template_key]) next[r.template_key] = { subject: r.subject, body: r.body };
  templateCache = next;
}

function getTemplate(key) {
  const def = TEMPLATES[key];
  const saved = templateCache[key];
  return {
    subject: def.channel === "email" ? (saved?.subject ?? def.subject) : null,
    body: saved?.body ?? def.body,
    saved: Boolean(saved),
  };
}

// Fills {{vars}} and resolves [[optional]] parts. `keep` lists vars to leave
// as placeholders (the confirm dialog fills {{reason}} only at send time).
function fillTemplate(text, vars, keep = []) {
  const val = (k) => (vars[k] == null ? "" : String(vars[k]));
  const withOptional = String(text || "").replace(/\[\[([\s\S]*?)\]\]/g, (_, seg) => {
    const names = [...seg.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
    return names.every((n) => keep.includes(n) || val(n).trim()) ? seg : "";
  });
  return withOptional.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (keep.includes(k) ? m : val(k)));
}

// Plain text → simple HTML email.
function templateHtml(text) {
  const paras = escapeHtml(text.trim())
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .split(/\n{2,}/)
    .map((p) => `<p style="margin: 0 0 16px 0;">${p.trim().replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<div style="font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px;">${paras}</div>`;
}

function renderEmail(key, vars, override = {}) {
  const t = getTemplate(key);
  const subject = fillTemplate(override.subject ?? t.subject, vars).replace(/\s+/g, " ").trim();
  const text = fillTemplate(override.body ?? t.body, vars).replace(/\n{3,}/g, "\n\n").trim();
  return { subject, text, html: templateHtml(text) };
}

// SMS: ASCII only. Shipping texts drop the tracking link rather than pay for
// a second credit; other texts may run to 3 parts (the editor shows the cost).
function renderSms(key, vars, override) {
  const body = override ?? getTemplate(key).body;
  let text = toSmsText(fillTemplate(body, vars).replace(/\s+/g, " "));
  if (key === "shipping_sms" && text.length > 160 && vars.link) {
    text = toSmsText(fillTemplate(body, { ...vars, link: "" }).replace(/\s+/g, " "));
  }
  return text.slice(0, TEMPLATE_LIMITS.sms);
}

async function sendTemplateEmail(key, to, vars, override, logCtx = {}) {
  const { subject, text, html } = renderEmail(key, vars, override);
  try {
    await transporter.sendMail({ from: `"Mediko.ph" <${process.env.MAIL_FROM}>`, to, subject, text, html });
    log("info", "template_email_sent", { template: key, ...logCtx });
    return true;
  } catch (err) {
    log("error", "template_email_failed", { template: key, ...logCtx, message: err.message });
    return false;
  }
}

// Variables available for each kind of record.
function recordVars(kind, row, extra = {}) {
  const full = String(row.full_name || "").trim();
  const base = {
    name: full,
    first_name: full.split(/\s+/)[0] || "there",
    reference_id: row.id,
  };
  if (kind === "application") Object.assign(base, { id_number: row.id_number });
  if (kind === "return") Object.assign(base, { order: row.order_number, items: row.items_to_return });
  if (kind === "contact") Object.assign(base, { message: row.message });
  if (kind === "chat") base.reference_id = "";
  return { ...base, ...extra };
}

function validateTemplateInput(def, input) {
  const body = typeof input?.body === "string" ? input.body.replace(/\r\n/g, "\n") : "";
  if (!body.trim()) return { error: "Message can't be empty." };
  const limit = def.channel === "sms" ? TEMPLATE_LIMITS.sms : TEMPLATE_LIMITS.email;
  if (body.length > limit) return { error: `Message is over ${limit} characters.` };
  if (def.channel === "email") {
    const subject = typeof input?.subject === "string" ? input.subject.trim() : "";
    if (!subject) return { error: "Subject can't be empty." };
    if (subject.length > TEMPLATE_LIMITS.subject) return { error: `Subject is over ${TEMPLATE_LIMITS.subject} characters.` };
    return { subject, body };
  }
  return { subject: null, body };
}

// ── /api/templates (admin) ────────────────────────────────────────────────────
app.get("/api/templates", requireAdmin, (_req, res) => {
  res.json({
    templates: Object.entries(TEMPLATES).map(([key, def]) => {
      const t = getTemplate(key);
      return {
        key, group: def.group, name: def.name, channel: def.channel, vars: def.vars,
        subject: t.subject, body: t.body, saved: t.saved,
        defaultSubject: def.subject || null, defaultBody: def.body,
      };
    }),
  });
});

app.put("/api/templates", requireAdmin, async (req, res) => {
  const input = req.body && typeof req.body.templates === "object" ? req.body.templates : null;
  if (!input || !Object.keys(input).length) return res.status(400).json({ error: "Nothing to save." });
  const rows = [];
  const errors = [];
  for (const [key, val] of Object.entries(input)) {
    const def = TEMPLATES[key];
    if (!def) { errors.push(`${key}: unknown template`); continue; }
    const v = validateTemplateInput(def, val);
    if (v.error) errors.push(`${def.name}: ${v.error}`);
    else rows.push([key, v.subject, v.body]);
  }
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });
  try {
    for (const [key, subject, body] of rows) {
      await queryAsync(
        `INSERT INTO message_templates (template_key, subject, body, updated_by) VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE subject = VALUES(subject), body = VALUES(body), updated_by = VALUES(updated_by)`,
        [key, subject, body, adminName(req)],
      );
    }
    await loadTemplates();
    log("info", "templates_saved", { keys: rows.map((r) => r[0]), ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    log("error", "templates_save_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/templates/:key", requireAdmin, async (req, res) => {
  if (!TEMPLATES[req.params.key]) return res.status(404).json({ error: "Unknown template" });
  try {
    await queryAsync("DELETE FROM message_templates WHERE template_key = ?", [req.params.key]);
    await loadTemplates();
    log("info", "template_reset", { key: req.params.key, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    log("error", "template_reset_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Fills a decision template for one record, leaving {{reason}} for send time,
// so the confirm dialog can show (and let staff edit) the real wording.
const DECISION_RECORDS = { applications: ["applications", "application"], returns: ["return_requests", "return"] };
app.get("/api/templates/fill/:kind/:id/:status", requireAdmin, async (req, res) => {
  const rec = DECISION_RECORDS[req.params.kind];
  const status = req.params.status;
  if (!rec || !["approved", "rejected"].includes(status)) return res.status(400).json({ error: "Invalid request" });
  const [table, kind] = rec;
  try {
    const rows = await queryAsync(`SELECT * FROM ${table} WHERE id = ?`, [parseInt(req.params.id, 10)]);
    if (!rows.length) return res.status(404).json({ error: "Not found" });
    const vars = recordVars(kind, rows[0]);
    const key = `${kind}_${status}`;
    const t = getTemplate(key);
    res.json({
      email: {
        subject: fillTemplate(t.subject, vars, ["reason"]).replace(/\s+/g, " ").trim(),
        body: fillTemplate(t.body, vars, ["reason"]).replace(/\n{3,}/g, "\n\n").trim(),
      },
      sms: toSmsText(fillTemplate(getTemplate(`${key}_sms`).body, vars).replace(/\s+/g, " ")),
    });
  } catch (err) {
    log("error", "template_fill_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Customer notifications on approve / reject ────────────────────────────────
// The portal sends { notify: { email, sms, email_subject?, email_body?, sms_text? } }
// with each decision. Email defaults to on (the old behavior); SMS is opt-in
// because it costs a credit. Overrides are this-send-only edits of the
// template text (placeholders still work in them).
function parseNotify(body) {
  const n = body && typeof body.notify === "object" && body.notify ? body.notify : {};
  const str = (v, max) => (typeof v === "string" && v.trim() ? v.replace(/\r\n/g, "\n").slice(0, max) : undefined);
  return {
    email: n.email !== false,
    sms: n.sms === true,
    emailOverride: { subject: str(n.email_subject, TEMPLATE_LIMITS.subject), body: str(n.email_body, TEMPLATE_LIMITS.email) },
    smsOverride: str(n.sms_text, TEMPLATE_LIMITS.sms),
  };
}

// Sends the decision email/SMS for one record; returns { email, sms } as reported to the portal.
async function notifyDecision(kind, status, row, reason, notify) {
  const vars = recordVars(kind, row, { reason });
  const key = `${kind}_${status}`;
  const ctx = { id: row.id, kind };
  if (notify.email) sendTemplateEmail(key, row.email_address, vars, notify.emailOverride, ctx);
  const sms = notify.sms
    ? await sendDecisionSms(row.contact_number, renderSms(`${key}_sms`, vars, notify.smsOverride), ctx)
    : "off";
  return { email: notify.email, sms };
}

// Returns "sent", "skipped: <why>" or "failed: <why>". Never throws.
async function sendDecisionSms(phoneRaw, message, ctx) {
  if (!getSmsConfig().apiKey) return "skipped: no Semaphore API key on the server";
  const phone = normalizePhMobile(phoneRaw);
  if (!phone) return "skipped: not a valid PH mobile number";
  try {
    const text = toSmsText(message).slice(0, TEMPLATE_LIMITS.sms);
    const sent = await sendSemaphoreSms(phone, text);
    log("info", "decision_sms_sent", { ...ctx, messageId: sent.message_id });
    return "sent";
  } catch (err) {
    log("error", "decision_sms_failed", { ...ctx, message: err.message });
    return `failed: ${err.message}`;
  }
}

app.patch("/api/submissions/:id/status", requireAdmin, async (req, res) => {

  const id = parseInt(req.params.id, 10);
  const { status, reason } = req.body || {};
  const notify = parseNotify(req.body);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid id" });
  }
  if (!["pending", "approved", "rejected"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const trimmedReason =
    typeof reason === "string" ? reason.trim().slice(0, 2000) : "";
  if (status === "rejected" && trimmedReason.length < 5) {
    return res
      .status(400)
      .json({ error: "A rejection reason of at least 5 characters is required." });
  }

  try {
    const rows = await queryAsync(
      "SELECT * FROM applications WHERE id = ?",
      [id],
    );
    if (!rows.length) {
      return res.status(404).json({ error: "Application not found" });
    }
    const applicant = rows[0];

    // Approving: status only. Shopify discount codes are discontinued, so
    // nothing is created in Shopify (old code columns are left as they are).
    if (status === "approved" && applicant.status !== "approved") {
      await queryAsync(
        "UPDATE applications SET status = 'approved', rejection_reason = NULL WHERE id = ?",
        [id],
      );
      log("info", "submission_approved", { id, ip: req.ip });
      const notified = await notifyDecision("application", "approved", applicant, "", notify);
      return res.json({ success: true, id, status: "approved", notified });
    }

    const wasRejected = applicant.status === "rejected";
    await queryAsync(
      "UPDATE applications SET status = ?, rejection_reason = ? WHERE id = ?",
      [status, status === "rejected" ? trimmedReason : null, id],
    );

    let notified = { email: false, sms: "off" };
    if (status === "rejected" && !wasRejected) {
      notified = await notifyDecision("application", "rejected", applicant, trimmedReason, notify);
    }

    log("info", "submission_status_updated", { id, status, notified, ip: req.ip });
    res.json({ success: true, id, status, notified });
  } catch (err) {
    log("error", "status_update_failed", {
      id,
      status,
      message: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/shopify/scopes ───────────────────────────────────────────────────
// Diagnostic: reports the scopes the configured Admin token actually carries.
// A token keeps the grant it was minted with, so this is the way to tell an
// out-of-date token apart from an app whose scopes were never updated.
app.get("/api/shopify/scopes", requireAdmin, async (req, res) => {
  if (!shopifyConfigured()) {
    return res.status(503).json({
      error:
        "Shopify is not configured. Set SHOPIFY_SHOP_DOMAIN, plus either "
        + "SHOPIFY_ADMIN_TOKEN or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.",
    });
  }

  try {
    const data = await shopifyGraphQL(
      `query appScopes {
         currentAppInstallation {
           accessScopes { handle }
         }
       }`,
    );

    const granted = (data?.currentAppInstallation?.accessScopes || []).map(
      (s) => s.handle,
    );

    res.json({
      shop: process.env.SHOPIFY_SHOP_DOMAIN,
      api_version: SHOPIFY_API_VERSION,
      granted,
      has_read_orders: granted.includes("read_orders"),
      has_write_orders: granted.includes("write_orders"),
    });
  } catch (err) {
    log("error", "scope_check_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/submissions/:id/orders ───────────────────────────────────────────
// Orders for the assign-order picker. Defaults to the applicant's own orders;
// ?q= searches all orders instead, for a discount used on someone else's order.
app.get("/api/submissions/:id/orders", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid id" });
  }
  if (!shopifyConfigured()) {
    return res.status(503).json({
      error:
        "Shopify is not configured. Set SHOPIFY_SHOP_DOMAIN, plus either "
        + "SHOPIFY_ADMIN_TOKEN or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.",
    });
  }

  try {
    const rows = await queryAsync(
      "SELECT email_address FROM applications WHERE id = ?",
      [id],
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    const email = rows[0].email_address;
    const search = typeof req.query.q === "string" ? req.query.q : "";
    const orders = await listOrders({ email, search });

    res.json({ email, search: search.trim(), orders });
  } catch (err) {
    log("error", "order_list_failed", { id, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/submissions/:id/assign-order ────────────────────────────────────
// Assigns one Shopify order to an application and tags it PWD or SC.
app.post("/api/submissions/:id/assign-order", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const {
    order_gid: orderGid,
    order_name: orderName,
    customer_gid: rawCustomerGid,
    tag,
  } = req.body || {};

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid id" });
  }
  if (typeof orderGid !== "string" || !orderGid.startsWith("gid://shopify/Order/")) {
    return res.status(400).json({ error: "Invalid order_gid" });
  }
  // Guest checkouts have no customer — the order still gets tagged, the
  // customer half is simply skipped.
  const customerGid =
    typeof rawCustomerGid === "string"
      && rawCustomerGid.startsWith("gid://shopify/Customer/")
      ? rawCustomerGid
      : null;
  if (rawCustomerGid && !customerGid) {
    return res.status(400).json({ error: "Invalid customer_gid" });
  }
  if (!ORDER_TAGS.includes(tag)) {
    return res.status(400).json({ error: `Tag must be one of: ${ORDER_TAGS.join(", ")}` });
  }
  if (!shopifyConfigured()) {
    return res.status(503).json({
      error:
        "Shopify is not configured. Set SHOPIFY_SHOP_DOMAIN, plus either "
        + "SHOPIFY_ADMIN_TOKEN or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.",
    });
  }

  try {
    const rows = await queryAsync(
      `SELECT assigned_order_gid, assigned_customer_gid, assigned_tag, refunded_at
         FROM applications WHERE id = ?`,
      [id],
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    const prev = rows[0];

    // Re-assigning: strip the old tag off the previous order first.
    const movedOrder =
      prev.assigned_order_gid && prev.assigned_order_gid !== orderGid;
    const changedTag =
      prev.assigned_order_gid === orderGid && prev.assigned_tag && prev.assigned_tag !== tag;

    if ((movedOrder || changedTag) && prev.assigned_tag) {
      try {
        await removeShopifyTag(prev.assigned_order_gid, prev.assigned_tag);
      } catch (e) {
        log("warn", "order_untag_failed", {
          id,
          orderGid: prev.assigned_order_gid,
          tag: prev.assigned_tag,
          message: e.message,
        });
      }
      await untagCustomerIfUnused(id, prev.assigned_customer_gid, prev.assigned_tag);
    }

    // A refund marker belongs to the order it was made against; moving to a
    // different order drops it.
    if (movedOrder && prev.refunded_at) {
      try {
        await removeShopifyTag(prev.assigned_order_gid, REFUND_TAG);
      } catch (e) {
        log("warn", "order_untag_failed", {
          id,
          orderGid: prev.assigned_order_gid,
          tag: REFUND_TAG,
          message: e.message,
        });
      }
    }

    await addShopifyTag(orderGid, tag);

    // The order tag is the record of truth; a failure to mirror it onto the
    // customer must not undo it.
    if (customerGid) {
      try {
        await addShopifyTag(customerGid, tag);
      } catch (e) {
        log("warn", "customer_tag_failed", { id, customerGid, tag, message: e.message });
      }
    } else {
      log("info", "customer_tag_skipped", { id, orderGid, tag });
    }

    await queryAsync(
      `UPDATE applications
         SET assigned_order_gid = ?, assigned_order_name = ?, assigned_customer_gid = ?,
             assigned_tag = ?
         WHERE id = ?`,
      [
        orderGid,
        typeof orderName === "string" ? orderName.slice(0, 64) : null,
        customerGid,
        tag,
        id,
      ],
    );

    if (movedOrder) {
      await queryAsync(
        "UPDATE applications SET refunded_at = NULL, refunded_by = NULL WHERE id = ?",
        [id],
      );
    }

    log("info", "order_assigned", { id, orderGid, customerGid, tag, ip: req.ip });
    res.json({
      success: true,
      id,
      order_gid: orderGid,
      order_name: orderName,
      customer_gid: customerGid,
      tag,
    });
  } catch (err) {
    log("error", "order_assign_failed", { id, orderGid, tag, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/submissions/:id/assign-order ──────────────────────────────────
app.delete("/api/submissions/:id/assign-order", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid id" });
  }

  try {
    const rows = await queryAsync(
      `SELECT assigned_order_gid, assigned_customer_gid, assigned_tag, refunded_at
         FROM applications WHERE id = ?`,
      [id],
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    const {
      assigned_order_gid: orderGid,
      assigned_customer_gid: customerGid,
      assigned_tag: tag,
      refunded_at: refundedAt,
    } = rows[0];

    if (orderGid && tag && shopifyConfigured()) {
      try {
        await removeShopifyTag(orderGid, tag);
      } catch (e) {
        log("warn", "order_untag_failed", { id, orderGid, tag, message: e.message });
      }
      await untagCustomerIfUnused(id, customerGid, tag);
    }

    // Don't leave a REFUNDED tag on an order this application no longer claims.
    if (orderGid && refundedAt && shopifyConfigured()) {
      try {
        await removeShopifyTag(orderGid, REFUND_TAG);
      } catch (e) {
        log("warn", "order_untag_failed", {
          id,
          orderGid,
          tag: REFUND_TAG,
          message: e.message,
        });
      }
    }

    await queryAsync(
      `UPDATE applications
         SET assigned_order_gid = NULL, assigned_order_name = NULL,
             assigned_customer_gid = NULL, assigned_tag = NULL,
             refunded_at = NULL, refunded_by = NULL
         WHERE id = ?`,
      [id],
    );

    log("info", "order_unassigned", { id, orderGid, tag, ip: req.ip });
    res.json({ success: true, id });
  } catch (err) {
    log("error", "order_unassign_failed", { id, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/submissions/:id/refund ──────────────────────────────────────────
// Marks the assigned order as refunded. Management still issues the refund by
// hand in Shopify — this only records that they did, on the order and locally.
app.post("/api/submissions/:id/refund", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid id" });
  }
  if (!shopifyConfigured()) {
    return res.status(503).json({ error: "Shopify is not configured." });
  }

  try {
    const rows = await queryAsync(
      "SELECT assigned_order_gid, refunded_at FROM applications WHERE id = ?",
      [id],
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    const { assigned_order_gid: orderGid, refunded_at: refundedAt } = rows[0];
    if (!orderGid) {
      return res
        .status(409)
        .json({ error: "Assign an order before marking it refunded" });
    }
    if (refundedAt) {
      return res.json({ success: true, id, refunded_at: refundedAt });
    }

    await addShopifyTag(orderGid, REFUND_TAG);

    const by = adminName(req);
    await queryAsync(
      "UPDATE applications SET refunded_at = NOW(), refunded_by = ? WHERE id = ?",
      [by.slice(0, 120), id],
    );

    log("info", "order_refund_marked", { id, orderGid, by, ip: req.ip });
    res.json({ success: true, id, refunded_by: by });
  } catch (err) {
    log("error", "order_refund_failed", { id, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/submissions/:id/refund ────────────────────────────────────────
app.delete("/api/submissions/:id/refund", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid id" });
  }

  try {
    const rows = await queryAsync(
      "SELECT assigned_order_gid FROM applications WHERE id = ?",
      [id],
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    const { assigned_order_gid: orderGid } = rows[0];

    if (orderGid && shopifyConfigured()) {
      try {
        await removeShopifyTag(orderGid, REFUND_TAG);
      } catch (e) {
        log("warn", "order_untag_failed", {
          id,
          orderGid,
          tag: REFUND_TAG,
          message: e.message,
        });
      }
    }

    await queryAsync(
      "UPDATE applications SET refunded_at = NULL, refunded_by = NULL WHERE id = ?",
      [id],
    );

    log("info", "order_refund_cleared", { id, orderGid, ip: req.ip });
    res.json({ success: true, id });
  } catch (err) {
    log("error", "order_refund_clear_failed", { id, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Shopify App Bridge Auth ───────────────────────────────────────────────────
// Exchanges a verified Shopify session token for a dashboard JWT.
// The session token arrives as `Authorization: Bearer <token>` (App Bridge's
// convention) or as { sessionToken } in the body.
app.post("/api/auth/shopify", express.json(), (req, res) => {
  const secret = dashboardSecret();
  if (!secret) return res.status(503).json({ error: "Admin auth is not configured on the server." });

  const header = req.headers.authorization || "";
  const sessionToken = header.startsWith("Bearer ") ? header.slice(7) : req.body?.sessionToken;
  if (!sessionToken) return res.status(401).json({ error: "Missing Shopify session token" });

  let shopify;
  try {
    shopify = verifyShopifySessionToken(String(sessionToken));
  } catch (err) {
    log("warn", "shopify_session_rejected", { reason: err.message, ip: req.ip });
    return res.status(401).json({ error: "Invalid Shopify session" });
  }

  const shop = new URL(shopify.dest).hostname;
  const token = jwt.sign({ shop, sid: shopify.sid }, secret, {
    algorithm: "HS256",
    subject: String(shopify.sub), // Shopify staff user ID
    issuer: DASHBOARD_JWT.issuer,
    audience: DASHBOARD_JWT.audience,
    expiresIn: DASHBOARD_JWT.ttlSec,
  });
  log("info", "admin_session_started", { shop, user: String(shopify.sub), ip: req.ip });
  res.json({ token, expiresIn: DASHBOARD_JWT.ttlSec });
});

// ── Frame Protection for Shopify ─────────────────────────────────────────────
app.use((req, res, next) => {
  const origins = (
    process.env.ALLOWED_ORIGINS ||
    "https://admin.shopify.com https://*.myshopify.com"
  )
    .split(",")
    .map((o) => o.trim())
    .join(" ");

  res.setHeader(
    "Content-Security-Policy",
    `frame-ancestors 'self' ${origins};`,
  );
  res.removeHeader("X-Frame-Options");
  next();
});

app.use("/admin-dashboard", (req, res, next) => {
  // Block direct access to index.html
  // if (req.path === "/index.html" || req.path === "/") {
  //   return res.status(403).json({ error: "Direct access blocked" });
  // }
  // Serve other assets (css/js) normally
  express.static(path.join(__dirname, "admin-portal"))(req, res, next);
});

// The portal is one HTML file with path-based pages (/admin-dashboard/applications/12,
// …), so any path that isn't a real file serves index.html.
// Old chat alert links (/chats/<id>) → the portal page. See legacyChatRedirect.
app.get(/^\/chats(\/.*)?$/, (req, res, next) => {
  const q = req.originalUrl.indexOf("?");
  const to = legacyChatRedirect(req.path, q === -1 ? "" : req.originalUrl.slice(q));
  return to ? res.redirect(302, to) : next();
});

app.get(/^\/admin-dashboard(\/.*)?$/, (req, res, next) => {
  if (/\.[a-z0-9]+$/i.test(req.path)) return next();
  res.sendFile(path.join(__dirname, "admin-portal", "index.html"));
});

// ── Single records (portal detail pages) ─────────────────────────────────────
const RECORD_TABLES = {
  "submissions": "applications",
  "contact-submissions": "contact_submissions",
  "return-requests": "return_requests",
};
for (const [route, table] of Object.entries(RECORD_TABLES)) {
  app.get(`/api/${route}/:id`, requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: "Invalid id" });
    try {
      const rows = await queryAsync(`SELECT * FROM ${table} WHERE id = ?`, [id]);
      if (!rows.length) return res.status(404).json({ error: "Not found" });
      res.json(rows[0]);
    } catch (err) {
      log("error", "record_get_failed", { table, id, message: err.message });
      res.status(500).json({ error: err.message });
    }
  });
}

// ── Inbox counts (status tabs + Home) ────────────────────────────────────────
async function inboxCounts() {
  const out = {};
  for (const [key, table] of [["applications", "applications"], ["contact", "contact_submissions"], ["returns", "return_requests"]]) {
    const rows = await queryAsync(`SELECT status, COUNT(*) AS c FROM ${table} GROUP BY status`);
    const counts = { total: 0 };
    for (const r of rows) {
      counts[r.status || "pending"] = Number(r.c);
      counts.total += Number(r.c);
    }
    out[key] = counts;
  }
  return out;
}

app.get("/api/inbox/counts", requireAdmin, async (_req, res) => {
  try {
    res.json(await inboxCounts());
  } catch (err) {
    log("error", "inbox_counts_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Setup guide flags (Home) ──────────────────────────────────────────────────
// Internal flags, not operator settings, so they live outside SETTINGS.
const SETUP_FLAGS = [
  "setup_checkout_phone_done", "setup_test_sms_sent", "setup_guide_dismissed",
  "setup_chat_embed_done", "setup_chat_guide_dismissed",
];

async function setSetupFlag(key, on, by) {
  await queryAsync(
    `INSERT INTO app_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
    [key, on ? "true" : "false", by],
  );
}

app.post("/api/setup", requireAdmin, async (req, res) => {
  const body = req.body || {};
  const map = {
    checkout_phone_done: "setup_checkout_phone_done", guide_dismissed: "setup_guide_dismissed",
    chat_embed_done: "setup_chat_embed_done", chat_guide_dismissed: "setup_chat_guide_dismissed",
  };
  const keys = Object.keys(body).filter((k) => map[k] && typeof body[k] === "boolean");
  if (!keys.length) return res.status(400).json({ error: "Nothing to update." });
  try {
    for (const k of keys) await setSetupFlag(map[k], body[k], adminName(req));
    res.json({ success: true });
  } catch (err) {
    log("error", "setup_flag_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Home summary ──────────────────────────────────────────────────────────────
app.get("/api/dashboard", requireAdmin, async (_req, res) => {
  try {
    const counts = await inboxCounts();
    const [sms7] = await queryAsync(
      `SELECT SUM(status = 'sent') AS sent, SUM(status = 'failed') AS failed
       FROM sms_notifications WHERE created_at >= NOW() - INTERVAL 7 DAY`,
    );
    const [smsToday] = await queryAsync(
      "SELECT COUNT(*) AS failed FROM sms_notifications WHERE status = 'failed' AND created_at >= CURDATE()",
    );
    const interrupted = [
      ...(await queryAsync(
        `SELECT b.id, b.subject AS title, b.total, 'email' AS kind,
                (SELECT COUNT(*) FROM email_blast_recipients r WHERE r.blast_id = b.id AND r.status <> 'queued') AS done
         FROM email_blasts b WHERE b.status = 'interrupted' ORDER BY b.created_at DESC LIMIT 3`,
      )),
      ...(await queryAsync(
        `SELECT b.id, b.title, b.total, 'sms' AS kind,
                (SELECT COUNT(*) FROM sms_blast_recipients r WHERE r.blast_id = b.id AND r.status <> 'queued') AS done
         FROM sms_blasts b WHERE b.status = 'interrupted' ORDER BY b.created_at DESC LIMIT 3`,
      )),
    ];
    const flagRows = await queryAsync(
      "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?)",
      [SETUP_FLAGS],
    );
    const flags = Object.fromEntries(flagRows.map((r) => [r.setting_key, r.setting_value === "true"]));
    const sms = getSmsConfig();
    res.json({
      counts,
      sms: {
        sent7d: Number(sms7?.sent || 0),
        failed7d: Number(sms7?.failed || 0),
        failedToday: Number(smsToday?.failed || 0),
        enabled: sms.enabled,
      },
      interrupted,
      setup: {
        apiKeySet: Boolean(sms.apiKey),
        webhookSecretSet: Boolean(process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET),
        senderName: sms.senderName,
        checkoutPhoneDone: Boolean(flags.setup_checkout_phone_done),
        testSmsSent: Boolean(flags.setup_test_sms_sent),
        dismissed: Boolean(flags.setup_guide_dismissed),
      },
      // Live chat setup. Counts come from the chat service (portal → /api/agent/stats).
      chat: {
        configured: chatSecretOk() && Boolean(process.env.CHAT_API_URL),
        recipientsSet: chatAlertRecipients().length > 0,
        embedDone: Boolean(flags.setup_chat_embed_done),
        dismissed: Boolean(flags.setup_chat_guide_dismissed),
      },
    });
  } catch (err) {
    log("error", "dashboard_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/contact-submissions ──────────────────────────────────────────────
app.get("/api/contact-submissions", requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;
  const search = (req.query.search || "").trim();
  const dateFrom = (req.query.date_from || "").trim();
  const dateTo = (req.query.date_to || "").trim();

  const whereClauses = [];
  const whereParams = [];
  if (search) {
    whereClauses.push("(full_name LIKE ? OR email_address LIKE ? OR message LIKE ?)");
    const like = `%${search}%`;
    whereParams.push(like, like, like);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
    whereClauses.push("created_at >= ?");
    whereParams.push(`${dateFrom} 00:00:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    whereClauses.push("created_at <= ?");
    whereParams.push(`${dateTo} 23:59:59`);
  }
  if (["pending", "approved", "rejected", "resolved"].includes(req.query.status)) {
    whereClauses.push("status = ?");
    whereParams.push(req.query.status);
  }
  const whereSql = whereClauses.length ? ` WHERE ${whereClauses.join(" AND ")}` : "";

  try {
    const countRows = await queryAsync(
      `SELECT COUNT(*) AS total FROM contact_submissions${whereSql}`,
      whereParams,
    );
    const totalItems = countRows[0].total;
    const data = await queryAsync(
      `SELECT * FROM contact_submissions${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...whereParams, limit, offset],
    );
    res.json({
      metadata: {
        total_items: totalItems,
        total_pages: Math.ceil(totalItems / limit) || 1,
        current_page: page,
      },
      data,
    });
  } catch (err) {
    log("error", "contact_list_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/contact-submissions/:id/status ────────────────────────────────
app.patch("/api/contact-submissions/:id/status", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status } = req.body || {};
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid id" });
  }
  if (!["pending", "resolved"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  try {
    const result = await queryAsync(
      "UPDATE contact_submissions SET status = ? WHERE id = ?",
      [status, id],
    );
    if (!result.affectedRows) {
      return res.status(404).json({ error: "Message not found" });
    }
    log("info", "contact_status_updated", { id, status, ip: req.ip });
    res.json({ success: true, id, status });
  } catch (err) {
    log("error", "contact_status_update_failed", { id, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/return-requests ──────────────────────────────────────────────────
app.get("/api/return-requests", requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;
  const search = (req.query.search || "").trim();
  const dateFrom = (req.query.date_from || "").trim();
  const dateTo = (req.query.date_to || "").trim();

  const whereClauses = [];
  const whereParams = [];
  if (search) {
    whereClauses.push(
      "(full_name LIKE ? OR email_address LIKE ? OR order_number LIKE ? OR items_to_return LIKE ?)",
    );
    const like = `%${search}%`;
    whereParams.push(like, like, like, like);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateFrom)) {
    whereClauses.push("created_at >= ?");
    whereParams.push(`${dateFrom} 00:00:00`);
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    whereClauses.push("created_at <= ?");
    whereParams.push(`${dateTo} 23:59:59`);
  }
  if (["pending", "approved", "rejected", "resolved"].includes(req.query.status)) {
    whereClauses.push("status = ?");
    whereParams.push(req.query.status);
  }
  const whereSql = whereClauses.length ? ` WHERE ${whereClauses.join(" AND ")}` : "";

  try {
    const countRows = await queryAsync(
      `SELECT COUNT(*) AS total FROM return_requests${whereSql}`,
      whereParams,
    );
    const totalItems = countRows[0].total;
    const data = await queryAsync(
      `SELECT * FROM return_requests${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...whereParams, limit, offset],
    );
    res.json({
      metadata: {
        total_items: totalItems,
        total_pages: Math.ceil(totalItems / limit) || 1,
        current_page: page,
      },
      data,
    });
  } catch (err) {
    log("error", "returns_list_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH /api/return-requests/:id/status ────────────────────────────────────
app.patch("/api/return-requests/:id/status", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { status, reason } = req.body || {};
  const notify = parseNotify(req.body);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid id" });
  }
  if (!["pending", "approved", "rejected"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const trimmedReason =
    typeof reason === "string" ? reason.trim().slice(0, 2000) : "";
  if (status === "rejected" && trimmedReason.length < 5) {
    return res
      .status(400)
      .json({ error: "A rejection reason of at least 5 characters is required." });
  }

  try {
    const rows = await queryAsync("SELECT * FROM return_requests WHERE id = ?", [id]);
    if (!rows.length) {
      return res.status(404).json({ error: "Return request not found" });
    }
    const returnReq = rows[0];
    const wasRejected = returnReq.status === "rejected";

    await queryAsync(
      "UPDATE return_requests SET status = ?, rejection_reason = ? WHERE id = ?",
      [status, status === "rejected" ? trimmedReason : null, id],
    );
    log("info", "return_status_updated", { id, status, ip: req.ip });

    let notified = { email: false, sms: "off" };
    const decided =
      (status === "approved" && returnReq.status !== "approved")
      || (status === "rejected" && !wasRejected);
    if (decided) {
      notified = await notifyDecision("return", status, returnReq, status === "rejected" ? trimmedReason : "", notify);
    }

    res.json({ success: true, id, status, notified });
  } catch (err) {
    log("error", "return_status_update_failed", { id, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Email blasts ──────────────────────────────────────────────────────────────
// Admin-composed bulk email. One message per recipient (never BCC, so
// addresses stay private), sent sequentially in the background with a small
// delay so the Brevo relay isn't flooded. Every recipient is a row, so the
// portal can show progress and a blast cut short by a restart can be resumed.
const BLAST_MAX_RECIPIENTS = 5000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Which statuses an admin may target per source table.
const BLAST_SOURCES = {
  applications: { table: "applications", statuses: ["pending", "approved", "rejected"] },
  contact: { table: "contact_submissions", statuses: ["pending", "resolved"] },
  returns: { table: "return_requests", statuses: ["pending", "approved", "rejected"] },
};

// blastId → { cancelled } for blasts this process is currently sending.
const runningBlasts = new Map();

async function ensureBlastTables() {
  try {
    await queryAsync(
      `CREATE TABLE IF NOT EXISTS email_blasts (
         id INT AUTO_INCREMENT PRIMARY KEY,
         subject VARCHAR(255) NOT NULL,
         body MEDIUMTEXT NOT NULL,
         audience TEXT,
         status ENUM('sending','completed','interrupted','cancelled') NOT NULL DEFAULT 'sending',
         total INT NOT NULL DEFAULT 0,
         created_by VARCHAR(120) NULL,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         finished_at DATETIME NULL,
         INDEX idx_blasts_created (created_at)
       )`,
    );
    await queryAsync(
      `CREATE TABLE IF NOT EXISTS email_blast_recipients (
         id INT AUTO_INCREMENT PRIMARY KEY,
         blast_id INT NOT NULL,
         email VARCHAR(255) NOT NULL,
         full_name VARCHAR(255) NULL,
         status ENUM('queued','sent','failed','skipped') NOT NULL DEFAULT 'queued',
         error TEXT NULL,
         sent_at DATETIME NULL,
         UNIQUE KEY uniq_blast_email (blast_id, email),
         INDEX idx_blast_status (blast_id, status)
       )`,
    );
    await queryAsync(
      `CREATE TABLE IF NOT EXISTS email_unsubscribes (
         email VARCHAR(255) PRIMARY KEY,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
       )`,
    );
    // Nothing is sending at boot — anything still marked so was cut short.
    const result = await queryAsync(
      "UPDATE email_blasts SET status = 'interrupted' WHERE status = 'sending'",
    );
    if (result.affectedRows) {
      log("warn", "blasts_interrupted_on_boot", { count: result.affectedRows });
    }
    log("info", "migration_blast_tables_ready");
  } catch (err) {
    log("error", "migration_blast_tables_failed", { message: err.message });
  }
}

function unsubscribeToken(email) {
  const secret = process.env.DASHBOARD_JWT_SECRET || "mediko-dashboard-secret-2026";
  return crypto
    .createHmac("sha256", secret)
    .update(`unsubscribe:${email.toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
}

function validUnsubscribeToken(email, token) {
  const expected = Buffer.from(unsubscribeToken(email));
  const given = Buffer.from(String(token || ""));
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

function publicBaseUrl(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get("host")}`).replace(/\/+$/, "");
}

function normalizeAudience(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const audience = {};
  for (const [source, { statuses }] of Object.entries(BLAST_SOURCES)) {
    const picked = Array.isArray(input[source]) ? input[source] : [];
    audience[source] = [...new Set(picked.filter((s) => statuses.includes(s)))];
  }
  audience.extra = String(input.extra || "")
    .split(/[\s,;]+/)
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return audience;
}

// Expands an audience into a deduplicated recipient list, dropping invalid and
// unsubscribed addresses. Newest submission wins when picking a name.
async function resolveBlastAudience(audience) {
  const byEmail = new Map();
  const invalid = [];
  const add = (email, fullName) => {
    const normalized = String(email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(normalized)) {
      invalid.push(normalized);
      return;
    }
    if (!byEmail.has(normalized)) {
      byEmail.set(normalized, { email: normalized, full_name: fullName || null });
    }
  };

  for (const [source, { table }] of Object.entries(BLAST_SOURCES)) {
    if (!audience[source].length) continue;
    const rows = await queryAsync(
      `SELECT email_address, full_name FROM ${table} WHERE status IN (?) ORDER BY created_at DESC`,
      [audience[source]],
    );
    rows.forEach((r) => add(r.email_address, r.full_name));
  }
  audience.extra.forEach((e) => add(e, null));

  let unsubscribed = 0;
  if (byEmail.size) {
    const rows = await queryAsync(
      "SELECT email FROM email_unsubscribes WHERE email IN (?)",
      [[...byEmail.keys()]],
    );
    rows.forEach((r) => byEmail.delete(r.email.toLowerCase()));
    unsubscribed = rows.length;
  }

  return { recipients: [...byEmail.values()], invalid, unsubscribed };
}

function validateBlastContent(body) {
  const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
  const text = typeof body?.body === "string" ? body.body.trim() : "";
  if (subject.length < 3 || subject.length > 200) {
    return { error: "Subject must be 3–200 characters." };
  }
  if (text.length < 10 || text.length > 50000) {
    return { error: "Message must be 10–50,000 characters." };
  }
  return { subject, text };
}

// The admin writes plain text; {{name}} is replaced per recipient. Everything
// is escaped after substitution so neither the admin nor a submitter's name
// can inject markup.
function buildBlastMail({ subject, body }, recipient, baseUrl) {
  const name = recipient.full_name || "there";
  const fill = (s) => s.replace(/\{\{\s*name\s*\}\}/gi, name);
  const filledBody = fill(body);
  const paragraphs = filledBody
    .split(/\n{2,}/)
    .map((p) => `<p style="margin: 0 0 16px 0;">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
  const unsubscribeUrl =
    `${baseUrl}/api/unsubscribe?email=${encodeURIComponent(recipient.email)}` +
    `&token=${unsubscribeToken(recipient.email)}`;

  return {
    from: `"Mediko.ph" <${process.env.MAIL_FROM}>`,
    to: recipient.email,
    subject: fill(subject),
    headers: {
      "List-Unsubscribe": `<${unsubscribeUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    text: `${filledBody}\n\n—\nMediko.ph\nUnsubscribe: ${unsubscribeUrl}`,
    html: `
      <div style="font-family: sans-serif; line-height: 1.6; color: #333; max-width: 600px;">
        ${paragraphs}
        <p>Stay healthy!<br><strong>Mediko.ph Team</strong></p>
        <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0 12px 0;">
        <p style="font-size: 12px; color: #9ca3af;">
          You are receiving this because you contacted or ordered from Mediko.ph.
          <a href="${escapeHtml(unsubscribeUrl)}" style="color: #9ca3af;">Unsubscribe</a>
        </p>
      </div>
    `,
  };
}

async function runBlast(blastId, baseUrl) {
  if (runningBlasts.has(blastId)) return;
  const state = { cancelled: false };
  runningBlasts.set(blastId, state);

  try {
    const [blast] = await queryAsync("SELECT * FROM email_blasts WHERE id = ?", [blastId]);
    if (!blast) return;
    await queryAsync(
      "UPDATE email_blasts SET status = 'sending', finished_at = NULL WHERE id = ?",
      [blastId],
    );
    log("info", "blast_started", { blastId, total: blast.total });

    while (!state.cancelled) {
      // Re-check unsubscribes per batch so an opt-out mid-blast is honoured.
      const batch = await queryAsync(
        `SELECT r.id, r.email, r.full_name, u.email AS unsubscribed
         FROM email_blast_recipients r
         LEFT JOIN email_unsubscribes u ON u.email = r.email
         WHERE r.blast_id = ? AND r.status = 'queued'
         ORDER BY r.id LIMIT 50`,
        [blastId],
      );
      if (!batch.length) break;

      for (const recipient of batch) {
        if (state.cancelled) break;
        if (recipient.unsubscribed) {
          await queryAsync(
            "UPDATE email_blast_recipients SET status = 'skipped', error = 'unsubscribed' WHERE id = ?",
            [recipient.id],
          );
          continue;
        }

        let sendError = null;
        try {
          await transporter.sendMail(buildBlastMail(blast, recipient, baseUrl));
        } catch (err) {
          sendError = err.message;
        }

        if (sendError) {
          log("warn", "blast_recipient_failed", { blastId, recipientId: recipient.id, message: sendError });
          await queryAsync(
            "UPDATE email_blast_recipients SET status = 'failed', error = ? WHERE id = ?",
            [sendError.slice(0, 1000), recipient.id],
          );
        } else {
          await queryAsync(
            "UPDATE email_blast_recipients SET status = 'sent', sent_at = NOW(), error = NULL WHERE id = ?",
            [recipient.id],
          );
        }

        const delayMs = getSetting("email_blast_delay_ms");
        if (delayMs) {
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      }
    }

    if (state.cancelled) {
      await queryAsync(
        "UPDATE email_blast_recipients SET status = 'skipped', error = 'cancelled' WHERE blast_id = ? AND status = 'queued'",
        [blastId],
      );
    }
    await queryAsync(
      "UPDATE email_blasts SET status = ?, finished_at = NOW() WHERE id = ?",
      [state.cancelled ? "cancelled" : "completed", blastId],
    );
    log("info", state.cancelled ? "blast_cancelled" : "blast_completed", { blastId });
  } catch (err) {
    log("error", "blast_run_failed", { blastId, message: err.message });
    await queryAsync(
      "UPDATE email_blasts SET status = 'interrupted' WHERE id = ? AND status = 'sending'",
      [blastId],
    ).catch(() => {});
  } finally {
    runningBlasts.delete(blastId);
  }
}

const BLAST_COUNTS_SQL = `
  SELECT blast_id,
         SUM(status = 'queued') AS queued,
         SUM(status = 'sent') AS sent,
         SUM(status = 'failed') AS failed,
         SUM(status = 'skipped') AS skipped
  FROM email_blast_recipients`;

// ── POST /api/blasts/preview ──────────────────────────────────────────────────
app.post("/api/blasts/preview", requireAdmin, async (req, res) => {
  try {
    const audience = normalizeAudience(req.body?.audience);
    const { recipients, invalid, unsubscribed } = await resolveBlastAudience(audience);
    res.json({
      total: recipients.length,
      unsubscribed,
      invalid,
      max: BLAST_MAX_RECIPIENTS,
      sample: recipients.slice(0, 10),
    });
  } catch (err) {
    log("error", "blast_preview_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/blasts/test ─────────────────────────────────────────────────────
app.post("/api/blasts/test", requireAdmin, async (req, res) => {
  const content = validateBlastContent(req.body);
  if (content.error) return res.status(400).json({ error: content.error });
  const to = String(req.body?.to || "").trim().toLowerCase();
  if (!EMAIL_RE.test(to)) {
    return res.status(400).json({ error: "Enter a valid test email address." });
  }

  try {
    await transporter.sendMail(
      buildBlastMail(
        { subject: `[TEST] ${content.subject}`, body: content.text },
        { email: to, full_name: null },
        publicBaseUrl(req),
      ),
    );
    log("info", "blast_test_sent", { ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    log("error", "blast_test_failed", { message: err.message });
    res.status(500).json({ error: `Mailer error: ${err.message}` });
  }
});

// ── POST /api/blasts ──────────────────────────────────────────────────────────
app.post("/api/blasts", requireAdmin, async (req, res) => {
  const content = validateBlastContent(req.body);
  if (content.error) return res.status(400).json({ error: content.error });

  try {
    const audience = normalizeAudience(req.body?.audience);
    const { recipients } = await resolveBlastAudience(audience);
    if (!recipients.length) {
      return res.status(400).json({ error: "The selected audience has no recipients." });
    }
    if (recipients.length > BLAST_MAX_RECIPIENTS) {
      return res.status(400).json({
        error: `Audience has ${recipients.length} recipients; the limit is ${BLAST_MAX_RECIPIENTS}.`,
      });
    }
    // The portal confirms a specific count; refuse if the audience moved since.
    const expected = parseInt(req.body?.expected_total, 10);
    if (Number.isInteger(expected) && expected !== recipients.length) {
      return res.status(409).json({
        error: `Audience changed: now ${recipients.length} recipients (you confirmed ${expected}). Recount and try again.`,
      });
    }
    // Guards against a double-submit fanning the same mail out twice.
    const recent = await queryAsync(
      "SELECT id FROM email_blasts WHERE subject = ? AND created_at >= NOW() - INTERVAL 2 MINUTE",
      [content.subject],
    );
    if (recent.length) {
      return res.status(409).json({ error: "A blast with this subject was just sent. Wait 2 minutes to resend." });
    }

    const result = await queryAsync(
      "INSERT INTO email_blasts (subject, body, audience, total, created_by) VALUES (?, ?, ?, ?, ?)",
      [
        content.subject,
        content.text,
        JSON.stringify(audience),
        recipients.length,
        adminName(req),
      ],
    );
    const blastId = result.insertId;

    for (let i = 0; i < recipients.length; i += 500) {
      const chunk = recipients.slice(i, i + 500).map((r) => [blastId, r.email, r.full_name]);
      await queryAsync(
        "INSERT INTO email_blast_recipients (blast_id, email, full_name) VALUES ?",
        [chunk],
      );
    }

    log("info", "blast_created", { blastId, total: recipients.length, ip: req.ip });
    res.status(202).json({ success: true, id: blastId, total: recipients.length });

    runBlast(blastId, publicBaseUrl(req));
  } catch (err) {
    log("error", "blast_create_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/blasts ───────────────────────────────────────────────────────────
app.get("/api/blasts", requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;

  try {
    const countRows = await queryAsync("SELECT COUNT(*) AS total FROM email_blasts");
    const totalItems = countRows[0].total;
    const data = await queryAsync(
      `SELECT b.id, b.subject, b.status, b.total, b.created_by, b.created_at, b.finished_at,
              COALESCE(c.queued, 0) AS queued, COALESCE(c.sent, 0) AS sent,
              COALESCE(c.failed, 0) AS failed, COALESCE(c.skipped, 0) AS skipped
       FROM email_blasts b
       LEFT JOIN (${BLAST_COUNTS_SQL} GROUP BY blast_id) c ON c.blast_id = b.id
       ORDER BY b.created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    res.json({
      metadata: {
        total_items: totalItems,
        total_pages: Math.ceil(totalItems / limit) || 1,
        current_page: page,
      },
      data,
    });
  } catch (err) {
    log("error", "blast_list_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/blasts/:id ───────────────────────────────────────────────────────
app.get("/api/blasts/:id", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    const [blast] = await queryAsync("SELECT * FROM email_blasts WHERE id = ?", [id]);
    if (!blast) return res.status(404).json({ error: "Blast not found" });
    const [counts] = await queryAsync(`${BLAST_COUNTS_SQL} WHERE blast_id = ? GROUP BY blast_id`, [id]);
    const failures = await queryAsync(
      `SELECT email, full_name, status, error FROM email_blast_recipients
       WHERE blast_id = ? AND status IN ('failed', 'skipped') ORDER BY id LIMIT 200`,
      [id],
    );
    res.json({
      ...blast,
      queued: Number(counts?.queued || 0),
      sent: Number(counts?.sent || 0),
      failed: Number(counts?.failed || 0),
      skipped: Number(counts?.skipped || 0),
      failures,
    });
  } catch (err) {
    log("error", "blast_get_failed", { id, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/blasts/:id/resume ───────────────────────────────────────────────
app.post("/api/blasts/:id/resume", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    const [blast] = await queryAsync("SELECT status FROM email_blasts WHERE id = ?", [id]);
    if (!blast) return res.status(404).json({ error: "Blast not found" });
    if (blast.status !== "interrupted" || runningBlasts.has(id)) {
      return res.status(409).json({ error: `Blast is ${blast.status}; only interrupted blasts can resume.` });
    }
    log("info", "blast_resumed", { blastId: id, ip: req.ip });
    res.json({ success: true, id });
    runBlast(id, publicBaseUrl(req));
  } catch (err) {
    log("error", "blast_resume_failed", { id, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/blasts/:id/cancel ───────────────────────────────────────────────
app.post("/api/blasts/:id/cancel", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid id" });
  }
  try {
    const running = runningBlasts.get(id);
    if (running) {
      // The worker finishes its current send, then skips the rest itself.
      running.cancelled = true;
    } else {
      const result = await queryAsync(
        "UPDATE email_blasts SET status = 'cancelled', finished_at = NOW() WHERE id = ? AND status = 'interrupted'",
        [id],
      );
      if (!result.affectedRows) {
        return res.status(409).json({ error: "Only sending or interrupted blasts can be cancelled." });
      }
      await queryAsync(
        "UPDATE email_blast_recipients SET status = 'skipped', error = 'cancelled' WHERE blast_id = ? AND status = 'queued'",
        [id],
      );
    }
    log("info", "blast_cancel_requested", { blastId: id, ip: req.ip });
    res.json({ success: true, id });
  } catch (err) {
    log("error", "blast_cancel_failed", { id, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Live chat (agent token, customer lookup, signed events) ───────────────────
const CHAT_SECRET_MIN = 32;

function chatSecretOk() {
  const s = process.env.CHAT_AGENT_SECRET;
  return typeof s === "string" && s.length >= CHAT_SECRET_MIN;
}

app.post("/api/chat/agent-token", requireAdmin, (req, res) => {
  if (!chatSecretOk() || !process.env.CHAT_API_URL) {
    return res.status(503).json({ error: "Chat service not configured" });
  }
  try {
    const token = jwt.sign({}, process.env.CHAT_AGENT_SECRET, {
      algorithm: "HS256",
      issuer: "mediko-gateway",
      audience: "mediko-chat",
      subject: String(req.admin.sub),
      expiresIn: 300,
    });
    res.json({
      token,
      expiresAt: new Date(Date.now() + 300 * 1000).toISOString(),
      apiUrl: process.env.CHAT_API_URL,
    });
  } catch (err) {
    log("error", "chat_agent_token_failed", { message: err.message });
    res.status(500).json({ error: "Could not issue token" });
  }
});

app.get("/api/chat/customer", requireAdmin, async (req, res) => {
  const email = typeof req.query.email === "string" ? req.query.email.trim() : "";
  if (!email || email.length > 254 || !EMAIL_LIST_RE.test(email)) {
    return res.status(400).json({ error: "Valid email required" });
  }
  if (!process.env.SHOPIFY_SHOP_DOMAIN) {
    return res.status(503).json({ error: "Shopify not configured" });
  }
  try {
    const data = await shopifyGraphQL(
      `query($q: String!) {
         customers(first: 1, query: $q) {
           nodes { id numberOfOrders lastOrder { name } }
         }
       }`,
      { q: `email:"${email.replace(/["\\]/g, "")}"` },
    );
    const c = data && data.customers && data.customers.nodes && data.customers.nodes[0];
    if (!c) return res.json({ customer: null });
    const numericId = String(c.id).split("/").pop();
    res.json({
      customer: {
        id: c.id,
        adminUrl: `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/customers/${numericId}`,
        ordersCount: Number(c.numberOfOrders) || 0,
        lastOrderName: (c.lastOrder && c.lastOrder.name) || null,
      },
    });
  } catch (err) {
    log("error", "chat_customer_lookup_failed", { message: err.message });
    res.status(500).json({ error: "Customer lookup failed" });
  }
});

// Link preview for a store product URL the agent is about to send. Built from
// the Admin API (needs read_products); the storefront blocks server fetches.
function linkPreviewHosts() {
  return String(process.env.LINK_PREVIEW_HOSTS || "store.mediko.ph,mediko.ph")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

app.get("/api/chat/link-preview", requireAdmin, async (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url.trim().slice(0, 2000) : "";
  const handle = productHandleFromUrl(url, linkPreviewHosts());
  if (!handle) return res.status(400).json({ error: "Only product links from the store get a preview" });
  if (!process.env.SHOPIFY_SHOP_DOMAIN) return res.status(503).json({ error: "Shopify not configured" });
  try {
    const data = await shopifyGraphQL(
      `query ChatLinkPreview($identifier: ProductIdentifierInput!) {
         product: productByIdentifier(identifier: $identifier) {
           title
           description(truncateAt: 200)
           status
           featuredMedia { preview { image { url(transform: { maxWidth: 400 }) } } }
           priceRangeV2 { minVariantPrice { amount currencyCode } }
         }
       }`,
      { identifier: { handle } },
    );
    const preview = productToPreview(data && data.product, url);
    if (!preview) return res.status(404).json({ error: "Product not found or not published" });
    res.json({ preview });
  } catch (err) {
    log("error", "chat_link_preview_failed", { message: err.message });
    const scope = /access|scope|read_products/i.test(err.message || "");
    res.status(500).json({ error: scope ? "Approve the read_products permission for MedikoPH Gateway in Shopify admin" : "Preview lookup failed" });
  }
});

function chatAlertRecipients() {
  // Same parsing as admin_cc's email_list.
  return String(getSetting("chat_alert_recipients") || "")
    .split(",").map((e) => e.trim()).filter(Boolean);
}

async function processChatEvent(event) {
  const link = chatDeepLink(event.sessionId);
  if (event.type === "offline_reply") {
    if (!event.email) {
      log("info", "chat_reply_no_email", { sessionId: maskId(event.sessionId) });
      return;
    }
    await sendTemplateEmail(
      "chat_reply_customer",
      event.email,
      recordVars("chat", { full_name: event.name || "" }, { messages: event.messages.join("\n\n"), link: event.link }),
      undefined,
      { event: "offline_reply" },
    );
    return;
  }
  const to = chatAlertRecipients();
  if (!to.length) {
    log("warn", "chat_alert_no_recipients", { type: event.type });
    return;
  }
  const mail = buildStaffAlertMail(event, link);
  await transporter.sendMail({
    from: `"Mediko Gateway" <${process.env.MAIL_FROM}>`,
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
  log("info", "chat_alert_sent", { type: event.type, recipients: to.length });
}

function handleChatEvent(req, res) {
  if (!chatSecretOk()) return res.status(503).json({ error: "Chat not configured" });
  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  if (
    !raw ||
    !verifyChatEventSignature(
      raw,
      req.get("x-mediko-timestamp"),
      req.get("x-mediko-signature"),
      process.env.CHAT_AGENT_SECRET,
    )
  ) {
    log("warn", "chat_event_rejected", { ip: req.ip });
    return res.status(401).json({ error: "Unauthorized" });
  }
  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    event = null;
  }
  if (!validateChatEvent(event)) {
    return res.status(400).json({ error: "Invalid event" });
  }
  res.status(202).json({ ok: true });
  log("info", "chat_event_received", { type: event.type, sessionId: maskId(event.sessionId) });
  processChatEvent(event).catch((err) =>
    log("error", "chat_event_failed", { type: event.type, message: err.message }),
  );
}

// ── /api/unsubscribe ──────────────────────────────────────────────────────────
// Public, token-guarded. GET only renders a confirm button, because mail
// scanners prefetch links; the POST does the work and also serves RFC 8058
// one-click unsubscribe from mailbox providers.
function unsubscribePage(title, message, formHtml = "") {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)} · Mediko.ph</title></head>
    <body style="font-family: sans-serif; background: #f9fafb; color: #333; display: flex; justify-content: center; padding: 48px 16px;">
      <div style="background: #fff; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,.1); padding: 32px; max-width: 420px; width: 100%;">
        <h2 style="margin-top: 0; color: #0F2237;">${escapeHtml(title)}</h2>
        <p>${message}</p>
        ${formHtml}
      </div>
    </body></html>`;
}

app.get("/api/unsubscribe", (req, res) => {
  const email = String(req.query.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || !validUnsubscribeToken(email, req.query.token)) {
    return res.status(400).send(unsubscribePage("Invalid link", "This unsubscribe link is invalid or incomplete."));
  }
  const action =
    `/api/unsubscribe?email=${encodeURIComponent(email)}&token=${encodeURIComponent(req.query.token)}`;
  res.send(
    unsubscribePage(
      "Unsubscribe",
      `Stop receiving announcement emails at <strong>${escapeHtml(email)}</strong>? You'll still get emails about your own applications and requests.`,
      `<form method="POST" action="${escapeHtml(action)}">
         <button type="submit" style="background: #BB3A45; color: #fff; border: 0; border-radius: 6px; padding: 10px 18px; font-size: 14px; cursor: pointer;">Unsubscribe</button>
       </form>`,
    ),
  );
});

app.post("/api/unsubscribe", express.urlencoded({ extended: false }), async (req, res) => {
  const email = String(req.query.email || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email) || !validUnsubscribeToken(email, req.query.token)) {
    return res.status(400).send(unsubscribePage("Invalid link", "This unsubscribe link is invalid or incomplete."));
  }
  try {
    await queryAsync("INSERT IGNORE INTO email_unsubscribes (email) VALUES (?)", [email]);
    log("info", "blast_unsubscribed", { ip: req.ip });
    res.send(unsubscribePage("Unsubscribed", "You won't receive announcement emails from Mediko.ph anymore."));
  } catch (err) {
    log("error", "blast_unsubscribe_failed", { message: err.message });
    res.status(500).send(unsubscribePage("Something went wrong", "Please try again later."));
  }
});

// ── SMS shipping notifications (Semaphore) ────────────────────────────────────
// Shopify fires fulfillments/create when an order ships. We verify the HMAC,
// claim the fulfillment in sms_notifications (unique key = no double texts on
// webhook retries), answer 200 right away, then text the customer through
// Semaphore. Outcome of every attempt is recorded on the row.
//
// The Semaphore API key is a secret, so it comes only from SEMAPHORE_API_KEY in
// .env. On/off and sender name are portal settings (see SETTINGS).
const SEMAPHORE_BASE = "https://api.semaphore.co/api/v4";

function getSmsConfig() {
  return {
    apiKey: process.env.SEMAPHORE_API_KEY || "",
    senderName: getSetting("sms_sender_name"),
    enabled: getSetting("sms_shipping_enabled"),
  };
}

function smsShippingEnabled() {
  const c = getSmsConfig();
  return c.enabled && Boolean(c.apiKey);
}

async function ensureSmsTable() {
  try {
    await queryAsync(
      `CREATE TABLE IF NOT EXISTS sms_notifications (
         id INT AUTO_INCREMENT PRIMARY KEY,
         fulfillment_id BIGINT NOT NULL,
         order_id BIGINT NULL,
         order_name VARCHAR(64) NULL,
         tracking_company VARCHAR(120) NULL,
         tracking_number VARCHAR(120) NULL,
         tracking_url TEXT NULL,
         phone VARCHAR(16) NULL,
         message TEXT NULL,
         status ENUM('queued','sent','failed','skipped') NOT NULL DEFAULT 'queued',
         provider_message_id VARCHAR(64) NULL,
         error TEXT NULL,
         attempts INT NOT NULL DEFAULT 0,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         sent_at DATETIME NULL,
         UNIQUE KEY uniq_sms_fulfillment (fulfillment_id),
         INDEX idx_sms_status (status),
         INDEX idx_sms_created (created_at)
       )`,
    );
    // Rows created before these columns existed (pre-portal version).
    ensureColumnFor("sms_notifications", "tracking_company", "VARCHAR(120) NULL");
    ensureColumnFor("sms_notifications", "tracking_number", "VARCHAR(120) NULL");
    ensureColumnFor("sms_notifications", "tracking_url", "TEXT NULL");
    ensureColumnFor("sms_notifications", "attempts", "INT NOT NULL DEFAULT 0");
    // An earlier build let the portal save the Semaphore key in the DB. Secrets
    // belong in .env only, so drop any copy that was saved. Only the secret and
    // the retired `sms_enabled` key: `sms_sender_name` is a live portal setting
    // (see SETTINGS), and deleting it here wiped it on every restart/deploy.
    await queryAsync("DELETE FROM app_settings WHERE setting_key IN ('sms_api_key', 'sms_enabled')");
    log("info", "migration_sms_tables_ready");
  } catch (err) {
    log("error", "migration_sms_tables_failed", { message: err.message });
  }
}

function verifyShopifyWebhook(rawBody, hmacHeader) {
  // App-config webhooks are signed with the app's client secret; webhooks
  // created in Shopify admin (Settings → Notifications) use their own key.
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret || !hmacHeader || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(String(hmacHeader), "base64");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Accepts 09XXXXXXXXX, +639XXXXXXXXX, 639XXXXXXXXX, 9XXXXXXXXX (with spaces,
// dashes, parens). Returns 639XXXXXXXXX or null for anything not a PH mobile.
function normalizePhMobile(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("09")) d = `63${d.slice(1)}`;
  else if (d.length === 10 && d.startsWith("9")) d = `63${d}`;
  return /^639\d{9}$/.test(d) ? d : null;
}

// Keep messages plain ASCII: any non-GSM character switches the SMS to UCS-2,
// which cuts a credit down to 70 characters.
function toSmsText(str) {
  return String(str || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .trim();
}

function buildShippingSms({ orderName, company, trackingNumber, trackingUrl }) {
  return renderSms("shipping_sms", {
    order: orderName, courier: company || "", tracking: trackingNumber || "", link: trackingUrl || "",
  });
}

async function lookupOrderPhone(orderId) {
  if (!shopifyConfigured() || !orderId) return null;
  const data = await shopifyGraphQL(
    `query OrderPhones($id: ID!) {
       order(id: $id) {
         name
         phone
         shippingAddress { phone }
         billingAddress { phone }
         customer { defaultPhoneNumber { phoneNumber } }
       }
     }`,
    { id: `gid://shopify/Order/${orderId}` },
  );
  const o = data && data.order;
  if (!o) return null;
  const candidates = [
    o.shippingAddress && o.shippingAddress.phone,
    o.phone,
    o.billingAddress && o.billingAddress.phone,
    o.customer && o.customer.defaultPhoneNumber && o.customer.defaultPhoneNumber.phoneNumber,
  ];
  for (const c of candidates) {
    const n = normalizePhMobile(c);
    if (n) return n;
  }
  return null;
}

async function semaphoreRequest(path, { method = "GET", params = {}, apiKey } = {}) {
  const body = new URLSearchParams({ apikey: apiKey || getSmsConfig().apiKey, ...params });
  const url = method === "GET" ? `${SEMAPHORE_BASE}${path}?${body}` : `${SEMAPHORE_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? undefined : body,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok || json === null) {
    // Never echo the key back into logs or the UI.
    throw new Error(`Semaphore ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

async function sendSemaphoreSms(number, message) {
  const { senderName } = getSmsConfig();
  const params = { number, message };
  if (senderName) params.sendername = senderName;
  const json = await semaphoreRequest("/messages", { method: "POST", params });
  _smsAccountCache.at = 0; // balance changed
  // Success is an array of message objects; validation errors come back as an
  // object keyed by field (sometimes with a 200 status).
  if (!Array.isArray(json) || !json.length) {
    throw new Error(`Semaphore rejected the message: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json[0];
}

async function getSemaphoreAccount(apiKey) {
  const json = await semaphoreRequest("/account", { apiKey });
  if (!json || json.credit_balance === undefined) {
    throw new Error(`Semaphore did not accept the API key: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json;
}

// Sends the text for one sms_notifications row and records the outcome.
// phoneOverride comes from an admin retry, for orders that had no usable number.
async function deliverShippingSms(fulfillmentId, { phoneOverride } = {}) {
  const rows = await queryAsync("SELECT * FROM sms_notifications WHERE fulfillment_id = ?", [fulfillmentId]);
  const row = rows[0];
  if (!row) throw new Error("Notification not found");
  await queryAsync("UPDATE sms_notifications SET attempts = attempts + 1 WHERE id = ?", [row.id]);

  try {
    let phone = phoneOverride || row.phone;
    if (!phone) phone = await lookupOrderPhone(row.order_id);
    if (!phone) {
      await queryAsync(
        "UPDATE sms_notifications SET status = 'skipped', error = 'No valid PH mobile number on the order' WHERE id = ?",
        [row.id],
      );
      log("warn", "sms_skipped_no_phone", { fulfillmentId, orderName: row.order_name });
      return { status: "skipped" };
    }

    const message = buildShippingSms({
      orderName: row.order_name,
      company: row.tracking_company,
      trackingNumber: row.tracking_number,
      trackingUrl: row.tracking_url,
    });
    const sent = await sendSemaphoreSms(phone, message);
    await queryAsync(
      "UPDATE sms_notifications SET status = 'sent', phone = ?, message = ?, provider_message_id = ?, error = NULL, sent_at = NOW() WHERE id = ?",
      [phone, message, sent.message_id ? String(sent.message_id) : null, row.id],
    );
    log("info", "sms_sent", { fulfillmentId, orderName: row.order_name, messageId: sent.message_id });
    return { status: "sent" };
  } catch (err) {
    log("error", "sms_send_failed", { fulfillmentId, orderName: row.order_name, message: err.message });
    await queryAsync("UPDATE sms_notifications SET status = 'failed', error = ? WHERE id = ?", [
      err.message.slice(0, 1000),
      row.id,
    ]).catch(() => {});
    return { status: "failed", error: err.message };
  }
}

async function handleFulfillmentCreateWebhook(req, res) {
  if (!verifyShopifyWebhook(req.body, req.get("X-Shopify-Hmac-Sha256"))) {
    log("warn", "sms_webhook_bad_hmac", { ip: req.ip });
    return res.status(401).send("Unauthorized");
  }
  if (req.get("X-Shopify-Topic") !== "fulfillments/create") return res.status(200).send("ignored");
  if (!smsShippingEnabled()) return res.status(200).send("sms disabled");

  let f;
  try {
    f = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).send("Bad JSON");
  }
  if (!f || !f.id) return res.status(400).send("Missing fulfillment id");

  // Third-party fulfillment services can create pending/failed fulfillments;
  // only a successful one means the parcel is actually on its way.
  if (f.status && f.status !== "success") {
    log("info", "sms_skipped_status", { fulfillmentId: f.id, status: f.status });
    return res.status(200).send("skipped");
  }

  const orderName = toSmsText(String(f.name || "").split(".")[0]) || `#${f.order_id}`;
  let claimed;
  try {
    const result = await queryAsync(
      `INSERT IGNORE INTO sms_notifications
         (fulfillment_id, order_id, order_name, tracking_company, tracking_number, tracking_url, phone)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        f.id,
        f.order_id || null,
        orderName,
        toSmsText(f.tracking_company).slice(0, 120) || null,
        toSmsText(f.tracking_number || (f.tracking_numbers || [])[0]).slice(0, 120) || null,
        f.tracking_url || (f.tracking_urls || [])[0] || null,
        normalizePhMobile(f.destination && f.destination.phone),
      ],
    );
    claimed = result.affectedRows === 1;
  } catch (err) {
    log("error", "sms_claim_failed", { fulfillmentId: f.id, message: err.message });
    // 500 lets Shopify retry later, once the DB is back.
    return res.status(500).send("DB error");
  }

  res.status(200).send("ok");
  if (!claimed) {
    log("info", "sms_duplicate_webhook", { fulfillmentId: f.id });
    return;
  }
  deliverShippingSms(f.id).catch((err) =>
    log("error", "sms_deliver_crashed", { fulfillmentId: f.id, message: err.message }),
  );
}

// ── /api/sms/* (admin) ────────────────────────────────────────────────────────
// Read-only status for the SMS tabs. Editing happens in /api/settings; the key
// is reported only as set or missing.
app.get("/api/sms/settings", requireAdmin, (req, res) => {
  const c = getSmsConfig();
  res.json({
    enabled: c.enabled,
    senderName: c.senderName,
    apiKeySet: Boolean(c.apiKey),
    webhookUrl: `${publicBaseUrl(req)}/webhooks/shopify/fulfillments-create`,
    webhookSecretSet: Boolean(process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET),
  });
});

// Semaphore rate-limits /account hard, so the balance is cached briefly.
let _smsAccountCache = { key: null, at: 0, data: null };
const SMS_ACCOUNT_CACHE_MS = 60 * 1000;

app.get("/api/sms/account", requireAdmin, async (_req, res) => {
  const { apiKey } = getSmsConfig();
  if (!apiKey) return res.status(503).json({ error: "No Semaphore API key set." });
  const c = _smsAccountCache;
  if (c.key === apiKey && c.data && Date.now() - c.at < SMS_ACCOUNT_CACHE_MS) return res.json(c.data);
  try {
    const a = await getSemaphoreAccount();
    const data = { accountName: a.account_name, status: a.status, creditBalance: a.credit_balance };
    _smsAccountCache = { key: apiKey, at: Date.now(), data };
    res.json(data);
  } catch (err) {
    log("error", "sms_account_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sms/notifications", requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  const offset = (page - 1) * limit;
  const where = [];
  const params = [];
  if (["queued", "sent", "failed", "skipped"].includes(req.query.status)) {
    where.push("status = ?");
    params.push(req.query.status);
  }
  if (req.query.search) {
    where.push("(order_name LIKE ? OR phone LIKE ? OR tracking_number LIKE ?)");
    const term = `%${String(req.query.search).trim()}%`;
    params.push(term, term, term);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  try {
    const [{ total }] = await queryAsync(`SELECT COUNT(*) AS total FROM sms_notifications ${whereSql}`, params);
    const data = await queryAsync(
      `SELECT id, fulfillment_id, order_id, order_name, tracking_company, tracking_number, phone, message,
              status, error, attempts, created_at, sent_at
       FROM sms_notifications ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    );
    const counts = await queryAsync("SELECT status, COUNT(*) AS c FROM sms_notifications GROUP BY status");
    res.json({
      metadata: { total_items: total, total_pages: Math.ceil(total / limit) || 1, current_page: page },
      counts: Object.fromEntries(counts.map((r) => [r.status, r.c])),
      data,
    });
  } catch (err) {
    log("error", "sms_list_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sms/notifications/:id/retry", requireAdmin, async (req, res) => {
  if (!getSmsConfig().apiKey) return res.status(503).json({ error: "No Semaphore API key set." });
  let phoneOverride;
  if (req.body && req.body.phone) {
    phoneOverride = normalizePhMobile(req.body.phone);
    if (!phoneOverride) return res.status(400).json({ error: "Enter a valid PH mobile number." });
  }
  try {
    const rows = await queryAsync("SELECT fulfillment_id, status FROM sms_notifications WHERE id = ?", [
      req.params.id,
    ]);
    if (!rows.length) return res.status(404).json({ error: "Not found." });
    if (rows[0].status === "sent" || rows[0].status === "queued") {
      return res.status(409).json({ error: `This message is already ${rows[0].status}.` });
    }
    const result = await deliverShippingSms(rows[0].fulfillment_id, { phoneOverride });
    log("info", "sms_retry", { id: req.params.id, result: result.status, ip: req.ip });
    if (result.status === "sent") return res.json({ success: true, status: "sent" });
    res.status(500).json({ error: result.error || "No valid PH mobile number on the order.", status: result.status });
  } catch (err) {
    log("error", "sms_retry_failed", { id: req.params.id, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// Send one test SMS to confirm the key / sender name.
app.post("/api/sms/test", requireAdmin, async (req, res) => {
  if (!getSmsConfig().apiKey) return res.status(503).json({ error: "No Semaphore API key set." });
  const number = normalizePhMobile(req.body && req.body.number);
  if (!number) return res.status(400).json({ error: "Enter a valid PH mobile number." });
  try {
    const sent = await sendSemaphoreSms(
      number,
      buildShippingSms({ orderName: "#TEST", company: "J&T Express", trackingNumber: "000000000" }),
    );
    log("info", "sms_test_sent", { messageId: sent.message_id, ip: req.ip });
    setSetupFlag("setup_test_sms_sent", true, adminName(req)).catch(() => {});
    res.json({ success: true, messageId: sent.message_id, status: sent.status, sender: sent.sender_name });
  } catch (err) {
    log("error", "sms_test_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── SMS blasts ────────────────────────────────────────────────────────────────
// Same shape as email blasts: audience from the form tables (by status) plus
// pasted numbers, one row per recipient, sent one by one in-process, with
// resume/cancel. Numbers on sms_optouts are never texted. Promotional SMS needs
// the customer's consent (Data Privacy Act), so the opt-out list is the
// admin's tool for honouring "please stop" requests.
const SMS_BLAST_MAX_RECIPIENTS = 5000;
const SMS_BLAST_MAX_LEN = 459; // 3 concatenated SMS
const runningSmsBlasts = new Map();

async function ensureSmsBlastTables() {
  try {
    await queryAsync(
      `CREATE TABLE IF NOT EXISTS sms_blasts (
         id INT AUTO_INCREMENT PRIMARY KEY,
         title VARCHAR(120) NOT NULL,
         body TEXT NOT NULL,
         audience TEXT,
         status ENUM('sending','completed','interrupted','cancelled') NOT NULL DEFAULT 'sending',
         total INT NOT NULL DEFAULT 0,
         created_by VARCHAR(120) NULL,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         finished_at DATETIME NULL,
         INDEX idx_sms_blasts_created (created_at)
       )`,
    );
    await queryAsync(
      `CREATE TABLE IF NOT EXISTS sms_blast_recipients (
         id INT AUTO_INCREMENT PRIMARY KEY,
         blast_id INT NOT NULL,
         phone VARCHAR(16) NOT NULL,
         full_name VARCHAR(255) NULL,
         status ENUM('queued','sent','failed','skipped') NOT NULL DEFAULT 'queued',
         provider_message_id VARCHAR(64) NULL,
         error TEXT NULL,
         sent_at DATETIME NULL,
         UNIQUE KEY uniq_sms_blast_phone (blast_id, phone),
         INDEX idx_sms_blast_status (blast_id, status)
       )`,
    );
    await queryAsync(
      `CREATE TABLE IF NOT EXISTS sms_optouts (
         phone VARCHAR(16) PRIMARY KEY,
         note VARCHAR(255) NULL,
         created_by VARCHAR(120) NULL,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
       )`,
    );
    const result = await queryAsync("UPDATE sms_blasts SET status = 'interrupted' WHERE status = 'sending'");
    if (result.affectedRows) log("warn", "sms_blasts_interrupted_on_boot", { count: result.affectedRows });
    log("info", "migration_sms_blast_tables_ready");
  } catch (err) {
    log("error", "migration_sms_blast_tables_failed", { message: err.message });
  }
}

// Numbers are pasted one per line or comma/semicolon separated. Unlike email,
// spaces can't be separators: "0917 123 4567" is one number.
function normalizeSmsAudience(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const audience = {};
  for (const [source, { statuses }] of Object.entries(BLAST_SOURCES)) {
    const picked = Array.isArray(input[source]) ? input[source] : [];
    audience[source] = [...new Set(picked.filter((s) => statuses.includes(s)))];
  }
  audience.extra = String(input.extra || "")
    .split(/[\n,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);
  return audience;
}

async function resolveSmsAudience(audience) {
  const byPhone = new Map();
  const invalid = [];
  const add = (raw, fullName) => {
    const phone = normalizePhMobile(raw);
    if (!phone) {
      invalid.push(String(raw || "").trim());
      return;
    }
    if (!byPhone.has(phone)) byPhone.set(phone, { phone, full_name: fullName || null });
  };

  for (const [source, { table }] of Object.entries(BLAST_SOURCES)) {
    if (!audience[source].length) continue;
    const rows = await queryAsync(
      `SELECT contact_number, full_name FROM ${table} WHERE status IN (?) ORDER BY created_at DESC`,
      [audience[source]],
    );
    rows.forEach((r) => add(r.contact_number, r.full_name));
  }
  audience.extra.forEach((p) => add(p, null));

  let optedOut = 0;
  if (byPhone.size) {
    const rows = await queryAsync("SELECT phone FROM sms_optouts WHERE phone IN (?)", [[...byPhone.keys()]]);
    rows.forEach((r) => byPhone.delete(r.phone));
    optedOut = rows.length;
  }
  return { recipients: [...byPhone.values()], invalid, optedOut };
}

function fillSmsBlast(body, recipient) {
  const first = toSmsText(String(recipient.full_name || "").trim().split(/\s+/)[0]) || "there";
  return toSmsText(body.replace(/\{\{\s*name\s*\}\}/gi, first));
}

function validateSmsBlastContent(body) {
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  // Strip non-GSM characters up front so the admin's preview matches what's sent.
  const text = typeof body?.body === "string" ? toSmsText(body.body.replace(/\r?\n/g, " ")) : "";
  if (title.length < 3 || title.length > 120) return { error: "Title must be 3–120 characters." };
  if (text.length < 5 || text.length > SMS_BLAST_MAX_LEN) {
    return { error: `Message must be 5–${SMS_BLAST_MAX_LEN} characters (up to 3 SMS).` };
  }
  // Semaphore silently drops messages that start with "TEST".
  if (/^test/i.test(text)) return { error: "Semaphore ignores messages starting with \"TEST\". Reword the start." };
  return { title, text };
}

async function runSmsBlast(blastId) {
  if (runningSmsBlasts.has(blastId)) return;
  const state = { cancelled: false };
  runningSmsBlasts.set(blastId, state);

  try {
    const [blast] = await queryAsync("SELECT * FROM sms_blasts WHERE id = ?", [blastId]);
    if (!blast) return;
    await queryAsync("UPDATE sms_blasts SET status = 'sending', finished_at = NULL WHERE id = ?", [blastId]);
    log("info", "sms_blast_started", { blastId, total: blast.total });

    while (!state.cancelled) {
      // Re-check opt-outs per batch so a number added mid-blast is honoured.
      const batch = await queryAsync(
        `SELECT r.id, r.phone, r.full_name, o.phone AS opted_out
         FROM sms_blast_recipients r
         LEFT JOIN sms_optouts o ON o.phone = r.phone
         WHERE r.blast_id = ? AND r.status = 'queued'
         ORDER BY r.id LIMIT 50`,
        [blastId],
      );
      if (!batch.length) break;

      for (const recipient of batch) {
        if (state.cancelled) break;
        if (recipient.opted_out) {
          await queryAsync(
            "UPDATE sms_blast_recipients SET status = 'skipped', error = 'opted out' WHERE id = ?",
            [recipient.id],
          );
          continue;
        }
        try {
          const sent = await sendSemaphoreSms(recipient.phone, fillSmsBlast(blast.body, recipient));
          await queryAsync(
            "UPDATE sms_blast_recipients SET status = 'sent', provider_message_id = ?, sent_at = NOW(), error = NULL WHERE id = ?",
            [sent.message_id ? String(sent.message_id) : null, recipient.id],
          );
        } catch (err) {
          log("warn", "sms_blast_recipient_failed", { blastId, recipientId: recipient.id, message: err.message });
          await queryAsync("UPDATE sms_blast_recipients SET status = 'failed', error = ? WHERE id = ?", [
            err.message.slice(0, 1000),
            recipient.id,
          ]);
        }
        const delayMs = getSetting("sms_blast_delay_ms");
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    if (state.cancelled) {
      await queryAsync(
        "UPDATE sms_blast_recipients SET status = 'skipped', error = 'cancelled' WHERE blast_id = ? AND status = 'queued'",
        [blastId],
      );
    }
    await queryAsync("UPDATE sms_blasts SET status = ?, finished_at = NOW() WHERE id = ?", [
      state.cancelled ? "cancelled" : "completed",
      blastId,
    ]);
    log("info", state.cancelled ? "sms_blast_cancelled" : "sms_blast_completed", { blastId });
  } catch (err) {
    log("error", "sms_blast_run_failed", { blastId, message: err.message });
    await queryAsync("UPDATE sms_blasts SET status = 'interrupted' WHERE id = ? AND status = 'sending'", [
      blastId,
    ]).catch(() => {});
  } finally {
    runningSmsBlasts.delete(blastId);
  }
}

const SMS_BLAST_COUNTS_SQL = `
  SELECT blast_id,
         SUM(status = 'queued') AS queued,
         SUM(status = 'sent') AS sent,
         SUM(status = 'failed') AS failed,
         SUM(status = 'skipped') AS skipped
  FROM sms_blast_recipients`;

function parseId(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return null;
  }
  return id;
}

app.post("/api/sms-blasts/preview", requireAdmin, async (req, res) => {
  try {
    const audience = normalizeSmsAudience(req.body?.audience);
    const { recipients, invalid, optedOut } = await resolveSmsAudience(audience);
    res.json({
      total: recipients.length,
      optedOut,
      invalid,
      max: SMS_BLAST_MAX_RECIPIENTS,
      sample: recipients.slice(0, 10),
    });
  } catch (err) {
    log("error", "sms_blast_preview_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sms-blasts/test", requireAdmin, async (req, res) => {
  if (!getSmsConfig().apiKey) return res.status(503).json({ error: "No Semaphore API key set." });
  const content = validateSmsBlastContent(req.body);
  if (content.error) return res.status(400).json({ error: content.error });
  const to = normalizePhMobile(req.body?.to);
  if (!to) return res.status(400).json({ error: "Enter a valid PH mobile number for the test." });
  try {
    const sent = await sendSemaphoreSms(to, fillSmsBlast(content.text, { full_name: "Juan" }));
    log("info", "sms_blast_test_sent", { messageId: sent.message_id, ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    log("error", "sms_blast_test_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sms-blasts", requireAdmin, async (req, res) => {
  if (!getSmsConfig().apiKey) return res.status(503).json({ error: "No Semaphore API key set." });
  const content = validateSmsBlastContent(req.body);
  if (content.error) return res.status(400).json({ error: content.error });

  try {
    const audience = normalizeSmsAudience(req.body?.audience);
    const { recipients } = await resolveSmsAudience(audience);
    if (!recipients.length) return res.status(400).json({ error: "The selected audience has no recipients." });
    if (recipients.length > SMS_BLAST_MAX_RECIPIENTS) {
      return res.status(400).json({
        error: `Audience has ${recipients.length} recipients; the limit is ${SMS_BLAST_MAX_RECIPIENTS}.`,
      });
    }
    const expected = parseInt(req.body?.expected_total, 10);
    if (Number.isInteger(expected) && expected !== recipients.length) {
      return res.status(409).json({
        error: `Audience changed: now ${recipients.length} recipients (you confirmed ${expected}). Recount and try again.`,
      });
    }
    const recent = await queryAsync(
      "SELECT id FROM sms_blasts WHERE title = ? AND created_at >= NOW() - INTERVAL 2 MINUTE",
      [content.title],
    );
    if (recent.length) {
      return res.status(409).json({ error: "A blast with this title was just sent. Wait 2 minutes to resend." });
    }

    const result = await queryAsync(
      "INSERT INTO sms_blasts (title, body, audience, total, created_by) VALUES (?, ?, ?, ?, ?)",
      [content.title, content.text, JSON.stringify(audience), recipients.length, adminName(req)],
    );
    const blastId = result.insertId;
    for (let i = 0; i < recipients.length; i += 500) {
      const chunk = recipients.slice(i, i + 500).map((r) => [blastId, r.phone, r.full_name]);
      await queryAsync("INSERT INTO sms_blast_recipients (blast_id, phone, full_name) VALUES ?", [chunk]);
    }

    log("info", "sms_blast_created", { blastId, total: recipients.length, ip: req.ip });
    res.status(202).json({ success: true, id: blastId, total: recipients.length });
    runSmsBlast(blastId);
  } catch (err) {
    log("error", "sms_blast_create_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sms-blasts", requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;
  try {
    const [{ total }] = await queryAsync("SELECT COUNT(*) AS total FROM sms_blasts");
    const data = await queryAsync(
      `SELECT b.id, b.title, b.status, b.total, b.created_by, b.created_at, b.finished_at,
              COALESCE(c.queued, 0) AS queued, COALESCE(c.sent, 0) AS sent,
              COALESCE(c.failed, 0) AS failed, COALESCE(c.skipped, 0) AS skipped
       FROM sms_blasts b
       LEFT JOIN (${SMS_BLAST_COUNTS_SQL} GROUP BY blast_id) c ON c.blast_id = b.id
       ORDER BY b.created_at DESC LIMIT ? OFFSET ?`,
      [limit, offset],
    );
    res.json({
      metadata: { total_items: total, total_pages: Math.ceil(total / limit) || 1, current_page: page },
      data,
    });
  } catch (err) {
    log("error", "sms_blast_list_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/sms-blasts/:id", requireAdmin, async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  try {
    const [blast] = await queryAsync("SELECT * FROM sms_blasts WHERE id = ?", [id]);
    if (!blast) return res.status(404).json({ error: "Blast not found" });
    const [counts] = await queryAsync(`${SMS_BLAST_COUNTS_SQL} WHERE blast_id = ? GROUP BY blast_id`, [id]);
    const failures = await queryAsync(
      `SELECT phone, full_name, status, error FROM sms_blast_recipients
       WHERE blast_id = ? AND status IN ('failed', 'skipped') ORDER BY id LIMIT 200`,
      [id],
    );
    res.json({
      ...blast,
      queued: Number(counts?.queued || 0),
      sent: Number(counts?.sent || 0),
      failed: Number(counts?.failed || 0),
      skipped: Number(counts?.skipped || 0),
      failures,
    });
  } catch (err) {
    log("error", "sms_blast_get_failed", { id, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sms-blasts/:id/resume", requireAdmin, async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  try {
    const [blast] = await queryAsync("SELECT status FROM sms_blasts WHERE id = ?", [id]);
    if (!blast) return res.status(404).json({ error: "Blast not found" });
    if (blast.status !== "interrupted" || runningSmsBlasts.has(id)) {
      return res.status(409).json({ error: `Blast is ${blast.status}; only interrupted blasts can resume.` });
    }
    log("info", "sms_blast_resumed", { blastId: id, ip: req.ip });
    res.json({ success: true, id });
    runSmsBlast(id);
  } catch (err) {
    log("error", "sms_blast_resume_failed", { id, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sms-blasts/:id/cancel", requireAdmin, async (req, res) => {
  const id = parseId(req, res);
  if (!id) return;
  try {
    const running = runningSmsBlasts.get(id);
    if (running) {
      running.cancelled = true;
    } else {
      const result = await queryAsync(
        "UPDATE sms_blasts SET status = 'cancelled', finished_at = NOW() WHERE id = ? AND status = 'interrupted'",
        [id],
      );
      if (!result.affectedRows) {
        return res.status(409).json({ error: "Only sending or interrupted blasts can be cancelled." });
      }
      await queryAsync(
        "UPDATE sms_blast_recipients SET status = 'skipped', error = 'cancelled' WHERE blast_id = ? AND status = 'queued'",
        [id],
      );
    }
    log("info", "sms_blast_cancel_requested", { blastId: id, ip: req.ip });
    res.json({ success: true, id });
  } catch (err) {
    log("error", "sms_blast_cancel_failed", { id, message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── /api/sms-optouts (admin) ──────────────────────────────────────────────────
app.get("/api/sms-optouts", requireAdmin, async (_req, res) => {
  try {
    const data = await queryAsync(
      "SELECT phone, note, created_by, created_at FROM sms_optouts ORDER BY created_at DESC LIMIT 1000",
    );
    res.json({ data });
  } catch (err) {
    log("error", "sms_optout_list_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.post("/api/sms-optouts", requireAdmin, async (req, res) => {
  const phones = String(req.body?.phones || "")
    .split(/[\n,;]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const valid = [...new Set(phones.map(normalizePhMobile).filter(Boolean))];
  const invalid = phones.filter((p) => !normalizePhMobile(p));
  if (!valid.length) return res.status(400).json({ error: "No valid PH mobile numbers.", invalid });
  const note = String(req.body?.note || "").trim().slice(0, 255) || null;
  try {
    await queryAsync("INSERT IGNORE INTO sms_optouts (phone, note, created_by) VALUES ?", [
      valid.map((p) => [p, note, adminName(req)]),
    ]);
    log("info", "sms_optouts_added", { count: valid.length, ip: req.ip });
    res.json({ success: true, added: valid.length, invalid });
  } catch (err) {
    log("error", "sms_optout_add_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/sms-optouts/:phone", requireAdmin, async (req, res) => {
  const phone = normalizePhMobile(req.params.phone);
  if (!phone) return res.status(400).json({ error: "Invalid number" });
  try {
    await queryAsync("DELETE FROM sms_optouts WHERE phone = ?", [phone]);
    log("info", "sms_optout_removed", { ip: req.ip });
    res.json({ success: true });
  } catch (err) {
    log("error", "sms_optout_remove_failed", { message: err.message });
    res.status(500).json({ error: err.message });
  }
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  log("error", "unhandled_error", { message: err.message, path: redactPath(req.path) });
  res.status(500).json({ error: "An unexpected error occurred." });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => log("info", "server_started", { port: PORT }));

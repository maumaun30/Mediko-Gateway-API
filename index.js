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
  productHandleFromUrl, productToPreview, createReplayGuard,
} = require("./lib/chat");
const { isAccessDenied, verifyAppProxy } = require("./lib/shopify");
const { applicationAdminMail, contactAdminMail, returnAdminMail } = require("./lib/adminEmail");
const { templateHtml } = require("./lib/emailFormat");
const { orderNameQuery, pickOrder, orderStatusResult, ORDER_FIELDS, normalizeOrderNumber, orderFromNode, contactMatches, publicOrderStatus, statusReply } = require("./lib/orders");

// ── Feature modules (lib/) ─────────────────────────────────────────────────────
const { TESTING_MODE } = require("./lib/config");
const { ensureBlastTables } = require("./lib/emailBlasts");
const { RECORD_TABLES } = require("./lib/inbox");
const { handleChatEvent, handleOrderStatus } = require("./lib/liveChat");
const { ensureSmsBlastTables, ensureSmsTable, handleFulfillmentCreateWebhook } = require("./lib/sms");
const { ensureTemplatesTable } = require("./lib/templates");

const app = express();
app.set("trust proxy", 1);

if (TESTING_MODE) {
  console.warn(
    "⚠️  TESTING_MODE is ON — rate limit, time trap, and cooldown are disabled.",
  );
}

// ── Infrastructure modules (lib/) ─────────────────────────────────────────────
const { log } = require("./lib/log");
const { db, ensureColumnFor, ensureColumn, ensureStatusColumn, ensureContactTable, ensureReturnsTable, queryAsync } = require("./lib/db");
const { DASHBOARD_JWT, shopifyClientId, dashboardSecret, verifyShopifySessionToken, requireAdmin } = require("./lib/auth");
const { EMAIL_LIST_RE, SETTINGS, SECRET_ENV_STATUS, settingsCache, parseSetting, settingSource, getSetting, validateSetting, ensureSettingsTable, loadSettings, adminRecipients, adminName } = require("./lib/settings");
const { transporter } = require("./lib/mailer");
const { SHOPIFY_API_VERSION, TOKEN_REFRESH_MARGIN_MS, clientCredentialsConfigured, shopifyConfigured, _tokenCache, _tokenInFlight, mintAdminToken, getAdminToken, invalidateAdminToken, shopifyGraphQL, throwIfUserErrors } = require("./lib/shopifyAdmin");


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
// /internal/chat-events and /internal/order-status are server-to-server
// (HMAC-signed by the chat service), so they skip CORS too.
app.use((req, res, next) =>
  req.path === "/api/unsubscribe" || req.path === "/internal/chat-events" || req.path === "/internal/order-status"
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
app.post(
  "/internal/order-status",
  express.raw({ type: "application/json", limit: "8kb" }),
  handleOrderStatus,
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


// ── Multer ────────────────────────────────────────────────────────────────────




// ── Image optimizer client ────────────────────────────────────────────────────

// ── Database ──────────────────────────────────────────────────────────────────

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




// ── /api/settings (admin) ─────────────────────────────────────────────────────
require("./routes/settings")(app);






// ── Shopify order tagging (Senior/PWD) ────────────────────────────────────────






// ── Approval email ────────────────────────────────────────────────────────────
// ── Contact / Returns email helpers ───────────────────────────────────────────




app.use("/view-uploads", express.static(path.join(__dirname, "uploads")));

// ── POST /api/apply ───────────────────────────────────────────────────────────
require("./routes/forms")(app);

// ── POST /api/contact ─────────────────────────────────────────────────────────

// ── POST /api/returns ─────────────────────────────────────────────────────────

// ── GET /api/submissions ──────────────────────────────────────────────────────
require("./routes/submissions")(app);

// ── PATCH /api/submissions/:id/status ────────────────────────────────────────
// ── Message templates (customer emails + SMS) ─────────────────────────────────











// ── /api/templates (admin) ────────────────────────────────────────────────────
require("./routes/templates")(app);




// ── Customer notifications on approve / reject ────────────────────────────────




// ── GET /api/shopify/scopes ───────────────────────────────────────────────────

// ── GET /api/submissions/:id/orders ───────────────────────────────────────────

// ── POST /api/submissions/:id/assign-order ────────────────────────────────────

// ── DELETE /api/submissions/:id/assign-order ──────────────────────────────────

// ── POST /api/submissions/:id/refund ──────────────────────────────────────────

// ── DELETE /api/submissions/:id/refund ────────────────────────────────────────

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

require("./routes/inbox")(app);

// ── Setup guide flags (Home) ──────────────────────────────────────────────────



// ── Home summary ──────────────────────────────────────────────────────────────

// ── GET /api/contact-submissions ──────────────────────────────────────────────

// ── PATCH /api/contact-submissions/:id/status ────────────────────────────────

// ── GET /api/return-requests ──────────────────────────────────────────────────

// ── PATCH /api/return-requests/:id/status ────────────────────────────────────

// ── Email blasts ──────────────────────────────────────────────────────────────













// ── POST /api/blasts/preview ──────────────────────────────────────────────────
require("./routes/emailBlasts")(app);

// ── POST /api/blasts/test ─────────────────────────────────────────────────────

// ── POST /api/blasts ──────────────────────────────────────────────────────────

// ── GET /api/blasts ───────────────────────────────────────────────────────────

// ── GET /api/blasts/:id ───────────────────────────────────────────────────────

// ── POST /api/blasts/:id/resume ───────────────────────────────────────────────

// ── POST /api/blasts/:id/cancel ───────────────────────────────────────────────

// ── Live chat (agent token, customer lookup, signed events) ───────────────────


require("./routes/liveChat")(app);


// ── Orders for live chat ──────────────────────────────────────────────────────












// ── /api/unsubscribe ──────────────────────────────────────────────────────────



// ── SMS shipping notifications (Semaphore) ────────────────────────────────────














// ── /api/sms/* (admin) ────────────────────────────────────────────────────────
require("./routes/sms")(app);






// ── SMS blasts ────────────────────────────────────────────────────────────────
















// ── /api/sms-optouts (admin) ──────────────────────────────────────────────────



// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  log("error", "unhandled_error", { message: err.message, path: redactPath(req.path) });
  res.status(500).json({ error: "An unexpected error occurred." });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => log("info", "server_started", { port: PORT }));

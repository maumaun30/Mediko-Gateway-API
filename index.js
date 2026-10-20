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
app.use((req, res, next) =>
  req.path === "/api/unsubscribe" ? next() : corsMiddleware(req, res, next),
);

app.use(express.json({ limit: "1mb" }));

// ── Request logger middleware ─────────────────────────────────────────────────
app.use((req, _res, next) => {
  log("info", "request_received", {
    method: req.method,
    path: req.path,
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
    ensureContactTable();
    ensureReturnsTable();
    ensureBlastTables();
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

function requireAdmin(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }
    const token = authHeader.split(" ")[1];
    const secret =
      process.env.DASHBOARD_JWT_SECRET || "mediko-dashboard-secret-2026";
    req.admin = jwt.verify(token, secret);
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

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

  const applicantMail = {
    from: `"Mediko.ph" <${process.env.MAIL_FROM}>`,
    to: email_address,
    subject: "Application Received - Mediko.ph Discount",
    html: `
      <div style="font-family: sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #2c3e50;">Hello ${full_name},</h2>
        <p>We have received your application for the Senior Citizen / PWD discount.</p>
        
        <div style="background-color: #f8f9fa; padding: 15px; border-left: 4px solid #005a9c; margin: 20px 0;">
          <strong>What happens next?</strong><br>
          Please wait for a Mediko representative to reach out to you via Email, SMS, or Call.
          <p>Standard processing time is <strong>3 to 5 business days</strong>.</p>
        </div>

        <p><strong>Application Details:</strong><br>
        ID Number: ${id_number}<br>
        Reference ID: #${insertId}</p> <p>Stay healthy!<br><strong>Mediko.ph Team</strong></p>
      </div>
    `,
  };

  const adminMail = {
    from: `"Mediko Gateway" <${process.env.MAIL_FROM}>`,
    to: process.env.ADMIN_EMAIL,
    cc:
      process.env.ADMIN_CC && process.env.ADMIN_CC.trim() !== ""
        ? process.env.ADMIN_CC.split(",")
        : [],
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
const DISCOUNT_PERCENTAGE = parseFloat(process.env.DISCOUNT_PERCENTAGE || "20");
const DISCOUNT_AUTOGEN_ENABLED = process.env.DISCOUNT_AUTOGEN_ENABLED !== "false";

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

async function findOrCreateShopifyCustomer(applicant) {
  const searchData = await shopifyGraphQL(
    `query findCustomer($q: String!) {
       customers(first: 1, query: $q) {
         edges { node { id } }
       }
     }`,
    { q: `email:${applicant.email_address}` },
  );
  const existing = searchData?.customers?.edges?.[0]?.node?.id;
  if (existing) return existing;

  const [firstName, ...rest] = (applicant.full_name || "").trim().split(/\s+/);
  const lastName = rest.join(" ") || firstName;

  const createData = await shopifyGraphQL(
    `mutation createCustomer($input: CustomerInput!) {
       customerCreate(input: $input) {
         customer { id }
         userErrors { field message }
       }
     }`,
    {
      input: {
        email: applicant.email_address,
        firstName,
        lastName,
        phone: applicant.contact_number,
        tags: ["senior-pwd-discount"],
      },
    },
  );

  throwIfUserErrors(createData?.customerCreate?.userErrors, "customerCreate");
  return createData.customerCreate.customer.id;
}

function generateDiscountCode(appId) {
  const rand = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `MEDIKO-${appId}-${rand}`;
}

async function createDiscountForApplicant(applicant) {
  const customerGid = await findOrCreateShopifyCustomer(applicant);
  const code = generateDiscountCode(applicant.id);

  const data = await shopifyGraphQL(
    `mutation createDiscount($basicCodeDiscount: DiscountCodeBasicInput!) {
       discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
         codeDiscountNode { id }
         userErrors { field code message }
       }
     }`,
    {
      basicCodeDiscount: {
        title: `Mediko Senior/PWD - App #${applicant.id}`,
        code,
        startsAt: new Date().toISOString(),
        customerSelection: { customers: { add: [customerGid] } },
        customerGets: {
          value: { percentage: DISCOUNT_PERCENTAGE / 100 },
          items: { all: true },
        },
        combinesWith: {
          productDiscounts: false,
          orderDiscounts: true,
          shippingDiscounts: true,
        },
        usageLimit: 1,
        appliesOncePerCustomer: true,
      },
    },
  );

  throwIfUserErrors(
    data?.discountCodeBasicCreate?.userErrors,
    "discountCodeBasicCreate",
  );

  return {
    code,
    nodeGid: data.discountCodeBasicCreate.codeDiscountNode.id,
  };
}

async function deleteDiscount(nodeGid) {
  const data = await shopifyGraphQL(
    `mutation deleteDiscount($id: ID!) {
       discountCodeDelete(id: $id) {
         deletedCodeDiscountId
         userErrors { field code message }
       }
     }`,
    { id: nodeGid },
  );
  throwIfUserErrors(
    data?.discountCodeDelete?.userErrors,
    "discountCodeDelete",
  );
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
async function sendApprovalEmail(applicant, code) {
  const mail = {
    from: `"Mediko.ph" <${process.env.MAIL_FROM}>`,
    to: applicant.email_address,
    subject: "Your Mediko.ph Senior/PWD Discount is Approved",
    html: `
      <div style="font-family: sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #2c3e50;">Hello ${applicant.full_name},</h2>
        <p>Good news — your Senior Citizen / PWD discount application has been <strong>approved</strong>.</p>

        <div style="background-color: #f0fdf4; border: 1px solid #16a34a; padding: 20px; border-radius: 8px; margin: 20px 0; text-align: center;">
          <p style="margin: 0 0 8px 0; color: #555;">Your personal discount code:</p>
          <p style="margin: 0; font-size: 28px; font-weight: bold; color: #15803d; letter-spacing: 2px;">${code}</p>
          <p style="margin: 12px 0 0 0; font-size: 13px; color: #555;">${DISCOUNT_PERCENTAGE}% off — tied to your email address.</p>
        </div>

        <div style="background-color: #fff7ed; border: 1px solid #f97316; padding: 15px; border-radius: 8px; margin: 20px 0;">
          <strong style="color: #c2410c;">⚠️ Important:</strong>
          <p style="margin: 8px 0 0 0; color: #7c2d12;">This code can only be used <strong>once</strong>. Please make sure your order is complete and correct before applying it at checkout. The code will expire after a single use and cannot be reissued.</p>
        </div>

        <p><strong>How to use it:</strong></p>
        <ol>
          <li>Add your items to the cart on <a href="https://mediko.ph">mediko.ph</a>.</li>
          <li>At checkout, enter the email address you used to apply: <strong>${applicant.email_address}</strong>.</li>
          <li>Paste the code <strong>${code}</strong> in the discount field and apply.</li>
        </ol>

        <p style="font-size: 13px; color: #777;">This code is permanently linked to your email. Keep this email for your records.</p>
        <p>Stay healthy!<br><strong>Mediko.ph Team</strong></p>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mail);
    log("info", "approval_email_sent", { appId: applicant.id });
  } catch (err) {
    log("error", "approval_email_failed", {
      appId: applicant.id,
      message: err.message,
    });
  }
}

async function sendRejectionEmail(applicant, reason) {
  const reasonHtml = reason
    ? `<div style="background-color: #fef2f2; border: 1px solid #dc2626; padding: 15px; border-radius: 8px; margin: 20px 0;">
         <strong style="color: #991b1b;">Reason:</strong>
         <pre style="white-space: pre-wrap; font-family: inherit; margin: 8px 0 0 0; color: #7f1d1d;">${escapeHtml(reason)}</pre>
       </div>`
    : "";

  const mail = {
    from: `"Mediko.ph" <${process.env.MAIL_FROM}>`,
    to: applicant.email_address,
    subject: "Update on your Mediko.ph Senior/PWD discount application",
    html: `
      <div style="font-family: sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #2c3e50;">Hello ${escapeHtml(applicant.full_name)},</h2>
        <p>Thank you for applying for the Senior Citizen / PWD discount on Mediko.ph.</p>
        <p>After reviewing your submission, we are unable to approve your application at this time.</p>
        ${reasonHtml}
        <p>If you believe this was a mistake or need help, please reply to this email or contact our support team and we'll be happy to assist.</p>
        <p>Reference ID: #${applicant.id}</p>
        <p>Stay healthy,<br><strong>Mediko.ph Team</strong></p>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mail);
    log("info", "rejection_email_sent", { appId: applicant.id });
  } catch (err) {
    log("error", "rejection_email_failed", {
      appId: applicant.id,
      message: err.message,
    });
  }
}

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

  const userMail = {
    from: `"Mediko.ph" <${process.env.MAIL_FROM}>`,
    to: email_address,
    subject: "We've received your message — Mediko.ph",
    html: `
      <div style="font-family: sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #2c3e50;">Hello ${escapeHtml(full_name)},</h2>
        <p>Thanks for reaching out. We've received your message and a Mediko representative will get back to you within <strong>1–2 business days</strong>.</p>
        <div style="background-color: #f8f9fa; padding: 15px; border-left: 4px solid #005a9c; margin: 20px 0;">
          <strong>Your message:</strong><br>
          <pre style="white-space: pre-wrap; font-family: inherit; margin: 8px 0 0 0;">${escapeHtml(message)}</pre>
        </div>
        <p>Reference ID: #${id}</p>
        <p>Stay healthy!<br><strong>Mediko.ph Team</strong></p>
      </div>
    `,
  };

  const adminMail = {
    from: `"Mediko Gateway" <${process.env.MAIL_FROM}>`,
    to: process.env.ADMIN_EMAIL,
    cc:
      process.env.ADMIN_CC && process.env.ADMIN_CC.trim() !== ""
        ? process.env.ADMIN_CC.split(",")
        : [],
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

  const userMail = {
    from: `"Mediko.ph" <${process.env.MAIL_FROM}>`,
    to: email_address,
    subject: `Return request received #${id} — Mediko.ph`,
    html: `
      <div style="font-family: sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #2c3e50;">Hello ${escapeHtml(full_name)},</h2>
        <p>We've received your return request for order <strong>${escapeHtml(order_number)}</strong>.</p>
        <div style="background-color: #f8f9fa; padding: 15px; border-left: 4px solid #005a9c; margin: 20px 0;">
          <strong>What happens next?</strong><br>
          A Mediko representative will review your request and reach out with next steps.
          <p>Standard processing time is <strong>3 to 5 business days</strong>.</p>
        </div>
        <p><strong>Request Details:</strong><br>
        Reference ID: #${id}<br>
        Order: ${escapeHtml(order_number)}<br>
        Items: ${escapeHtml(items_to_return)}</p>
        <p>Stay healthy!<br><strong>Mediko.ph Team</strong></p>
      </div>
    `,
  };

  const adminMail = {
    from: `"Mediko Gateway" <${process.env.MAIL_FROM}>`,
    to: process.env.ADMIN_EMAIL,
    cc:
      process.env.ADMIN_CC && process.env.ADMIN_CC.trim() !== ""
        ? process.env.ADMIN_CC.split(",")
        : [],
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

async function sendReturnApprovalEmail(returnReq) {
  const mail = {
    from: `"Mediko.ph" <${process.env.MAIL_FROM}>`,
    to: returnReq.email_address,
    subject: `Your return request #${returnReq.id} has been approved`,
    html: `
      <div style="font-family: sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #2c3e50;">Hello ${escapeHtml(returnReq.full_name)},</h2>
        <p>Good news — your return request for order <strong>${escapeHtml(returnReq.order_number)}</strong> has been <strong>approved</strong>.</p>
        <div style="background-color: #f0fdf4; border: 1px solid #16a34a; padding: 20px; border-radius: 8px; margin: 20px 0;">
          A Mediko representative will reach out shortly with shipping and refund instructions.
        </div>
        <p>Reference ID: #${returnReq.id}</p>
        <p>Thank you,<br><strong>Mediko.ph Team</strong></p>
      </div>
    `,
  };
  try {
    await transporter.sendMail(mail);
    log("info", "return_approval_email_sent", { id: returnReq.id });
  } catch (err) {
    log("error", "return_approval_email_failed", { id: returnReq.id, message: err.message });
  }
}

async function sendReturnRejectionEmail(returnReq, reason) {
  const reasonHtml = reason
    ? `<div style="background-color: #fef2f2; border: 1px solid #dc2626; padding: 15px; border-radius: 8px; margin: 20px 0;">
         <strong style="color: #991b1b;">Reason:</strong>
         <pre style="white-space: pre-wrap; font-family: inherit; margin: 8px 0 0 0; color: #7f1d1d;">${escapeHtml(reason)}</pre>
       </div>`
    : "";

  const mail = {
    from: `"Mediko.ph" <${process.env.MAIL_FROM}>`,
    to: returnReq.email_address,
    subject: `Update on your return request #${returnReq.id} — Mediko.ph`,
    html: `
      <div style="font-family: sans-serif; line-height: 1.6; color: #333;">
        <h2 style="color: #2c3e50;">Hello ${escapeHtml(returnReq.full_name)},</h2>
        <p>Thank you for submitting a return request for order <strong>${escapeHtml(returnReq.order_number)}</strong>.</p>
        <p>After reviewing your request, we are unable to approve this return at this time.</p>
        ${reasonHtml}
        <p>If you have questions or believe this was made in error, please reply to this email or contact our support team.</p>
        <p>Reference ID: #${returnReq.id}</p>
        <p>Thank you,<br><strong>Mediko.ph Team</strong></p>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mail);
    log("info", "return_rejection_email_sent", { id: returnReq.id });
  } catch (err) {
    log("error", "return_rejection_email_failed", { id: returnReq.id, message: err.message });
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
app.get("/api/submissions", (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }

    const token = authHeader.split(" ")[1];
    const secret =
      process.env.DASHBOARD_JWT_SECRET || "mediko-dashboard-secret-2026"; // ✅ SAME FALLBACK

    jwt.verify(token, secret);
    console.log("✅ JWT verified OK"); // DEBUG
  } catch (err) {
    console.log("❌ JWT ERROR:", err.message); // DEBUG
    return res.status(401).json({ error: "Invalid or expired token" });
  }

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
app.patch("/api/submissions/:id/status", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return res.status(401).json({ error: "Missing Bearer token" });
    }
    const token = authHeader.split(" ")[1];
    const secret =
      process.env.DASHBOARD_JWT_SECRET || "mediko-dashboard-secret-2026";
    jwt.verify(token, secret);
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  const id = parseInt(req.params.id, 10);
  const { status, reason } = req.body || {};
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

    // Approving a pending row: create the Shopify discount.
    if (status === "approved" && applicant.status !== "approved") {
      if (!DISCOUNT_AUTOGEN_ENABLED) {
        await queryAsync(
          `UPDATE applications
            SET status = 'approved', rejection_reason = NULL
            WHERE id = ?`,
          [id],
        );
        log("info", "submission_approved", {
          id,
          ip: req.ip,
          autogen: false,
        });
        return res.json({ success: true, id, status: "approved", code: null });
      }
      if (!shopifyConfigured()) {
        return res.status(503).json({
          error:
            "Shopify is not configured. Set SHOPIFY_SHOP_DOMAIN, plus either "
        + "SHOPIFY_ADMIN_TOKEN or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.",
        });
      }
      const { code, nodeGid } = await createDiscountForApplicant(applicant);
      await queryAsync(
        `UPDATE applications
          SET status = 'approved', discount_code = ?, discount_node_gid = ?, rejection_reason = NULL
          WHERE id = ?`,
        [code, nodeGid, id],
      );
      log("info", "submission_approved", { id, code, ip: req.ip });

      // Best-effort email; don't fail the request if it bounces.
      sendApprovalEmail(applicant, code);

      return res.json({ success: true, id, status: "approved", code });
    }

    const wasRejected = applicant.status === "rejected";

    // Reverting or rejecting a previously-approved row: delete the discount.
    if (status !== "approved" && applicant.discount_node_gid) {
      try {
        await deleteDiscount(applicant.discount_node_gid);
      } catch (e) {
        log("warn", "shopify_delete_failed", {
          id,
          nodeGid: applicant.discount_node_gid,
          message: e.message,
        });
      }
      await queryAsync(
        `UPDATE applications
           SET status = ?, discount_code = NULL, discount_node_gid = NULL, rejection_reason = ?
           WHERE id = ?`,
        [status, status === "rejected" ? trimmedReason : null, id],
      );
    } else {
      await queryAsync(
        "UPDATE applications SET status = ?, rejection_reason = ? WHERE id = ?",
        [status, status === "rejected" ? trimmedReason : null, id],
      );
    }

    if (status === "rejected" && !wasRejected) {
      sendRejectionEmail(applicant, trimmedReason);
    }

    log("info", "submission_status_updated", { id, status, ip: req.ip });
    res.json({ success: true, id, status });
  } catch (err) {
    log("error", "status_update_failed", {
      id,
      status,
      message: err.message,
    });
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/submissions/:id/discount-usage ───────────────────────────────
app.get("/api/submissions/:id/discount-usage", requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid id" });
  }

  try {
    const rows = await queryAsync(
      "SELECT discount_node_gid, discount_code FROM applications WHERE id = ?",
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    const { discount_node_gid, discount_code } = rows[0];
    if (!discount_node_gid) {
      return res.json({ used: false, usage_count: 0, code: null });
    }

    const data = await shopifyGraphQL(
      `query discountUsage($id: ID!) {
         codeDiscountNode(id: $id) {
           codeDiscount {
             ... on DiscountCodeBasic {
               asyncUsageCount
             }
           }
         }
       }`,
      { id: discount_node_gid },
    );

    const usageCount =
      data?.codeDiscountNode?.codeDiscount?.asyncUsageCount ?? 0;
    res.json({
      code: discount_code,
      usage_count: usageCount,
      used: usageCount >= 1,
    });
  } catch (err) {
    log("error", "discount_usage_check_failed", { id, message: err.message });
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

    const by = req.admin?.shopOrigin || "admin";
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

app.post('/api/auth/admin', express.json(), (req, res) => {
  const { password } = req.body;
  const adminPassword = process.env.ADMIN_DASHBOARD_PASSWORD;

  if (!adminPassword || password !== adminPassword) {
    return res.status(401).json({ error: 'Invalid password' });
  }

  const secret = process.env.DASHBOARD_JWT_SECRET || 'mediko-dashboard-secret-2026';
  const token = jwt.sign(
    { admin: true, exp: Math.floor(Date.now() / 1000) + 8 * 60 * 60 }, // 8h
    secret
  );

  res.json({ token });
});

// ── Shopify App Bridge Auth ───────────────────────────────────────────────────
app.post("/api/auth/shopify", express.json(), async (req, res) => {
  try {
    const { shopOrigin, sessionToken } = req.body;

    // ✅ Simple Shopify origin validation (no external verification needed)
    if (!shopOrigin?.endsWith(".myshopify.com") || !sessionToken) {
      return res.status(401).json({ error: "Invalid Shopify session" });
    }

    const secret =
      process.env.DASHBOARD_JWT_SECRET || "mediko-dashboard-secret-2026";

    // Generate short-lived JWT for dashboard
    const dashboardToken = jwt.sign(
      { shopOrigin, admin: true, exp: Math.floor(Date.now() / 1000) + 30 * 60 }, // 30min vs 60min
      secret,
    );

    console.log("✅ Token generated for:", shopOrigin);
    res.json({ token: dashboardToken });
  } catch (err) {
    console.error("Auth error:", err);
    res.status(401).json({ error: "Auth failed" });
  }
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

    if (status === "approved" && returnReq.status !== "approved") {
      sendReturnApprovalEmail(returnReq);
    }
    if (status === "rejected" && !wasRejected) {
      sendReturnRejectionEmail(returnReq, trimmedReason);
    }

    res.json({ success: true, id, status });
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
const BLAST_SEND_DELAY_MS = Math.max(0, parseInt(process.env.BLAST_SEND_DELAY_MS, 10) || 300);
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

        if (BLAST_SEND_DELAY_MS) {
          await new Promise((resolve) => setTimeout(resolve, BLAST_SEND_DELAY_MS));
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
    res.status(502).json({ error: `Mailer error: ${err.message}` });
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
        req.admin?.shopOrigin || "admin",
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

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  log("error", "unhandled_error", { message: err.message, path: req.path });
  res.status(500).json({ error: "An unexpected error occurred." });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => log("info", "server_started", { port: PORT }));

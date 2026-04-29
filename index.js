require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const multer = require("multer");
const nodemailer = require("nodemailer");
const path = require("path");
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

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        log("warn", "cors_blocked", { origin });
        callback(new Error("Not allowed by CORS Policy"));
      }
    },
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-api-key", "Authorization"],
    optionsSuccessStatus: 200,
  }),
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
    jwt.verify(token, secret);
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
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2024-10";
const DISCOUNT_PERCENTAGE = parseFloat(process.env.DISCOUNT_PERCENTAGE || "20");

function shopifyConfigured() {
  return Boolean(
    process.env.SHOPIFY_SHOP_DOMAIN && process.env.SHOPIFY_ADMIN_TOKEN,
  );
}

async function shopifyFetch(method, pathSuffix, body) {
  const url = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}${pathSuffix}`;
  const res = await fetch(url, {
    method,
    headers: {
      "X-Shopify-Access-Token": process.env.SHOPIFY_ADMIN_TOKEN,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 204) return null;

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* not JSON */
  }

  if (!res.ok) {
    const msg =
      (json && (json.errors || json.error)) || `Shopify ${res.status}`;
    const err = new Error(
      typeof msg === "string" ? msg : JSON.stringify(msg),
    );
    err.status = res.status;
    throw err;
  }
  return json;
}

async function findOrCreateShopifyCustomer(applicant) {
  const emailQuery = encodeURIComponent(`email:${applicant.email_address}`);
  const search = await shopifyFetch(
    "GET",
    `/customers/search.json?query=${emailQuery}`,
  );
  if (search?.customers?.length) {
    return search.customers[0].id;
  }

  const [firstName, ...rest] = (applicant.full_name || "").trim().split(/\s+/);
  const lastName = rest.join(" ") || firstName;

  const created = await shopifyFetch("POST", "/customers.json", {
    customer: {
      email: applicant.email_address,
      first_name: firstName,
      last_name: lastName,
      phone: applicant.contact_number,
      tags: "senior-pwd-discount",
      verified_email: true,
    },
  });
  return created.customer.id;
}

function generateDiscountCode(appId) {
  const rand = crypto.randomBytes(4).toString("hex").toUpperCase();
  return `MEDIKO-${appId}-${rand}`;
}

async function createDiscountForApplicant(applicant) {
  const customerId = await findOrCreateShopifyCustomer(applicant);

  const priceRule = await shopifyFetch("POST", "/price_rules.json", {
    price_rule: {
      title: `Mediko Senior/PWD - App #${applicant.id}`,
      target_type: "line_item",
      target_selection: "all",
      allocation_method: "across",
      value_type: "percentage",
      value: `-${DISCOUNT_PERCENTAGE}`,
      customer_selection: "prerequisite",
      prerequisite_customer_ids: [customerId],
      usage_limit: 1,
      once_per_customer: true,
      starts_at: new Date().toISOString(),
      combines_with: {
        product_discounts: true,
        order_discounts: true,
        shipping_discounts: true,
      },
    },
  });

  const code = generateDiscountCode(applicant.id);
  const codeRes = await shopifyFetch(
    "POST",
    `/price_rules/${priceRule.price_rule.id}/discount_codes.json`,
    { discount_code: { code } },
  );

  return {
    code,
    priceRuleId: priceRule.price_rule.id,
    discountCodeId: codeRes.discount_code.id,
  };
}

async function deleteDiscountPriceRule(priceRuleId) {
  await shopifyFetch("DELETE", `/price_rules/${priceRuleId}.json`);
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

          // Send emails in the background
          sendApplicationEmails(
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

      sendReturnEmails(
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
      if (!shopifyConfigured()) {
        return res.status(503).json({
          error:
            "Shopify is not configured. Set SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_TOKEN.",
        });
      }
      const { code, priceRuleId, discountCodeId } = await createDiscountForApplicant(applicant);
      await queryAsync(
        `UPDATE applications
          SET status = 'approved', discount_code = ?, discount_price_rule_id = ?, discount_code_id = ?, rejection_reason = NULL
          WHERE id = ?`,
        [code, priceRuleId, discountCodeId, id],
      );
      log("info", "submission_approved", { id, code, ip: req.ip });

      // Best-effort email; don't fail the request if it bounces.
      sendApprovalEmail(applicant, code);

      return res.json({ success: true, id, status: "approved", code });
    }

    const wasRejected = applicant.status === "rejected";

    // Reverting or rejecting a previously-approved row: delete the discount.
    if (status !== "approved" && applicant.discount_price_rule_id) {
      try {
        await deleteDiscountPriceRule(applicant.discount_price_rule_id);
      } catch (e) {
        log("warn", "shopify_delete_failed", {
          id,
          priceRuleId: applicant.discount_price_rule_id,
          message: e.message,
        });
      }
      await queryAsync(
        `UPDATE applications
           SET status = ?, discount_code = NULL, discount_price_rule_id = NULL, discount_price_rule_id = NULL, rejection_reason = ?
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
    res.status(502).json({ error: err.message });
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
      "SELECT discount_price_rule_id, discount_code_id, discount_code FROM applications WHERE id = ?",
      [id]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });

    const { discount_price_rule_id, discount_code_id, discount_code } = rows[0];
    if (!discount_price_rule_id || !discount_code_id) {
      return res.json({ used: false, usage_count: 0, code: null });
    }

    const data = await shopifyFetch(
      "GET",
      `/price_rules/${discount_price_rule_id}/discount_codes/${discount_code_id}.json`
    );

    const usageCount = data?.discount_code?.usage_count ?? 0;
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

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  log("error", "unhandled_error", { message: err.message, path: req.path });
  res.status(500).json({ error: "An unexpected error occurred." });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => log("info", "server_started", { port: PORT }));

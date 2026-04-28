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
    ensureStatusColumn();
  }
});

function ensureColumn(name, definition) {
  db.query(
    `SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'applications' AND COLUMN_NAME = ?`,
    [process.env.DB_NAME, name],
    (err, rows) => {
      if (err) {
        log("error", "migration_check_failed", { column: name, message: err.message });
        return;
      }
      if (rows[0].c > 0) return;
      db.query(`ALTER TABLE applications ADD COLUMN ${name} ${definition}`, (alterErr) => {
        if (alterErr) {
          log("error", "migration_failed", { column: name, message: alterErr.message });
        } else {
          log("info", "migration_applied", { column: name });
        }
      });
    },
  );
}

function ensureStatusColumn() {
  ensureColumn("status", "ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending'");
  ensureColumn("discount_code", "VARCHAR(64) NULL");
  ensureColumn("discount_price_rule_id", "BIGINT NULL");
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
      starts_at: new Date().toISOString(),
    },
  });

  const code = generateDiscountCode(applicant.id);
  await shopifyFetch(
    "POST",
    `/price_rules/${priceRule.price_rule.id}/discount_codes.json`,
    { discount_code: { code } },
  );

  return { code, priceRuleId: priceRule.price_rule.id };
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
    if (!formLoadedAt || now - formLoadedAt < 3000) {
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

    db.query(cooldownSql, [email_address, id_number], (err, rows) => {
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
const queryAsync = (sql, params) =>
  new Promise((resolve, reject) =>
    db.query(sql, params, (err, rows) => (err ? reject(err) : resolve(rows))),
  );

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
  const { status } = req.body || {};
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: "Invalid id" });
  }
  if (!["pending", "approved", "rejected"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
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
      const { code, priceRuleId } = await createDiscountForApplicant(applicant);
      await queryAsync(
        `UPDATE applications
           SET status = 'approved', discount_code = ?, discount_price_rule_id = ?
           WHERE id = ?`,
        [code, priceRuleId, id],
      );
      log("info", "submission_approved", { id, code, ip: req.ip });

      // Best-effort email; don't fail the request if it bounces.
      sendApprovalEmail(applicant, code);

      return res.json({ success: true, id, status: "approved", code });
    }

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
           SET status = ?, discount_code = NULL, discount_price_rule_id = NULL
           WHERE id = ?`,
        [status, id],
      );
    } else {
      await queryAsync("UPDATE applications SET status = ? WHERE id = ?", [
        status,
        id,
      ]);
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

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  log("error", "unhandled_error", { message: err.message, path: req.path });
  res.status(500).json({ error: "An unexpected error occurred." });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => log("info", "server_started", { port: PORT }));

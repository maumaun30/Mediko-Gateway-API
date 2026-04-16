require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const multer = require("multer");
const nodemailer = require("nodemailer");
const path = require("path");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

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
    })
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
    methods: ["GET", "POST"],
    optionsSuccessStatus: 200,
  })
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
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { error: "Too many attempts. Please try again after 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip,
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

// Helper: send email and log result (non-blocking — never fails the request)
async function sendApplicationEmails(application, photoPaths) {
  const { full_name, email_address, id_number, insertId } = application;

  // 1. Confirmation to the applicant
  const applicantMail = {
    from: `"Mediko.ph" <${process.env.MAIL_FROM}>`,
    to: email_address,
    subject: "We received your Senior/PWD discount application",
    html: `
      <p>Hi <strong>${full_name}</strong>,</p>
      <p>Thank you for submitting your Senior Citizen / PWD discount application.</p>
      <p><strong>Application ID:</strong> ${insertId}<br>
         <strong>ID Number on file:</strong> ${id_number}</p>
      <p>Our team will review your submission and get back to you within 3–5 business days.</p>
      <p>— Mediko.ph Team</p>
    `,
  };

  // 2. Internal alert to the admin
  const adminMail = {
    from: `"Mediko Gateway" <${process.env.MAIL_FROM}>`,
    to: process.env.ADMIN_EMAIL,
    cc: (process.env.ADMIN_CC && process.env.ADMIN_CC.trim() !== "") ? process.env.ADMIN_CC.split(',') : [],
    subject: `[Mediko] New application #${insertId} — ${full_name}`,
    html: `
      <h3>New discount application received</h3>
      <table>
        <tr><td><strong>App ID</strong></td><td>${insertId}</td></tr>
        <tr><td><strong>Name</strong></td><td>${full_name}</td></tr>
        <tr><td><strong>Email</strong></td><td>${email_address}</td></tr>
        <tr><td><strong>ID Number</strong></td><td>${id_number}</td></tr>
        <tr><td><strong>Photos</strong></td><td>${photoPaths || "none"}</td></tr>
      </table>
    `,
  };

  try {
    const [applicantInfo, adminInfo] = await Promise.all([
      transporter.sendMail(applicantMail),
      transporter.sendMail(adminMail),
    ]);
    log("info", "emails_sent", {
      appId: insertId,
      applicantMessageId: applicantInfo.messageId,
      adminMessageId: adminInfo.messageId,
    });
  } catch (err) {
    // Log but don't surface email errors to the applicant
    log("error", "email_send_failed", {
      appId: insertId,
      message: err.message,
    });
  }
}

// ── POST /api/apply ───────────────────────────────────────────────────────────
app.post("/api/apply", submitLimiter, upload.array("id_photos", 2), (req, res) => {
  const { full_name, birthday, contact_number, email_address, id_number } = req.body;
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
    return res.status(400).json({ error: "Invalid Philippine contact number." });
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
    AND created_at > NOW() - INTERVAL 10 MINUTE
    LIMIT 1
  `;

  db.query(cooldownSql, [email_address], (err, rows) => {
    if (err) {
      log("error", "db_cooldown_check_failed", { message: err.message });
      return res.status(500).json({ error: "Database error. Please try again." });
    }

    if (rows.length > 0) {
      log("warn", "cooldown_rejected", { email: email_address, ip: req.ip });
      return res.status(429).json({ error: "Please wait before submitting again." });
    }

    // 5. Insert
    const photoPaths = req.files.map((f) => f.path).join(",");

    const insertSql = `
      INSERT INTO applications
        (full_name, birthday, contact_number, email_address, id_number, id_photo_path)
      VALUES (?, ?, ?, ?, ?, ?)
    `;

    db.query(
      insertSql,
      [full_name.trim(), birthday, contact_number.trim(), email_address.trim(), id_number.trim(), photoPaths],
      (err, result) => {
        if (err) {
          log("error", "db_insert_failed", { message: err.message, email: email_address });
          return res.status(500).json({ error: "Failed to save application." });
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
          message: "Application submitted successfully! Please check your email for confirmation.",
          id: result.insertId,
        });

        // Send emails in the background
        sendApplicationEmails(
          { full_name, email_address, id_number, insertId: result.insertId },
          photoPaths
        );
      }
    );
  });
});

// ── GET /api/submissions ──────────────────────────────────────────────────────
const ADMIN_API_KEY = process.env.ADMIN_API_KEY;
if (!ADMIN_API_KEY) log("warn", "admin_api_key_not_set");

app.get("/api/submissions", (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (!ADMIN_API_KEY || apiKey !== ADMIN_API_KEY) {
    log("warn", "unauthorized_submissions_access", { ip: req.ip });
    return res.status(401).json({ error: "Unauthorized." });
  }

  const page   = Math.max(1, parseInt(req.query.page)  || 1);
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit) || 10));
  const offset = (page - 1) * limit;

  db.query("SELECT COUNT(*) AS total FROM applications", (countErr, countResult) => {
    if (countErr) {
      log("error", "db_count_failed", { message: countErr.message });
      return res.status(500).json({ error: countErr.message });
    }

    const totalItems = countResult[0].total;

    db.execute(
      "SELECT * FROM applications ORDER BY created_at DESC LIMIT ? OFFSET ?",
      [limit, offset],
      (err, results) => {
        if (err) {
          log("error", "db_select_failed", { message: err.message });
          return res.status(500).json({ error: err.message });
        }

        log("info", "submissions_listed", { page, limit, totalItems, ip: req.ip });

        res.status(200).json({
          metadata: {
            total_items: totalItems,
            total_pages: Math.ceil(totalItems / limit),
            current_page: page,
          },
          data: results,
        });
      }
    );
  });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  log("error", "unhandled_error", { message: err.message, path: req.path });
  res.status(500).json({ error: "An unexpected error occurred." });
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => log("info", "server_started", { port: PORT }));
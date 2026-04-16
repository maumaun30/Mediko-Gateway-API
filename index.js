require("dotenv").config();
const express = require("express");
const mysql = require("mysql2");
const multer = require("multer");
const nodemailer = require("nodemailer");
const path = require("path");
const cors = require("cors");
const rateLimit = require("express-rate-limit");

const app = express();

app.set('trust proxy', 1);

// --- SECURITY: CORS LOCKDOWN ---
const allowedOriginsEnv = process.env.ALLOWED_ORIGINS || "";
const allowedOrigins = allowedOriginsEnv
  .split(",")
  .filter((o) => o.trim() !== "");

const corsOptions = {
  origin: function (origin, callback) {
    // 1. Allow requests with no origin (like Postman or Mobile Apps)
    // 2. Check if the incoming origin is in our allowed list
    if (!origin || allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.error(
        `CORS Blocked: Request from ${origin} is not in ALLOWED_ORIGINS`,
      );
      callback(new Error("Not allowed by CORS Policy"));
    }
  },
  methods: ["GET", "POST"],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));
app.use(express.json({ limit: "1mb" }));

// --- SECURITY: RATE LIMITING ---
const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 3, // Limit each IP to 5 applications per window
  message: { error: "Too many attempts. Please try again after 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req, res) => req.ip,
});

// --- STORAGE CONFIG ---
const storage = multer.diskStorage({
  destination: "./uploads/",
  filename: (req, file, cb) => {
    cb(null, `ID-${Date.now()}${path.extname(file.originalname)}`);
  },
});

// File filter to ensure only images are uploaded
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed!"), false);
    }
  },
});

// --- DATABASE CONNECTION ---
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// --- MAILER CONFIG ---
const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  auth: {
    user: process.env.BREVO_USER,
    pass: process.env.BREVO_PASS,
  },
});

// --- POST ROUTE: RECEIVE APPLICATION ---
app.post(
  "/api/apply",
  submitLimiter,
  upload.array("id_photos", 2),
  (req, res) => {
    const { full_name, birthday, contact_number, email_address, id_number } =
      req.body;

    const now = Date.now();
    const formLoadedAt = parseInt(req.body.form_loaded_at, 10);

    // 1. VALIDATION FIRST
    if (!full_name || full_name.length < 3)
      return res.status(400).json({ error: "Invalid full name" });

    if (!/^\S+@\S+\.\S+$/.test(email_address))
      return res.status(400).json({ error: "Invalid email" });

    if (!/^[0-9+\- ]{7,15}$/.test(contact_number))
      return res.status(400).json({ error: "Invalid contact number" });

    // 2. TIME TRAP
    if (!formLoadedAt || now - formLoadedAt < 3000)
      return res.status(200).json({ success: true });

    // 3. HONEYPOT
    const dynamicHp = Object.keys(req.body).find((k) => k.startsWith("hp_"));
    if (dynamicHp && req.body[dynamicHp])
      return res.status(200).json({ success: true });

    // 4. COOLDOWN CHECK
    const cooldownSql = `
        SELECT id FROM applications
        WHERE email_address = ?
        AND created_at > NOW() - INTERVAL 10 MINUTE
        LIMIT 1
    `;

    db.query(cooldownSql, [email_address], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });

      if (rows.length > 0)
        return res
          .status(429)
          .json({ error: "Please wait before submitting again." });

      // 5. INSERT
      const photoPaths = req.files
        ? req.files.map((f) => f.path).join(",")
        : "";

      const sql = `
            INSERT INTO applications
            (full_name, birthday, contact_number, email_address, id_number, id_photo_path)
            VALUES (?, ?, ?, ?, ?, ?)
        `;

      db.query(
        sql,
        [
          full_name,
          birthday,
          contact_number,
          email_address,
          id_number,
          photoPaths,
        ],
        (err, result) => {
          if (err)
            return res
              .status(500)
              .json({ error: "Failed to save application." });

          res.json({
            success: true,
            message: "Application submitted successfully!",
            id: result.insertId,
          });
        },
      );
    });
  },
);

// --- GET ROUTE: LIST SUBMISSIONS ---
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || "super-secret-key";

app.get("/api/submissions", (req, res) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey !== ADMIN_API_KEY)
    return res.status(401).json({ error: "Unauthorized" });

  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  db.query(
    "SELECT COUNT(*) as total FROM applications",
    (countErr, countResult) => {
      if (countErr) return res.status(500).json({ error: countErr.message });

      const totalItems = countResult[0].total;
      const dataSql = `SELECT * FROM applications ORDER BY created_at DESC LIMIT ? OFFSET ?`;

      db.execute(
        dataSql,
        [limit.toString(), offset.toString()],
        (err, results) => {
          if (err) return res.status(500).json({ error: err.message });
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

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Mediko Gateway running on port ${PORT}`));

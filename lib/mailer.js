// Brevo SMTP transporter.
// Moved verbatim from index.js.
const nodemailer = require("nodemailer");
const { log } = require("./log");

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

module.exports = { transporter };

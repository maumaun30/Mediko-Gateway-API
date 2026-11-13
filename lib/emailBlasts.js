// Moved verbatim from index.js.
const crypto = require("crypto");
const { queryAsync } = require("./db");
const { escapeHtml } = require("./emailFormat");
const { log } = require("./log");
const { transporter } = require("./mailer");
const { getSetting } = require("./settings");

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

module.exports = { BLAST_COUNTS_SQL, BLAST_MAX_RECIPIENTS, BLAST_SOURCES, EMAIL_RE, buildBlastMail, ensureBlastTables, normalizeAudience, publicBaseUrl, resolveBlastAudience, runBlast, runningBlasts, unsubscribePage, unsubscribeToken, validUnsubscribeToken, validateBlastContent };

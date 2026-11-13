// Routes moved verbatim from index.js; registered at the same place in the middleware order.
const express = require("express");
const { requireAdmin } = require("../lib/auth");
const { queryAsync } = require("../lib/db");
const { BLAST_COUNTS_SQL, BLAST_MAX_RECIPIENTS, EMAIL_RE, buildBlastMail, normalizeAudience, publicBaseUrl, resolveBlastAudience, runBlast, runningBlasts, unsubscribePage, validUnsubscribeToken, validateBlastContent } = require("../lib/emailBlasts");
const { escapeHtml } = require("../lib/emailFormat");
const { log } = require("../lib/log");
const { transporter } = require("../lib/mailer");
const { adminName } = require("../lib/settings");

module.exports = function register(app) {
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
};

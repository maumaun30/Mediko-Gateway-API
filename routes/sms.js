// Routes moved verbatim from index.js; registered at the same place in the middleware order.
const { requireAdmin } = require("../lib/auth");
const { queryAsync } = require("../lib/db");
const { publicBaseUrl } = require("../lib/emailBlasts");
const { log } = require("../lib/log");
const { adminName } = require("../lib/settings");
const { setSetupFlag } = require("../lib/setup");
const { SMS_ACCOUNT_CACHE_MS, SMS_BLAST_COUNTS_SQL, SMS_BLAST_MAX_RECIPIENTS, _smsAccountCache, buildShippingSms, deliverShippingSms, fillSmsBlast, getSemaphoreAccount, getSmsConfig, normalizePhMobile, normalizeSmsAudience, parseId, resolveSmsAudience, runSmsBlast, runningSmsBlasts, sendSemaphoreSms, validateSmsBlastContent } = require("../lib/sms");

module.exports = function register(app) {
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
};

// Routes moved verbatim from index.js; registered at the same place in the middleware order.
const { requireAdmin } = require("../lib/auth");
const { queryAsync } = require("../lib/db");
const { inboxCounts } = require("../lib/inbox");
const { chatAlertRecipients, chatSecretOk } = require("../lib/liveChat");
const { log } = require("../lib/log");
const { notifyDecision, parseNotify } = require("../lib/notifications");
const { adminName } = require("../lib/settings");
const { SETUP_FLAGS, setSetupFlag } = require("../lib/setup");
const { getSmsConfig } = require("../lib/sms");

module.exports = function register(app) {
  app.get("/api/inbox/counts", requireAdmin, async (_req, res) => {
    try {
      res.json(await inboxCounts());
    } catch (err) {
      log("error", "inbox_counts_failed", { message: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.post("/api/setup", requireAdmin, async (req, res) => {
    const body = req.body || {};
    const map = {
      checkout_phone_done: "setup_checkout_phone_done", guide_dismissed: "setup_guide_dismissed",
      chat_embed_done: "setup_chat_embed_done", chat_guide_dismissed: "setup_chat_guide_dismissed",
    };
    const keys = Object.keys(body).filter((k) => map[k] && typeof body[k] === "boolean");
    if (!keys.length) return res.status(400).json({ error: "Nothing to update." });
    try {
      for (const k of keys) await setSetupFlag(map[k], body[k], adminName(req));
      res.json({ success: true });
    } catch (err) {
      log("error", "setup_flag_failed", { message: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/dashboard", requireAdmin, async (_req, res) => {
    try {
      const counts = await inboxCounts();
      const [sms7] = await queryAsync(
        `SELECT SUM(status = 'sent') AS sent, SUM(status = 'failed') AS failed
         FROM sms_notifications WHERE created_at >= NOW() - INTERVAL 7 DAY`,
      );
      const [smsToday] = await queryAsync(
        "SELECT COUNT(*) AS failed FROM sms_notifications WHERE status = 'failed' AND created_at >= CURDATE()",
      );
      const interrupted = [
        ...(await queryAsync(
          `SELECT b.id, b.subject AS title, b.total, 'email' AS kind,
                  (SELECT COUNT(*) FROM email_blast_recipients r WHERE r.blast_id = b.id AND r.status <> 'queued') AS done
           FROM email_blasts b WHERE b.status = 'interrupted' ORDER BY b.created_at DESC LIMIT 3`,
        )),
        ...(await queryAsync(
          `SELECT b.id, b.title, b.total, 'sms' AS kind,
                  (SELECT COUNT(*) FROM sms_blast_recipients r WHERE r.blast_id = b.id AND r.status <> 'queued') AS done
           FROM sms_blasts b WHERE b.status = 'interrupted' ORDER BY b.created_at DESC LIMIT 3`,
        )),
      ];
      const flagRows = await queryAsync(
        "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?)",
        [SETUP_FLAGS],
      );
      const flags = Object.fromEntries(flagRows.map((r) => [r.setting_key, r.setting_value === "true"]));
      const sms = getSmsConfig();
      res.json({
        counts,
        sms: {
          sent7d: Number(sms7?.sent || 0),
          failed7d: Number(sms7?.failed || 0),
          failedToday: Number(smsToday?.failed || 0),
          enabled: sms.enabled,
        },
        interrupted,
        setup: {
          apiKeySet: Boolean(sms.apiKey),
          webhookSecretSet: Boolean(process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET),
          senderName: sms.senderName,
          checkoutPhoneDone: Boolean(flags.setup_checkout_phone_done),
          testSmsSent: Boolean(flags.setup_test_sms_sent),
          dismissed: Boolean(flags.setup_guide_dismissed),
        },
        // Live chat setup. Counts come from the chat service (portal → /api/agent/stats).
        chat: {
          configured: chatSecretOk() && Boolean(process.env.CHAT_API_URL),
          recipientsSet: chatAlertRecipients().length > 0,
          embedDone: Boolean(flags.setup_chat_embed_done),
          dismissed: Boolean(flags.setup_chat_guide_dismissed),
        },
      });
    } catch (err) {
      log("error", "dashboard_failed", { message: err.message });
      res.status(500).json({ error: err.message });
    }
  });

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
    if (["pending", "approved", "rejected", "resolved"].includes(req.query.status)) {
      whereClauses.push("status = ?");
      whereParams.push(req.query.status);
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
    if (["pending", "approved", "rejected", "resolved"].includes(req.query.status)) {
      whereClauses.push("status = ?");
      whereParams.push(req.query.status);
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

  app.patch("/api/return-requests/:id/status", requireAdmin, async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { status, reason } = req.body || {};
    const notify = parseNotify(req.body);
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

      let notified = { email: false, sms: "off" };
      const decided =
        (status === "approved" && returnReq.status !== "approved")
        || (status === "rejected" && !wasRejected);
      if (decided) {
        notified = await notifyDecision("return", status, returnReq, status === "rejected" ? trimmedReason : "", notify);
      }

      res.json({ success: true, id, status, notified });
    } catch (err) {
      log("error", "return_status_update_failed", { id, message: err.message });
      res.status(500).json({ error: err.message });
    }
  });
};

// Routes moved verbatim from index.js; registered at the same place in the middleware order.
const { requireAdmin } = require("../lib/auth");
const { queryAsync } = require("../lib/db");
const { log } = require("../lib/log");
const { adminName } = require("../lib/settings");
const { toSmsText } = require("../lib/smsText");
const { DECISION_RECORDS, TEMPLATES, fillTemplate, getTemplate, loadTemplates, recordVars, validateTemplateInput } = require("../lib/templates");

module.exports = function register(app) {
  app.get("/api/templates", requireAdmin, (_req, res) => {
    res.json({
      templates: Object.entries(TEMPLATES).map(([key, def]) => {
        const t = getTemplate(key);
        return {
          key, group: def.group, name: def.name, channel: def.channel, vars: def.vars,
          subject: t.subject, body: t.body, saved: t.saved,
          defaultSubject: def.subject || null, defaultBody: def.body,
        };
      }),
    });
  });

  app.put("/api/templates", requireAdmin, async (req, res) => {
    const input = req.body && typeof req.body.templates === "object" ? req.body.templates : null;
    if (!input || !Object.keys(input).length) return res.status(400).json({ error: "Nothing to save." });
    const rows = [];
    const errors = [];
    for (const [key, val] of Object.entries(input)) {
      const def = TEMPLATES[key];
      if (!def) { errors.push(`${key}: unknown template`); continue; }
      const v = validateTemplateInput(def, val);
      if (v.error) errors.push(`${def.name}: ${v.error}`);
      else rows.push([key, v.subject, v.body]);
    }
    if (errors.length) return res.status(400).json({ error: errors.join("; ") });
    try {
      for (const [key, subject, body] of rows) {
        await queryAsync(
          `INSERT INTO message_templates (template_key, subject, body, updated_by) VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE subject = VALUES(subject), body = VALUES(body), updated_by = VALUES(updated_by)`,
          [key, subject, body, adminName(req)],
        );
      }
      await loadTemplates();
      log("info", "templates_saved", { keys: rows.map((r) => r[0]), ip: req.ip });
      res.json({ success: true });
    } catch (err) {
      log("error", "templates_save_failed", { message: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.delete("/api/templates/:key", requireAdmin, async (req, res) => {
    if (!TEMPLATES[req.params.key]) return res.status(404).json({ error: "Unknown template" });
    try {
      await queryAsync("DELETE FROM message_templates WHERE template_key = ?", [req.params.key]);
      await loadTemplates();
      log("info", "template_reset", { key: req.params.key, ip: req.ip });
      res.json({ success: true });
    } catch (err) {
      log("error", "template_reset_failed", { message: err.message });
      res.status(500).json({ error: err.message });
    }
  });

  app.get("/api/templates/fill/:kind/:id/:status", requireAdmin, async (req, res) => {
    const rec = DECISION_RECORDS[req.params.kind];
    const status = req.params.status;
    if (!rec || !["approved", "rejected"].includes(status)) return res.status(400).json({ error: "Invalid request" });
    const [table, kind] = rec;
    try {
      const rows = await queryAsync(`SELECT * FROM ${table} WHERE id = ?`, [parseInt(req.params.id, 10)]);
      if (!rows.length) return res.status(404).json({ error: "Not found" });
      const vars = recordVars(kind, rows[0]);
      const key = `${kind}_${status}`;
      const t = getTemplate(key);
      res.json({
        email: {
          subject: fillTemplate(t.subject, vars, ["reason"]).replace(/\s+/g, " ").trim(),
          body: fillTemplate(t.body, vars, ["reason"]).replace(/\n{3,}/g, "\n\n").trim(),
        },
        sms: toSmsText(fillTemplate(getTemplate(`${key}_sms`).body, vars).replace(/\s+/g, " ")),
      });
    } catch (err) {
      log("error", "template_fill_failed", { message: err.message });
      res.status(500).json({ error: err.message });
    }
  });
};

// Routes moved verbatim from index.js; registered at the same place in the middleware order.
const { requireAdmin } = require("../lib/auth");
const { queryAsync } = require("../lib/db");
const { log } = require("../lib/log");
const { SECRET_ENV_STATUS, SETTINGS, adminName, getSetting, loadSettings, settingSource, validateSetting } = require("../lib/settings");

module.exports = function register(app) {
  app.get("/api/settings", requireAdmin, (_req, res) => {
    res.json({
      settings: Object.entries(SETTINGS).map(([key, def]) => ({
        key,
        group: def.group,
        label: def.label,
        help: def.help,
        type: def.type,
        min: def.min,
        max: def.max,
        env: def.env,
        value: getSetting(key),
        source: settingSource(key),
      })),
      secrets: SECRET_ENV_STATUS.map(([name, label]) => ({ name, label, set: Boolean(process.env[name]) })),
    });
  });

  app.put("/api/settings", requireAdmin, async (req, res) => {
    const values = req.body && typeof req.body.values === "object" ? req.body.values : null;
    if (!values || !Object.keys(values).length) return res.status(400).json({ error: "Nothing to save." });

    const updates = [];
    const errors = [];
    for (const [key, input] of Object.entries(values)) {
      const def = SETTINGS[key];
      if (!def) {
        errors.push(`${key}: unknown setting`);
        continue;
      }
      const result = validateSetting(def, input);
      if (result.error) errors.push(`${def.label} ${result.error}`);
      else updates.push([key, result.value]);
    }
    if (errors.length) return res.status(400).json({ error: errors.join("; ") });

    try {
      for (const [key, value] of updates) {
        await queryAsync(
          `INSERT INTO app_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
           ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
          [key, value, adminName(req)],
        );
      }
      await loadSettings();
      log("info", "settings_saved", { keys: updates.map(([k]) => k), ip: req.ip });
      res.json({ success: true });
    } catch (err) {
      log("error", "settings_save_failed", { message: err.message });
      res.status(500).json({ error: err.message });
    }
  });
};

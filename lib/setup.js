// Moved verbatim from index.js.
const { queryAsync } = require("./db");

// Internal flags, not operator settings, so they live outside SETTINGS.
const SETUP_FLAGS = [
  "setup_checkout_phone_done", "setup_test_sms_sent", "setup_guide_dismissed",
  "setup_chat_embed_done", "setup_chat_guide_dismissed",
];

async function setSetupFlag(key, on, by) {
  await queryAsync(
    `INSERT INTO app_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
    [key, on ? "true" : "false", by],
  );
}

module.exports = { SETUP_FLAGS, setSetupFlag };

// Moved verbatim from index.js.
const crypto = require("crypto");
const { ensureColumnFor, queryAsync } = require("./db");
const { BLAST_SOURCES } = require("./emailBlasts");
const { log } = require("./log");
const { getSetting } = require("./settings");
const { shopifyConfigured, shopifyGraphQL } = require("./shopifyAdmin");
const { toSmsText } = require("./smsText");
const { renderSms } = require("./templates");
const path = require("path");

// Shopify fires fulfillments/create when an order ships. We verify the HMAC,
// claim the fulfillment in sms_notifications (unique key = no double texts on
// webhook retries), answer 200 right away, then text the customer through
// Semaphore. Outcome of every attempt is recorded on the row.
//
// The Semaphore API key is a secret, so it comes only from SEMAPHORE_API_KEY in
// .env. On/off and sender name are portal settings (see SETTINGS).
const SEMAPHORE_BASE = "https://api.semaphore.co/api/v4";

function getSmsConfig() {
  return {
    apiKey: process.env.SEMAPHORE_API_KEY || "",
    senderName: getSetting("sms_sender_name"),
    enabled: getSetting("sms_shipping_enabled"),
  };
}

function smsShippingEnabled() {
  const c = getSmsConfig();
  return c.enabled && Boolean(c.apiKey);
}

async function ensureSmsTable() {
  try {
    await queryAsync(
      `CREATE TABLE IF NOT EXISTS sms_notifications (
         id INT AUTO_INCREMENT PRIMARY KEY,
         fulfillment_id BIGINT NOT NULL,
         order_id BIGINT NULL,
         order_name VARCHAR(64) NULL,
         tracking_company VARCHAR(120) NULL,
         tracking_number VARCHAR(120) NULL,
         tracking_url TEXT NULL,
         phone VARCHAR(16) NULL,
         message TEXT NULL,
         status ENUM('queued','sent','failed','skipped') NOT NULL DEFAULT 'queued',
         provider_message_id VARCHAR(64) NULL,
         error TEXT NULL,
         attempts INT NOT NULL DEFAULT 0,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         sent_at DATETIME NULL,
         UNIQUE KEY uniq_sms_fulfillment (fulfillment_id),
         INDEX idx_sms_status (status),
         INDEX idx_sms_created (created_at)
       )`,
    );
    // Rows created before these columns existed (pre-portal version).
    ensureColumnFor("sms_notifications", "tracking_company", "VARCHAR(120) NULL");
    ensureColumnFor("sms_notifications", "tracking_number", "VARCHAR(120) NULL");
    ensureColumnFor("sms_notifications", "tracking_url", "TEXT NULL");
    ensureColumnFor("sms_notifications", "attempts", "INT NOT NULL DEFAULT 0");
    // An earlier build let the portal save the Semaphore key in the DB. Secrets
    // belong in .env only, so drop any copy that was saved. Only the secret and
    // the retired `sms_enabled` key: `sms_sender_name` is a live portal setting
    // (see SETTINGS), and deleting it here wiped it on every restart/deploy.
    await queryAsync("DELETE FROM app_settings WHERE setting_key IN ('sms_api_key', 'sms_enabled')");
    log("info", "migration_sms_tables_ready");
  } catch (err) {
    log("error", "migration_sms_tables_failed", { message: err.message });
  }
}

function verifyShopifyWebhook(rawBody, hmacHeader) {
  // App-config webhooks are signed with the app's client secret; webhooks
  // created in Shopify admin (Settings → Notifications) use their own key.
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET || process.env.SHOPIFY_CLIENT_SECRET;
  if (!secret || !hmacHeader || !Buffer.isBuffer(rawBody)) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest();
  const given = Buffer.from(String(hmacHeader), "base64");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Accepts 09XXXXXXXXX, +639XXXXXXXXX, 639XXXXXXXXX, 9XXXXXXXXX (with spaces,
// dashes, parens). Returns 639XXXXXXXXX or null for anything not a PH mobile.
function normalizePhMobile(raw) {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("09")) d = `63${d.slice(1)}`;
  else if (d.length === 10 && d.startsWith("9")) d = `63${d}`;
  return /^639\d{9}$/.test(d) ? d : null;
}

function buildShippingSms({ orderName, company, trackingNumber, trackingUrl }) {
  return renderSms("shipping_sms", {
    order: orderName, courier: company || "", tracking: trackingNumber || "", link: trackingUrl || "",
  });
}

async function lookupOrderPhone(orderId) {
  if (!shopifyConfigured() || !orderId) return null;
  const data = await shopifyGraphQL(
    `query OrderPhones($id: ID!) {
       order(id: $id) {
         name
         phone
         shippingAddress { phone }
         billingAddress { phone }
         customer { defaultPhoneNumber { phoneNumber } }
       }
     }`,
    { id: `gid://shopify/Order/${orderId}` },
  );
  const o = data && data.order;
  if (!o) return null;
  const candidates = [
    o.shippingAddress && o.shippingAddress.phone,
    o.phone,
    o.billingAddress && o.billingAddress.phone,
    o.customer && o.customer.defaultPhoneNumber && o.customer.defaultPhoneNumber.phoneNumber,
  ];
  for (const c of candidates) {
    const n = normalizePhMobile(c);
    if (n) return n;
  }
  return null;
}

async function semaphoreRequest(path, { method = "GET", params = {}, apiKey } = {}) {
  const body = new URLSearchParams({ apikey: apiKey || getSmsConfig().apiKey, ...params });
  const url = method === "GET" ? `${SEMAPHORE_BASE}${path}?${body}` : `${SEMAPHORE_BASE}${path}`;
  const res = await fetch(url, {
    method,
    headers: method === "GET" ? {} : { "Content-Type": "application/x-www-form-urlencoded" },
    body: method === "GET" ? undefined : body,
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok || json === null) {
    // Never echo the key back into logs or the UI.
    throw new Error(`Semaphore ${res.status}: ${text.slice(0, 300)}`);
  }
  return json;
}

async function sendSemaphoreSms(number, message) {
  const { senderName } = getSmsConfig();
  const params = { number, message };
  if (senderName) params.sendername = senderName;
  const json = await semaphoreRequest("/messages", { method: "POST", params });
  _smsAccountCache.at = 0; // balance changed
  // Success is an array of message objects; validation errors come back as an
  // object keyed by field (sometimes with a 200 status).
  if (!Array.isArray(json) || !json.length) {
    throw new Error(`Semaphore rejected the message: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return json[0];
}

async function getSemaphoreAccount(apiKey) {
  const json = await semaphoreRequest("/account", { apiKey });
  if (!json || json.credit_balance === undefined) {
    throw new Error(`Semaphore did not accept the API key: ${JSON.stringify(json).slice(0, 200)}`);
  }
  return json;
}

// Sends the text for one sms_notifications row and records the outcome.
// phoneOverride comes from an admin retry, for orders that had no usable number.
async function deliverShippingSms(fulfillmentId, { phoneOverride } = {}) {
  const rows = await queryAsync("SELECT * FROM sms_notifications WHERE fulfillment_id = ?", [fulfillmentId]);
  const row = rows[0];
  if (!row) throw new Error("Notification not found");
  await queryAsync("UPDATE sms_notifications SET attempts = attempts + 1 WHERE id = ?", [row.id]);

  try {
    let phone = phoneOverride || row.phone;
    if (!phone) phone = await lookupOrderPhone(row.order_id);
    if (!phone) {
      await queryAsync(
        "UPDATE sms_notifications SET status = 'skipped', error = 'No valid PH mobile number on the order' WHERE id = ?",
        [row.id],
      );
      log("warn", "sms_skipped_no_phone", { fulfillmentId, orderName: row.order_name });
      return { status: "skipped" };
    }

    const message = buildShippingSms({
      orderName: row.order_name,
      company: row.tracking_company,
      trackingNumber: row.tracking_number,
      trackingUrl: row.tracking_url,
    });
    const sent = await sendSemaphoreSms(phone, message);
    await queryAsync(
      "UPDATE sms_notifications SET status = 'sent', phone = ?, message = ?, provider_message_id = ?, error = NULL, sent_at = NOW() WHERE id = ?",
      [phone, message, sent.message_id ? String(sent.message_id) : null, row.id],
    );
    log("info", "sms_sent", { fulfillmentId, orderName: row.order_name, messageId: sent.message_id });
    return { status: "sent" };
  } catch (err) {
    log("error", "sms_send_failed", { fulfillmentId, orderName: row.order_name, message: err.message });
    await queryAsync("UPDATE sms_notifications SET status = 'failed', error = ? WHERE id = ?", [
      err.message.slice(0, 1000),
      row.id,
    ]).catch(() => {});
    return { status: "failed", error: err.message };
  }
}

async function handleFulfillmentCreateWebhook(req, res) {
  if (!verifyShopifyWebhook(req.body, req.get("X-Shopify-Hmac-Sha256"))) {
    log("warn", "sms_webhook_bad_hmac", { ip: req.ip });
    return res.status(401).send("Unauthorized");
  }
  if (req.get("X-Shopify-Topic") !== "fulfillments/create") return res.status(200).send("ignored");
  if (!smsShippingEnabled()) return res.status(200).send("sms disabled");

  let f;
  try {
    f = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).send("Bad JSON");
  }
  if (!f || !f.id) return res.status(400).send("Missing fulfillment id");

  // Third-party fulfillment services can create pending/failed fulfillments;
  // only a successful one means the parcel is actually on its way.
  if (f.status && f.status !== "success") {
    log("info", "sms_skipped_status", { fulfillmentId: f.id, status: f.status });
    return res.status(200).send("skipped");
  }

  const orderName = toSmsText(String(f.name || "").split(".")[0]) || `#${f.order_id}`;
  let claimed;
  try {
    const result = await queryAsync(
      `INSERT IGNORE INTO sms_notifications
         (fulfillment_id, order_id, order_name, tracking_company, tracking_number, tracking_url, phone)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        f.id,
        f.order_id || null,
        orderName,
        toSmsText(f.tracking_company).slice(0, 120) || null,
        toSmsText(f.tracking_number || (f.tracking_numbers || [])[0]).slice(0, 120) || null,
        f.tracking_url || (f.tracking_urls || [])[0] || null,
        normalizePhMobile(f.destination && f.destination.phone),
      ],
    );
    claimed = result.affectedRows === 1;
  } catch (err) {
    log("error", "sms_claim_failed", { fulfillmentId: f.id, message: err.message });
    // 500 lets Shopify retry later, once the DB is back.
    return res.status(500).send("DB error");
  }

  res.status(200).send("ok");
  if (!claimed) {
    log("info", "sms_duplicate_webhook", { fulfillmentId: f.id });
    return;
  }
  deliverShippingSms(f.id).catch((err) =>
    log("error", "sms_deliver_crashed", { fulfillmentId: f.id, message: err.message }),
  );
}

// Semaphore rate-limits /account hard, so the balance is cached briefly.
let _smsAccountCache = { key: null, at: 0, data: null };

const SMS_ACCOUNT_CACHE_MS = 60 * 1000;

// Same shape as email blasts: audience from the form tables (by status) plus
// pasted numbers, one row per recipient, sent one by one in-process, with
// resume/cancel. Numbers on sms_optouts are never texted. Promotional SMS needs
// the customer's consent (Data Privacy Act), so the opt-out list is the
// admin's tool for honouring "please stop" requests.
const SMS_BLAST_MAX_RECIPIENTS = 5000;

const SMS_BLAST_MAX_LEN = 459; // 3 concatenated SMS

const runningSmsBlasts = new Map();

async function ensureSmsBlastTables() {
  try {
    await queryAsync(
      `CREATE TABLE IF NOT EXISTS sms_blasts (
         id INT AUTO_INCREMENT PRIMARY KEY,
         title VARCHAR(120) NOT NULL,
         body TEXT NOT NULL,
         audience TEXT,
         status ENUM('sending','completed','interrupted','cancelled') NOT NULL DEFAULT 'sending',
         total INT NOT NULL DEFAULT 0,
         created_by VARCHAR(120) NULL,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
         finished_at DATETIME NULL,
         INDEX idx_sms_blasts_created (created_at)
       )`,
    );
    await queryAsync(
      `CREATE TABLE IF NOT EXISTS sms_blast_recipients (
         id INT AUTO_INCREMENT PRIMARY KEY,
         blast_id INT NOT NULL,
         phone VARCHAR(16) NOT NULL,
         full_name VARCHAR(255) NULL,
         status ENUM('queued','sent','failed','skipped') NOT NULL DEFAULT 'queued',
         provider_message_id VARCHAR(64) NULL,
         error TEXT NULL,
         sent_at DATETIME NULL,
         UNIQUE KEY uniq_sms_blast_phone (blast_id, phone),
         INDEX idx_sms_blast_status (blast_id, status)
       )`,
    );
    await queryAsync(
      `CREATE TABLE IF NOT EXISTS sms_optouts (
         phone VARCHAR(16) PRIMARY KEY,
         note VARCHAR(255) NULL,
         created_by VARCHAR(120) NULL,
         created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
       )`,
    );
    const result = await queryAsync("UPDATE sms_blasts SET status = 'interrupted' WHERE status = 'sending'");
    if (result.affectedRows) log("warn", "sms_blasts_interrupted_on_boot", { count: result.affectedRows });
    log("info", "migration_sms_blast_tables_ready");
  } catch (err) {
    log("error", "migration_sms_blast_tables_failed", { message: err.message });
  }
}

// Numbers are pasted one per line or comma/semicolon separated. Unlike email,
// spaces can't be separators: "0917 123 4567" is one number.
function normalizeSmsAudience(raw) {
  const input = raw && typeof raw === "object" ? raw : {};
  const audience = {};
  for (const [source, { statuses }] of Object.entries(BLAST_SOURCES)) {
    const picked = Array.isArray(input[source]) ? input[source] : [];
    audience[source] = [...new Set(picked.filter((s) => statuses.includes(s)))];
  }
  audience.extra = String(input.extra || "")
    .split(/[\n,;]+/)
    .map((e) => e.trim())
    .filter(Boolean);
  return audience;
}

async function resolveSmsAudience(audience) {
  const byPhone = new Map();
  const invalid = [];
  const add = (raw, fullName) => {
    const phone = normalizePhMobile(raw);
    if (!phone) {
      invalid.push(String(raw || "").trim());
      return;
    }
    if (!byPhone.has(phone)) byPhone.set(phone, { phone, full_name: fullName || null });
  };

  for (const [source, { table }] of Object.entries(BLAST_SOURCES)) {
    if (!audience[source].length) continue;
    const rows = await queryAsync(
      `SELECT contact_number, full_name FROM ${table} WHERE status IN (?) ORDER BY created_at DESC`,
      [audience[source]],
    );
    rows.forEach((r) => add(r.contact_number, r.full_name));
  }
  audience.extra.forEach((p) => add(p, null));

  let optedOut = 0;
  if (byPhone.size) {
    const rows = await queryAsync("SELECT phone FROM sms_optouts WHERE phone IN (?)", [[...byPhone.keys()]]);
    rows.forEach((r) => byPhone.delete(r.phone));
    optedOut = rows.length;
  }
  return { recipients: [...byPhone.values()], invalid, optedOut };
}

function fillSmsBlast(body, recipient) {
  const first = toSmsText(String(recipient.full_name || "").trim().split(/\s+/)[0]) || "there";
  return toSmsText(body.replace(/\{\{\s*name\s*\}\}/gi, first));
}

function validateSmsBlastContent(body) {
  const title = typeof body?.title === "string" ? body.title.trim() : "";
  // Strip non-GSM characters up front so the admin's preview matches what's sent.
  const text = typeof body?.body === "string" ? toSmsText(body.body.replace(/\r?\n/g, " ")) : "";
  if (title.length < 3 || title.length > 120) return { error: "Title must be 3–120 characters." };
  if (text.length < 5 || text.length > SMS_BLAST_MAX_LEN) {
    return { error: `Message must be 5–${SMS_BLAST_MAX_LEN} characters (up to 3 SMS).` };
  }
  // Semaphore silently drops messages that start with "TEST".
  if (/^test/i.test(text)) return { error: "Semaphore ignores messages starting with \"TEST\". Reword the start." };
  return { title, text };
}

async function runSmsBlast(blastId) {
  if (runningSmsBlasts.has(blastId)) return;
  const state = { cancelled: false };
  runningSmsBlasts.set(blastId, state);

  try {
    const [blast] = await queryAsync("SELECT * FROM sms_blasts WHERE id = ?", [blastId]);
    if (!blast) return;
    await queryAsync("UPDATE sms_blasts SET status = 'sending', finished_at = NULL WHERE id = ?", [blastId]);
    log("info", "sms_blast_started", { blastId, total: blast.total });

    while (!state.cancelled) {
      // Re-check opt-outs per batch so a number added mid-blast is honoured.
      const batch = await queryAsync(
        `SELECT r.id, r.phone, r.full_name, o.phone AS opted_out
         FROM sms_blast_recipients r
         LEFT JOIN sms_optouts o ON o.phone = r.phone
         WHERE r.blast_id = ? AND r.status = 'queued'
         ORDER BY r.id LIMIT 50`,
        [blastId],
      );
      if (!batch.length) break;

      for (const recipient of batch) {
        if (state.cancelled) break;
        if (recipient.opted_out) {
          await queryAsync(
            "UPDATE sms_blast_recipients SET status = 'skipped', error = 'opted out' WHERE id = ?",
            [recipient.id],
          );
          continue;
        }
        try {
          const sent = await sendSemaphoreSms(recipient.phone, fillSmsBlast(blast.body, recipient));
          await queryAsync(
            "UPDATE sms_blast_recipients SET status = 'sent', provider_message_id = ?, sent_at = NOW(), error = NULL WHERE id = ?",
            [sent.message_id ? String(sent.message_id) : null, recipient.id],
          );
        } catch (err) {
          log("warn", "sms_blast_recipient_failed", { blastId, recipientId: recipient.id, message: err.message });
          await queryAsync("UPDATE sms_blast_recipients SET status = 'failed', error = ? WHERE id = ?", [
            err.message.slice(0, 1000),
            recipient.id,
          ]);
        }
        const delayMs = getSetting("sms_blast_delay_ms");
        if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    if (state.cancelled) {
      await queryAsync(
        "UPDATE sms_blast_recipients SET status = 'skipped', error = 'cancelled' WHERE blast_id = ? AND status = 'queued'",
        [blastId],
      );
    }
    await queryAsync("UPDATE sms_blasts SET status = ?, finished_at = NOW() WHERE id = ?", [
      state.cancelled ? "cancelled" : "completed",
      blastId,
    ]);
    log("info", state.cancelled ? "sms_blast_cancelled" : "sms_blast_completed", { blastId });
  } catch (err) {
    log("error", "sms_blast_run_failed", { blastId, message: err.message });
    await queryAsync("UPDATE sms_blasts SET status = 'interrupted' WHERE id = ? AND status = 'sending'", [
      blastId,
    ]).catch(() => {});
  } finally {
    runningSmsBlasts.delete(blastId);
  }
}

const SMS_BLAST_COUNTS_SQL = `
  SELECT blast_id,
         SUM(status = 'queued') AS queued,
         SUM(status = 'sent') AS sent,
         SUM(status = 'failed') AS failed,
         SUM(status = 'skipped') AS skipped
  FROM sms_blast_recipients`;

function parseId(req, res) {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id) || id < 1) {
    res.status(400).json({ error: "Invalid id" });
    return null;
  }
  return id;
}

module.exports = { SEMAPHORE_BASE, SMS_ACCOUNT_CACHE_MS, SMS_BLAST_COUNTS_SQL, SMS_BLAST_MAX_LEN, SMS_BLAST_MAX_RECIPIENTS, _smsAccountCache, buildShippingSms, deliverShippingSms, ensureSmsBlastTables, ensureSmsTable, fillSmsBlast, getSemaphoreAccount, getSmsConfig, handleFulfillmentCreateWebhook, lookupOrderPhone, normalizePhMobile, normalizeSmsAudience, parseId, resolveSmsAudience, runSmsBlast, runningSmsBlasts, semaphoreRequest, sendSemaphoreSms, smsShippingEnabled, validateSmsBlastContent, verifyShopifyWebhook };

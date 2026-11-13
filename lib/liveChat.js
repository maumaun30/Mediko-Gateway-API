// Moved verbatim from index.js.
const { buildStaffAlertMail, chatDeepLink, createReplayGuard, maskId, validateChatEvent, verifyChatEventSignature } = require("./chat");
const { log } = require("./log");
const { transporter } = require("./mailer");
const { ORDER_FIELDS, normalizeOrderNumber, orderFromNode, orderNameQuery, orderStatusResult, publicOrderStatus, statusReply } = require("./orders");
const { getSetting } = require("./settings");
const { shopifyGraphQL } = require("./shopifyAdmin");
const { recordVars, sendTemplateEmail } = require("./templates");

const CHAT_SECRET_MIN = 32;

function chatSecretOk() {
  const s = process.env.CHAT_AGENT_SECRET;
  return typeof s === "string" && s.length >= CHAT_SECRET_MIN;
}

// Raw Admin API order nodes (contact fields included, for verification only).
async function fetchOrderNodes(q, first) {
  const data = await shopifyGraphQL(
    `query ChatOrders($q: String!, $first: Int!) {
       orders(first: $first, query: $q, sortKey: CREATED_AT, reverse: true) { nodes { ${ORDER_FIELDS} } }
     }`,
    { q, first },
  );
  return (data && data.orders && data.orders.nodes) || [];
}

const panelOrder = (n) => { const o = orderFromNode(n); return o && { ...o, state: publicOrderStatus(o).state, reply: statusReply(o) }; };

// Link preview for a store product URL the agent is about to send. Built from
// the Admin API (needs read_products); the storefront blocks server fetches.
function linkPreviewHosts() {
  return String(process.env.LINK_PREVIEW_HOSTS || "store.mediko.ph,mediko.ph")
    .split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

function chatAlertRecipients() {
  // Same parsing as admin_cc's email_list.
  return String(getSetting("chat_alert_recipients") || "")
    .split(",").map((e) => e.trim()).filter(Boolean);
}

async function processChatEvent(event) {
  const link = chatDeepLink(event.sessionId);
  if (event.type === "offline_reply") {
    if (!event.email) {
      log("info", "chat_reply_no_email", { sessionId: maskId(event.sessionId) });
      return;
    }
    await sendTemplateEmail(
      "chat_reply_customer",
      event.email,
      recordVars("chat", { full_name: event.name || "" }, { messages: event.messages.join("\n\n"), link: event.link }),
      undefined,
      { event: "offline_reply" },
    );
    return;
  }
  const to = chatAlertRecipients();
  if (!to.length) {
    log("warn", "chat_alert_no_recipients", { type: event.type });
    return;
  }
  const mail = buildStaffAlertMail(event, link);
  await transporter.sendMail({
    from: `"Mediko Gateway" <${process.env.MAIL_FROM}>`,
    to,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
  });
  log("info", "chat_alert_sent", { type: event.type, recipients: to.length });
}

// Raw-body HMAC check shared by the chat service's signed routes.
function signedChatBody(req) {
  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  if (!raw || !verifyChatEventSignature(raw, req.get("x-mediko-timestamp"), req.get("x-mediko-signature"), process.env.CHAT_AGENT_SECRET)) {
    return null;
  }
  try { return JSON.parse(raw.toString("utf8")); } catch { return undefined; }
}

// "Track my order" from the widget, relayed (and rate limited) by the chat
// service. Returns the status only when the email/mobile matches the order.
async function handleOrderStatus(req, res) {
  if (!chatSecretOk()) return res.status(503).json({ error: "Chat not configured" });
  const body = signedChatBody(req);
  if (body === null) {
    log("warn", "order_status_rejected", { ip: req.ip });
    return res.status(401).json({ error: "Unauthorized" });
  }
  const num = normalizeOrderNumber(body && body.order);
  const contact = body && typeof body.contact === "string" ? body.contact.trim() : "";
  if (!num || !contact || contact.length > 254) return res.status(400).json({ error: "Invalid request" });
  if (!process.env.SHOPIFY_SHOP_DOMAIN) return res.status(503).json({ error: "Shopify not configured" });
  try {
    const result = orderStatusResult(await fetchOrderNodes(orderNameQuery(num), 5), contact, num);
    log("info", "order_status_lookup", { found: result.found });
    res.json(result);
  } catch (err) {
    log("error", "order_status_failed", { message: err.message });
    res.status(500).json({ error: "Order lookup failed" });
  }
}

const chatEventReplays = createReplayGuard();

function handleChatEvent(req, res) {
  if (!chatSecretOk()) return res.status(503).json({ error: "Chat not configured" });
  const raw = Buffer.isBuffer(req.body) ? req.body : null;
  if (
    !raw ||
    !verifyChatEventSignature(
      raw,
      req.get("x-mediko-timestamp"),
      req.get("x-mediko-signature"),
      process.env.CHAT_AGENT_SECRET,
    )
  ) {
    log("warn", "chat_event_rejected", { ip: req.ip });
    return res.status(401).json({ error: "Unauthorized" });
  }
  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    event = null;
  }
  if (!validateChatEvent(event)) {
    return res.status(400).json({ error: "Invalid event" });
  }
  if (!chatEventReplays.firstTime(String(req.get("x-mediko-signature")))) {
    log("warn", "chat_event_replayed", { type: event.type });
    return res.status(202).json({ ok: true });
  }
  res.status(202).json({ ok: true });
  log("info", "chat_event_received", { type: event.type, sessionId: maskId(event.sessionId) });
  processChatEvent(event).catch((err) =>
    log("error", "chat_event_failed", { type: event.type, message: err.message }),
  );
}

module.exports = { CHAT_SECRET_MIN, chatAlertRecipients, chatEventReplays, chatSecretOk, fetchOrderNodes, handleChatEvent, handleOrderStatus, linkPreviewHosts, panelOrder, processChatEvent, signedChatBody };

// Moved verbatim from index.js.
const { queryAsync } = require("./db");
const { templateHtml } = require("./emailFormat");
const { log } = require("./log");
const { transporter } = require("./mailer");
const { toSmsText } = require("./smsText");

// Wording lives here as defaults and can be overridden from the portal's
// Templates page (message_templates table). Syntax:
//   {{var}}        replaced with the value
//   [[ ... ]]      optional part: dropped when any {{var}} inside it is empty
//   blank line     new paragraph (email); **bold** works in emails
// Everything is HTML-escaped before formatting, so templates can't inject markup.
const SIGNOFF = "Stay healthy!\n**Mediko.ph Team**";

const TEMPLATES = {
  application_received: {
    group: "Senior/PWD", name: "Application received", channel: "email",
    vars: ["name", "first_name", "id_number", "reference_id"],
    subject: "Application received — Mediko.ph",
    body: `Hello {{name}},

We have received your application for the Senior Citizen / PWD discount.

**What happens next?**
Please wait for a Mediko representative to reach out to you via email, SMS or call. Standard processing time is **3 to 5 business days**.

ID number: {{id_number}}
Reference ID: #{{reference_id}}

${SIGNOFF}`,
  },
  application_approved: {
    group: "Senior/PWD", name: "Application approved", channel: "email",
    vars: ["name", "first_name", "id_number", "reference_id"],
    subject: "Your Mediko.ph Senior/PWD application is approved",
    body: `Hello {{name}},

Good news — your Senior Citizen / PWD application on Mediko.ph has been **approved**.

If you have any questions, just reply to this email.

${SIGNOFF}`,
  },
  application_rejected: {
    group: "Senior/PWD", name: "Application rejected", channel: "email",
    vars: ["name", "first_name", "id_number", "reference_id", "reason"],
    subject: "Update on your Mediko.ph Senior/PWD application",
    body: `Hello {{name}},

Thank you for applying for the Senior Citizen / PWD discount on Mediko.ph.

After reviewing your submission, we are unable to approve your application at this time.
[[
**Reason:** {{reason}}
]]
If you believe this was a mistake or need help, please reply to this email and we'll be happy to assist.

Reference ID: #{{reference_id}}

${SIGNOFF}`,
  },
  application_approved_sms: {
    group: "Senior/PWD", name: "Application approved (SMS)", channel: "sms",
    vars: ["first_name", "reference_id"],
    body: "Mediko: Hi {{first_name}}, your Senior/PWD application is approved. Thank you for choosing Mediko.ph!",
  },
  application_rejected_sms: {
    group: "Senior/PWD", name: "Application rejected (SMS)", channel: "sms",
    vars: ["first_name", "reference_id"],
    body: "Mediko: Hi {{first_name}}, we couldn't approve your Senior/PWD application. Please check your email for details.",
  },
  return_received: {
    group: "Returns", name: "Return request received", channel: "email",
    vars: ["name", "first_name", "order", "items", "reference_id"],
    subject: "Return request received #{{reference_id}} — Mediko.ph",
    body: `Hello {{name}},

We've received your return request for order **{{order}}**.

**What happens next?**
A Mediko representative will review your request and reach out with next steps. Standard processing time is **3 to 5 business days**.

Reference ID: #{{reference_id}}
Order: {{order}}
Items: {{items}}

${SIGNOFF}`,
  },
  return_approved: {
    group: "Returns", name: "Return approved", channel: "email",
    vars: ["name", "first_name", "order", "items", "reference_id"],
    subject: "Your return request #{{reference_id}} has been approved",
    body: `Hello {{name}},

Good news — your return request for order **{{order}}** has been **approved**.

A Mediko representative will reach out shortly with shipping and refund instructions.

Reference ID: #{{reference_id}}

Thank you,
**Mediko.ph Team**`,
  },
  return_rejected: {
    group: "Returns", name: "Return rejected", channel: "email",
    vars: ["name", "first_name", "order", "items", "reference_id", "reason"],
    subject: "Update on your return request #{{reference_id}} — Mediko.ph",
    body: `Hello {{name}},

Thank you for submitting a return request for order **{{order}}**.

After reviewing your request, we are unable to approve this return at this time.
[[
**Reason:** {{reason}}
]]
If you have questions or believe this was made in error, please reply to this email.

Reference ID: #{{reference_id}}

Thank you,
**Mediko.ph Team**`,
  },
  return_approved_sms: {
    group: "Returns", name: "Return approved (SMS)", channel: "sms",
    vars: ["first_name", "order", "reference_id"],
    body: "Mediko: Hi {{first_name}}, your return request for order {{order}} is approved. We'll email you the next steps.",
  },
  return_rejected_sms: {
    group: "Returns", name: "Return rejected (SMS)", channel: "sms",
    vars: ["first_name", "order", "reference_id"],
    body: "Mediko: Hi {{first_name}}, your return request for order {{order}} wasn't approved. Please check your email for details.",
  },
  chat_reply_customer: {
    group: "Chat", name: "Chat reply (customer offline)", channel: "email",
    vars: ["name", "first_name", "messages", "link"],
    subject: "Sumagot na po ang Mediko Support",
    body: `Hello {{first_name}},

Sumagot na po ang Mediko Support sa inyong mensahe:

{{messages}}

Para magpatuloy sa chat, buksan po ito: {{link}}

${SIGNOFF}`,
  },
  contact_received: {
    group: "Messages", name: "Message received", channel: "email",
    vars: ["name", "first_name", "message", "reference_id"],
    subject: "We've received your message — Mediko.ph",
    body: `Hello {{name}},

Thanks for reaching out. We've received your message and a Mediko representative will get back to you within **1–2 business days**.

**Your message:**
{{message}}

Reference ID: #{{reference_id}}

${SIGNOFF}`,
  },
  shipping_sms: {
    group: "Shipping", name: "Order shipped (SMS)", channel: "sms",
    vars: ["order", "courier", "tracking", "link"],
    body: "Mediko: Your order {{order}} has shipped[[ via {{courier}}]].[[ Tracking no: {{tracking}}.]][[ Track: {{link}}]]",
  },
};

const TEMPLATE_LIMITS = { subject: 200, email: 10000, sms: 459 };

let templateCache = {}; // key → { subject, body } saved overrides

async function ensureTemplatesTable() {
  try {
    await queryAsync(
      `CREATE TABLE IF NOT EXISTS message_templates (
         template_key VARCHAR(64) PRIMARY KEY,
         subject TEXT NULL,
         body TEXT NOT NULL,
         updated_by VARCHAR(120) NULL,
         updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
       )`,
    );
    await loadTemplates();
    log("info", "migration_templates_table_ready", { saved: Object.keys(templateCache).length });
  } catch (err) {
    log("error", "migration_templates_table_failed", { message: err.message });
  }
}

async function loadTemplates() {
  const rows = await queryAsync("SELECT template_key, subject, body FROM message_templates");
  const next = {};
  for (const r of rows) if (TEMPLATES[r.template_key]) next[r.template_key] = { subject: r.subject, body: r.body };
  templateCache = next;
}

function getTemplate(key) {
  const def = TEMPLATES[key];
  const saved = templateCache[key];
  return {
    subject: def.channel === "email" ? (saved?.subject ?? def.subject) : null,
    body: saved?.body ?? def.body,
    saved: Boolean(saved),
  };
}

// Fills {{vars}} and resolves [[optional]] parts. `keep` lists vars to leave
// as placeholders (the confirm dialog fills {{reason}} only at send time).
function fillTemplate(text, vars, keep = []) {
  const val = (k) => (vars[k] == null ? "" : String(vars[k]));
  const withOptional = String(text || "").replace(/\[\[([\s\S]*?)\]\]/g, (_, seg) => {
    const names = [...seg.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]);
    return names.every((n) => keep.includes(n) || val(n).trim()) ? seg : "";
  });
  return withOptional.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (keep.includes(k) ? m : val(k)));
}

// Plain text → simple HTML email: lib/emailFormat.js (paragraphs, **bold**, clickable https links).

function renderEmail(key, vars, override = {}) {
  const t = getTemplate(key);
  const subject = fillTemplate(override.subject ?? t.subject, vars).replace(/\s+/g, " ").trim();
  const text = fillTemplate(override.body ?? t.body, vars).replace(/\n{3,}/g, "\n\n").trim();
  return { subject, text, html: templateHtml(text) };
}

// SMS: ASCII only. Shipping texts drop the tracking link rather than pay for
// a second credit; other texts may run to 3 parts (the editor shows the cost).
function renderSms(key, vars, override) {
  const body = override ?? getTemplate(key).body;
  let text = toSmsText(fillTemplate(body, vars).replace(/\s+/g, " "));
  if (key === "shipping_sms" && text.length > 160 && vars.link) {
    text = toSmsText(fillTemplate(body, { ...vars, link: "" }).replace(/\s+/g, " "));
  }
  return text.slice(0, TEMPLATE_LIMITS.sms);
}

async function sendTemplateEmail(key, to, vars, override, logCtx = {}) {
  const { subject, text, html } = renderEmail(key, vars, override);
  try {
    await transporter.sendMail({ from: `"Mediko.ph" <${process.env.MAIL_FROM}>`, to, subject, text, html });
    log("info", "template_email_sent", { template: key, ...logCtx });
    return true;
  } catch (err) {
    log("error", "template_email_failed", { template: key, ...logCtx, message: err.message });
    return false;
  }
}

// Variables available for each kind of record.
function recordVars(kind, row, extra = {}) {
  const full = String(row.full_name || "").trim();
  const base = {
    name: full,
    first_name: full.split(/\s+/)[0] || "there",
    reference_id: row.id,
  };
  if (kind === "application") Object.assign(base, { id_number: row.id_number });
  if (kind === "return") Object.assign(base, { order: row.order_number, items: row.items_to_return });
  if (kind === "contact") Object.assign(base, { message: row.message });
  if (kind === "chat") base.reference_id = "";
  return { ...base, ...extra };
}

function validateTemplateInput(def, input) {
  const body = typeof input?.body === "string" ? input.body.replace(/\r\n/g, "\n") : "";
  if (!body.trim()) return { error: "Message can't be empty." };
  const limit = def.channel === "sms" ? TEMPLATE_LIMITS.sms : TEMPLATE_LIMITS.email;
  if (body.length > limit) return { error: `Message is over ${limit} characters.` };
  if (def.channel === "email") {
    const subject = typeof input?.subject === "string" ? input.subject.trim() : "";
    if (!subject) return { error: "Subject can't be empty." };
    if (subject.length > TEMPLATE_LIMITS.subject) return { error: `Subject is over ${TEMPLATE_LIMITS.subject} characters.` };
    return { subject, body };
  }
  return { subject: null, body };
}

// Fills a decision template for one record, leaving {{reason}} for send time,
// so the confirm dialog can show (and let staff edit) the real wording.
const DECISION_RECORDS = { applications: ["applications", "application"], returns: ["return_requests", "return"] };

module.exports = { DECISION_RECORDS, SIGNOFF, TEMPLATES, TEMPLATE_LIMITS, ensureTemplatesTable, fillTemplate, getTemplate, loadTemplates, recordVars, renderEmail, renderSms, sendTemplateEmail, templateCache, validateTemplateInput };

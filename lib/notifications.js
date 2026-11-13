// Moved verbatim from index.js.
const { applicationAdminMail, contactAdminMail, returnAdminMail } = require("./adminEmail");
const { log } = require("./log");
const { transporter } = require("./mailer");
const { adminRecipients } = require("./settings");
const { getSmsConfig, normalizePhMobile, sendSemaphoreSms } = require("./sms");
const { toSmsText } = require("./smsText");
const { TEMPLATE_LIMITS, recordVars, renderEmail, renderSms, sendTemplateEmail } = require("./templates");
const path = require("path");

// Helper: send email and log result
async function sendApplicationEmails(application, reqFiles, metadataStr) {
  const {
    full_name,
    email_address,
    id_number,
    birthday,
    contact_number,
    insertId,
  } = application;

  let meta = {};
  try {
    // metadataStr must match what is passed in the call
    meta =
      typeof metadataStr === "string" ? JSON.parse(metadataStr) : metadataStr;
  } catch (e) {
    meta = { error: "Could not parse metadata" };
  }

  const attachments = reqFiles
    ? reqFiles.map((f) => ({
        filename: f.originalname,
        path: f.path,
      }))
    : [];

  const received = renderEmail("application_received", recordVars("application", { ...application, id: insertId }));
  const applicantMail = {
    from: `"Mediko.ph" <${process.env.MAIL_FROM}>`,
    to: email_address,
    subject: received.subject,
    text: received.text,
    html: received.html,
  };

  const adminMail = {
    from: `"Mediko Gateway" <${process.env.MAIL_FROM}>`,
    ...adminRecipients(),
    attachments,
    ...applicationAdminMail({ ...application, insertId }, meta, attachments.length),
  };


  try {
    await Promise.all([
      transporter.sendMail(applicantMail),
      transporter.sendMail(adminMail),
    ]);
    log("info", "emails_sent", { appId: insertId });
  } catch (err) {
    log("error", "email_send_failed", {
      appId: insertId,
      message: err.message,
    });
  }
}

function metaTable(meta) {
  return `
    <h4 style="margin-bottom: 5px; margin-top: 20px;">Technical Metadata:</h4>
    <table border="1" style="border-collapse: collapse; width: 100%; max-width: 600px; font-family: sans-serif; font-size: 12px; color: #555;">
      <tr><td style="padding: 6px; width: 150px;"><strong>IP Address</strong></td><td style="padding: 6px;">${meta.ip || "N/A"}</td></tr>
      <tr><td style="padding: 6px;"><strong>Origin</strong></td><td style="padding: 6px;">${meta.origin || "N/A"}</td></tr>
      <tr><td style="padding: 6px;"><strong>Browser Agent</strong></td><td style="padding: 6px;">${meta.user_agent || "N/A"}</td></tr>
      <tr><td style="padding: 6px;"><strong>Referer</strong></td><td style="padding: 6px;">${meta.referer || "N/A"}</td></tr>
    </table>
  `;
}

async function sendContactEmails(submission, metadataStr) {
  const { id, full_name, email_address, contact_number, message } = submission;
  let meta = {};
  try {
    meta = typeof metadataStr === "string" ? JSON.parse(metadataStr) : metadataStr || {};
  } catch {
    meta = {};
  }

  const received = renderEmail("contact_received", recordVars("contact", submission));
  const userMail = {
    from: `"Mediko.ph" <${process.env.MAIL_FROM}>`,
    to: email_address,
    subject: received.subject,
    text: received.text,
    html: received.html,
  };

  const adminMail = {
    from: `"Mediko Gateway" <${process.env.MAIL_FROM}>`,
    ...adminRecipients(),
    ...contactAdminMail({ ...submission, id }, meta),
  };


  try {
    await Promise.all([
      transporter.sendMail(userMail),
      transporter.sendMail(adminMail),
    ]);
    log("info", "contact_emails_sent", { id });
  } catch (err) {
    log("error", "contact_email_failed", { id, message: err.message });
  }
}

async function sendReturnEmails(returnReq, files, metadataStr) {
  const {
    id,
    full_name,
    email_address,
    contact_number,
    order_number,
    items_to_return,
    reason,
  } = returnReq;

  let meta = {};
  try {
    meta = typeof metadataStr === "string" ? JSON.parse(metadataStr) : metadataStr || {};
  } catch {
    meta = {};
  }

  const attachments = files
    ? files.map((f) => ({ filename: f.originalname, path: f.path }))
    : [];

  const received = renderEmail("return_received", recordVars("return", returnReq));
  const userMail = {
    from: `"Mediko.ph" <${process.env.MAIL_FROM}>`,
    to: email_address,
    subject: received.subject,
    text: received.text,
    html: received.html,
  };

  const adminMail = {
    from: `"Mediko Gateway" <${process.env.MAIL_FROM}>`,
    ...adminRecipients(),
    attachments,
    ...returnAdminMail({ ...returnReq, id }, meta, attachments.length),
  };


  try {
    await Promise.all([
      transporter.sendMail(userMail),
      transporter.sendMail(adminMail),
    ]);
    log("info", "return_emails_sent", { id });
  } catch (err) {
    log("error", "return_email_failed", { id, message: err.message });
  }
}

// The portal sends { notify: { email, sms, email_subject?, email_body?, sms_text? } }
// with each decision. Email defaults to on (the old behavior); SMS is opt-in
// because it costs a credit. Overrides are this-send-only edits of the
// template text (placeholders still work in them).
function parseNotify(body) {
  const n = body && typeof body.notify === "object" && body.notify ? body.notify : {};
  const str = (v, max) => (typeof v === "string" && v.trim() ? v.replace(/\r\n/g, "\n").slice(0, max) : undefined);
  return {
    email: n.email !== false,
    sms: n.sms === true,
    emailOverride: { subject: str(n.email_subject, TEMPLATE_LIMITS.subject), body: str(n.email_body, TEMPLATE_LIMITS.email) },
    smsOverride: str(n.sms_text, TEMPLATE_LIMITS.sms),
  };
}

// Sends the decision email/SMS for one record; returns { email, sms } as reported to the portal.
async function notifyDecision(kind, status, row, reason, notify) {
  const vars = recordVars(kind, row, { reason });
  const key = `${kind}_${status}`;
  const ctx = { id: row.id, kind };
  if (notify.email) sendTemplateEmail(key, row.email_address, vars, notify.emailOverride, ctx);
  const sms = notify.sms
    ? await sendDecisionSms(row.contact_number, renderSms(`${key}_sms`, vars, notify.smsOverride), ctx)
    : "off";
  return { email: notify.email, sms };
}

// Returns "sent", "skipped: <why>" or "failed: <why>". Never throws.
async function sendDecisionSms(phoneRaw, message, ctx) {
  if (!getSmsConfig().apiKey) return "skipped: no Semaphore API key on the server";
  const phone = normalizePhMobile(phoneRaw);
  if (!phone) return "skipped: not a valid PH mobile number";
  try {
    const text = toSmsText(message).slice(0, TEMPLATE_LIMITS.sms);
    const sent = await sendSemaphoreSms(phone, text);
    log("info", "decision_sms_sent", { ...ctx, messageId: sent.message_id });
    return "sent";
  } catch (err) {
    log("error", "decision_sms_failed", { ...ctx, message: err.message });
    return `failed: ${err.message}`;
  }
}

module.exports = { metaTable, notifyDecision, parseNotify, sendApplicationEmails, sendContactEmails, sendDecisionSms, sendReturnEmails };

// Admin notification emails (to the staff, not customers): one branded layout
// for new applications, contact messages, return requests and chat alerts.
// Email-safe markup: tables + inline styles only (Gmail/Outlook), PNG logo
// (SVG is blocked by most mail clients). Every value is escaped here.

const FONT = "-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif"
const MONO = "ui-monospace,Menlo,Consolas,monospace"
const C = { primary: '#187adc', accent: '#ffb73a', text: '#1a2e4a', body: '#475569', muted: '#6b85a3', faint: '#94a3b8', line: '#eef2f7', soft: '#f7faff', softLine: '#d0e4f7', page: '#f1f5f9' }
const BADGES = {
  pending: { bg: '#fff8e8', fg: '#92400e' },
  info: { bg: '#e8f3fd', fg: '#115fa8' },
  warning: { bg: '#fef3c7', fg: '#92400e' },
}

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** "**bold**" in an already-plain sentence → escaped HTML with <strong>. */
const richIntro = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
const plainIntro = (s) => String(s ?? '').replace(/\*\*(.+?)\*\*/g, '$1')

/** 639171234567 / +63 917… / 0917… → "0917 123 4567"; anything else unchanged. */
function fmtPhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '')
  if (d.startsWith('63')) d = '0' + d.slice(2)
  if (d.length === 10 && d.startsWith('9')) d = '0' + d
  return /^09\d{9}$/.test(d) ? `${d.slice(0, 4)} ${d.slice(4, 7)} ${d.slice(7)}` : String(raw ?? '')
}

function telHref(raw) {
  const d = fmtPhone(raw).replace(/\D/g, '')
  return /^09\d{9}$/.test(d) ? `tel:+63${d.slice(1)}` : null
}

/** Gateway page in the Shopify admin: SHOPIFY_ADMIN_APP_URL + /admin-dashboard/<path>. */
function gatewayLink(path, base = process.env.SHOPIFY_ADMIN_APP_URL) {
  const root = String(base || '').replace(/\/+$/, '').replace(/\/admin-dashboard$/, '')
  return `${root}/admin-dashboard/${String(path).replace(/^\/+/, '')}`
}

/** Public URL of the white PNG logo served from admin-portal/. */
function logoUrl() {
  const base = (process.env.PUBLIC_BASE_URL || 'https://mediko-gateway.quailshack.com').replace(/\/+$/, '')
  return `${base}/admin-dashboard/mediko-logo-email.png`
}

function fmtDate(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(raw ?? ''))
  if (!m) return String(raw ?? '')
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

const link = (href, text) => `<a href="${esc(href)}" style="color:${C.primary};text-decoration:none;">${esc(text)}</a>`

function rowValue({ value, kind }) {
  const v = value == null || value === '' ? '—' : value
  if (kind === 'email' && v !== '—') return link(`mailto:${v}`, v)
  if (kind === 'phone' && v !== '—') { const t = telHref(v); return t ? link(t, fmtPhone(v)) : esc(v) }
  return esc(v)
}

const META_LABELS = [['ip', 'IP address'], ['origin', 'Origin'], ['user_agent', 'Browser'], ['referer', 'Referrer']]

/**
 * @param {object} spec { preheader, eyebrow, title, intro ("**bold**" allowed), badge: { text, tone },
 *   rows: [{ label, value, kind: 'text'|'mono'|'email'|'phone' }], blocks: [{ label, text }],
 *   cta: { label, href }, secondary?: { label, href }, meta?: { ip, origin, user_agent, referer } }
 * @returns {{ html: string, text: string }}
 */
function renderAdminEmail(spec, { logoUrl: logo = logoUrl() } = {}) {
  const { preheader = '', eyebrow = '', title, intro = '', badge, rows = [], blocks = [], cta, secondary, meta } = spec
  const tone = badge && (BADGES[badge.tone] || BADGES.info)

  const rowHtml = (r) => `<tr>
    <td style="padding:9px 0;border-bottom:1px solid ${C.line};width:140px;vertical-align:top;font:600 13px/1.4 ${FONT};color:${C.muted};">${esc(r.label)}</td>
    <td style="padding:9px 0;border-bottom:1px solid ${C.line};vertical-align:top;font:${r.kind === 'mono' ? `500 13px/1.4 ${MONO}` : `400 14px/1.4 ${FONT}`};color:${C.text};word-break:break-word;">${rowValue(r)}</td></tr>`
  const blockHtml = (b) => `<tr><td colspan="2" style="padding:16px 0 0;">
    <div style="font:600 12px/1.4 ${FONT};color:${C.muted};text-transform:uppercase;letter-spacing:.04em;margin-bottom:6px;">${esc(b.label)}</div>
    <div style="background:${C.soft};border:1px solid ${C.softLine};border-radius:10px;padding:12px 14px;font:400 14px/1.55 ${FONT};color:${C.text};white-space:pre-wrap;word-break:break-word;">${esc(b.text)}</div></td></tr>`
  const metaHtml = meta ? META_LABELS.map(([k, label]) => `<tr>
    <td style="padding:2px 12px 2px 0;font:12px/1.5 ${FONT};color:${C.faint};white-space:nowrap;vertical-align:top;">${label}</td>
    <td style="padding:2px 0;font:12px/1.5 ${FONT};color:${C.faint};word-break:break-all;">${esc(meta[k] || 'N/A')}</td></tr>`).join('') : ''

  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:${C.page};">
<span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.page};padding:24px 12px;"><tr><td align="center">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:14px;overflow:hidden;">
    <tr><td style="background:${C.primary};padding:16px 24px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td><img src="${esc(logo)}" width="150" height="26" alt="Mediko.ph" style="display:block;border:0;outline:none;height:26px;width:150px;color:#ffffff;font:700 15px ${FONT};"></td>
        <td align="right" style="font:600 12px/1 ${FONT};color:#cfe4fb;">${esc(eyebrow)}</td>
      </tr></table></td></tr>
    <tr><td style="height:4px;background:${C.accent};font-size:0;line-height:0;">&nbsp;</td></tr>
    <tr><td style="padding:28px 24px 8px;">
      ${badge ? `<span style="display:inline-block;background:${tone.bg};color:${tone.fg};font:600 12px/1 ${FONT};padding:6px 10px;border-radius:999px;margin-bottom:12px;">${esc(badge.text)}</span>` : ''}
      <h1 style="margin:0 0 6px;font:700 21px/1.3 ${FONT};color:${C.text};">${esc(title)}</h1>
      <p style="margin:0;font:400 14px/1.55 ${FONT};color:${C.body};">${richIntro(intro)}</p>
    </td></tr>
    <tr><td style="padding:12px 24px 4px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${rows.map(rowHtml).join('')}${blocks.map(blockHtml).join('')}</table>
    </td></tr>
    ${cta ? `<tr><td style="padding:22px 24px 8px;">
      <a href="${esc(cta.href)}" style="display:inline-block;background:${C.primary};color:#ffffff;text-decoration:none;font:600 14px/1 ${FONT};padding:13px 20px;border-radius:10px;">${esc(cta.label)}</a>
      ${secondary ? `<a href="${esc(secondary.href)}" style="display:inline-block;margin-left:10px;color:${C.primary};text-decoration:none;font:600 14px/1 ${FONT};padding:13px 4px;">${esc(secondary.label)}</a>` : ''}
    </td></tr>` : ''}
    ${metaHtml ? `<tr><td style="padding:18px 24px 22px;"><div style="border-top:1px solid ${C.line};padding-top:14px;">
      <div style="font:600 11px/1.4 ${FONT};color:${C.faint};text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px;">Submission details</div>
      <table role="presentation" cellpadding="0" cellspacing="0">${metaHtml}</table></div></td></tr>` : '<tr><td style="height:16px;"></td></tr>'}
  </table>
  <div style="max-width:600px;padding:14px 8px 0;font:12px/1.5 ${FONT};color:${C.faint};text-align:center;">Sent by Mediko Gateway to the admin notification address. Change recipients in Gateway › Settings.</div>
</td></tr></table></body></html>`

  const textLines = [
    title, '', plainIntro(intro), '',
    ...rows.map((r) => `${r.label}: ${r.kind === 'phone' && r.value ? fmtPhone(r.value) : (r.value == null || r.value === '' ? '—' : r.value)}`),
    ...blocks.flatMap((b) => ['', `${b.label}:`, b.text]),
    ...(cta ? ['', `${cta.label}: ${cta.href}`] : []),
    ...(secondary ? [`${secondary.label}: ${secondary.href}`] : []),
    ...(meta ? ['', ...META_LABELS.map(([k, label]) => `${label}: ${meta[k] || 'N/A'}`)] : []),
  ]
  return { html, text: textLines.join('\n') }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
const PENDING = { text: 'Pending review', tone: 'pending' }

function applicationAdminMail(a, meta, attachmentCount, { base, logoUrl: logo } = {}) {
  const name = String(a.full_name ?? '')
  const { html, text } = renderAdminEmail({
    preheader: `${name} · ID ${a.id_number ?? ''} · review in Gateway`,
    eyebrow: 'Senior/PWD', title: 'New Senior/PWD application', badge: PENDING,
    intro: `**${name}** applied for the Senior Citizen / PWD discount.${attachmentCount ? ' The ID photo is attached.' : ''}`,
    rows: [
      { label: 'Application', value: `#${a.insertId}`, kind: 'mono' }, { label: 'Name', value: name },
      { label: 'Birthday', value: fmtDate(a.birthday) }, { label: 'Mobile', value: a.contact_number, kind: 'phone' },
      { label: 'Email', value: a.email_address, kind: 'email' }, { label: 'ID number', value: a.id_number, kind: 'mono' },
      { label: 'Attachments', value: attachmentCount ? plural(attachmentCount, 'image (ID photo)', 'images') : 'None' },
    ],
    cta: { label: 'Review application', href: gatewayLink(`applications/${a.insertId}`, base) }, meta,
  }, logo ? { logoUrl: logo } : undefined)
  return { subject: `[Mediko] New application #${a.insertId} — ${name}`, html, text }
}

function contactAdminMail(s, meta, { base, logoUrl: logo } = {}) {
  const name = String(s.full_name ?? '')
  const msg = String(s.message ?? '')
  const { html, text } = renderAdminEmail({
    preheader: `${name}: ${msg.replace(/\s+/g, ' ').slice(0, 90)}`,
    eyebrow: 'Messages', title: 'New contact message',
    intro: `**${name}** sent a message from the contact form.`,
    rows: [
      { label: 'Message', value: `#${s.id}`, kind: 'mono' }, { label: 'Name', value: name },
      { label: 'Email', value: s.email_address, kind: 'email' }, { label: 'Mobile', value: s.contact_number, kind: 'phone' },
    ],
    blocks: [{ label: 'Message', text: msg }],
    cta: { label: 'Open message', href: gatewayLink(`requests/messages/${s.id}`, base) },
    secondary: s.email_address ? { label: 'Reply by email', href: `mailto:${s.email_address}` } : null, meta,
  }, logo ? { logoUrl: logo } : undefined)
  return { subject: `[Mediko] New contact message #${s.id} — ${name}`, html, text }
}

function returnAdminMail(r, meta, attachmentCount, { base, logoUrl: logo } = {}) {
  const name = String(r.full_name ?? '')
  const photos = attachmentCount ? ` ${plural(attachmentCount, 'photo is', 'photos are')} attached.` : ''
  const { html, text } = renderAdminEmail({
    preheader: `${name} · order ${r.order_number ?? ''}${attachmentCount ? ` · ${plural(attachmentCount, 'photo', 'photos')}` : ''}`,
    eyebrow: 'Returns', title: 'New return request', badge: PENDING,
    intro: `**${name}** requested a return for order **${r.order_number ?? ''}**.${photos}`,
    rows: [
      { label: 'Request', value: `#${r.id}`, kind: 'mono' }, { label: 'Order', value: r.order_number, kind: 'mono' },
      { label: 'Name', value: name }, { label: 'Email', value: r.email_address, kind: 'email' },
      { label: 'Mobile', value: r.contact_number, kind: 'phone' },
      { label: 'Attachments', value: attachmentCount ? plural(attachmentCount, 'image', 'images') : 'None' },
    ],
    blocks: [{ label: 'Items', text: r.items_to_return }, { label: 'Reason', text: r.reason }],
    cta: { label: 'Review return', href: gatewayLink(`requests/returns/${r.id}`, base) }, meta,
  }, logo ? { logoUrl: logo } : undefined)
  return { subject: `[Mediko] New return request #${r.id} — ${name}`, html, text }
}

module.exports = { renderAdminEmail, gatewayLink, fmtPhone, logoUrl, applicationAdminMail, contactAdminMail, returnAdminMail }

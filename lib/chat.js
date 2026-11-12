const crypto = require('crypto')

const WINDOW_MS = 5 * 60 * 1000
const EVENT_TYPES = ['new_conversation', 'unanswered', 'offline_reply']

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function verifyChatEventSignature(rawBody, timestamp, signature, secret, now = Date.now()) {
  if (typeof secret !== 'string' || secret.length < 32) return false
  if (typeof timestamp !== 'string' || !/^\d{1,16}$/.test(timestamp)) return false
  if (typeof signature !== 'string' || !/^[0-9a-f]{64}$/i.test(signature)) return false
  if (Math.abs(now - Number(timestamp)) > WINDOW_MS) return false
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''))
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest()
  const given = Buffer.from(signature, 'hex')
  return given.length === expected.length && crypto.timingSafeEqual(given, expected)
}

// Shopify loads <app URL origin> + the path after the app handle, and the portal
// lives under /admin-dashboard, so the link must include it.
function chatDeepLink(sessionId, base = process.env.SHOPIFY_ADMIN_APP_URL) {
  const root = String(base || '').replace(/\/+$/, '').replace(/\/admin-dashboard$/, '')
  return `${root}/admin-dashboard/chats/${encodeURIComponent(sessionId)}`
}

const CHAT_PATH_RE = /^\/chats(?:\/([0-9a-f-]{36}))?\/?$/

// Alert emails sent before the fix linked to /chats/<id>. Map them to the
// portal page, keeping Shopify's query (host, embedded, id_token…). Null = not ours.
function legacyChatRedirect(path, search = '') {
  const m = CHAT_PATH_RE.exec(String(path || ''))
  if (!m) return null
  return `/admin-dashboard/chats${m[1] ? `/${m[1]}` : ''}${search || ''}`
}

const SUBJECT_NAME_MAX = 60
// C0/C1 controls, zero-width and bidi override/isolate characters.
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g

/** Customer-typed name, safe for a mail subject: no control/bidi chars, at most 60 chars. */
function subjectName(name) {
  const clean = String(name || '').replace(UNSAFE_CHARS, ' ').replace(/\s+/g, ' ').trim()
  if (!clean) return 'Unknown visitor'
  const chars = Array.from(clean)
  return chars.length > SUBJECT_NAME_MAX ? `${chars.slice(0, SUBJECT_NAME_MAX - 1).join('').trimEnd()}…` : clean
}

/** Session ids are bearer credentials for the widget: log only a short prefix. */
function maskId(id) {
  if (!id) return id
  const s = String(id)
  return s.length <= 8 ? '…' : `${s.slice(0, 8)}…`
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
/** Request path for logs, with UUIDs (chat session ids) masked. */
function redactPath(path) {
  return typeof path === 'string' ? path.replace(UUID_RE, ':id') : path
}

function buildStaffAlertMail(event, link) {
  const name = String(event.name || '').replace(UNSAFE_CHARS, ' ').trim() || 'Unknown visitor'
  const email = event.email || '—'
  const phone = event.phone || '—'
  const subject = `${event.type === 'unanswered' ? 'Unanswered chat' : 'New chat'} from ${subjectName(event.name)}`
  const text = String(event.text || '').slice(0, 300)
  const textBody = [
    `Name: ${name}`, `Email: ${email}`, `Phone: ${phone}`, '',
    text, '', `Open in Gateway: ${link}`,
  ].join('\n')
  const html = `<p><strong>Name:</strong> ${escapeHtml(name)}<br>
<strong>Email:</strong> ${escapeHtml(email)}<br>
<strong>Phone:</strong> ${escapeHtml(phone)}</p>
<blockquote>${escapeHtml(text).replace(/\n/g, '<br>')}</blockquote>
<p><a href="${escapeHtml(link)}">Open in Gateway</a></p>`
  return { subject, text: textBody, html }
}

const isStr = (v, max) => typeof v === 'string' && v.length <= max
// Legacy anonymous sessions have null/missing name, email and phone.
const isOptStr = (v, max) => v == null || isStr(v, max)

function validateChatEvent(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false
  if (!EVENT_TYPES.includes(e.type)) return false
  if (!(typeof e.sessionId === 'string' && e.sessionId.length > 0 && e.sessionId.length <= 200)) return false
  if (!isOptStr(e.name, 200) || !isOptStr(e.email, 254)) return false
  if (e.type === 'offline_reply') {
    if (e.email != null && e.email !== '' && !/^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/.test(e.email)) return false
    if (!Array.isArray(e.messages) || e.messages.length === 0 || e.messages.length > 50) return false
    if (!e.messages.every((m) => isStr(m, 2000))) return false
    if (!isStr(e.link, 2000) || !e.link.startsWith('https://')) return false
    return true
  }
  return isOptStr(e.phone, 50) && isStr(e.text, 5000)
}

// ── Link previews for agent replies ─────────────────────────────────────────
// Store product links only: the preview comes from the Admin API (the storefront
// answers 429 to server fetches), and the chat service re-validates it.
const HANDLE_RE = /^[a-z0-9][a-z0-9-]*$/i

function productHandleFromUrl(raw, hosts) {
  let u
  try { u = new URL(String(raw)) } catch { return null }
  if (u.protocol !== 'https:' || !hosts.includes(u.host.toLowerCase())) return null
  const m = /\/products\/([^/?#]+)\/?$/.exec(u.pathname)
  return m && HANDLE_RE.test(m[1]) ? m[1] : null
}

function clip(s, max) {
  const t = typeof s === 'string' ? s.trim() : ''
  return t ? t.slice(0, max) : null
}

function productToPreview(p, url) {
  if (!p || p.status !== 'ACTIVE' || !p.title) return null
  const img = p.featuredMedia && p.featuredMedia.preview && p.featuredMedia.preview.image && p.featuredMedia.preview.image.url
  const min = p.priceRangeV2 && p.priceRangeV2.minVariantPrice
  const amount = min ? Number(min.amount) : NaN
  return {
    url,
    title: clip(p.title, 200),
    description: clip(p.description, 300),
    image: typeof img === 'string' && img.startsWith('https://cdn.shopify.com/') ? img : null,
    price: Number.isFinite(amount) ? amount.toFixed(2) : null,
    currency: min && /^[A-Z]{3}$/.test(min.currencyCode) ? min.currencyCode : null,
  }
}

module.exports = {
  productHandleFromUrl, productToPreview,
  legacyChatRedirect, verifyChatEventSignature, chatDeepLink, buildStaffAlertMail, validateChatEvent, subjectName, maskId, redactPath }

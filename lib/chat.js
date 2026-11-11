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

function chatDeepLink(sessionId, base = process.env.SHOPIFY_ADMIN_APP_URL) {
  return `${String(base || '').replace(/\/$/, '')}/chats/${encodeURIComponent(sessionId)}`
}

function buildStaffAlertMail(event, link) {
  const name = String(event.name || '')
  const subject = `${event.type === 'unanswered' ? 'Unanswered chat' : 'New chat'} from ${name}`.replace(/[\r\n]+/g, ' ')
  const text = String(event.text || '').slice(0, 300)
  const textBody = [
    `Name: ${name}`, `Email: ${event.email || ''}`, `Phone: ${event.phone || ''}`, '',
    text, '', `Open in Gateway: ${link}`,
  ].join('\n')
  const html = `<p><strong>Name:</strong> ${escapeHtml(name)}<br>
<strong>Email:</strong> ${escapeHtml(event.email)}<br>
<strong>Phone:</strong> ${escapeHtml(event.phone)}</p>
<blockquote>${escapeHtml(text).replace(/\n/g, '<br>')}</blockquote>
<p><a href="${escapeHtml(link)}">Open in Gateway</a></p>`
  return { subject, text: textBody, html }
}

const isStr = (v, max) => typeof v === 'string' && v.length <= max

function validateChatEvent(e) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return false
  if (!EVENT_TYPES.includes(e.type)) return false
  if (!(typeof e.sessionId === 'string' && e.sessionId.length > 0 && e.sessionId.length <= 200)) return false
  if (!isStr(e.name, 200) || !isStr(e.email, 254)) return false
  if (e.type === 'offline_reply') {
    if (!/^[^\s@,]+@[^\s@,]+\.[^\s@,]{2,}$/.test(e.email)) return false
    if (!Array.isArray(e.messages) || e.messages.length === 0 || e.messages.length > 50) return false
    if (!e.messages.every((m) => isStr(m, 2000))) return false
    if (!isStr(e.link, 2000) || !e.link.startsWith('https://')) return false
    return true
  }
  return isStr(e.phone, 50) && isStr(e.text, 5000)
}

module.exports = { verifyChatEventSignature, chatDeepLink, buildStaffAlertMail, validateChatEvent }

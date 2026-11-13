// Small pure helpers for Admin API responses.

/**
 * True when Shopify refused a field for lack of scope. A minted (client
 * credentials) token keeps the scopes granted when it was issued, so after
 * the merchant approves a new scope the cached token must be replaced.
 */
function isAccessDenied(json) {
  const errors = json && Array.isArray(json.errors) ? json.errors : []
  return errors.some((e) =>
    (e && e.extensions && e.extensions.code === 'ACCESS_DENIED') || /access denied/i.test(String(e && e.message)))
}

const crypto = require('crypto')

/**
 * Shopify app proxy request (storefront /apps/... forwarded to us). Shopify signs
 * the query: params minus `signature`, sorted by key, "key=value" with array
 * values joined by ",", concatenated, hex HMAC-SHA256 with the app's client
 * secret. `logged_in_customer_id` is set when a customer is logged in, so it can
 * be trusted only after this check. Timestamps older than 5 minutes are refused.
 * @returns {{ ok: true, shop: string, customerId: string|null } | { ok: false }}
 */
function verifyAppProxy(query, secret, now = Date.now()) {
  const q = query || {}
  if (!secret || typeof q.signature !== 'string' || !/^[0-9a-f]{64}$/i.test(q.signature)) return { ok: false }
  const msg = Object.keys(q).filter((k) => k !== 'signature').sort()
    .map((k) => `${k}=${[].concat(q[k]).join(',')}`).join('')
  const want = crypto.createHmac('sha256', secret).update(msg).digest('hex')
  const a = Buffer.from(want, 'hex'), b = Buffer.from(q.signature, 'hex')
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false }
  const ts = Number(q.timestamp)
  if (!Number.isFinite(ts) || Math.abs(now / 1000 - ts) > 300) return { ok: false }
  const id = String(q.logged_in_customer_id || '')
  return { ok: true, shop: String(q.shop || ''), customerId: /^\d+$/.test(id) ? id : null }
}

module.exports = { isAccessDenied, verifyAppProxy }

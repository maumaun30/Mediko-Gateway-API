const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const { verifyAppProxy } = require('../lib/shopify')

const SECRET = 'hush'
// Shopify app proxy: sort params (minus signature) by key, "key=value" (arrays joined
// with ","), concatenate with no separator, hex HMAC-SHA256 with the app secret.
function sign(params) {
  const msg = Object.keys(params).sort().map((k) => `${k}=${[].concat(params[k]).join(',')}`).join('')
  return crypto.createHmac('sha256', SECRET).update(msg).digest('hex')
}

test('verifyAppProxy accepts a correctly signed request and returns the customer id', () => {
  const now = 1_800_000_000
  const p = { shop: 'fic0hr-kz.myshopify.com', logged_in_customer_id: '7001', path_prefix: '/apps/mediko', timestamp: String(now) }
  assert.deepEqual(verifyAppProxy({ ...p, signature: sign(p) }, SECRET, now * 1000), { ok: true, shop: p.shop, customerId: '7001' })
})

test('verifyAppProxy: logged-out request is valid with customerId null', () => {
  const now = 1_800_000_000
  const p = { shop: 's.myshopify.com', logged_in_customer_id: '', path_prefix: '/apps/mediko', timestamp: String(now) }
  assert.deepEqual(verifyAppProxy({ ...p, signature: sign(p) }, SECRET, now * 1000), { ok: true, shop: p.shop, customerId: null })
})

test('verifyAppProxy rejects tampering, stale timestamps and missing signatures', () => {
  const now = 1_800_000_000
  const p = { shop: 's.myshopify.com', logged_in_customer_id: '7001', path_prefix: '/apps/mediko', timestamp: String(now) }
  const sig = sign(p)
  assert.equal(verifyAppProxy({ ...p, logged_in_customer_id: '7002', signature: sig }, SECRET, now * 1000).ok, false)
  assert.equal(verifyAppProxy({ ...p, signature: sig }, SECRET, (now + 600) * 1000).ok, false)
  assert.equal(verifyAppProxy(p, SECRET, now * 1000).ok, false)
  assert.equal(verifyAppProxy({ ...p, signature: sig }, '', now * 1000).ok, false)
})

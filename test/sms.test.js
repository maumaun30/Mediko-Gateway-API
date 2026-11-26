const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('node:crypto')
const {
  normalizePhMobile, buildShippingSms, verifyShopifyWebhook, normalizeSmsAudience,
  fillSmsBlast, validateSmsBlastContent, parseId, semaphoreRequest, sendSemaphoreSms,
  handleFulfillmentCreateWebhook, shippingSmsFromOrder, SMS_BLAST_MAX_LEN,
} = require('../lib/sms')
const { toSmsText } = require('../lib/smsText')

// ---- phone normalization ----

test('normalizePhMobile accepts every common PH mobile format', () => {
  for (const raw of ['09171234567', '+639171234567', '639171234567', '9171234567',
    '0917 123 4567', '(0917) 123-4567', '+63 917 123 4567']) {
    assert.equal(normalizePhMobile(raw), '639171234567', raw)
  }
})

test('normalizePhMobile rejects landlines, short, long and empty input', () => {
  for (const raw of ['0281234567', '028123456', '091712345678', '0817123456', '', null, undefined, 'abc']) {
    assert.equal(normalizePhMobile(raw), null, String(raw))
  }
})

// ---- shipping SMS text ----

const JT = 'https://www.jtexpress.ph/appExpressTrack?wayBillNo=782044190031'

test('buildShippingSms uses the MedikoPH format with the order\'s own link', () => {
  const text = buildShippingSms({ orderName: '#1234', company: 'J&T Express', trackingNumber: '782044190031', trackingUrl: JT })
  assert.equal(text, `MedikoPH: Order #1234 has been shipped via J&T Express. You can track your package at ${JT}`)
  assert.ok(text.length <= 160, `length ${text.length}`)
})

test('buildShippingSms drops optional parts that are missing', () => {
  assert.equal(buildShippingSms({ orderName: '#1234' }), 'MedikoPH: Order #1234 has been shipped.')
  assert.equal(
    buildShippingSms({ orderName: '#1234', trackingUrl: JT }),
    `MedikoPH: Order #1234 has been shipped. You can track your package at ${JT}`,
  )
})

test('buildShippingSms drops the link rather than go past one SMS (160 chars)', () => {
  const longUrl = `https://www.jtexpress.ph/appExpressTrack?wayBillNo=${'9'.repeat(90)}`
  const text = buildShippingSms({ orderName: '#1234', company: 'J&T Express', trackingNumber: 'x', trackingUrl: longUrl })
  assert.equal(text, 'MedikoPH: Order #1234 has been shipped via J&T Express.')
})

test('toSmsText strips accents and non-GSM characters (avoids UCS-2 billing)', () => {
  assert.equal(toSmsText('  Niño — ✓ salamat  '), 'Nino   salamat')
  assert.equal(toSmsText(null), '')
})

// ---- webhook signature ----

function sign(body, secret) {
  return crypto.createHmac('sha256', secret).update(body).digest('base64')
}

test('verifyShopifyWebhook accepts a valid signature and rejects tampering', (t) => {
  const prev = { w: process.env.SHOPIFY_WEBHOOK_SECRET, c: process.env.SHOPIFY_CLIENT_SECRET }
  t.after(() => {
    process.env.SHOPIFY_WEBHOOK_SECRET = prev.w ?? ''
    process.env.SHOPIFY_CLIENT_SECRET = prev.c ?? ''
    if (prev.w === undefined) delete process.env.SHOPIFY_WEBHOOK_SECRET
    if (prev.c === undefined) delete process.env.SHOPIFY_CLIENT_SECRET
  })
  process.env.SHOPIFY_WEBHOOK_SECRET = 'whsec'
  const body = Buffer.from('{"id":1}')
  assert.equal(verifyShopifyWebhook(body, sign(body, 'whsec')), true)
  assert.equal(verifyShopifyWebhook(Buffer.from('{"id":2}'), sign(body, 'whsec')), false)
  assert.equal(verifyShopifyWebhook(body, sign(body, 'other')), false)
  assert.equal(verifyShopifyWebhook(body, 'short'), false)
  assert.equal(verifyShopifyWebhook(body, undefined), false)
  assert.equal(verifyShopifyWebhook('{"id":1}', sign(body, 'whsec')), false, 'body must be a raw Buffer')

  delete process.env.SHOPIFY_WEBHOOK_SECRET
  process.env.SHOPIFY_CLIENT_SECRET = 'client'
  assert.equal(verifyShopifyWebhook(body, sign(body, 'client')), true, 'falls back to client secret')
  delete process.env.SHOPIFY_CLIENT_SECRET
  assert.equal(verifyShopifyWebhook(body, sign(body, 'client')), false, 'no secret configured')
})

function fakeRes() {
  return {
    code: null, sent: null,
    status(c) { this.code = c; return this },
    send(b) { this.sent = b; return this },
  }
}

test('fulfillment webhook: bad HMAC is 401, other topics are ignored', async (t) => {
  process.env.SHOPIFY_WEBHOOK_SECRET = 'whsec'
  t.after(() => delete process.env.SHOPIFY_WEBHOOK_SECRET)
  const body = Buffer.from('{"id":1}')
  const req = (headers) => ({ body, ip: '1.2.3.4', get: (h) => headers[h] })

  const bad = fakeRes()
  await handleFulfillmentCreateWebhook(req({ 'X-Shopify-Hmac-Sha256': 'nope' }), bad)
  assert.equal(bad.code, 401)

  const other = fakeRes()
  await handleFulfillmentCreateWebhook(
    req({ 'X-Shopify-Hmac-Sha256': sign(body, 'whsec'), 'X-Shopify-Topic': 'orders/create' }), other,
  )
  assert.equal(other.code, 200)
  assert.equal(other.sent, 'ignored')
})

// ---- SMS blasts ----

test('normalizeSmsAudience keeps known statuses only and splits pasted numbers', () => {
  const a = normalizeSmsAudience({
    applications: ['pending', 'pending', 'bogus'],
    contact: 'not-an-array',
    extra: '0917 123 4567\n09181234567, 09191234567;;  ',
  })
  assert.deepEqual(a.applications, ['pending'])
  assert.deepEqual(a.contact, [])
  assert.deepEqual(a.returns, [])
  assert.deepEqual(a.extra, ['0917 123 4567', '09181234567', '09191234567'])
  assert.deepEqual(normalizeSmsAudience(null).extra, [])
})

test('fillSmsBlast uses the first name, falling back to "there"', () => {
  assert.equal(fillSmsBlast('Hi {{name}}!', { full_name: 'Maria  Santos' }), 'Hi Maria!')
  assert.equal(fillSmsBlast('Hi {{ NAME }}!', { full_name: 'José Cruz' }), 'Hi Jose!')
  assert.equal(fillSmsBlast('Hi {{name}}!', { full_name: null }), 'Hi there!')
})

test('validateSmsBlastContent enforces title, length and the TEST prefix rule', () => {
  assert.deepEqual(validateSmsBlastContent({ title: ' Promo ', body: 'Sale\nnow on' }), { title: 'Promo', text: 'Sale now on' })
  assert.match(validateSmsBlastContent({ title: 'ab', body: 'Sale now on' }).error, /Title/)
  assert.match(validateSmsBlastContent({ title: 'Promo', body: 'Hi' }).error, /Message/)
  assert.match(validateSmsBlastContent({ title: 'Promo', body: 'x'.repeat(SMS_BLAST_MAX_LEN + 1) }).error, /Message/)
  assert.match(validateSmsBlastContent({ title: 'Promo', body: 'Testing our sale' }).error, /TEST/)
  assert.match(validateSmsBlastContent({ title: 'Promo', body: '✓✓✓ ok' }).error, /Message/, 'length counted after stripping non-GSM')
  assert.ok(validateSmsBlastContent(undefined).error)
})

test('parseId accepts positive integers only', () => {
  const res = { code: null, body: null, status(c) { this.code = c; return this }, json(b) { this.body = b } }
  assert.equal(parseId({ params: { id: '42' } }, res), 42)
  for (const id of ['0', '-1', 'abc', undefined]) {
    res.code = null
    assert.equal(parseId({ params: { id } }, res), null, String(id))
    assert.equal(res.code, 400)
  }
})

// ---- Semaphore client (fetch mocked) ----

function mockFetch(t, { status = 200, body }) {
  const calls = []
  const orig = global.fetch
  global.fetch = async (url, opts) => {
    calls.push({ url, opts })
    return { ok: status >= 200 && status < 300, status, text: async () => body }
  }
  t.after(() => { global.fetch = orig })
  return calls
}

test('semaphoreRequest error never includes the API key', async (t) => {
  mockFetch(t, { status: 401, body: 'Unauthorized' })
  await assert.rejects(
    semaphoreRequest('/account', { apiKey: 'SECRET-KEY' }),
    (err) => /Semaphore 401/.test(err.message) && !err.message.includes('SECRET-KEY'),
  )
})

test('semaphoreRequest rejects a non-JSON 200 response', async (t) => {
  mockFetch(t, { body: '<html>oops</html>' })
  await assert.rejects(semaphoreRequest('/account', { apiKey: 'k' }), /Semaphore 200/)
})

test('sendSemaphoreSms POSTs form data and returns the first message', async (t) => {
  const calls = mockFetch(t, { body: JSON.stringify([{ message_id: 99 }]) })
  const sent = await sendSemaphoreSms('639171234567', 'Hello')
  assert.equal(sent.message_id, 99)
  assert.equal(calls[0].opts.method, 'POST')
  assert.ok(calls[0].url.endsWith('/messages'))
  const params = new URLSearchParams(String(calls[0].opts.body))
  assert.equal(params.get('number'), '639171234567')
  assert.equal(params.get('message'), 'Hello')
})

test('sendSemaphoreSms treats a 200 validation object as a failure', async (t) => {
  mockFetch(t, { body: JSON.stringify({ number: ['The number format is invalid.'] }) })
  await assert.rejects(sendSemaphoreSms('123', 'Hello'), /rejected the message/)
})

// ---- test / resend from a real order ----

const orderNode = (over = {}) => ({
  name: '#1234',
  phone: null,
  shippingAddress: { phone: '0917 123 4567' },
  billingAddress: { phone: '09181234567' },
  customer: { defaultPhoneNumber: { phoneNumber: '+639191234567' } },
  fulfillments: [
    { status: 'SUCCESS', trackingInfo: [{ company: 'J&T Express', number: '111', url: 'https://www.jtexpress.ph/appExpressTrack?wayBillNo=111' }] },
    { status: 'SUCCESS', trackingInfo: [{ company: 'J&T Express', number: '222', url: 'https://www.jtexpress.ph/appExpressTrack?wayBillNo=222' }] },
  ],
  ...over,
})

test('shippingSmsFromOrder uses the latest shipment and the shipping phone', () => {
  assert.deepEqual(shippingSmsFromOrder(orderNode()), {
    orderName: '#1234', company: 'J&T Express', trackingNumber: '222',
    trackingUrl: 'https://www.jtexpress.ph/appExpressTrack?wayBillNo=222', phone: '639171234567',
  })
})

test('shippingSmsFromOrder: phone falls back shipping → order → billing → customer', () => {
  assert.equal(shippingSmsFromOrder(orderNode({ shippingAddress: { phone: '028123456' } })).phone, '639181234567')
  assert.equal(shippingSmsFromOrder(orderNode({ shippingAddress: null, billingAddress: null })).phone, '639191234567')
  assert.equal(shippingSmsFromOrder(orderNode({ shippingAddress: null, billingAddress: null, customer: null })).phone, null)
})

test('shippingSmsFromOrder: unshipped orders are null; failed shipments and bad links ignored', () => {
  assert.equal(shippingSmsFromOrder(orderNode({ fulfillments: [] })), null)
  assert.equal(shippingSmsFromOrder(orderNode({ fulfillments: [{ status: 'CANCELLED', trackingInfo: [] }] })), null)
  assert.equal(shippingSmsFromOrder(null), null)
  const o = shippingSmsFromOrder(orderNode({
    fulfillments: [
      { status: 'SUCCESS', trackingInfo: [{ company: 'J&T Express', number: '111', url: 'javascript:alert(1)' }] },
      { status: 'CANCELLED', trackingInfo: [{ company: 'LBC', number: '999', url: 'https://lbc.ph/999' }] },
    ],
  }))
  assert.equal(o.trackingNumber, '111')
  assert.equal(o.trackingUrl, null)
  const bare = shippingSmsFromOrder(orderNode({ fulfillments: [{ status: 'SUCCESS', trackingInfo: [] }] }))
  assert.equal(buildShippingSms(bare), 'MedikoPH: Order #1234 has been shipped.')
})

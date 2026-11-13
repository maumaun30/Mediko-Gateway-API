const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeOrderNumber, orderFromNode, contactMatches, publicOrderStatus, statusReply } = require('../lib/orders')

const shippedNode = {
  name: '#1042', createdAt: '2026-11-08T03:00:00Z', cancelledAt: null,
  email: 'Maria@Example.ph', phone: null,
  displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED',
  statusPageUrl: 'https://store.mediko.ph/123/orders/abc',
  customer: { defaultEmailAddress: { emailAddress: 'maria@example.ph' }, defaultPhoneNumber: { phoneNumber: '+639171234567' } },
  shippingAddress: { phone: '0917 123 4567' }, billingAddress: null,
  fulfillments: [{ createdAt: '2026-11-10T02:00:00Z', status: 'SUCCESS', displayStatus: 'IN_TRANSIT',
    trackingInfo: [{ company: 'J&T Express', number: 'JT123', url: 'https://jtexpress.ph/track?b=JT123' }] }],
}

test('normalizeOrderNumber accepts #1042, 1042, "order 1042"; rejects junk', () => {
  assert.equal(normalizeOrderNumber('#1042'), '1042')
  assert.equal(normalizeOrderNumber(' 1042 '), '1042')
  assert.equal(normalizeOrderNumber('Order #1042'), '1042')
  assert.equal(normalizeOrderNumber('12'), null)
  assert.equal(normalizeOrderNumber('abc'), null)
  assert.equal(normalizeOrderNumber('1042; DROP'), null)
})

test('orderFromNode keeps status, dates and tracking only', () => {
  const o = orderFromNode(shippedNode)
  assert.equal(o.name, '#1042')
  assert.equal(o.fulfillmentStatus, 'FULFILLED')
  assert.deepEqual(o.tracking, [{ company: 'J&T Express', number: 'JT123', url: 'https://jtexpress.ph/track?b=JT123', shippedAt: '2026-11-10T02:00:00Z', status: 'IN_TRANSIT' }])
  assert.equal('email' in o, false)
})

test('contactMatches: email (any case) or PH mobile in any format', () => {
  assert.equal(contactMatches(shippedNode, 'maria@example.ph'), true)
  assert.equal(contactMatches(shippedNode, 'MARIA@EXAMPLE.PH'), true)
  assert.equal(contactMatches(shippedNode, '09171234567'), true)
  assert.equal(contactMatches(shippedNode, '+63 917 123 4567'), true)
  assert.equal(contactMatches(shippedNode, 'other@example.ph'), false)
  assert.equal(contactMatches(shippedNode, '09999999999'), false)
  assert.equal(contactMatches(shippedNode, ''), false)
})

test('publicOrderStatus: shipped with tracking, no personal data', () => {
  const p = publicOrderStatus(orderFromNode(shippedNode))
  assert.deepEqual(p, { order: '#1042', state: 'shipped', placedAt: '2026-11-08T03:00:00Z', shippedAt: '2026-11-10T02:00:00Z', deliveredAt: null,
    carrier: 'J&T Express', trackingNumber: 'JT123', trackingUrl: 'https://jtexpress.ph/track?b=JT123' })
})

test('publicOrderStatus: processing, cancelled, partially shipped; non-https tracking dropped', () => {
  const base = orderFromNode({ ...shippedNode, displayFulfillmentStatus: 'UNFULFILLED', fulfillments: [] })
  assert.equal(publicOrderStatus(base).state, 'processing')
  assert.equal(publicOrderStatus(orderFromNode({ ...shippedNode, cancelledAt: '2026-11-09T00:00:00Z' })).state, 'cancelled')
  assert.equal(publicOrderStatus(orderFromNode({ ...shippedNode, displayFulfillmentStatus: 'PARTIALLY_FULFILLED' })).state, 'partially_shipped')
  const bad = orderFromNode({ ...shippedNode, fulfillments: [{ ...shippedNode.fulfillments[0], trackingInfo: [{ company: 'X', number: 'N', url: 'javascript:alert(1)' }] }] })
  assert.equal(publicOrderStatus(bad).trackingUrl, null)
})

test('statusReply drafts a Tagalog reply the agent can edit', () => {
  assert.match(statusReply(orderFromNode(shippedNode)), /#1042.*J&T Express.*https:\/\/jtexpress\.ph/s)
  assert.match(statusReply(orderFromNode({ ...shippedNode, displayFulfillmentStatus: 'UNFULFILLED', fulfillments: [] })), /#1042.*inihahanda/)
  assert.match(statusReply(orderFromNode({ ...shippedNode, cancelledAt: '2026-11-09T00:00:00Z' })), /na-cancel.*#1042/i)
})

test('orderStatusResult: found only when the contact matches; same answer for missing and mismatch', () => {
  const { orderStatusResult } = require('../lib/orders')
  const ok = orderStatusResult([shippedNode], '09171234567')
  assert.equal(ok.found, true)
  assert.equal(ok.status.order, '#1042')
  assert.equal(ok.status.trackingNumber, 'JT123')
  assert.deepEqual(orderStatusResult([shippedNode], 'someone@else.ph'), { found: false })
  assert.deepEqual(orderStatusResult([], 'maria@example.ph'), { found: false })
  assert.equal(JSON.stringify(ok).includes('maria'), false)
})

test('orderNameQuery searches with and without "#"; pickOrder needs an exact number match', () => {
  const { orderNameQuery, pickOrder } = require('../lib/orders')
  assert.equal(orderNameQuery('1002'), 'name:"#1002" OR name:"1002"')
  assert.equal(pickOrder([{ name: '#10021' }, { name: '#1002' }], '1002').name, '#1002')
  assert.equal(pickOrder([{ name: '#10021' }], '1002'), null)
  assert.equal(pickOrder([], '1002'), null)
})

test('delivered: every fulfillment delivered → state delivered with deliveredAt; reply says na-deliver', () => {
  const delivered = { ...shippedNode, fulfillments: [{ ...shippedNode.fulfillments[0], displayStatus: 'DELIVERED', deliveredAt: '2026-11-12T05:00:00Z' }] }
  const o = orderFromNode(delivered)
  const p = publicOrderStatus(o)
  assert.equal(p.state, 'delivered')
  assert.equal(p.deliveredAt, '2026-11-12T05:00:00Z')
  assert.match(statusReply(o), /Na-deliver na po ang order #1042/)
  // one of two shipments still in transit → still "shipped"
  const mixed = { ...delivered, fulfillments: [...delivered.fulfillments, { ...shippedNode.fulfillments[0], displayStatus: 'IN_TRANSIT' }] }
  assert.equal(publicOrderStatus(orderFromNode(mixed)).state, 'shipped')
  assert.equal(publicOrderStatus(orderFromNode(shippedNode)).deliveredAt, null)
})

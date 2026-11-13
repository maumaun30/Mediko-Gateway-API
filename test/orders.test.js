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
  assert.deepEqual(p, { order: '#1042', state: 'shipped', placedAt: '2026-11-08T03:00:00Z', shippedAt: '2026-11-10T02:00:00Z',
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

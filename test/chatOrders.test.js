const test = require('node:test')
const assert = require('node:assert/strict')
const { findOrderNumber } = require('../admin-portal/chat-orders.js')

test('findOrderNumber picks up the ways customers write order numbers', () => {
  assert.equal(findOrderNumber('Saan na po order ko #1042?'), '1042')
  assert.equal(findOrderNumber('order 1042 po'), '1042')
  assert.equal(findOrderNumber('Order no. 1042'), '1042')
  assert.equal(findOrderNumber('order number: 1042'), '1042')
  assert.equal(findOrderNumber('ORDER#1042'), '1042')
})

test('findOrderNumber ignores phone numbers, prices and plain numbers', () => {
  assert.equal(findOrderNumber('09171234567 po number ko'), null)
  assert.equal(findOrderNumber('magkano po 1899?'), null)
  assert.equal(findOrderNumber('2 boxes po'), null)
  assert.equal(findOrderNumber(''), null)
})

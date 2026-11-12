const test = require('node:test')
const assert = require('node:assert/strict')
const { isAccessDenied } = require('../lib/shopify')

test('isAccessDenied spots a missing-scope GraphQL error', () => {
  assert.equal(isAccessDenied({ errors: [{ message: 'Access denied for productByIdentifier field. Required access: `read_products` access scope.', extensions: { code: 'ACCESS_DENIED' } }] }), true)
  assert.equal(isAccessDenied({ errors: [{ message: 'Access denied for product field.' }] }), true)
  assert.equal(isAccessDenied({ errors: [{ message: 'Field x does not exist', extensions: { code: 'undefinedField' } }] }), false)
  assert.equal(isAccessDenied({ data: {} }), false)
  assert.equal(isAccessDenied(null), false)
})

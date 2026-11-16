const test = require('node:test')
const assert = require('node:assert/strict')
const { switchedOff, TEMPLATES } = require('../lib/templates')

test('switchedOff keeps only known templates explicitly switched off', () => {
  const key = Object.keys(TEMPLATES).find((k) => TEMPLATES[k].channel === 'email')
  const off = switchedOff([
    { template_key: key, enabled: 0 },
    { template_key: 'nope', enabled: 0 },
    { template_key: 'contact_received', enabled: 1 },
  ])
  assert.deepEqual([...off], [key])
  assert.equal(switchedOff(null).size, 0)
})

test('every email template can be switched (no hard-coded always-on list)', () => {
  const emails = Object.entries(TEMPLATES).filter(([, d]) => d.channel === 'email').map(([k]) => k)
  assert.ok(emails.includes('chat_reply_customer'))
  assert.ok(emails.includes('application_received'))
})

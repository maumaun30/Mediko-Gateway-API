const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const { verifyChatEventSignature, chatDeepLink, buildStaffAlertMail, validateChatEvent } = require('../lib/chat')

const S = 'x'.repeat(32)
const sig = (ts, body, s = S) => crypto.createHmac('sha256', s).update(`${ts}.${body}`).digest('hex')

test('valid signature within window', () => {
  const body = '{"type":"unanswered"}', ts = '1000000'
  assert.equal(verifyChatEventSignature(Buffer.from(body), ts, sig(ts, body), S, 1000000 + 60000), true)
})
test('replay outside 5 min → false', () => {
  const body = '{}', ts = '1000000'
  assert.equal(verifyChatEventSignature(body, ts, sig(ts, body), S, 1000000 + 301000), false)
})
test('tampered body → false', () => {
  const ts = '1000000'
  assert.equal(verifyChatEventSignature('{"a":2}', ts, sig(ts, '{"a":1}'), S, 1000000), false)
})
test('short or missing secret → false', () => {
  const body = '{}', ts = '1000000', short = 'x'.repeat(31)
  assert.equal(verifyChatEventSignature(body, ts, sig(ts, body, short), short, 1000000), false)
  assert.equal(verifyChatEventSignature(body, ts, sig(ts, body), undefined, 1000000), false)
})
test('missing/garbage timestamp or signature → false', () => {
  const body = '{}'
  assert.equal(verifyChatEventSignature(body, undefined, 'ab', S, 1), false)
  assert.equal(verifyChatEventSignature(body, 'abc', sig('abc', body), S, 1), false)
  assert.equal(verifyChatEventSignature(body, '1000000', undefined, S, 1000000), false)
  assert.equal(verifyChatEventSignature(body, '1000000', 'zz', S, 1000000), false)
})
test('chatDeepLink', () => assert.equal(chatDeepLink('abc', 'https://admin.shopify.com/store/mediko/apps/gw/'), 'https://admin.shopify.com/store/mediko/apps/gw/chats/abc'))
test('chatDeepLink encodes session id', () => assert.equal(chatDeepLink('a/b', 'https://x.y'), 'https://x.y/chats/a%2Fb'))
test('staff mail escapes HTML', () => {
  const m = buildStaffAlertMail({ type: 'new_conversation', name: '<b>x</b>', email: 'a@b.c', phone: '639171234567', text: 'hi' }, 'https://l')
  assert.match(m.subject, /^New chat from/)
  assert.ok(!m.html.includes('<b>x</b>'))
  assert.match(m.html, /Open in Gateway/)
})
test('unanswered subject and 300-char cut', () => {
  const m = buildStaffAlertMail({ type: 'unanswered', name: 'N', email: 'a@b.c', phone: '1', text: 'y'.repeat(400) }, 'https://l')
  assert.match(m.subject, /^Unanswered chat from N/)
  assert.ok(m.text.includes('y'.repeat(300)) && !m.text.includes('y'.repeat(301)))
})

const ok = { type: 'new_conversation', sessionId: 's1', name: 'N', email: 'a@b.c', phone: '639171234567', text: 'hi' }
test('validateChatEvent accepts valid events', () => {
  assert.equal(validateChatEvent(ok), true)
  assert.equal(validateChatEvent({ ...ok, type: 'unanswered' }), true)
  assert.equal(validateChatEvent({ type: 'offline_reply', sessionId: 's', name: 'N', email: 'a@b.co', messages: ['a'], link: 'https://x.y/z' }), true)
})
test('validateChatEvent rejects bad events', () => {
  const off = { type: 'offline_reply', sessionId: 's', name: 'N', email: 'a@b.co', messages: ['a'], link: 'https://x.y' }
  for (const bad of [
    null, [], 'x', { ...ok, type: 'nope' }, { ...ok, name: 5 }, { ...ok, name: 'n'.repeat(201) },
    { ...ok, email: 'e'.repeat(255) }, { ...ok, text: 't'.repeat(5001) }, { ...ok, sessionId: undefined },
    { ...off, email: 'a@b.c, evil@x.y' }, { ...off, messages: 'a' }, { ...off, messages: Array(51).fill('a') }, { ...off, messages: ['a'.repeat(2001)] },
    { ...off, messages: [1] }, { ...off, link: 'http://x.y' }, { ...off, link: 'https://' + 'a'.repeat(2000) },
  ]) assert.equal(validateChatEvent(bad), false, JSON.stringify(bad)?.slice(0, 80))
})

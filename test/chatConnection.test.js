const test = require('node:test')
const assert = require('node:assert/strict')
const { createChatConnection } = require('../admin-portal/chat-connection.js')

const tick = () => new Promise((r) => setImmediate(r))

function harness({ tokens = ['t1', 't2', 't3', 't4'], backoffMs } = {}) {
  let i = 0
  const sockets = []
  const timers = []
  const statuses = []
  const events = []
  class FakeWS {
    constructor(url) { this.url = url; this.sent = []; sockets.push(this) }
    send(s) { this.sent.push(s) }
    close() { this.onclose?.() }
  }
  const conn = createChatConnection({
    getToken: async () => ({ token: tokens[i++], apiUrl: 'https://chat.test' }),
    WebSocketImpl: FakeWS,
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
    setTimer: (f, ms) => { timers.push({ f, ms }) },
    ...(backoffMs ? { backoffMs } : {}),
  })
  return { conn, sockets, timers, statuses, events }
}

test('reconnects with a fresh token after close', async () => {
  const tokens = ['t1', 't2']; let i = 0; const sockets = []; let fire
  class FakeWS { constructor(url) { this.url = url; sockets.push(this) } send() {} close() { this.onclose?.() } }
  const statuses = []
  createChatConnection({ getToken: async () => ({ token: tokens[i++], apiUrl: 'https://chat.test' }), WebSocketImpl: FakeWS,
    onEvent: () => {}, onStatus: (s) => statuses.push(s), setTimer: (f) => { fire = f } })
  await new Promise(r => setImmediate(r))
  assert.equal(sockets[0].url, 'wss://chat.test/api/agent/ws?token=t1')
  sockets[0].onopen?.(); sockets[0].onclose?.()
  await fire(); await new Promise(r => setImmediate(r))
  assert.equal(sockets[1].url, 'wss://chat.test/api/agent/ws?token=t2')
  assert.deepEqual(statuses.slice(0, 2), ['online', 'offline'])
})

test('http apiUrl maps to ws://', async () => {
  const sockets = []
  class FakeWS { constructor(url) { this.url = url; sockets.push(this) } send() {} close() {} }
  createChatConnection({ getToken: async () => ({ token: 'a.b.c', apiUrl: 'http://localhost:3000' }), WebSocketImpl: FakeWS,
    onEvent: () => {}, onStatus: () => {}, setTimer: () => {} })
  await tick()
  assert.equal(sockets[0].url, 'ws://localhost:3000/api/agent/ws?token=a.b.c')
})

test('backoff grows on repeated failures, caps at the last value, and resets on open', async () => {
  const h = harness({ tokens: ['t1', 't2', 't3', 't4', 't5'], backoffMs: [10, 20, 30] })
  await tick()
  h.sockets[0].onclose()
  assert.equal(h.timers[0].ms, 10)
  await h.timers[0].f(); await tick()
  h.sockets[1].onclose()
  assert.equal(h.timers[1].ms, 20)
  await h.timers[1].f(); await tick()
  h.sockets[2].onclose()
  assert.equal(h.timers[2].ms, 30)
  await h.timers[2].f(); await tick()
  h.sockets[3].onclose()
  assert.equal(h.timers[3].ms, 30, 'capped at the last backoff value')
  await h.timers[3].f(); await tick()
  h.sockets[4].onopen(); h.sockets[4].onclose()
  assert.equal(h.timers[4].ms, 10, 'reset after a successful open')
})

test('a failed token fetch reports offline and retries', async () => {
  const sockets = []; const timers = []; const statuses = []
  let calls = 0
  class FakeWS { constructor(url) { this.url = url; sockets.push(this) } send() {} close() {} }
  createChatConnection({
    getToken: async () => { calls++; if (calls === 1) throw new Error('503'); return { token: 'ok', apiUrl: 'https://chat.test' } },
    WebSocketImpl: FakeWS, onEvent: () => {}, onStatus: (s) => statuses.push(s),
    setTimer: (f, ms) => timers.push({ f, ms }), backoffMs: [5],
  })
  await tick()
  assert.equal(sockets.length, 0)
  assert.deepEqual(statuses, ['offline'])
  assert.equal(timers.length, 1)
  await timers[0].f(); await tick()
  assert.equal(sockets[0].url, 'wss://chat.test/api/agent/ws?token=ok')
})

test('onEvent gets parsed JSON; bad frames are ignored', async () => {
  const h = harness()
  await tick()
  h.sockets[0].onopen()
  h.sockets[0].onmessage({ data: '{"type":"connected"}' })
  h.sockets[0].onmessage({ data: 'not json' })
  assert.deepEqual(h.events, [{ type: 'connected' }])
})

test('send() writes JSON only while open', async () => {
  const h = harness()
  await tick()
  assert.equal(h.conn.send({ type: 'typing', sessionId: 's', value: true }), false)
  h.sockets[0].onopen()
  assert.equal(h.conn.send({ type: 'close', sessionId: 's' }), true)
  assert.deepEqual(h.sockets[0].sent, ['{"type":"close","sessionId":"s"}'])
  h.sockets[0].onclose()
  assert.equal(h.conn.send({ type: 'close', sessionId: 's' }), false)
})

test('close() stops reconnecting', async () => {
  const h = harness()
  await tick()
  h.sockets[0].onopen()
  h.conn.close()
  assert.equal(h.timers.length, 0)
  assert.equal(h.sockets.length, 1)
})

test('close() during a pending reconnect prevents the new socket', async () => {
  const h = harness()
  await tick()
  h.sockets[0].onclose()
  h.conn.close()
  await h.timers[0].f(); await tick()
  assert.equal(h.sockets.length, 1)
})

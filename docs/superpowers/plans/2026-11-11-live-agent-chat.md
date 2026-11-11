# Live Agent Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Customers on the storefront chat in real time with Mediko staff, who answer from a new Chats page in MedikoPH Gateway. Email alerts go to staff, and offline customers get replies by email. AI is off.

**Architecture:** `mediko-chatbot` stays the conversation service (MySQL, widget SSE, agent WebSocket). It is locked behind short-lived JWTs that Gateway mints for its admins. The chat service sends signed events to Gateway (`/internal/chat-events`), and Gateway sends all email through Brevo. `mediko-widget` gets a pre-chat form and a plain send path, without AI.

**Tech Stack:** Fastify 4 + `ws` + mysql2 (ESM, `node --test`); Express 5 + nodemailer + jsonwebtoken (CJS); Polaris web components + App Bridge v4; React 18 + Vite.

**Spec:** `mediko_gateway_api/docs/superpowers/specs/2026-11-11-live-agent-chat-design.md`

Repos (each its own git repo, commit in the one you touched):
`C` = `mediko-chatbot`, `G` = `mediko_gateway_api`, `W` = `mediko-widget`, all under `/Users/mau/Documents/web_projects/mediko/`.

## Global Constraints

- AI is on only when `process.env.AI_ENABLED === 'true'`. `.env.example` ships `AI_ENABLED=false`.
- Agent JWT: HS256, `iss: 'mediko-gateway'`, `aud: 'mediko-chat'`, TTL 300 s, `sub` = Shopify staff user id. Secret `CHAT_AGENT_SECRET` (32+ chars), set in both `.env` files and never in the DB.
- Chat event auth: header `X-Mediko-Timestamp` (unix ms) and `X-Mediko-Signature` = hex HMAC-SHA256 of `` `${timestamp}.${rawBody}` `` with `CHAT_AGENT_SECRET`. Reject if the timestamp is more than 5 min off.
- Customer link token: `` `${sessionId}.${expSec}.${sig}` ``, where `sig` = base64url HMAC-SHA256 of `` `${sessionId}.${expSec}` ``. Valid 14 days. URL param `mdk_chat`.
- Office hours default: Mon–Fri 08:00–17:00, `Asia/Manila`, `enabled: true`.
- Unanswered alert default: 10 minutes. At most one alert per unanswered stretch. Alerts fire around the clock.
- Offline-reply debounce: 120 000 ms. Re-check presence when the timer fires.
- PH mobile: accept `^(\+639|09)\d{9}$` after stripping spaces and dashes. Store as `639XXXXXXXXX`.
- Customers see every agent reply as **"Mediko Support"**. No quick replies anywhere.
- The chat service runs as one process (`instances: 1`).
- Gateway: never answer 502 (use 500 + `{ error }`). Use `log(level, event, data)`, not `console.log`. Columns via `ensureColumn`. Secrets in `.env` only (`SECRET_ENV_STATUS` set/not set).
- Commits: the owner is sole author. No `Co-Authored-By`, no AI attribution lines.
- Copy in the widget is Filipino, the same tone as now.

## Review Focus

1. **Agent token expires mid-shift** (laptop asleep for an hour, then the WS reconnects). Expect a silent re-fetch of the token and a reconnect, with no reload. Test lives in Task 9 (`chatConnection` reconnect test).
2. **Customer has two tabs open, then closes one.** They must still show as online and must not be emailed. Test lives in Task 5 (`createPresence` counts subscribers).
3. **Customer reconnects inside the 2-min debounce.** Expect no email. Test lives in Task 6.
4. **Clock skew or replayed event to `/internal/chat-events`.** Expect a 401 and no email. Test lives in Task 7.
5. **Old anonymous sessions and legacy `"[Agent] "` rows.** Expect them listed as "Unknown visitor", with history rendered as agent bubbles and no prefix. Test lives in Task 2 (`stripAgentPrefix`) and Task 4 (list mapping `displayName`).

---

### Task 1 (C): Auth primitives

**Files:**
- Create: `mediko-chatbot/src/services/agentAuth.js`
- Modify: `mediko-chatbot/package.json` (add `jsonwebtoken@^9.0.3`)
- Test: `mediko-chatbot/tests/agentAuth.test.js`

**Interfaces:**
- Produces:
  - `verifyAgentToken(token: string, secret?: string): { sub: string } | null`, with the secret defaulting to `process.env.CHAT_AGENT_SECRET`. It returns null when the secret is missing or shorter than 32 chars.
  - `bearerFrom(header?: string): string | null`
  - `signChatLink(sessionId: string, { secret?, now = Date.now(), ttlDays = 14 }): string`
  - `verifyChatLink(token: string, { secret?, now = Date.now() }): string | null`, returning the sessionId.
  - `signEvent(rawBody: string, timestamp: string, secret?: string): string` (hex)

- [ ] **Step 1: Write failing tests**

```js
const S = 'x'.repeat(32)
test('verifyAgentToken accepts gateway token', () => {
  const t = jwt.sign({ sub: '42' }, S, { algorithm: 'HS256', issuer: 'mediko-gateway', audience: 'mediko-chat', expiresIn: 300 })
  assert.deepEqual(verifyAgentToken(t, S), { sub: '42' })
})
test('verifyAgentToken rejects wrong aud, expired, short secret', () => {
  const bad = jwt.sign({ sub: '1' }, S, { issuer: 'mediko-gateway', audience: 'mediko-admin' })
  assert.equal(verifyAgentToken(bad, S), null)
  const old = jwt.sign({ sub: '1', exp: Math.floor(Date.now()/1000) - 10 }, S, { issuer: 'mediko-gateway', audience: 'mediko-chat' })
  assert.equal(verifyAgentToken(old, S), null)
  assert.equal(verifyAgentToken('anything', 'short'), null)
})
test('chat link round-trips and expires after 14 days', () => {
  const id = '3f1c2a4e-0000-4000-8000-000000000000', now = Date.UTC(2026, 10, 11)
  const t = signChatLink(id, { secret: S, now })
  assert.equal(verifyChatLink(t, { secret: S, now: now + 13 * 864e5 }), id)
  assert.equal(verifyChatLink(t, { secret: S, now: now + 15 * 864e5 }), null)
  assert.equal(verifyChatLink(t.replace(/.$/, c => c === 'A' ? 'B' : 'A'), { secret: S, now }), null)
})
test('signEvent is hex HMAC of ts.body', () => {
  const expect = crypto.createHmac('sha256', S).update('123.{"a":1}').digest('hex')
  assert.equal(signEvent('{"a":1}', '123', S), expect)
})
```

- [ ] **Step 2: Run** `cd mediko-chatbot && npm i && node --test tests/agentAuth.test.js`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `agentAuth.js`.** Use `jwt.verify` with `algorithms: ['HS256']`, `issuer`, `audience`. Use `crypto.timingSafeEqual` for link signatures.
- [ ] **Step 4: Run the same command.** Expected: PASS.
- [ ] **Step 5: Commit (C)** `feat: add agent token and chat link signing`

---

### Task 2 (C): Schema, phone, session service

**Files:**
- Create: `mediko-chatbot/src/db/migrate.js`, `mediko-chatbot/src/services/phone.js`
- Modify: `src/db/schema.sql` (new columns; seed `business_hours` → Mon–Fri 08:00–17:00 `enabled:true`; add `unanswered_minutes {"value":10}`; delete quick-reply seed rows), `src/services/sessionService.js`, `src/app.js` (await `migrate()` before listen)
- Test: `mediko-chatbot/tests/session.test.js`

**Interfaces:**
- Produces:
  - `migrate(): Promise<void>`. It adds the `chat_sessions` columns `customer_name VARCHAR(255) NULL`, `customer_phone VARCHAR(20) NULL`, `status VARCHAR(10) NOT NULL DEFAULT 'open'`, `last_customer_at DATETIME(3) NULL`, `last_agent_at DATETIME(3) NULL`, `alerted_at DATETIME(3) NULL`, `customer_emailed_at DATETIME(3) NULL`, and index `idx_sessions_status (status, last_customer_at)`. Check existence through `INFORMATION_SCHEMA`. Then run `UPDATE chat_messages SET role='agent', content=SUBSTRING(content, 9) WHERE role='assistant' AND content LIKE '[Agent] %'`. It is idempotent.
  - `normalizePhMobile(raw: string): string | null`, returning `639XXXXXXXXX`.
  - `stripAgentPrefix(content: string): string`
  - `isUnanswered(row: { status, last_customer_at, last_agent_at }): boolean`
  - sessionService additions and changes:
    - `createSession({ channel='widget', customerName, customerEmail, customerPhone, metadata, mode }): Promise<string>`, where `mode` defaults to `aiEnabled() ? 'ai' : 'agent'`.
    - `getSession(id): Promise<row|null>`
    - `recordCustomerMessage(sessionId, text): Promise<{ message, isFirst: boolean }>`. It sets `last_customer_at`, `last_active` and `status='open'`.
    - `saveAgentMessage(sessionId, text): Promise<message>`. It writes `role='agent'` with no prefix and sets `last_agent_at`.
    - `setStatus(sessionId, 'open'|'closed'): Promise<void>`
    - `listConversations({ status: 'open'|'unanswered'|'closed', q?, limit=50, before? }): Promise<row[]>`
    - `findAlertCandidates(): Promise<row[]>` (open sessions where `last_customer_at` is set)
    - `markAlerted(id, at: Date)`
    - `agentMessagesToEmail(sessionId): Promise<string[]>`, returning agent messages created after `GREATEST(last_customer_at, COALESCE(customer_emailed_at, 0))`
    - `markEmailed(id, at: Date)`
  - `aiEnabled(): boolean` exported from `src/services/settingsService.js` (`process.env.AI_ENABLED === 'true'`).
  - `message` shape everywhere: `{ id, role: 'user'|'agent'|'assistant', content, created_at }`.

- [ ] **Step 1: Write failing tests**

```js
test('normalizePhMobile', () => {
  assert.equal(normalizePhMobile('0917 123-4567'), '639171234567')
  assert.equal(normalizePhMobile('+639171234567'), '639171234567')
  assert.equal(normalizePhMobile('12345'), null)
})
test('stripAgentPrefix', () => {
  assert.equal(stripAgentPrefix('[Agent] Hello po'), 'Hello po')
  assert.equal(stripAgentPrefix('Hello'), 'Hello')
})
test('isUnanswered', () => {
  assert.equal(isUnanswered({ status: 'open', last_customer_at: '2026-11-11 01:00:00', last_agent_at: null }), true)
  assert.equal(isUnanswered({ status: 'open', last_customer_at: '2026-11-11 01:00:00', last_agent_at: '2026-11-11 01:05:00' }), false)
  assert.equal(isUnanswered({ status: 'closed', last_customer_at: '2026-11-11 01:00:00', last_agent_at: null }), false)
  assert.equal(isUnanswered({ status: 'open', last_customer_at: null, last_agent_at: null }), false)
})
test('aiEnabled only for exact "true"', () => {
  process.env.AI_ENABLED = 'TRUE'; assert.equal(aiEnabled(), false)
  process.env.AI_ENABLED = 'true'; assert.equal(aiEnabled(), true)
  delete process.env.AI_ENABLED;  assert.equal(aiEnabled(), false)
})
```

- [ ] **Step 2: Run** `node --test tests/session.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Put `isUnanswered` and `stripAgentPrefix` in `sessionService.js`, and `normalizePhMobile` in `phone.js`. The `listConversations` `unanswered` filter uses the same predicate as `isUnanswered` in SQL. `q` matches `customer_name`, `customer_email` and `customer_phone` with `LIKE`. Order by `last_active DESC`. `before` is a `last_active` cursor.
- [ ] **Step 4: Run tests, then smoke-test the migration** with `docker compose up -d db && node -e "import('./src/db/migrate.js').then(m=>m.migrate()).then(()=>process.exit())"` run twice. Expected: no error either time.
- [ ] **Step 5: Commit (C)** `feat: add chat session status, contact fields and migration`

---

### Task 3 (C): Office hours and widget-facing chat routes, AI gate

**Files:**
- Modify: `src/services/settingsService.js`, `src/routes/chat.js`, `src/services/conversationManager.js`, `src/channels/widgetAdapter.js` (if needed), `src/app.js`
- Delete: `src/routes/quickReplies.js`, `src/services/quickReplyService.js`, `closeIdleSessions` (and its import in `app.js`), `src/routes/settings.js` (its replacement comes in Task 5)
- Test: `mediko-chatbot/tests/hours.test.js`

**Interfaces:**
- Consumes: Task 2 sessionService, `aiEnabled()`, `normalizePhMobile`, `signChatLink`/`verifyChatLink` (Task 1).
- Produces:
  - `isOpenAt(bh, date: Date): boolean` and `nextOpenAt(bh, date: Date): Date | null` (pure; null when no day is open; `bh.enabled === false` means always open, so `nextOpenAt` is null).
  - `getUnansweredMinutes(): Promise<number>` (default 10), `saveUnansweredMinutes(n)`.
  - `isWithinBusinessHours()` re-implemented as `isOpenAt(await getBusinessHours(), new Date())`.
  - Routes (public, `/api/chat` prefix):
    - `GET /config` → `{ aiEnabled, online, nextOpenAt: string|null, awayMessage }`
    - `POST /session` body `{ customerName (1–100), customerEmail (format email), customerPhone, metadata? }`. All three are required. It returns 400 `{ error: 'Pakilagay po ang tamang mobile number (09XXXXXXXXX).' }` when `normalizePhMobile` is null, and 201 `{ sessionId }` on success.
    - `POST /message` body `{ sessionId (uuid), message (1–2000) }` → 200 `{ message, away: string|null }`. `away` is the away message when the service is offline. Return 404 for an unknown session. The route keeps `spamCheck` and its 15/min rate limit. It calls `onCustomerMessage` (Task 5 wires the broadcast and alerts; until then it is a no-op hook exported from `src/services/chatEvents.js` as `export const hooks = { onCustomerMessage: async () => {} }`).
    - `POST /typing` body `{ sessionId }` → 204. It calls `hooks.onCustomerTyping(sessionId)`.
    - `GET /resume?t=` → 200 `{ sessionId }`, or 410 `{ error: 'expired' }` when `verifyChatLink` fails.
    - `POST /` (the SSE AI route) is used only when `aiEnabled()`. Otherwise it answers 409 `{ error: 'AI is off' }`.
  - `processMessage` begins with `if (!aiEnabled())` and throws, because it is only reachable on the AI route.
  - Fix: use `bh?.awayMessage` (not `away_message`).

- [ ] **Step 1: Write failing tests** (fixed dates; Manila is UTC+8):

```js
const bh = { enabled: true, timezone: 'Asia/Manila', hours: {
  mon:{open:true,start:'08:00',end:'17:00'}, tue:{open:true,start:'08:00',end:'17:00'}, wed:{open:true,start:'08:00',end:'17:00'},
  thu:{open:true,start:'08:00',end:'17:00'}, fri:{open:true,start:'08:00',end:'17:00'}, sat:{open:false}, sun:{open:false} } }
test('open Wed 10:00 Manila', () => assert.equal(isOpenAt(bh, new Date('2026-11-11T02:00:00Z')), true))
test('closed Wed 17:00 Manila', () => assert.equal(isOpenAt(bh, new Date('2026-11-11T09:00:00Z')), false))
test('Sat 21:00 → next open Mon 08:00 Manila', () =>
  assert.equal(nextOpenAt(bh, new Date('2026-11-14T13:00:00Z')).toISOString(), '2026-11-16T00:00:00.000Z'))
test('Wed 07:00 → same day 08:00', () =>
  assert.equal(nextOpenAt(bh, new Date('2026-11-10T23:00:00Z')).toISOString(), '2026-11-11T00:00:00.000Z'))
test('disabled hours = always open, no nextOpenAt', () => {
  assert.equal(isOpenAt({ ...bh, enabled: false }, new Date('2026-11-14T13:00:00Z')), true)
  assert.equal(nextOpenAt({ ...bh, enabled: false }, new Date()), null)
})
```

- [ ] **Step 2: Run** `node --test tests/hours.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Compute Manila wall-clock time with `Intl.DateTimeFormat(..., { timeZone, hour12:false })` parts, not `toLocaleString` re-parsing. `nextOpenAt` scans up to 7 days ahead.
- [ ] **Step 4: Run** `node --test tests/`. Then update the stale structural tests in `tests/chat.test.js`: remove the dashboard HTML test, the quick-reply widget assertion and the `styles.js` CSS test (that file doesn't exist; CSS is `widget.css`). Keep the AI-pure tests. Expected: all PASS.
- [ ] **Step 5: Manual check** with `npm run dev` and `curl -s localhost:3001/api/chat/config`. Expected: JSON with `aiEnabled:false` and `online` for the current Manila time. `POST /api/chat/session` with phone `12345` should return 400 with the Filipino error.
- [ ] **Step 6: Commit (C)** `feat: human-only chat routes, office hours, remove quick replies`

---

### Task 4 (C): Agent auth gate, CORS, agent REST

**Files:**
- Create: `src/plugins/requireAgent.js` (Fastify plugin), `src/routes/agent.js`
- Modify: `src/plugins/security.js`, `src/app.js`, `src/routes/keywords.js`, `src/routes/analytics.js` (swap `requireAuth` for `requireAgent`), `src/routes/chat.js` (`openSSE` and `/listen` use `corsOriginFor`), `.env.example`
- Delete: `src/routes/admin.js`, `src/routes/dashboard.js`, `src/dashboard/index.html`, all `ADMIN_SECRET` use
- Test: `mediko-chatbot/tests/agentRoutes.test.js`

**Interfaces:**
- Consumes: `verifyAgentToken`, `bearerFrom` (Task 1); sessionService (Task 2); `getBusinessHours`/`saveBusinessHours`/`getUnansweredMinutes`/`saveUnansweredMinutes` (Task 3).
- Produces:
  - `allowedOrigins(): string[]`, from `ALLOWED_ORIGINS` (comma list), falling back to `[WIDGET_ALLOWED_ORIGIN]`. `corsOriginFor(origin?: string): string` returns the origin when it is allowed, else `''`.
  - `requireAgent(request, reply)`, an onRequest hook. It sends 401 `{ error: 'Unauthorized' }` unless the bearer passes `verifyAgentToken`, and sets `request.agent = { sub }`.
  - Global rate-limit `allowList: (req) => !!verifyAgentToken(bearerFrom(req.headers.authorization))`.
  - CORS methods `GET, POST, PUT, PATCH, DELETE, OPTIONS`, headers `Content-Type, Authorization`.
  - `toConversation(row, online: boolean)` → `{ id, displayName: row.customer_name || 'Unknown visitor', email, phone, status, unanswered: isUnanswered(row), online, lastMessage, lastActive }`
  - Routes under `/api/agent` (all `requireAgent`):
    - `GET /conversations?status&q&limit&before` → `{ conversations: Conversation[] }`
    - `GET /conversations/:id` → `{ conversation, messages }`, where `messages` have `stripAgentPrefix` applied to `agent`/`assistant` rows
    - `GET /settings` → `{ businessHours, unansweredMinutes }`
    - `PUT /settings` body `{ businessHours?, unansweredMinutes? (1–240) }` → same shape
  - `online` comes from `isOnline(sessionId)` in `agentService.js` (Task 5). Until Task 5 lands, import a stub that returns false.

- [ ] **Step 1: Write failing tests** using `fastify.inject` on a Fastify instance with only the `requireAgent` plugin and `agent.js` registered, with sessionService mocked through `mock.module` or a test-only injection param `agentRoutes(fastify, { sessions })`. Pick injection, since `node --test` module mocking needs a flag.

```js
test('GET /api/agent/conversations without token → 401', async () => {
  const res = await app.inject({ url: '/api/agent/conversations' })
  assert.equal(res.statusCode, 401)
})
test('with valid token → list mapped, unknown visitor name', async () => {
  const res = await app.inject({ url: '/api/agent/conversations?status=open', headers: { authorization: `Bearer ${token}` } })
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().conversations[0].displayName, 'Unknown visitor')
})
test('PUT /settings rejects unansweredMinutes 0', async () => {
  const res = await app.inject({ method: 'PUT', url: '/api/agent/settings', headers: { authorization: `Bearer ${token}` }, payload: { unansweredMinutes: 0 } })
  assert.equal(res.statusCode, 400)
})
test('corsOriginFor', () => {
  process.env.ALLOWED_ORIGINS = 'https://store.mediko.ph,https://mediko-gateway.quailshack.com'
  assert.equal(corsOriginFor('https://store.mediko.ph'), 'https://store.mediko.ph')
  assert.equal(corsOriginFor('https://evil.example'), '')
})
```

- [ ] **Step 2: Run** `node --test tests/agentRoutes.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** the plugin, routes and CORS changes. Then delete the admin and dashboard files. `.env.example` gets `CHAT_AGENT_SECRET=`, `ALLOWED_ORIGINS=https://store.mediko.ph,https://mediko-gateway.quailshack.com`, `GATEWAY_URL=https://mediko-gateway.quailshack.com`, `GATEWAY_ORIGIN=https://mediko-gateway.quailshack.com`, `CHAT_CUSTOMER_URL=https://store.mediko.ph/pages/test-page` and `AI_ENABLED=false`, and drops `ADMIN_SECRET`.
- [ ] **Step 4: Run** `node --test tests/`. Expected: PASS.
- [ ] **Step 5: Commit (C)** `feat: gate agent API behind gateway JWT, remove standalone dashboard`

---

### Task 5 (C): Secure agent WebSocket, presence, live events

**Files:**
- Modify: `src/services/agentService.js`, `src/services/chatEvents.js` (from Task 3), `src/routes/chat.js` (`/listen` subscribe/unsubscribe → presence + `session_updated`)
- Test: `mediko-chatbot/tests/agentWs.test.js`

**Interfaces:**
- Consumes: Task 1, Task 2, `hooks` (Task 3).
- Produces:
  - `authorizeUpgrade(req: { url, headers }, { secret?, gatewayOrigin = process.env.GATEWAY_ORIGIN }): { sub } | null`. The path must be `/api/agent/ws`, `headers.origin === gatewayOrigin`, and the `token` query param must be valid. On failure the upgrade handler writes `HTTP/1.1 401 Unauthorized\r\n\r\n` and destroys the socket.
  - `createPresence()` → `{ add(sessionId, raw), remove(sessionId, raw), isOnline(sessionId): boolean, each(sessionId, fn) }`. Online means one or more subscribers.
  - `isOnline(sessionId)` exported from `agentService.js` (the module-level presence).
  - `broadcast(event)` (renamed from `notifyAgentInbox`).
  - Server → agent events: `connected`, `customer_message {sessionId, message, conversation}`, `agent_sent {sessionId, message}`, `session_updated {sessionId, conversation}`, `customer_typing {sessionId}`.
  - Agent → server commands: `agent_message {sessionId, text}` (1–2000 chars), `typing {sessionId, value}`, `close {sessionId}`, `reopen {sessionId}`. Unknown → `{type:'error'}`. Remove `take_over` and `return_to_ai`.
  - Widget SSE events: `agent_message {message}` (with `message.role='agent'`), `agent_typing {value}`.
  - `hooks.onCustomerMessage(session, message, isFirst)` broadcasts `customer_message`. `hooks.onCustomerTyping` broadcasts `customer_typing`. Task 6 adds alerts.
  - `hooks.onAgentMessage(session, message)`, called from the `agent_message` command after `saveAgentMessage`. Task 6 adds the offline queue.

- [ ] **Step 1: Write failing tests**

```js
test('authorizeUpgrade requires origin + token', () => {
  const ok = { url: `/api/agent/ws?token=${token}`, headers: { origin: 'https://mediko-gateway.quailshack.com' } }
  assert.deepEqual(authorizeUpgrade(ok, { secret: S, gatewayOrigin: 'https://mediko-gateway.quailshack.com' }), { sub: '42' })
  assert.equal(authorizeUpgrade({ ...ok, headers: { origin: 'https://evil.example' } }, { secret: S, gatewayOrigin: 'https://mediko-gateway.quailshack.com' }), null)
  assert.equal(authorizeUpgrade({ ...ok, url: '/api/agent/ws' }, { secret: S, gatewayOrigin: 'https://mediko-gateway.quailshack.com' }), null)
  assert.equal(authorizeUpgrade({ ...ok, url: `/other?token=${token}` }, { secret: S, gatewayOrigin: 'https://mediko-gateway.quailshack.com' }), null)
})
test('presence: two tabs, one closes → still online', () => {
  const p = createPresence(), a = {}, b = {}
  p.add('s1', a); p.add('s1', b); p.remove('s1', a)
  assert.equal(p.isOnline('s1'), true)
  p.remove('s1', b)
  assert.equal(p.isOnline('s1'), false)
})
```

- [ ] **Step 2: Run** `node --test tests/agentWs.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Wire `POST /api/chat/message` → `recordCustomerMessage` → `hooks.onCustomerMessage`, and `/listen` → presence add/remove → broadcast `session_updated`.
- [ ] **Step 4: Manual check:** run `npm run dev`, then use `npx wscat -c "ws://localhost:3001/api/agent/ws" -H "Origin: https://mediko-gateway.quailshack.com"` (no token). Expected: 401. With `?token=<signed test token>`, expect a `connected` event. `curl -XPOST /api/chat/message` should then show a `customer_message` in wscat.
- [ ] **Step 5: Commit (C)** `feat: authenticated agent websocket with presence and live events`

---

### Task 6 (C): Gateway notifier, unanswered alerts, offline-reply queue

**Files:**
- Create: `src/services/gatewayNotifier.js`, `src/services/alertScheduler.js`, `src/services/offlineReplyQueue.js`
- Modify: `src/services/chatEvents.js` (hooks), `src/app.js` (start the scheduler after listen)
- Test: `mediko-chatbot/tests/alerts.test.js`

**Interfaces:**
- Consumes: `signEvent`, `signChatLink` (Task 1); `findAlertCandidates`, `markAlerted`, `agentMessagesToEmail`, `markEmailed`, `getSession` (Task 2); `getUnansweredMinutes` (Task 3); `isOnline` (Task 5).
- Produces:
  - `postChatEvent(type: 'new_conversation'|'unanswered'|'offline_reply', payload: object, { fetchImpl = fetch, now = Date.now } = {}): Promise<boolean>`. It POSTs to `${GATEWAY_URL}/internal/chat-events` with body `JSON.stringify({ type, ...payload })` and the signature headers, and has a 10 s timeout. It logs and returns false on failure and never throws.
  - Payloads: `new_conversation` / `unanswered` → `{ sessionId, name, email, phone, text }`; `offline_reply` → `{ sessionId, name, email, messages: string[], link: \`${CHAT_CUSTOMER_URL}?mdk_chat=${token}\` }`.
  - `shouldAlert(row, minutes: number, now: Date): boolean`. True when `isUnanswered(row)`, `now - last_customer_at >= minutes`, and (`alerted_at` is null or `alerted_at < last_customer_at`).
  - `startUnansweredAlerts({ intervalMs = 60000 } = {}): () => void` (returns a stop function).
  - `createOfflineReplyQueue({ delayMs = 120000, isOnline, send, setTimer = setTimeout, clearTimer = clearTimeout })` → `{ enqueue(sessionId), size() }`. The first enqueue starts a timer, and further enqueues while it is pending do nothing. When the timer fires: if `isOnline` → skip, else `await send(sessionId)`.
  - Hook wiring: when `isFirst`, `onCustomerMessage` calls `postChatEvent('new_conversation', …)` and sets `markAlerted(now)`, so that the first message doesn't also fire an `unanswered` alert N minutes later unless the customer writes again. `onAgentMessage` calls `queue.enqueue` when `!isOnline`. The queue's `send` reads `agentMessagesToEmail`, skips if empty or there is no email, then posts `offline_reply` and calls `markEmailed`.

Alert semantics: the first message is covered by `new_conversation`, which sets `alerted_at`. `unanswered` fires only when the customer has written **again** since the last alert and nobody has answered for N minutes. This also covers a customer writing after an agent reply. `alerted_at < last_customer_at` encodes this.

- [ ] **Step 1: Write failing tests**

```js
const t = (s) => new Date(`2026-11-11T${s}Z`)
test('shouldAlert after N minutes, once per stretch', () => {
  const row = { status: 'open', last_customer_at: '2026-11-11 01:00:00', last_agent_at: null, alerted_at: null }
  assert.equal(shouldAlert(row, 10, t('01:09:00')), false)
  assert.equal(shouldAlert(row, 10, t('01:10:00')), true)
  assert.equal(shouldAlert({ ...row, alerted_at: '2026-11-11 01:10:00' }, 10, t('01:30:00')), false)
  assert.equal(shouldAlert({ ...row, alerted_at: '2026-11-11 01:00:00', last_customer_at: '2026-11-11 01:20:00' }, 10, t('01:30:00')), true)
})
test('offline queue: reconnect within debounce → no send', async () => {
  let fire, online = false, sent = 0
  const q = createOfflineReplyQueue({ isOnline: () => online, send: async () => { sent++ }, setTimer: (f) => { fire = f; return 1 }, clearTimer: () => {} })
  q.enqueue('s1'); q.enqueue('s1')
  online = true; await fire()
  assert.equal(sent, 0)
})
test('offline queue: burst → one send', async () => {
  let fire, sent = 0
  const q = createOfflineReplyQueue({ isOnline: () => false, send: async () => { sent++ }, setTimer: (f) => { fire = f; return 1 }, clearTimer: () => {} })
  q.enqueue('s1'); q.enqueue('s1'); q.enqueue('s1'); await fire()
  assert.equal(sent, 1); assert.equal(q.size(), 0)
})
test('postChatEvent signs ts.body and never throws', async () => {
  process.env.GATEWAY_URL = 'https://gw.test'; process.env.CHAT_AGENT_SECRET = S
  let seen
  const ok = await postChatEvent('unanswered', { sessionId: 'x' }, { now: () => 1000, fetchImpl: async (url, o) => { seen = { url, o }; return { ok: true } } })
  assert.equal(ok, true)
  assert.equal(seen.url, 'https://gw.test/internal/chat-events')
  assert.equal(seen.o.headers['X-Mediko-Signature'], signEvent(seen.o.body, '1000', S))
  assert.equal(await postChatEvent('unanswered', {}, { fetchImpl: async () => { throw new Error('down') } }), false)
})
```

- [ ] **Step 2: Run** `node --test tests/alerts.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement.** Compare MySQL `DATETIME` strings as UTC (`new Date(s.replace(' ', 'T') + 'Z')`), matching the pool's `timezone: 'Z'`.
- [ ] **Step 4: Run** `node --test tests/`. Expected: PASS.
- [ ] **Step 5: Update docs (C):** rewrite `README.md` (architecture without AI-first, endpoints table, WS protocol, env vars, single-instance note) and `DEPLOY.md` (new env, `instances: 1`, removed `/dashboard`).
- [ ] **Step 6: Commit (C)** `feat: staff alerts and offline reply emails via gateway events`

---

### Task 7 (G): Gateway chat backend: token, events, email, settings

**Files:**
- Create: `mediko_gateway_api/lib/chat.js` (CJS, pure helpers), `mediko_gateway_api/test/chat.test.js`
- Modify: `mediko_gateway_api/index.js` (SETTINGS, SECRET_ENV_STATUS, TEMPLATES, recordVars, routes, raw-body mount), `.env.example`
- Test: `node --test test/` (built-in; no dependency)

**Interfaces:**
- Consumes: the event format from Task 6.
- Produces:
  - `lib/chat.js`:
    - `verifyChatEventSignature(rawBody: Buffer|string, timestamp: string, signature: string, secret: string, now = Date.now()): boolean` (5-min window, `timingSafeEqual`, false for a short or missing secret)
    - `chatDeepLink(sessionId: string, base = process.env.SHOPIFY_ADMIN_APP_URL): string` → `${base.replace(/\/$/, '')}/chats/${encodeURIComponent(sessionId)}`
    - `buildStaffAlertMail(event, link): { subject, text, html }`. Subjects: `New chat from ${name}` / `Unanswered chat from ${name}`. The body has name, email, phone, the first 300 chars of `text`, and an "Open in Gateway" link. Everything is HTML-escaped.
  - `index.js`:
    - SETTINGS key `chat_alert_recipients`: `{ group: "Chat", label: "Chat alert recipients", type: "email_list", env: "CHAT_ALERT_RECIPIENTS", default: "", help: "Get an email when a chat starts or goes unanswered." }`
    - SECRET_ENV_STATUS adds `["CHAT_AGENT_SECRET", "Chat service shared secret"]` and `["CHAT_API_URL", "Chat service URL"]`.
    - TEMPLATES key `chat_reply_customer`: `{ group: "Chat", name: "Chat reply (customer offline)", channel: "email", vars: ["name","first_name","messages","link"], subject: "Sumagot na po ang Mediko Support", body: "Hello {{first_name}},\n\nSumagot na po ang Mediko Support sa inyong mensahe:\n\n{{messages}}\n\nPara magpatuloy sa chat, buksan po ito: {{link}}\n\n${SIGNOFF}" }`
    - `recordVars('chat', { full_name: name }, { messages, link })`
    - `POST /api/chat/agent-token` (`requireAdmin`) → `{ token, expiresAt, apiUrl: process.env.CHAT_API_URL }`. It returns 503 `{ error: 'Chat service not configured' }` when either env var is missing. Sign with the Global Constraints JWT spec, `sub: String(req.admin.sub)`.
    - `GET /api/chat/customer?email=` (`requireAdmin`) → `{ customer: { id, adminUrl, ordersCount, lastOrderName } | null }` via `shopifyGraphQL` (`customers(first:1, query:"email:…")`). Return 500 `{ error }` on a Shopify failure, never 502.
    - `POST /internal/chat-events` is mounted with `express.raw({ type: 'application/json', limit: '256kb' })` **above** `express.json()`, and is exempt from CORS like `/api/unsubscribe`. Bad signature → 401. It responds 202 and then does the work: `new_conversation`/`unanswered` → `transporter.sendMail` to `chat_alert_recipients` (skip and log `chat_alert_no_recipients` if empty); `offline_reply` → `sendTemplateEmail('chat_reply_customer', email, recordVars('chat', …))`, where `messages` is joined with a blank line. Log `chat_event_received` without the link.

- [ ] **Step 1: Write failing tests** (`test/chat.test.js`, `node:test`, `require('../lib/chat')`):

```js
const S = 'x'.repeat(32)
const sig = (ts, body) => crypto.createHmac('sha256', S).update(`${ts}.${body}`).digest('hex')
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
test('chatDeepLink', () => assert.equal(chatDeepLink('abc', 'https://admin.shopify.com/store/mediko/apps/gw/'), 'https://admin.shopify.com/store/mediko/apps/gw/chats/abc'))
test('staff mail escapes HTML', () => {
  const m = buildStaffAlertMail({ type: 'new_conversation', name: '<b>x</b>', email: 'a@b.c', phone: '639171234567', text: 'hi' }, 'https://l')
  assert.match(m.subject, /^New chat from/)
  assert.ok(!m.html.includes('<b>x</b>'))
})
```

- [ ] **Step 2: Run** `cd mediko_gateway_api && node --test test/`. Expected: FAIL.
- [ ] **Step 3: Implement** `lib/chat.js` and the `index.js` changes. `.env.example` adds `CHAT_API_URL=`, `CHAT_AGENT_SECRET=` and `SHOPIFY_ADMIN_APP_URL=` (with a comment: open any Gateway page in the Shopify admin and copy the URL up to and including the app handle).
- [ ] **Step 4: Run** `node --test test/`. Expected: PASS. Then run `node index.js`, sign an event locally with the Step 1 helper, and `curl -XPOST localhost:3001/internal/chat-events` with headers. Expected: 202, plus a log line `chat_event_received`. An unsigned request should get 401.
- [ ] **Step 5: Commit (G)** `feat: chat agent tokens, signed chat events and chat emails`

---

### Task 8 (G): Settings "Chat" card

**Files:**
- Modify: `mediko_gateway_api/admin-portal/index.html` (`viewSettings`; new shared helper `chatClient`)

**Interfaces:**
- Consumes: `POST /api/chat/agent-token` (Task 7); `GET/PUT {apiUrl}/api/agent/settings` (Task 4).
- Produces (portal script scope, reused by Task 9):
  - `chatClient`, an object with `token(): Promise<{ token, apiUrl }>` (cached until 30 s before `expiresAt`) and `api(path, { method, body }): Promise<json>` (adds the Bearer header, retries once after a token refresh on 401, and throws `Error(json.error)` like `api()`).
- UI: on the Settings page, an `s-section` heading "Chat". It has office hours per weekday (an `s-switch` for open, and `s-text-field` start and end in `HH:MM`), an away message `s-text-area`, and an `s-number-field` for "Alert when unanswered for (minutes)" with min 1 and max 240. It has its own "Save chat settings" `s-button`, outside the `data-save-bar` form. `chat_alert_recipients` appears automatically in the generated "Chat" group. If `agent-token` returns 503, the card shows an `s-banner tone="warning"` saying "Chat service not configured (CHAT_API_URL / CHAT_AGENT_SECRET)."

- [ ] **Step 1: Implement** `chatClient` and the card.
- [ ] **Step 2: Manual check in the Shopify admin** (dev store), with the chat service running and the `.env` values set. Change Friday's end to 16:00, save, and reload. Expected: the value persists and `curl {chat}/api/chat/config` reflects it. Stop the chat service and reload Settings. Expected: a critical toast or banner, and the rest of the Settings page still works.
- [ ] **Step 3: Commit (G)** `feat: chat settings card in gateway settings`

---

### Task 9 (G): Chats page

**Files:**
- Modify: `mediko_gateway_api/admin-portal/index.html` (nav link, `ROUTES`, `viewChats`, `chatConnection`), `mediko_gateway_api/CLAUDE.md`, `mediko_gateway_api/README.md`
- Create: `mediko_gateway_api/admin-portal/chat-connection.js` (plain script, no build; loaded with a `<script src>` before the main script so it can be unit-tested), `mediko_gateway_api/test/chatConnection.test.js`

**Interfaces:**
- Consumes: `chatClient` (Task 8); agent REST (Task 4); WS protocol (Task 5); `GET /api/chat/customer` (Task 7).
- Produces:
  - `createChatConnection({ getToken: () => Promise<{token, apiUrl}>, WebSocketImpl = WebSocket, onEvent, onStatus, backoffMs = [1000, 2000, 5000, 10000, 30000], setTimer = setTimeout })` → `{ send(cmd), close() }`. It connects to `` `${apiUrl.replace(/^http/, 'ws')}/api/agent/ws?token=${token}` ``. On close it calls `onStatus('offline')`, waits `backoffMs[min(n, last)]`, **fetches a fresh token**, and reconnects. On open it calls `onStatus('online')` and resets the backoff. Exposed as `window.createChatConnection` and `module.exports` when defined.
  - Nav: `<s-link href="/admin-dashboard/chats">Chats</s-link>`, placed right after Home. Routes `[/^\/chats$/, () => viewChats()]` and `[/^\/chats\/([0-9a-f-]{36})$/, viewChats]`.
  - `viewChats(sessionId?)` follows the approved Layout A: an `s-page heading="Chats"` with an unanswered `s-badge tone="attention"`. Three panes go in one `s-section` with layout-glue CSS (`.chat-grid` grid `32% 1fr 24%`, which below 768 px shows one pane at a time with a back button):
    - list: `s-button-group` segmented Open / Unanswered / Closed, an `s-search-field` (debounced 300 ms, calls REST with `q`), and rows with name, preview, relative time and a "New" `s-badge` when `unanswered`
    - thread: header name, an "Online" `s-badge tone="success"` when `online`, and a "Close chat"/"Reopen" `s-button`. Messages: `user` left, `agent`/`assistant` right. "{name} is typing…" for 5 s after `customer_typing`. Composer `s-text-area` with Enter = send and Shift+Enter = newline, and a primary "Send" button. Typing commands are throttled to one per 3 s.
    - details: name, email, phone, and the Shopify panel from `/api/chat/customer` ("View customer" link to `adminUrl`, order count, last order), plus the text "Replies are emailed if the customer is offline."
    - selecting a conversation calls `history.replaceState` to `/admin-dashboard/chats/<id>`, so deep links from email land on it
    - a WS `offline` status shows `s-banner tone="critical"` with "Chat service is offline. Reconnecting…"
    - events update the list and thread in place, with no full re-render of the composer (keep the draft text)

- [ ] **Step 1: Write failing test** (`test/chatConnection.test.js`):

```js
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
```

- [ ] **Step 2: Run** `node --test test/`. Expected: FAIL.
- [ ] **Step 3: Implement** `chat-connection.js`. Make sure `express.static` serves it under `/admin-dashboard/` (check that the SPA fallback doesn't swallow it).
- [ ] **Step 4: Run** `node --test test/`. Expected: PASS.
- [ ] **Step 5: Implement** the nav, routes and `viewChats`.
- [ ] **Step 6: Manual check in the Shopify admin**, with the widget dev server running against the local chat service:
  - (a) Start a chat in the widget. It appears in the list live with "New".
  - (b) Reply from Gateway. It appears in the widget instantly as "Mediko Support".
  - (c) Typing on either side shows the indicator.
  - (d) Close the chat, then write from the widget. The chat reopens under Open.
  - (e) Open the deep link `/admin-dashboard/chats/<id>`. That chat is selected.
  - (f) Kill the chat service. The banner shows. Restart it. The page reconnects without a reload.
- [ ] **Step 7: Update docs (G):** in `CLAUDE.md`, add a "Live chat" section (token route, internal events and signature, the `chat_reply_customer` template, now 13 template keys, the `chat_alert_recipients` setting, the Chats page, how to run `node --test test/`). Note in Commands that `node --test test/` exists while `npm test` stays as is. In `README.md`, list the new routes.
- [ ] **Step 8: Commit (G)** `feat: live chats page in gateway`

---

### Task 10 (W): Widget: pre-chat form, human-only flow, resume link

**Files:**
- Modify: `mediko-widget/src/hooks/useChat.js`, `src/components/ChatWidget.jsx`, `src/components/Message.jsx`, `src/widget.css`, `.env.example` (drop the `VITE_SUPABASE_*` lines)
- Create: `mediko-widget/src/prechat.js` (pure validation)
- Test: `mediko-chatbot/tests/widget.test.js`. It runs with the chatbot's `node --test`, the way the existing widget structural tests do, by importing `../../mediko-widget/src/prechat.js` (ESM, no JSX).

**Interfaces:**
- Consumes: `/api/chat/config`, `/session`, `/message`, `/typing`, `/resume`, `/history`, `/listen` (Tasks 3 and 5).
- Produces:
  - `validatePrechat({ name, email, phone }): { ok: true, value: { customerName, customerEmail, customerPhone } } | { ok: false, errors: { name?, email?, phone? } }`. Name 1–100 trimmed; email `^[^\s@]+@[^\s@]+\.[^\s@]+$`; phone `^(\+639|09)\d{9}$` after stripping spaces and dashes. Error copy: name `'Pakilagay po ang inyong pangalan.'`, email `'Pakilagay po ang tamang email.'`, phone `'Pakilagay po ang tamang mobile number (09XXXXXXXXX).'`
  - `readResumeToken(search: string): string | null` (reads `mdk_chat`)
  - `useChat` (AI off path): it exposes `{ messages, agentTyping, needsPrechat, online, nextOpenAt, error, startChat(prechatValue), sendMessage(text), notifyTyping(), resetSession }`. On mount: fetch config. If `mdk_chat` is in the URL, call `/resume`; on 200, store the sessionId, auto-open, and remove the param with `history.replaceState`; on 410, ignore it. Otherwise restore from `localStorage`. With a session, load history and **always** open the `/listen` SSE. Without one, `needsPrechat = true`. `sendMessage` POSTs `/message` and shows `away` once per page view when it is present. Map history roles: `agent`/`assistant` → staff bubble labeled "Mediko Support". When `config.aiEnabled` is true, keep the old streaming path (leave that code, behind the flag).
  - Remove quick-reply fetch, state and UI, the "type agent" mode banner, and `mode_changed` handling.
  - Header copy: online → "Online · karaniwang sumasagot sa loob ng ilang minuto"; offline → `"Offline · babalik ${formatted nextOpenAt}"`, formatted in `Asia/Manila` like `Lun 8:00 AM`. Pre-chat intro: "Bago tayo magsimula, pakilagay po ang inyong detalye:" plus a privacy line: "Gagamitin lang po namin ang inyong detalye para sagutin ang inyong mensahe." (The final privacy wording is the owner's call. Flag it in the PR.)
  - If a logged-in Shopify customer is passed in via `window.MEDIKO_CUSTOMER = { name, email, phone }` from the theme, prefill the form.

- [ ] **Step 1: Write failing tests**

```js
test('validatePrechat requires all three', async () => {
  const { validatePrechat } = await import('../../mediko-widget/src/prechat.js')
  const r = validatePrechat({ name: ' ', email: 'x', phone: '123' })
  assert.equal(r.ok, false)
  assert.deepEqual(Object.keys(r.errors).sort(), ['email', 'name', 'phone'])
  const ok = validatePrechat({ name: 'Maria', email: 'm@e.ph', phone: '0917 123 4567' })
  assert.equal(ok.ok, true)
  assert.equal(ok.value.customerPhone, '0917 123 4567'.replace(/[\s-]/g, ''))
})
test('readResumeToken', async () => {
  const { readResumeToken } = await import('../../mediko-widget/src/prechat.js')
  assert.equal(readResumeToken('?a=1&mdk_chat=abc.1.sig'), 'abc.1.sig')
  assert.equal(readResumeToken(''), null)
})
```

- [ ] **Step 2: Run** `cd mediko-chatbot && node --test tests/widget.test.js`. Expected: FAIL.
- [ ] **Step 3: Implement** `prechat.js`, then the hook and component changes. Update the existing structural test in `tests/chat.test.js` for `useChat` (assert `'/api/chat/message'`, `'/listen/'`, `'mdk_chat'`, `localStorage` instead of the AI event cases).
- [ ] **Step 4: Run** `node --test tests/`. Expected: PASS. Run `cd ../mediko-widget && npm run build`. Expected: the build succeeds.
- [ ] **Step 5: Manual check** (`./start-dev.sh`):
  - (a) The form blocks a bad phone with the Filipino error.
  - (b) Outside the configured hours (temporarily set the hours in the Gateway card), the header says Offline with the next opening, and the first message shows the away text.
  - (c) Close the tab, reply from Gateway, and wait 2 min. Brevo delivers the "Sumagot na po…" email, and its link reopens the same chat on the test page.
  - (d) Same as (c), but reopen the tab within 2 min. No email arrives.
- [ ] **Step 6: Commit (W)** `feat: pre-chat form and human-only live chat`

---

## Rollout (after all tasks; owner runs these)

1. Generate `CHAT_AGENT_SECRET` (`openssl rand -hex 32`) and set it in both server `.env` files. Set `CHAT_API_URL` and `SHOPIFY_ADMIN_APP_URL` in Gateway, and `GATEWAY_URL`, `GATEWAY_ORIGIN`, `ALLOWED_ORIGINS`, `CHAT_CUSTOMER_URL` and `AI_ENABLED=false` in the chat service. Remove `ADMIN_SECRET`.
2. Deploy the chat service (the migration runs at boot), then Gateway, then rebuild the widget and update the asset on the test page.
3. In Gateway Settings, add the chat alert recipients and confirm the Chat card hours.

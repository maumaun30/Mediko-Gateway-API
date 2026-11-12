# Live agent chat in Mediko Gateway — design

Date: 2026-11-11
Repos touched: `mediko-widget`, `mediko-chatbot`, `mediko_gateway_api`

## Intent

Mediko wants real-time chat between storefront customers and Mediko staff, with
agents working inside the MedikoPH Gateway embedded Shopify app. The current
chat stack is built around a Gemini AI assistant, but AI API costs can't be
justified right now. So for now the chat goes **straight to a human**. The AI
code stays in the codebase, switched off, so it can come back later without a
rebuild.

The work also simplifies the current setup. Today agents use a separate
standalone `/dashboard` page on the chat service with one shared password. The
agent WebSocket (`/api/agent/ws`) has **no authentication at all**: anyone who
knows the URL can read live customer messages and reply as Mediko. Both go away.

## Current state (as of 2026-11-11)

- **`mediko-widget`** (React + Vite) is built and embedded on
  `https://store.mediko.ph/pages/test-page` only. It is anonymous and keeps a
  session id in `localStorage`. It streams AI replies from `POST /api/chat` and
  listens for agent replies on SSE `GET /api/chat/listen/:sessionId`. Brand
  theme in `src/widget.css`: primary `#187adc`, secondary `#ffb73a`, Poppins.
- **`mediko-chatbot`** (Fastify + MySQL + Gemini) is the conversation backend:
  tables `chat_sessions`, `chat_messages`, `chat_quick_replies`,
  `chat_settings`, `chat_keywords`. It has an AI-first flow with keyword
  handoff to a human ("agent", "tulong", …) and `AI_ENABLED=false`, which
  auto-hands off. The agent inbox is an in-process `ws` broadcast at
  `/api/agent/ws` (no auth) plus `/api/admin/*` REST behind `ADMIN_SECRET`
  (open if unset). The standalone dashboard is at `/dashboard`. WhatsApp and
  Messenger adapters exist but are not live.
- **`mediko_gateway_api`** (Express 5 + MySQL + Polaris web components) is the
  embedded Shopify admin (`/admin-dashboard/`). Auth is the Shopify session
  token via `requireAdmin`. It sends email through Brevo SMTP (nodemailer,
  `sendTemplateEmail`) and has a Settings page and an editable Templates page.
  Its "Messages" page is **contact-form submissions**, not chat, and stays
  as is.

## Goals

1. Customers chat with Mediko staff in real time from the storefront widget.
   No AI in the path.
2. Agents answer from a new **Chats** page inside MedikoPH Gateway, using their
   Shopify staff login. No second app, no shared password.
3. Staff get **email alerts** (to a recipient list set in Gateway Settings) for
   new conversations and for unanswered ones. The alerts go out at any hour and
   link straight to the chat in Gateway.
4. Customers who aren't online when an agent replies get the reply **by
   email**.
5. AI stays dormant behind one switch, ready for later.
6. Close the unauthenticated agent WebSocket hole.

## Non-goals (for now)

- AI replies, AI handoff keywords, off-topic filtering. These stay in code but
  are inactive.
- WhatsApp or Messenger. Ruled out because Meta charges for business-initiated
  messages. Leave the adapters in place, but unused.
- Chat assignment or ownership. Every agent sees every chat.
- SMS alerts, browser push notifications.
- Rolling the widget out store-wide. It stays on the test page until the owner
  decides.
- Merging the chat service into the Gateway codebase.

## Decisions made with the owner

- **Layout: "Option A"** (approved from mockup). A three-pane Chats page:
  conversation list | live thread | customer panel.
  - List: segmented filter **Open / Unanswered / Closed**, search by name,
    email or phone. Each row shows name, last message preview, relative time,
    and a "New" badge for unanswered chats.
  - Thread: header with customer name, an Online badge when their widget is
    connected, and a "Close chat" button. Messages are customer (left, white)
    and agent (right, dark). "… is typing" indicator. Composer with a
    text input and Send. **No quick replies** (owner decision, see below).
  - Customer panel: name, email, phone. Shopify customer link and order count
    when the email matches a Shopify customer. A note that replies are emailed
    if the customer is offline.
- **Theme:** the Gateway page uses Polaris web components, the same look as
  Senior/PWD and Returns ("Polaris owns the look"; use layout glue CSS only).
  The widget keeps its current Mediko brand theme.
- **Pre-chat form in widget:** **name, email and mobile number, all required.**
  Mobile is normalized to `639XXXXXXXXX`, the same rule the Gateway already uses
  for SMS. Collected before the first message.
- **Staff email alerts**, sent to a recipient list in Gateway Settings:
  - when a new conversation starts (first customer message)
  - when a customer writes in a conversation with no agent reply for **N
    minutes**
  - never for every message in a conversation that is actively being answered
  - sent at any hour, including outside office hours
  - each email: customer name, email and phone, first lines of the message,
    and an "Open in Gateway" button deep-linking to that chat
- **Offline customer email:** when an agent replies and the customer's widget is
  not connected, email the reply to the customer automatically, with a link back
  to the store that reopens the chat.
- **Office hours:** agents work **8:00–17:00 Mon–Fri, Asia/Manila**. Outside
  hours the widget shows an "offline" status and an away message, and still
  accepts messages.
- **Quick replies removed entirely.** No customer suggestion chips in the widget
  and no agent canned replies. Remove `routes/quickReplies.js`,
  `quickReplyService.js`, the widget's `fetchQuickReplies` and chip UI, and the
  seed rows. Leave the `chat_quick_replies` table in place (harmless) or drop
  it. That's the builder's choice.
- **Agent identity:** customers see every agent reply as **"Mediko Support"**.
  No per-agent names, and no display-name setting.
- **Architecture:** the chat backend stays its own service (`mediko-chatbot`).
  Gateway integrates with it. (Proposed by Claude, approved by the owner.)

## Design

### Conversation flow (AI off)

1. Customer opens the widget. If there is no stored session, the widget shows
   the pre-chat form. Submitting it creates a session with name, email and phone
   via `POST /api/chat/session`.
2. Customer sends a message. It is saved as `role='user'`, the session is marked
   open and unanswered, and the event is pushed to connected agents. If this is
   the first message, a staff "new conversation" alert is triggered.
3. An agent replies from Gateway. The reply is saved as `role='agent'` and pushed
   to the widget over the existing SSE `/api/chat/listen/:sessionId`. If no SSE
   subscriber is connected for that session, the customer is emailed.
4. "Close chat" sets the conversation to closed. If the customer writes again,
   the **same** conversation reopens with full history. *(Claude's call.)*

With AI off, new sessions start in `mode='agent'`. There is no handoff
acknowledgement message and no keyword detection. The AI branch in
`conversationManager.processMessage` and the AI streaming in `routes/chat.js`
run only when `AI_ENABLED=true`. When the flag is off, those modules are never
called (no Gemini calls, no Shopify product lookups per message). *(Claude's
call:)* keep `AI_ENABLED` as the single switch, defaulting to `false`.

### Data model changes (`mediko-chatbot`)

Add to `chat_sessions` (idempotent migration at boot or in `schema.sql`):

- `customer_name VARCHAR(255)`, `customer_phone VARCHAR(20)`. `customer_email`
  already exists.
- `status VARCHAR(10) NOT NULL DEFAULT 'open'`, either `open` or `closed`.
- `last_customer_at DATETIME(3) NULL`, `last_agent_at DATETIME(3) NULL`. "Unanswered"
  means `status='open' AND last_customer_at IS NOT NULL AND (last_agent_at IS NULL
  OR last_agent_at < last_customer_at)`.
- `alerted_at DATETIME(3) NULL`, the last time a staff alert went out for this
  session. Used for throttling.
- Index on `(status, last_customer_at)`.

`chat_messages.role` is a free `VARCHAR(16)`. Today `saveAgentMessage` writes
agent replies as `role='assistant'` with content prefixed `"[Agent] "`.
*(Claude's call:)* new agent replies are stored as `role='agent'` with no prefix.
A boot-time migration converts existing `assistant` rows starting with
`"[Agent] "` to `role='agent'` and strips the prefix. The widget history
renders `agent` as a staff bubble. When AI comes back, `loadHistory` maps
`agent` to the model's assistant role.

`closeIdleSessions` is imported in `app.js` but never scheduled, so it is dead
code today. *(Claude's call:)* delete it.

`AI_ENABLED` is currently treated as on unless it is exactly `'false'`, and
`.env.example` ships `true`. Change the code so AI is on **only** when
`AI_ENABLED === 'true'`, and set `.env.example` to `false`.

`POST /api/chat/session` today accepts only `customerEmail` and `metadata`. Add
required `customerName` and `customerPhone`, and validate the phone with the
Gateway's PH regex `^(\+639|09)\d{9}$` before normalizing.

Existing latent bug to fix along the way: `routes/chat.js` reads
`bh?.away_message`, but the seed and `getAwayMessage` use `awayMessage`.

### Agent auth: Gateway → chat service

*(Claude's call.)* Gateway is the only agent client. Flow:

- New Gateway route `POST /api/chat/agent-token` (`requireAdmin`). It returns a
  short-lived JWT (about 5 min, HS256, `iss: mediko-gateway`,
  `aud: mediko-chat`) signed with a new shared secret `CHAT_AGENT_SECRET`
  (32+ chars), which is set in both services' `.env`. Claims: `sub` = Shopify
  staff user id (the session token has no email), used for logging only.
- The chat service verifies this JWT on:
  - the agent WebSocket upgrade (`/api/agent/ws?token=…`). If it is invalid,
    reject the upgrade with 401 and destroy the socket.
  - every agent REST route (list conversations, history, close/reopen, chat
    settings) via an `Authorization: Bearer` header.
- The browser in Gateway gets the token from Gateway, then talks to the chat
  service directly for WS and REST. It refreshes the token before expiry and on
  WS reconnect.
- CORS on the chat service today allows one origin (`WIDGET_ALLOWED_ORIGIN`) and
  only `GET, POST, OPTIONS`. Change it to an allowlist (`ALLOWED_ORIGINS`,
  comma-separated: the store origin and `https://mediko-gateway.quailshack.com`)
  and add `PUT, PATCH, DELETE` and the `Authorization` header. Browsers don't
  apply CORS to WebSockets, so the WS upgrade checks both the `Origin` header
  (Gateway origin only) and the token.
- Rate limits: JWT-authenticated agent routes skip the global 20/min per-IP
  limit, because agents share an office IP. Public widget routes keep their
  limits. *(Claude's call.)*
- Remove `ADMIN_SECRET` auth and the `/dashboard` route and HTML. All
  `/api/admin/*`, `/api/keywords`, `/api/analytics`, all of `/api/settings`
  (including today's public business-hours GET) move behind the JWT check. Public routes that stay
  public: `GET /api/chat/config`, the widget's chat/session/history/listen
  routes, and `GET /api/products/*` (AI-era, left as is).
- `GET /api/chat/config` is extended so the widget can show status without the
  settings API: `{ aiEnabled, online, nextOpenAt, awayMessage }`, computed
  server-side from `business_hours` in Asia/Manila.

### Agent WebSocket protocol

Keep the current JSON event and command shape. Trim it to:

- Server → agent: `connected`, `customer_message {sessionId, text, ts}`,
  `agent_sent {sessionId, text, ts}` (so other agents' screens update),
  `session_updated {sessionId, status, unanswered, online}`,
  `customer_typing {sessionId}`.
- Agent → server: `agent_message {sessionId, text}`, `typing {sessionId, value}`,
  `close {sessionId}`, `reopen {sessionId}`.
- Drop `take_over` and `return_to_ai` while AI is off. Keep them in code behind
  the flag if that's cheap; otherwise remove them and note it for later.

Online presence: a session is "online" while it has at least one widget SSE
subscriber (`widgetSubscribers` map). Emit `session_updated` on subscribe and
unsubscribe.

Single-process limit: live state is in memory, so the chat service must run as
**one instance** (pm2 `instances: 1`). Document this. No Redis.

### Gateway Chats page (`mediko_gateway_api/admin-portal`)

- Add `<s-link href="/admin-dashboard/chats">Chats</s-link>` to `s-app-nav`
  (after Home). Route `chats[/:sessionId]` goes in the `ROUTES` table and maps to
  `viewChats`. The deep link from emails is
  `https://admin.shopify.com/store/<store>/apps/<app-handle>/admin-dashboard/chats/<sessionId>`,
  or whatever form the existing portal links use.
- Three-pane layout as in "Decisions". Build with Polaris web components and
  the existing layout-glue CSS. On narrow widths, collapse to list → thread →
  details, one at a time.
- Live updates over the agent WS. Unanswered count badge in the page title.
- Customer panel Shopify lookup: Gateway already has Admin API access
  (`read_customers`, `read_orders`). Add a small `requireAdmin` endpoint that
  looks up a customer by email and returns the id, order count and last order
  name.

### Gateway Settings: new "Chat" section

- **Alert recipients:** list of emails. New `SETTINGS` registry key
  `chat_alert_recipients` (stored in `app_settings`, read with `getSetting` at
  use time, form auto-generated, like `admin_cc`).
- **Unanswered alert after N minutes:** default **10**. *(Claude's call.)* Stored
  in the chat service's `chat_settings` (`unanswered_minutes`), because the chat
  service runs the timer. It is edited on the Gateway "Chat" settings card next
  to office hours. (Planning decision for "how N reaches the chat service".)
- `CHAT_API_URL` and `CHAT_AGENT_SECRET` are infrastructure, so they go in
  `.env` only and never in `app_settings` (per "Settings vs secrets").
- **Office hours and away message:** these already live in the chat service's
  `chat_settings.business_hours`. Edit them from Gateway through the chat
  service's JWT-protected `/api/settings` endpoints. Set the default to Mon–Fri
  08:00–17:00 and `enabled: true`. (The seed currently has 08:00–18:00, disabled.)

### Email (all sent by Gateway via Brevo)

*(Claude's call.)* Email stays in one place, the Gateway. The chat service
notifies Gateway of chat events. It does not send email itself.

- New Gateway endpoint `POST /internal/chat-events`. It is not
  `requireAdmin`. Auth: `X-Mediko-Signature` = hex HMAC-SHA256 of
  `"<timestamp>.<raw body>"` with `CHAT_AGENT_SECRET`, plus an `X-Mediko-Timestamp` header that must be
  within 5 minutes (for replay protection). Mount it with a raw-body parser,
  the same way as the Shopify webhook. *(Claude's call.)* Payloads:
  - `{type:'new_conversation', sessionId, name, email, phone, text}`
  - `{type:'unanswered', sessionId, name, email, phone, text}`
  - `{type:'offline_reply', sessionId, name, email, agentText}`
- The chat service decides when to fire:
  - `new_conversation`: on the first customer message of a session.
  - `unanswered`: a timer in the chat service. Every minute, find sessions that
    have been unanswered for at least N minutes, where `alerted_at` is null or
    earlier than `last_customer_at`. Fire once and set `alerted_at = now`, so
    there is at most one alert per unanswered stretch. The chat service reads N
    from Gateway, or Gateway sends it with the settings save. The builder
    decides.
  - Alerts fire around the clock, including off hours. The owner said
    notifications should still work outside office hours.
  - `offline_reply`: on `agent_message` when the session has no SSE subscriber.
    *(Claude's call:)* debounce for 2 minutes. When the timer fires, re-check:
    if the customer has reconnected, skip the email. Otherwise send one email
    with every agent message since the customer's last message.
- Staff alerts (`new_conversation`, `unanswered`) follow the existing
  convention that admin notification emails are **not templated**. They are
  plain built-in emails like the current admin notifications. The customer
  email (`offline_reply`) **is** templated: add one new key,
  `chat_reply_customer`, to `TEMPLATES`, with a new `recordVars` kind `chat`
  (vars `name`, `messages`, `link`). It is editable on the Templates page.
- The customer email link points to the store page where the widget lives and
  carries a **signed, expiring token**: `?mdk_chat=<token>`, where the token is
  an HMAC over `sessionId` + expiry with `CHAT_AGENT_SECRET`, valid 14 days. The
  chat service verifies it, and the widget then restores that session and opens.
  An expired link opens the widget fresh. This keeps a forwarded or old email
  from exposing the conversation and the customer's details forever. *(Claude's
  call, for Data Privacy Act reasons.)* Don't log full links.
- Gateway reports `CHAT_API_URL` and `CHAT_AGENT_SECRET` as set / not set in
  `SECRET_ENV_STATUS`. If the chat service is unreachable, the Chats page shows a
  critical banner ("Chat service is offline") and retries the WS with backoff.
- Failures to send email are logged and never fail the chat action.

### Widget changes (`mediko-widget`)

- Pre-chat form (name, email, mobile, all required, with client-side validation
  plus server-side validation in the session schema). Filipino copy, matching
  the current tone. Prefill from the logged-in Shopify customer when the theme
  passes it in. *(Claude's call.)*
- With AI off: send via a simple non-streaming `POST /api/chat/message`, or the
  existing endpoint returning plain JSON (builder's choice). Open the SSE listen
  stream as soon as a session exists, not only in agent mode.
- Header status: "Online · usually replies in minutes" during office hours,
  "Offline · back <next opening>" outside them. Outside hours, show the away
  message after the customer's first message, mentioning that the reply will
  also go to their email.
- Handle `?mdk_chat=<sessionId>` to restore the session and auto-open.
- Typing indicator for agent typing (already partly supported).
- Remove the unused Supabase env vars from `.env.example`.

## Constraints

- Gateway error responses must keep upstream messages visible through
  Cloudflare (see the status code rule in `mediko_gateway_api/CLAUDE.md`).
- The chat service runs as a single instance (in-memory live state).
- No paid messaging APIs.
- Customer contact data (name, email, phone) is personal data under the PH Data
  Privacy Act. Show a one-line notice on the pre-chat form that details are used
  to reply to the inquiry. Final wording is the owner's call.
- No AI attribution in commits or PRs (owner's global rule).

## Left to the builder

- Exact REST paths and payloads for agent list, history and pagination in the
  chat service.
- Whether the widget uses a new non-streaming send endpoint or reuses `POST
  /api/chat`.
- How N minutes reaches the chat service.
- Migration mechanism (`schema.sql` plus a boot-time `ALTER … ADD COLUMN IF NOT
  EXISTS`-style check).
- Existing anonymous sessions: leave them. They have no name, email or phone and
  show as "Unknown visitor" in the list.
- Tests: extend `mediko-chatbot/tests/chat.test.js` for the AI-off flow,
  JWT-gated WS upgrade, unanswered-alert throttling, and offline-reply
  debounce.
- Docs: update `mediko-chatbot/README.md` and `DEPLOY.md`, and
  `mediko_gateway_api/CLAUDE.md` and `README.md`.

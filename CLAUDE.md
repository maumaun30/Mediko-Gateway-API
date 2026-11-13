# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `node index.js` — start the API (defaults to port 3001, override with `PORT`).
- `npm install` — install dependencies. There is no build step and no linter. `npm test` still exits 1 by design.
- `node --test test/*.test.js` — unit tests for the live-chat helpers (`lib/chat.js`, `admin-portal/chat-connection.js`). Node 26 rejects a bare `node --test test/`, so keep the glob.
- Copy `.env.example` to `.env` before running — the app will boot without it but DB, mailer, and Shopify calls will all fail.
- `TESTING_MODE=true` in `.env` disables the rate limiter, time-trap, and per-email cooldown on `/api/apply`, `/api/contact`, `/api/returns`. Local/staging only — never prod.

## Deployment

`.github/workflows/deploy.yml` deploys on push to `main`: rsyncs to a CloudPanel host (excluding `node_modules`, `uploads`, `.env`, `.git*`), then `pm2 restart all` over SSH. Required GitHub secrets: `SSH_PRIVATE_KEY`, `SSH_USER`, `SSH_HOST`, `SSH_DOMAIN`. Server-side `.env` and `uploads/` are preserved across deploys — do not rely on committed copies.

## Architecture

The entire backend lives in **`index.js`** (~1660 lines). It's a single Express 5 app — no router files, no service layer, no ORM. Helpers, mailer templates, Shopify glue, and route handlers are all in this one file. When changing behavior, expect to read the whole file rather than navigate by module.

### Three form pipelines, one shape

`/api/apply`, `/api/contact`, `/api/returns` all follow the same pattern and share the same anti-abuse stack:

1. `submitLimiter` (express-rate-limit, 3/15min/IP, skipped under `TESTING_MODE`)
2. Field validation (PH phone regex `^(\+639|09)\d{9}$`, email regex, length checks)
3. **Time trap** — rejects if `form_loaded_at` POST field is < 3s old (silent 200 success)
4. **Dynamic honeypot** — any field name starting with `hp_` triggers silent 200 success if filled. The frontend is expected to inject a randomly-named `hp_*` field.
5. **Cooldown** — DB query for recent same-email (and same id_number / order_number) submissions within 2 minutes; duplicates return success without inserting.
6. Insert + immediate 200 response, then fire-and-forget email via `sendApplicationEmails` / `sendContactEmails` / `sendReturnEmails` (errors logged, never surfaced to the client).

If you add a new form endpoint, replicate this exact ordering — the silent-success on time trap and honeypot is intentional (don't tell bots they were caught).

### Database

MySQL via `mysql2` connection pool. Three tables: `applications`, `contact_submissions`, `return_requests`. There is **no migrations directory** — schema is enforced at boot by `ensureContactTable()` / `ensureReturnsTable()` / `ensureStatusColumn()` using `CREATE TABLE IF NOT EXISTS` and `ensureColumn()` (which checks `INFORMATION_SCHEMA.COLUMNS` then `ALTER TABLE ADD COLUMN`). To add a column, add an `ensureColumn(...)` call — do not write external migration scripts. The `applications` table is assumed to pre-exist (no `CREATE TABLE` for it); only its added columns are auto-migrated.

### Admin auth

The portal is **admin-only**: it works only embedded in the Shopify admin. There is no password login.

`requireAdmin` accepts either of two bearer tokens:

- **A Shopify session token (current portal).** App Bridge v4 attaches a fresh one to every `fetch()` to this domain automatically. `requireAdmin` verifies it per request with `verifyShopifySessionToken()` (below) and sets `req.admin = { sub, shop, sid }`.
- **A dashboard JWT (older portal builds),** obtained like this:

1. The portal gets a Shopify session token from App Bridge (a JWT, HS256-signed with `SHOPIFY_CLIENT_SECRET`, ~60s life) and sends it to `POST /api/auth/shopify` as `Authorization: Bearer`.
2. `verifyShopifySessionToken()` checks it the way Shopify documents: HS256 signature, `exp`/`nbf` (5s clock tolerance), `aud` = app client ID (`SHOPIFY_CLIENT_ID`, else read from `shopify.app.toml`), `iss` and `dest` on the same host. It also pins `dest` to `SHOPIFY_SHOP_DOMAIN`, so tokens for any other shop are refused.
3. On success it mints a 15-minute dashboard JWT (HS256, `iss: mediko-gateway`, `aud: mediko-admin`, `sub` = Shopify staff user ID) signed with `DASHBOARD_JWT_SECRET`. The portal renews it in the background and re-exchanges silently on any 401.

Every admin route uses the `requireAdmin` middleware, which pins the algorithm, issuer and audience. `DASHBOARD_JWT_SECRET` must be 32+ characters; without it, admin routes return 503 (there is no fallback secret). `adminName(req)` labels who did something as `staff #<sub>`. Rejected session tokens log `shopify_session_rejected` with the reason.

The unsubscribe HMAC (`unsubscribeToken`) still uses `DASHBOARD_JWT_SECRET` with its old fallback, so links already sent keep working; changing that secret invalidates old unsubscribe links.

### Message templates

Customer-facing emails and SMS come from the `TEMPLATES` registry in `index.js`, with overrides in the `message_templates` table (edited on the portal's **Templates** page). There are 13 keys: `application_received|approved|rejected` (+ `_sms` for approved/rejected), `return_received|approved|rejected` (+ `_sms`), `contact_received`, `shipping_sms`, and `chat_reply_customer` (see **Live chat**). Syntax: `{{var}}`; `[[ … ]]` is an optional part, dropped when any var inside is empty; in email, a blank line is a paragraph and `**bold**` works. Everything is HTML-escaped before formatting. `renderEmail()` produces subject + text + HTML; `renderSms()` produces ASCII text, and for `shipping_sms` it drops the link if it would push past 160 chars. Variables come from `recordVars(kind, row, extra)`. Routes (all `requireAdmin`): `GET /api/templates`, `PUT /api/templates` (`{ templates: { key: { subject, body } } }`), `DELETE /api/templates/:key` (reset to default), and `GET /api/templates/fill/:kind/:id/:status` (filled text for the confirm dialog, with `{{reason}}` kept). Admin notification emails (new application, contact message, return request, chat alerts) are not editable templates: they share one branded layout in `lib/adminEmail.js` (`renderAdminEmail`: logo header, status pill, detail rows, message boxes, button to the record in Gateway via `gatewayLink`, metadata footer, plus a plain-text version). Email-safe markup only (tables, inline styles); the logo is `admin-portal/mediko-logo-email.png` (PNG, since mail clients block SVG) loaded from `PUBLIC_BASE_URL`. Every value is escaped there.

### Decision notifications

`PATCH /api/submissions/:id/status` and `PATCH /api/return-requests/:id/status` take an optional `notify: { email, sms, email_subject?, email_body?, sms_text? }`. Email defaults to **on** (old clients keep their behavior); SMS defaults to **off**. The `email_*`/`sms_text` fields are per-send edits of the template text, and placeholders still work in them. `notifyDecision()` sends via `sendTemplateEmail()` and `sendDecisionSms()`. The response carries `notified: { email, sms }`, where `sms` is `"off"`, `"sent"`, `"skipped: …"` or `"failed: …"`; an SMS failure never fails the status change. In the portal, every approve, reject, resolve and reopen goes through `openDecision`, which prefills the email/SMS from the templates for that customer. Messages have no notification options.

### Shopify integration

**Discount codes are discontinued.** Approving an application only sets its status and (optionally) emails/texts the customer; nothing is created or deleted in Shopify, and the old discount helpers, the `discount-usage` route, the `discount_*` settings and the `read_discounts`/`write_discounts` scopes were removed. The `discount_*` columns on `applications` are kept (legacy data) but no longer written or shown.

Shopify is used for: order assignment (`/api/submissions/:id/orders`, `assign-order`, which tags the order and customer PWD/SC), refund marks (`/refund`), the shipping-SMS webhook and order phone lookup, and `GET /api/shopify/scopes`. If Shopify env vars are absent, those routes return 503.

### Email blasts

Admin bulk email under `/api/blasts*` (all `requireAdmin`). The audience comes from `applications` / `contact_submissions` / `return_requests` filtered by status, plus pasted addresses. It is deduplicated and excludes `email_unsubscribes`. Tables: `email_blasts`, `email_blast_recipients` (one row per recipient), `email_unsubscribes`, all created by `ensureBlastTables()`. `runBlast` sends one mail per recipient (never BCC), one after another, waiting the `email_blast_delay_ms` setting between sends. It runs in-process with no queue, so blasts still `sending` at boot are marked `interrupted` and can be resumed from the portal. `/api/unsubscribe` is public and HMAC-token-guarded. It is exempt from CORS because its own form posts back to this host. Unsubscribe links use `PUBLIC_BASE_URL`.

### SMS shipping notifications

`POST /webhooks/shopify/fulfillments-create` (declared in `shopify.app.toml`, needs `read_fulfillments`) texts the customer via Semaphore when an order ships. It is mounted **above** the global `express.json()` because HMAC verification needs the raw body; the secret is `SHOPIFY_WEBHOOK_SECRET` or else `SHOPIFY_CLIENT_SECRET`. Flow: verify HMAC, skip non-`success` fulfillments, `INSERT IGNORE` into `sms_notifications` (unique `fulfillment_id`, so webhook retries never double-text), respond 200, then pick a phone number (fulfillment `destination.phone`, else the order's shipping/order/billing/customer phone via GraphQL), normalize to `639XXXXXXXXX`, send, and record `sent` / `failed` / `skipped` on the row. Messages are kept ASCII and within 160 chars (one credit); the tracking link is dropped if it would overflow. The Semaphore key comes only from `SEMAPHORE_API_KEY` in `.env`; on/off and sender name are portal settings (see **Settings vs secrets**). `GET /api/sms/settings` is a read-only status for the SMS tabs. Other `requireAdmin` routes: `GET /api/sms/account` (credit balance, cached 60s because Semaphore rate-limits it), `GET /api/sms/notifications` (log with `status` / `search` filters), `POST /api/sms/notifications/:id/retry` (failed or skipped rows; optional `{ "phone" }` for orders that had no number), `POST /api/sms/test` (`{ "number" }`).

### SMS blasts

Admin bulk SMS under `/api/sms-blasts*` (all `requireAdmin`), a copy of the email blast design: audience from the same `BLAST_SOURCES` by status (using each row's `contact_number`) plus pasted numbers (split on newlines/commas/semicolons, not spaces), normalized to `639XXXXXXXXX`, deduplicated, minus `sms_optouts`. Tables `sms_blasts`, `sms_blast_recipients`, `sms_optouts`, created by `ensureSmsBlastTables()`. `runSmsBlast` sends one Semaphore request per recipient (so `{{name}}` can become the first name), waiting the `sms_blast_delay_ms` setting between sends; blasts still `sending` at boot become `interrupted` and can be resumed. Message text is forced to ASCII and capped at 459 chars (3 SMS). Messages starting with "TEST" are rejected because Semaphore silently drops them. There is no SMS reply/unsubscribe channel: admins manage `/api/sms-optouts` by hand in the portal. Opt-outs only block blasts, not shipping notifications.

### Admin SPA

`admin-portal/index.html` is one static file: a native Shopify embedded app built with **Polaris web components** (`s-page`, `s-section`, `s-table`, …) and **App Bridge v4** (`app-bridge.js` + the `shopify-api-key` meta tag), both from Shopify's CDN, plus plain JS. No build step, no Tailwind, no custom styling beyond layout glue. Designed from the Claude Design handoff "Mediko Gateway Redesign".

- **Pages** are path-based under `/admin-dashboard/` (Home, `chats[/:sessionId]`, `applications[/:id]`, `requests/messages|returns[/:id]`, `blasts/email|sms[/new|/:id]`, `shipping-sms`, `settings`). Each navigation is a full page load; an `app.get(/^\/admin-dashboard(\/.*)?$/)` fallback serves `index.html` for any path that isn't a real file. `express.static` runs first, so real files such as `chat-connection.js` (loaded with `<script src>` before the main script) are served as themselves, and a missing `*.ext` path 404s instead of returning `index.html`. The `ROUTES` table in the script maps paths to `view*` functions.
- **Admin chrome comes from App Bridge:** `s-app-nav` (sidebar), `s-page` heading/`primary-action`/`secondary-actions`/`breadcrumb-actions` (title bar), `s-modal` for every confirmation (no `alert`/`confirm`/`prompt`), `shopify.toast` for feedback, `shopify.loading` for page loads, and `<form data-save-bar>` on Settings.
- **Auth:** calls use plain `fetch('/api/...')`; App Bridge adds the session token (see **Admin auth**). Opened outside the admin iframe, the page shows only an "Open this app from your Shopify admin" notice.
- **Status badges:** one mapping (`TONES`) for every status.
- **Inbox tables** (Senior/PWD, Returns, Messages) share `viewInbox(kind)` with the `INBOX` config. They have row checkboxes and a bulk bar that replaces the filters while rows are selected. Bulk actions call the normal per-record `PATCH …/status` one at a time (so each customer gets their own templated email/SMS) and skip rows not in the right starting status. "Per page" (10/20/50/100) is kept in the URL (`per`) and remembered per table in `localStorage`.
- **Portal-only endpoints:** `GET /api/{submissions|contact-submissions|return-requests}/:id`, the `status` filter on those three lists, `GET /api/inbox/counts`, `GET /api/dashboard` (Home metrics, banners, setup guide), and `POST /api/setup` (setup-guide flags `setup_*` in `app_settings`: `checkout_phone_done`, `guide_dismissed`, `chat_embed_done`, `chat_guide_dismissed`; a successful `/api/sms/test` sets `setup_test_sms_sent`). Home also shows live chat: `/api/dashboard` returns `chat: { configured, recipientsSet, embedDone, dismissed }`, and the portal loads open/unanswered counts and the office-hours flag from the chat service's `/api/agent/stats` on its own, so a chat outage shows a banner instead of breaking Home.

The CSP middleware sets `frame-ancestors` from `ALLOWED_ORIGINS` so the admin can frame it — keep new origins in sync there.

### Live chat

The storefront chat widget talks to a separate chat service (repo `mediko-chatbot`, Fastify, one process). The Gateway does three things for it; the shared secret `CHAT_AGENT_SECRET` (32+ chars, same value in both `.env` files) and `CHAT_API_URL` are `.env` only and reported as set / not set in `SECRET_ENV_STATUS`. Helpers live in `lib/chat.js`.

- **Agent token:** `POST /api/chat/agent-token` (`requireAdmin`) mints an HS256 JWT (`iss: mediko-gateway`, `aud: mediko-chat`, `sub` = Shopify staff id, 300 s) signed with `CHAT_AGENT_SECRET`, and returns `{ token, expiresAt, apiUrl }`. 503 when the secret or URL is missing. The portal then calls the chat service directly at `apiUrl` (REST with `Authorization: Bearer`, WebSocket at `/api/agent/ws?token=`); the token is never sent anywhere else.
- **Link previews:** `GET /api/chat/link-preview?url=` (`requireAdmin`) builds a product preview `{ url, title, description, image, price, currency }` for a store product link (`/products/<handle>` on a `LINK_PREVIEW_HOSTS` host, default `store.mediko.ph,mediko.ph`) from the Admin API `productByIdentifier` (needs the `read_products` scope). It never fetches the storefront: Shopify bot protection answers 429 to server requests. 400 = not a store product link, 404 = not found or not active. In Chats, the first product link in the draft shows the card above the composer (× removes it for that link) and it is sent as `preview` on `agent_message`; the chat service re-validates and stores it, and the widget draws it from the message.
- **Unread vs unanswered:** the list's "New" badge is `conversation.unread` (customer wrote after an agent last opened or replied); opening a chat sends `{type:'seen'}` (also after reconnecting and when a message arrives while the chat is open and the tab visible). The Unanswered tab/count stays reply-based.
- **Orders in Chats:** `GET /api/chat/orders?email=` (recent 5 for the chat's customer) and `GET /api/chat/order?number=` (an order number from the chat), both `requireAdmin`, return panel orders `{ name, createdAt, cancelledAt, financialStatus, fulfillmentStatus, tracking[], state, reply }` built by `lib/orders.js` (no contact data). The details pane lists them, flags the order the customer wrote (`admin-portal/chat-orders.js` `findOrderNumber`: only `#1042` / `order … 1042`, never bare numbers), and "Insert status" drafts the Tagalog `reply` into the composer. Order names are assumed to be `#<number>` (`name:#1042` search).
- **Track my order:** `POST /internal/order-status` (raw body, same HMAC as chat events, CORS-exempt) is called only by the chat service, which exposes `POST /api/chat/order-status` to the widget with per-IP and per-order-number limits. Body `{ order, contact }`; answers `{ found: true, status }` (`publicOrderStatus`: state, dates, carrier, tracking only) when the email or PH mobile matches the order (`contactMatches`: order email, customer default email/phone, shipping/billing phone), otherwise `{ found: false }`, the same as for a missing order, so order numbers can't be probed. Logs `order_status_lookup` with `found` only.
- **Logged-in customers' orders (app proxy):** `shopify.app.toml` `[app_proxy]` maps storefront `/apps/mediko/*` to `/proxy/*` (needs `write_app_proxy`). `GET /proxy/orders` checks Shopify's proxy signature (`lib/shopify.js` `verifyAppProxy`: sorted params, HMAC with `SHOPIFY_CLIENT_SECRET`, 5-minute timestamp window) and the shop, then lists the `logged_in_customer_id`'s 10 latest orders as `publicOrderStatus` (no contact data). Logged out → `{ loggedIn: false, orders: [] }`. Order-number searches use `orderNameQuery` (`name:"#1002" OR name:"1002"`) plus `pickOrder` (exact match). Orders older than 60 days need the `read_all_orders` scope (requested in the Dev Dashboard).
- **Customer lookup:** `GET /api/chat/customer?email=` (`requireAdmin`) returns `{ customer: { id, adminUrl, ordersCount, lastOrderName } | null }` from the Shopify Admin API, for the Chats page details pane.
- **Signed events:** `POST /internal/chat-events` is mounted above `express.json()` (raw body). Headers `X-Mediko-Timestamp` (unix ms) and `X-Mediko-Signature` = hex HMAC-SHA256 of `` `${timestamp}.${rawBody}` `` with `CHAT_AGENT_SECRET`; more than 5 minutes off is rejected (401). Types: `new_conversation` and `unanswered` email the staff (recipients from the `chat_alert_recipients` setting, with an "Open in Gateway" link built from `SHOPIFY_ADMIN_APP_URL` + `/admin-dashboard/chats/<sessionId>`; Shopify loads the app origin + the path after the app handle, so the `/admin-dashboard` prefix is required. Old `/chats/<id>` links 302 to the portal page via `legacyChatRedirect`); `offline_reply` emails the customer the agent's replies with the `chat_reply_customer` template (vars `name`, `first_name`, `messages`, `link`). The route answers 202 first; mail failures are logged and never surface to the chat service.

**Chats page** (`/admin-dashboard/chats[/<sessionId>]`, `viewChats`): three panes (list | thread | details) in one `s-section`, one pane at a time below 768 px. The list has Open / Unanswered / Closed and a debounced search (REST `q`); the thread has the Online badge, Close chat / Reopen, "… is typing" and a composer (Enter sends, Shift+Enter is a new line, typing commands at most one per 3 s). Selecting a chat `history.replaceState`s to `/chats/<id>`, so email deep links land on it; session ids must match `/^[0-9a-f-]{36}$/`. Live updates come over the WebSocket from `admin-portal/chat-connection.js` (`createChatConnection`, which reconnects with backoff 1/2/5/10/30 s and a fresh token each time, and shows a critical "Chat service is offline" banner while down; after reconnecting it reloads the lists and the open thread). While open it sends `{type:'ping'}` every 15 s (the chat service answers `pong`) and treats 60 s with no frame as a dead socket and reconnects. A reply is sent with a `clientId` and stays in the composer until the matching `agent_sent` echo arrives (`createReplyTracker`); an error, a 10 s timeout or a disconnect keeps the text and shows a toast. Logs never carry a full chat session id or link: use `maskId()` / `redactPath()` from `lib/chat.js`. Events update the list and thread in place and never re-render the composer, so a draft survives. Everything from the widget (names, emails, messages) is untrusted: always `esc()` it. Office hours, the away message and the unanswered-alert minutes are edited on the Settings page's Chat card, which reads and writes the chat service's `/api/agent/settings`.

**Storefront widget (app embed):** `extensions/mediko-chat-widget/` is a theme app extension. `blocks/chat-widget.liquid` is an app embed (`target: body`) that loads `assets/mediko-chat.js` and, if enabled, sets `window.MEDIKO_CUSTOMER` for logged-in customers. Its "Show only on these pages" setting takes comma-separated page handles; blank means every page. Merchants switch it on in Theme editor → App embeds. `assets/mediko-chat.js` is a build artifact: regenerate it with `npm run build:embed` in `mediko-widget` (the chat API URL is baked in from that repo's `VITE_API_URL`), then release with `shopify app deploy`, which publishes a new app version. Check it with `shopify theme check --path extensions/mediko-chat-widget`.

Tests: `node --test test/*.test.js`.

### File uploads

Two Multer instances (`upload` for ID photos, `returnsUpload` for return attachments), both writing to `./uploads/` with a 5MB image-only filter. Files are served read-only at `/view-uploads/*`. The `uploads/` directory is preserved across deploys (excluded from rsync) — never `rm -rf` it.

### Settings vs secrets

Boot-time cleanup in the SMS migration deletes only the retired `sms_api_key` and `sms_enabled` rows. Never add a live `SETTINGS` key to that list: it would be wiped on every restart (this is how `sms_sender_name` used to disappear after each deploy).

**Secrets and infrastructure stay in `.env` only** — DB, Brevo, `MAIL_FROM`, admin/JWT secrets, `ALLOWED_ORIGINS`, Shopify credentials, `SEMAPHORE_API_KEY`, webhook secret, URLs, `TESTING_MODE`. Never store these in the DB or return their values to the portal (it may only report set / not set).

**Operating config lives in `app_settings`**, edited in the portal's Settings tab via `GET/PUT /api/settings`. The `SETTINGS` registry in `index.js` defines each key (type, bounds, group, label, legacy env var). Read values with `getSetting(key)` at use time — never cache them in module-level constants — so a save takes effect without a restart. Precedence: saved value → env var of the same meaning (keeps old `.env` files working) → default. To add a setting, add it to `SETTINGS`; the portal form is generated from it. Current keys: `admin_email`, `admin_cc`, `email_blast_delay_ms`, `sms_shipping_enabled`, `sms_sender_name`, `chat_alert_recipients`, `sms_blast_delay_ms`.

### Health check

`GET /health` (public, also answers HEAD) is for UptimeRobot. It runs `SELECT 1` with a 3s timeout: 200 `{"status":"ok"}` when the DB answers, 503 when it doesn't. It sits above the request logger so monitor pings aren't logged; only failures log `health_check_failed`.

### Logging

Use the `log(level, event, data)` helper for any new logging — it emits one JSON line per event with a timestamp. Do not add bare `console.log` calls in request paths.

### Error status codes

Never answer 502. Cloudflare fronts the app and replaces an origin 502 body with its own HTML page, so the JSON `error` never reaches the portal (it shows only "Server error 502"). Upstream failures (Shopify, Brevo, Semaphore) answer 500 with `{ error }`.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `node index.js` — start the API (defaults to port 3001, override with `PORT`).
- `npm install` — install dependencies. There is no build step, no linter, and no test suite (`npm test` exits 1 by design).
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

Two ways to mint a dashboard JWT, both signing with `DASHBOARD_JWT_SECRET`:

- `POST /api/auth/admin` — password check against `ADMIN_DASHBOARD_PASSWORD`, 8h token.
- `POST /api/auth/shopify` — accepts any payload where `shopOrigin` ends in `.myshopify.com` and `sessionToken` is truthy. Note: the session token is **not cryptographically verified** against Shopify; trust comes from the App Bridge frame + CORS + frame-ancestors CSP. 30min token.

Admin routes use the `requireAdmin` middleware. Two routes (`/api/submissions` GET and `/api/submissions/:id/status` PATCH) **inline** the JWT check instead of using `requireAdmin` — they predate the helper. Both code paths fall back to a hardcoded secret `"mediko-dashboard-secret-2026"` if `DASHBOARD_JWT_SECRET` is unset; production must set the env var.

### Shopify integration

When an application is moved to `approved` via `PATCH /api/submissions/:id/status`:

1. `findOrCreateShopifyCustomer` — search by email, create if missing (tagged `senior-pwd-discount`).
2. Create a `price_rule` with `customer_selection: "prerequisite"` tied to that customer ID, `usage_limit: 1`, `once_per_customer: true`, percentage discount from the `discount_percentage` setting.
3. Create a `discount_code` under that price rule, format `MEDIKO-{appId}-{8 hex chars}`.
4. Persist `discount_code`, `discount_price_rule_id`, `discount_code_id` on the row.
5. Email the code to the applicant.

Reverting an approved row to `pending`/`rejected` deletes the `price_rule` (cascades the code) and nulls those columns. `GET /api/submissions/:id/discount-usage` proxies to Shopify to report `usage_count`. If Shopify env vars are absent, approval returns 503 — there is no offline fallback path.

### Email blasts

Admin bulk email under `/api/blasts*` (all `requireAdmin`). The audience comes from `applications` / `contact_submissions` / `return_requests` filtered by status, plus pasted addresses. It is deduplicated and excludes `email_unsubscribes`. Tables: `email_blasts`, `email_blast_recipients` (one row per recipient), `email_unsubscribes`, all created by `ensureBlastTables()`. `runBlast` sends one mail per recipient (never BCC), one after another, waiting the `email_blast_delay_ms` setting between sends. It runs in-process with no queue, so blasts still `sending` at boot are marked `interrupted` and can be resumed from the portal. `/api/unsubscribe` is public and HMAC-token-guarded. It is exempt from CORS because its own form posts back to this host. Unsubscribe links use `PUBLIC_BASE_URL`.

### SMS shipping notifications

`POST /webhooks/shopify/fulfillments-create` (declared in `shopify.app.toml`, needs `read_fulfillments`) texts the customer via Semaphore when an order ships. It is mounted **above** the global `express.json()` because HMAC verification needs the raw body; the secret is `SHOPIFY_WEBHOOK_SECRET` or else `SHOPIFY_CLIENT_SECRET`. Flow: verify HMAC, skip non-`success` fulfillments, `INSERT IGNORE` into `sms_notifications` (unique `fulfillment_id`, so webhook retries never double-text), respond 200, then pick a phone number (fulfillment `destination.phone`, else the order's shipping/order/billing/customer phone via GraphQL), normalize to `639XXXXXXXXX`, send, and record `sent` / `failed` / `skipped` on the row. Messages are kept ASCII and within 160 chars (one credit); the tracking link is dropped if it would overflow. The Semaphore key comes only from `SEMAPHORE_API_KEY` in `.env`; on/off and sender name are portal settings (see **Settings vs secrets**). `GET /api/sms/settings` is a read-only status for the SMS tabs. Other `requireAdmin` routes: `GET /api/sms/account` (credit balance, cached 60s because Semaphore rate-limits it), `GET /api/sms/notifications` (log with `status` / `search` filters), `POST /api/sms/notifications/:id/retry` (failed or skipped rows; optional `{ "phone" }` for orders that had no number), `POST /api/sms/test` (`{ "number" }`).

### SMS blasts

Admin bulk SMS under `/api/sms-blasts*` (all `requireAdmin`), a copy of the email blast design: audience from the same `BLAST_SOURCES` by status (using each row's `contact_number`) plus pasted numbers (split on newlines/commas/semicolons, not spaces), normalized to `639XXXXXXXXX`, deduplicated, minus `sms_optouts`. Tables `sms_blasts`, `sms_blast_recipients`, `sms_optouts`, created by `ensureSmsBlastTables()`. `runSmsBlast` sends one Semaphore request per recipient (so `{{name}}` can become the first name), waiting the `sms_blast_delay_ms` setting between sends; blasts still `sending` at boot become `interrupted` and can be resumed. Message text is forced to ASCII and capped at 459 chars (3 SMS). Messages starting with "TEST" are rejected because Semaphore silently drops them. There is no SMS reply/unsubscribe channel: admins manage `/api/sms-optouts` by hand in the portal. Opt-outs only block blasts, not shipping notifications.

### Admin SPA

`admin-portal/index.html` is a single static HTML file (Tailwind via CDN, vanilla JS, no build) served at `/admin-dashboard` via `express.static`. It calls the same `/api/*` routes with the JWT in `Authorization: Bearer`. The CSP middleware below the routes sets `frame-ancestors` from `ALLOWED_ORIGINS` so the SPA can be embedded inside Shopify admin via App Bridge — keep new origins in sync there.

### File uploads

Two Multer instances (`upload` for ID photos, `returnsUpload` for return attachments), both writing to `./uploads/` with a 5MB image-only filter. Files are served read-only at `/view-uploads/*`. The `uploads/` directory is preserved across deploys (excluded from rsync) — never `rm -rf` it.

### Settings vs secrets

**Secrets and infrastructure stay in `.env` only** — DB, Brevo, `MAIL_FROM`, admin/JWT secrets, `ALLOWED_ORIGINS`, Shopify credentials, `SEMAPHORE_API_KEY`, webhook secret, URLs, `TESTING_MODE`. Never store these in the DB or return their values to the portal (it may only report set / not set).

**Operating config lives in `app_settings`**, edited in the portal's Settings tab via `GET/PUT /api/settings`. The `SETTINGS` registry in `index.js` defines each key (type, bounds, group, label, legacy env var). Read values with `getSetting(key)` at use time — never cache them in module-level constants — so a save takes effect without a restart. Precedence: saved value → env var of the same meaning (keeps old `.env` files working) → default. To add a setting, add it to `SETTINGS`; the portal form is generated from it. Current keys: `discount_percentage`, `discount_autogen_enabled`, `admin_email`, `admin_cc`, `email_blast_delay_ms`, `sms_shipping_enabled`, `sms_sender_name`, `sms_blast_delay_ms`.

### Health check

`GET /health` (public, also answers HEAD) is for UptimeRobot. It runs `SELECT 1` with a 3s timeout: 200 `{"status":"ok"}` when the DB answers, 503 when it doesn't. It sits above the request logger so monitor pings aren't logged; only failures log `health_check_failed`.

### Logging

Use the `log(level, event, data)` helper for any new logging — it emits one JSON line per event with a timestamp. Do not add bare `console.log` calls in request paths (a couple remain in the auth routes as debug leftovers; new code shouldn't follow that pattern).

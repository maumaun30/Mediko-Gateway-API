# Mediko Gateway API

Backend for the Mediko.ph storefront forms and the staff dashboard that processes
them. It receives three public form submissions, stores them in MySQL, emails the
staff and the customer, and lets staff approve or reject them, tag the matching
Shopify order PWD or SC, text customers when their order ships (Semaphore SMS),
and send email or SMS blasts.

Express 5, Node 22, MySQL, no build step.

## Contents

- [How it fits together](#how-it-fits-together)
- [Running it locally](#running-it-locally)
- [Environment variables](#environment-variables)
- [API](#api)
- [Anti-abuse stack](#anti-abuse-stack)
- [Database](#database)
- [Shopify integration](#shopify-integration)
- [Admin dashboard](#admin-dashboard)
- [Deployment](#deployment)
- [Operational notes](#operational-notes)

## How it fits together

```
storefront forms ──▶ POST /api/apply | /api/contact | /api/returns
                          │
                          ├─▶ MySQL (applications, contact_submissions, return_requests)
                          └─▶ Brevo SMTP (staff notification + customer acknowledgement)

staff ──▶ Shopify admin ──▶ /admin-dashboard (embedded SPA, App Bridge + Polaris)
                                  │
                                  └─▶ /api/* with a Shopify session token or dashboard JWT
                                           │
                                           ├─▶ Shopify Admin GraphQL API
                                           │      • list/search orders, tag PWD or SC
                                           │      • read order phone numbers
                                           ├─▶ Brevo SMTP (decisions, email blasts)
                                           └─▶ Semaphore (shipping SMS, SMS blasts)

Shopify ──▶ POST /webhooks/shopify/fulfillments-create ──▶ shipping SMS
```

The entire backend is one file: **`index.js`** (~4000 lines). No router files, no
service layer, no ORM. Helpers, mail templates, Shopify glue and route handlers
all live there. Expect to read the file rather than navigate by module.

## Running it locally

```bash
npm install
cp .env.example .env     # then fill it in
node index.js            # listens on PORT, default 3001
```

The app boots without a `.env`, but every database, mail and Shopify call will
fail. There is no build step, no linter and no test suite — `npm test` exits 1 by
design.

For local form testing set `TESTING_MODE=true`, which disables the rate limiter,
the time trap and the per-email cooldown. **Never set this in production.**

## Environment variables

### Database

| Variable | Notes |
|---|---|
| `DB_HOST` `DB_USER` `DB_PASSWORD` `DB_NAME` | MySQL connection, pooled via `mysql2` |

`.env` holds secrets and infrastructure only. Everyday settings (staff
notification emails, SMS on/off, sender name, send delays) and the email/SMS
message templates are edited in the portal and saved in the DB. A saved value
wins; the matching env var (see the bottom of `.env.example`) is only a
fallback until something is saved.

### Mail

| Variable | Notes |
|---|---|
| `BREVO_USER` `BREVO_PASS` | Brevo SMTP credentials |
| `MAIL_FROM` | From address on all outbound mail |

### Auth

| Variable | Notes |
|---|---|
| `DASHBOARD_JWT_SECRET` | Signs the 15-minute dashboard JWT. 32+ characters, no fallback — admin routes answer 503 without it |
| `ALLOWED_ORIGINS` | Comma-separated origins. Drives both CORS and the `frame-ancestors` CSP that lets the SPA embed in Shopify admin |
| `PUBLIC_BASE_URL` | Public URL of the gateway, for unsubscribe links and the webhook URL shown in the portal |

### Shopify

| Variable | Notes |
|---|---|
| `SHOPIFY_SHOP_DOMAIN` | e.g. `fic0hr-kz.myshopify.com`. Also pins admin sign-in to this store |
| `SHOPIFY_CLIENT_ID` `SHOPIFY_CLIENT_SECRET` | App credentials. The gateway mints its own Admin API token from these and refreshes it before expiry. The secret also verifies admin session tokens and webhooks. Client ID falls back to `shopify.app.toml` |
| `SHOPIFY_ADMIN_TOKEN` | A long-lived install token. **Wins over the client credentials when set.** Never put a client-credentials token here — see [Operational notes](#operational-notes) |
| `SHOPIFY_API_VERSION` | Defaults to `2026-04` |
| `SHOPIFY_WEBHOOK_SECRET` | Only if the fulfillment webhook was created in Shopify admin instead of `shopify.app.toml` |

### SMS

| Variable | Notes |
|---|---|
| `SEMAPHORE_API_KEY` | Semaphore API key, for shipping texts and SMS blasts |

### Other

| Variable | Notes |
|---|---|
| `PORT` | Defaults to `3001` |
| `IMAGE_OPTIMIZER_URL` | Converts uploads to WebP (1200px max width) before storage. If unset or unreachable, originals are kept and the upload still succeeds |
| `TESTING_MODE` | `true` disables anti-abuse on the form endpoints. Local and staging only |

## API

### Public

| Method | Path | Body |
|---|---|---|
| `POST` | `/api/apply` | `multipart/form-data` — `full_name`, `birthday`, `contact_number`, `email_address`, `id_number`, `id_photos` (≤2 images) |
| `POST` | `/api/contact` | JSON — `full_name`, `email_address`, `contact_number`, `message` |
| `POST` | `/api/returns` | `multipart/form-data` — `full_name`, `email_address`, `contact_number`, `order_number`, `items_to_return`, `reason`, `attachments` (≤5 images) |

All three also expect a `form_loaded_at` field and a randomly-named `hp_*`
honeypot field — see [Anti-abuse stack](#anti-abuse-stack).

Phone numbers must match `^(\+639|09)\d{9}$`. Uploads are images only, 5MB max.

### Token endpoints

| Method | Path | Result |
|---|---|---|
| `POST` | `/api/auth/shopify` | Shopify session token (Bearer header) → verified, then traded for a 15-minute dashboard JWT |

There is no password login. See [Admin dashboard](#admin-dashboard).

### Admin

All require `Authorization: Bearer <token>` — a dashboard JWT or a Shopify
session token. Grouped by area; read `index.js` for bodies.

| Area | Routes |
|---|---|
| Applications | `GET /api/submissions`, `GET /api/submissions/:id`, `PATCH /api/submissions/:id/status`, `GET/POST/DELETE` on `/api/submissions/:id/orders` and `/assign-order`, `POST/DELETE /api/submissions/:id/refund` |
| Messages | `GET /api/contact-submissions[/:id]`, `PATCH /api/contact-submissions/:id/status` |
| Returns | `GET /api/return-requests[/:id]`, `PATCH /api/return-requests/:id/status` |
| Home | `GET /api/dashboard`, `GET /api/inbox/counts`, `POST /api/setup` |
| Settings | `GET/PUT /api/settings` |
| Templates | `GET/PUT /api/templates`, `DELETE /api/templates/:key`, `GET /api/templates/fill/:kind/:id/:status` |
| Email blasts | `/api/blasts` (preview, test, create, list, detail, resume, cancel) |
| Shipping SMS | `/api/sms/settings`, `/api/sms/account`, `/api/sms/notifications[/:id/retry]`, `/api/sms/test` |
| SMS blasts | `/api/sms-blasts` (same shape as email blasts), `/api/sms-optouts` |
| Diagnostics | `GET /api/shopify/scopes` |

The three list routes take `limit`, `page`, `search`, `status`, `date_from`,
`date_to`. Status changes take `{status, reason, notify}` — `notify` picks
email and/or SMS and can carry an edited message for that one send.

### Webhooks and public

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/webhooks/shopify/fulfillments-create` | HMAC-verified; texts the customer once per fulfillment |
| `GET/POST` | `/api/unsubscribe` | Email blast unsubscribe link |
| `GET` | `/health` | `SELECT 1` with a 3s timeout, for UptimeRobot |

### Static

| Path | Serves |
|---|---|
| `/admin-dashboard/*` | The staff SPA (`admin-portal/index.html`); any extension-less path falls back to it |
| `/view-uploads/*` | Uploaded files, read-only |

## Anti-abuse stack

`/api/apply`, `/api/contact` and `/api/returns` share one pipeline. **If you add a
form endpoint, replicate this ordering exactly.**

1. **Rate limit** — 3 requests per 15 minutes per IP, skipped under `TESTING_MODE`
2. **Field validation** — phone regex, email regex, length checks
3. **Time trap** — rejects if `form_loaded_at` is less than 3 seconds old
4. **Dynamic honeypot** — any filled field whose name starts with `hp_`. The
   frontend injects one under a random name
5. **Cooldown** — a matching email (and `id_number` / `order_number`) submitted
   within the last 2 minutes is treated as a duplicate
6. **Insert, respond 200, then send mail** — mail is fire-and-forget; failures are
   logged and never surfaced to the client

Steps 3, 4 and 5 all return a **silent 200 success**. That is deliberate — a bot
should not learn it was caught. Don't "fix" it into an error response.

## Database

MySQL through a `mysql2` pool. Form tables: `applications`,
`contact_submissions`, `return_requests`. Feature tables: `app_settings`,
`message_templates`, email blast tables, `sms_notifications`, `sms_blasts`,
`sms_blast_recipients`, `sms_optouts`.

**There is no migrations directory.** Schema is enforced at boot by
`ensure*Table()` functions using `CREATE TABLE IF NOT EXISTS` plus
`ensureColumn()` / `ensureColumnFor()`, which checks
`INFORMATION_SCHEMA.COLUMNS` and issues `ALTER TABLE ADD COLUMN` when a column is
missing.

To add a column, add an `ensureColumn(...)` call. Do not write external migration
scripts.

`applications` is assumed to pre-exist — there is no `CREATE TABLE` for it, only
auto-migration of its added columns. Its `discount_*` columns are legacy data
from the discontinued discount codes and are no longer written.

## Shopify integration

### Required scopes

`shopify.app.toml` is the source of truth — the app is linked to the Shopify CLI,
so scope changes go through `shopify app deploy`, not the dashboard UI.

| Scope | Needed by |
|---|---|
| `read_customers` / `write_customers` | Customer tags alongside order tags |
| `read_orders` | Order picker, order phone lookup for shipping SMS |
| `write_orders` | `tagsAdd`, `tagsRemove` on orders |
| `read_fulfillments` | `fulfillments/create` webhook |

Phone numbers on orders are protected customer data. If the app lacks that
access, Shopify redacts them and shipping texts log as skipped.

`read_orders` only reaches orders from the **last 60 days**. Older orders need
`read_all_orders`, which requires Shopify approval and is deliberately not
declared.

### Authentication

Two ways to authenticate, checked in this order:

1. **`SHOPIFY_ADMIN_TOKEN`** — used directly if set
2. **`SHOPIFY_CLIENT_ID` + `SHOPIFY_CLIENT_SECRET`** — the gateway mints a token
   through the client credentials grant, caches it, and refreshes 5 minutes
   before expiry. Concurrent callers share one mint rather than stampeding the
   token endpoint. If Shopify rejects a minted token with a 401, it is discarded
   and re-minted once before the request fails.

Prefer the second. Scope changes then take effect without editing `.env`.
A long-lived token issued under a client secret that was since revoked fails
with 401 — remove it and let the client credentials take over.

`GET /api/shopify/scopes` reports what the live token actually carries — the
quickest way to tell a stale token apart from an unreleased app version.

### Approval flow

Discount codes are discontinued. Approving or rejecting an application (or a
return) only sets its status and stores the reason; nothing is created or
deleted in Shopify. The confirmation dialog can email and/or text the customer
from the editable templates.

### Order assignment

Staff assign an application to one Shopify order and tag it `PWD` or `SC`. The
assignment is stored on the row (`assigned_order_gid`, `assigned_order_name`,
`assigned_tag`). Re-assigning or changing the tag strips the old tag from the
previous order first, best-effort and logged on failure.

The picker defaults to orders matching the applicant's email, but a discount is
often used on an order placed under a different address — a gift, or a household
account. The search box in the modal drops the email filter and queries all
orders, and every option carries the order's own email so the mismatch is visible
before assigning.

## Admin dashboard

`admin-portal/index.html` — one static file: App Bridge v4 and Polaris web
components from Shopify's CDN, vanilla JS, client-side routes under
`/admin-dashboard/`, no build. It only works embedded in the Shopify admin;
opened anywhere else it shows an "Open this app from your Shopify admin"
notice.

App Bridge adds a Shopify session token to every same-origin `fetch`.
`requireAdmin` verifies it (HS256 with `SHOPIFY_CLIENT_SECRET`, `exp`/`nbf`,
`aud` = client ID, `dest` pinned to `SHOPIFY_SHOP_DOMAIN`). Nav, title bar,
save bar, toasts and modals all come from App Bridge.

The CSP middleware sets `frame-ancestors` from `ALLOWED_ORIGINS` — keep new
origins in sync there.

## Deployment

`.github/workflows/deploy.yml` runs on push to `main`: rsync to a CloudPanel host,
then `npm install --production` and `pm2 restart all` over SSH.

Required GitHub secrets: `SSH_PRIVATE_KEY`, `SSH_USER`, `SSH_HOST`, `SSH_DOMAIN`.

Excluded from rsync and preserved on the server: `.env`, `uploads/`,
`node_modules`, `.git*`. The server-side `.env` is authoritative — committed
copies are never deployed.

## Operational notes

**Rotating the Shopify client secret.** During a rotation Shopify keeps
signing session tokens with the oldest unrevoked secret, so sign-in fails with
"invalid signature" until the old secret is revoked in the Dev Dashboard.

**A client-credentials token does not belong in `SHOPIFY_ADMIN_TOKEN`.** Those
expire after 24 hours. Pasting one there produces a service that works for a day
and then fails — set `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` instead and
let the gateway refresh it. `SHOPIFY_ADMIN_TOKEN` is only for a long-lived
install token.

**Never return 502.** Cloudflare fronts this app and replaces the body of an
origin 502 with its own HTML error page, so the JSON never reaches the client.
Upstream failures (Shopify, Brevo, Semaphore) answer 500 with a JSON
`error` the portal shows in its toast.

**`ALLOWED_ORIGINS` is matched exactly.** The CORS check is
`allowedOrigins.includes(origin)`, so a wildcard entry such as
`https://*.myshopify.com` matches nothing.

**Never `rm -rf uploads/`.** It is excluded from rsync, so the server copy is the
only copy.

**Log with the `log(level, event, data)` helper**, which emits one JSON line per
event with a timestamp. Don't add bare `console.log` calls in request paths.

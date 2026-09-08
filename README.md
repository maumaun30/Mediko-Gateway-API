# Mediko Gateway API

Backend for the Mediko.ph storefront forms and the staff dashboard that processes
them. It receives three public form submissions, stores them in MySQL, emails the
staff and the customer, and — for Senior Citizen / PWD discount applications —
issues a personal Shopify discount code on approval and tags the order the
discount was used on.

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

staff ──▶ /admin-dashboard (static SPA, also embedded in Shopify admin)
              │
              └─▶ /api/* with a Bearer JWT
                       │
                       └─▶ Shopify Admin GraphQL API
                              • create/delete customer discount codes
                              • list a customer's orders
                              • tag an order PWD or SC
```

The entire backend is one file: **`index.js`** (~2000 lines). No router files, no
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

### Mail

| Variable | Notes |
|---|---|
| `BREVO_USER` `BREVO_PASS` | Brevo SMTP credentials |
| `MAIL_FROM` | From address on all outbound mail |
| `ADMIN_EMAIL` | Primary staff recipient |
| `ADMIN_CC` | Comma-separated additional recipients |

### Auth

| Variable | Notes |
|---|---|
| `ADMIN_DASHBOARD_PASSWORD` | Password for `POST /api/auth/admin` |
| `DASHBOARD_JWT_SECRET` | JWT signing secret. **Must be set in production** — see [Operational notes](#operational-notes) |
| `ADMIN_API_KEY` | Legacy key |
| `ALLOWED_ORIGINS` | Comma-separated origins. Drives both CORS and the `frame-ancestors` CSP that lets the SPA embed in Shopify admin |

### Shopify

| Variable | Notes |
|---|---|
| `SHOPIFY_SHOP_DOMAIN` | e.g. `fic0hr-kz.myshopify.com` |
| `SHOPIFY_ADMIN_TOKEN` | Admin API access token (`shpat_…`) |
| `SHOPIFY_API_VERSION` | Defaults to `2026-04` |
| `DISCOUNT_PERCENTAGE` | Percentage off, defaults to `20` |
| `DISCOUNT_AUTOGEN_ENABLED` | Set to `false` to approve applications without issuing a code. Approval still succeeds; the row keeps no code and no approval email goes out |

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
| `POST` | `/api/auth/admin` | `{password}` checked against `ADMIN_DASHBOARD_PASSWORD` → 8 hour JWT |
| `POST` | `/api/auth/shopify` | `{shopOrigin, sessionToken}` from App Bridge → 30 minute JWT |

### Admin

All require `Authorization: Bearer <jwt>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/submissions` | List applications. Query: `limit`, `page`, `search`, `date_from`, `date_to` |
| `PATCH` | `/api/submissions/:id/status` | `{status, reason}` — `pending` / `approved` / `rejected`. Drives the whole discount lifecycle |
| `GET` | `/api/submissions/:id/discount-usage` | Proxies Shopify for `asyncUsageCount` |
| `GET` | `/api/submissions/:id/orders` | Orders for the assign-order picker. Defaults to the applicant's own orders; `?q=` searches all orders by number, customer name or email |
| `POST` | `/api/submissions/:id/assign-order` | `{order_gid, order_name, tag}` — tags the order `PWD` or `SC` and records it |
| `DELETE` | `/api/submissions/:id/assign-order` | Removes the tag and clears the assignment |
| `GET` | `/api/contact-submissions` | List contact messages |
| `PATCH` | `/api/contact-submissions/:id/status` | `pending` / `resolved` |
| `GET` | `/api/return-requests` | List return requests |
| `PATCH` | `/api/return-requests/:id/status` | `pending` / `approved` / `rejected` |
| `GET` | `/api/shopify/scopes` | Diagnostic — reports the scopes the configured Admin token actually carries |

### Static

| Path | Serves |
|---|---|
| `/admin-dashboard` | The staff SPA (`admin-portal/`) |
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

MySQL through a `mysql2` pool. Three tables: `applications`,
`contact_submissions`, `return_requests`.

**There is no migrations directory.** Schema is enforced at boot by
`ensureContactTable()` / `ensureReturnsTable()` / `ensureStatusColumn()` using
`CREATE TABLE IF NOT EXISTS` plus `ensureColumn()`, which checks
`INFORMATION_SCHEMA.COLUMNS` and issues `ALTER TABLE ADD COLUMN` when a column is
missing.

To add a column, add an `ensureColumn(...)` call. Do not write external migration
scripts.

`applications` is assumed to pre-exist — there is no `CREATE TABLE` for it, only
auto-migration of its added columns.

## Shopify integration

### Required scopes

`shopify.app.toml` is the source of truth — the app is linked to the Shopify CLI,
so scope changes go through `shopify app deploy`, not the dashboard UI.

| Scope | Needed by |
|---|---|
| `read_customers` | `findCustomer` |
| `write_customers` | `createCustomer` |
| `read_discounts` | `discountUsage` |
| `write_discounts` | `createDiscount`, `deleteDiscount` |
| `read_orders` | `customerOrders` |
| `write_orders` | `addTags`, `removeTags` |

`read_orders` only reaches orders from the **last 60 days**. Older orders need
`read_all_orders`, which requires Shopify approval and is deliberately not
declared.

### Approval flow

Moving an application to `approved` via `PATCH /api/submissions/:id/status`:

1. `findOrCreateShopifyCustomer` — search by email, create if missing, tagged
   `senior-pwd-discount`
2. `discountCodeBasicCreate` — percentage discount limited to that customer,
   `usageLimit: 1`, `appliesOncePerCustomer: true`
3. Persist `discount_code` and `discount_node_gid` on the row
4. Email the code to the applicant

Reverting an approved row to `pending` or `rejected` deletes the discount and
nulls those columns. If the Shopify env vars are absent, approval returns 503 —
there is no offline fallback.

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

`admin-portal/index.html` — a single static file, Tailwind via CDN, vanilla JS,
no build. Served at `/admin-dashboard` through `express.static`, and embeddable in
Shopify admin via App Bridge.

It calls the same `/api/*` routes with the JWT in `Authorization: Bearer`. The CSP
middleware sets `frame-ancestors` from `ALLOWED_ORIGINS` — keep new origins in
sync there.

Every fetch goes through `readJson(res)`, which reports the HTTP status and a
snippet of the body when a response isn't JSON. Use it for new fetches too;
calling `res.json()` directly turns any proxy error page into an opaque
`Unexpected token '<'`.

## Deployment

`.github/workflows/deploy.yml` runs on push to `main`: rsync to a CloudPanel host,
then `npm install --production` and `pm2 restart all` over SSH.

Required GitHub secrets: `SSH_PRIVATE_KEY`, `SSH_USER`, `SSH_HOST`, `SSH_DOMAIN`.

Excluded from rsync and preserved on the server: `.env`, `uploads/`,
`node_modules`, `.git*`. The server-side `.env` is authoritative — committed
copies are never deployed.

## Operational notes

**Set `DASHBOARD_JWT_SECRET`.** Both the `requireAdmin` middleware and the two
routes that inline their own JWT check (`GET /api/submissions` and
`PATCH /api/submissions/:id/status`, which predate the helper) fall back to a
hardcoded secret when the variable is unset. Production must set it.

**Shopify session tokens are not cryptographically verified.**
`POST /api/auth/shopify` accepts any payload whose `shopOrigin` ends in
`.myshopify.com` with a truthy `sessionToken`. Trust comes from the App Bridge
frame, CORS and the `frame-ancestors` CSP — not from the token itself.

**Never return 502.** Cloudflare fronts this app and replaces the body of an
origin 502 with its own HTML error page, so the JSON never reaches the client.
Upstream failures answer 500.

**`ALLOWED_ORIGINS` is matched exactly.** The CORS check is
`allowedOrigins.includes(origin)`, so a wildcard entry such as
`https://*.myshopify.com` matches nothing.

**Never `rm -rf uploads/`.** It is excluded from rsync, so the server copy is the
only copy.

**Log with the `log(level, event, data)` helper**, which emits one JSON line per
event with a timestamp. Don't add bare `console.log` calls in request paths — a
couple remain in the auth routes as debug leftovers and shouldn't be copied.

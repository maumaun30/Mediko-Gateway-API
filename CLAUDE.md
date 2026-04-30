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
2. Create a `price_rule` with `customer_selection: "prerequisite"` tied to that customer ID, `usage_limit: 1`, `once_per_customer: true`, percentage discount `DISCOUNT_PERCENTAGE`.
3. Create a `discount_code` under that price rule, format `MEDIKO-{appId}-{8 hex chars}`.
4. Persist `discount_code`, `discount_price_rule_id`, `discount_code_id` on the row.
5. Email the code to the applicant.

Reverting an approved row to `pending`/`rejected` deletes the `price_rule` (cascades the code) and nulls those columns. `GET /api/submissions/:id/discount-usage` proxies to Shopify to report `usage_count`. If Shopify env vars are absent, approval returns 503 — there is no offline fallback path.

### Admin SPA

`admin-portal/index.html` is a single static HTML file (Tailwind via CDN, vanilla JS, no build) served at `/admin-dashboard` via `express.static`. It calls the same `/api/*` routes with the JWT in `Authorization: Bearer`. The CSP middleware below the routes sets `frame-ancestors` from `ALLOWED_ORIGINS` so the SPA can be embedded inside Shopify admin via App Bridge — keep new origins in sync there.

### File uploads

Two Multer instances (`upload` for ID photos, `returnsUpload` for return attachments), both writing to `./uploads/` with a 5MB image-only filter. Files are served read-only at `/view-uploads/*`. The `uploads/` directory is preserved across deploys (excluded from rsync) — never `rm -rf` it.

### Logging

Use the `log(level, event, data)` helper for any new logging — it emits one JSON line per event with a timestamp. Do not add bare `console.log` calls in request paths (a couple remain in the auth routes as debug leftovers; new code shouldn't follow that pattern).

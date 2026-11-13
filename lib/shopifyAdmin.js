// Shopify Admin API client (client-credentials token cache + GraphQL).
// Moved verbatim from index.js.
const { log } = require("./log");

// ── Shopify Admin API ─────────────────────────────────────────────────────────
// Upstream failures here answer 500, not 502: Cloudflare fronts this app and
// replaces a 502 body with its own HTML error page, so the JSON never lands.
const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION || "2026-04";

// Refresh this long before a minted token actually expires, so a request never
// races the expiry.
const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

function clientCredentialsConfigured() {
  return Boolean(
    process.env.SHOPIFY_CLIENT_ID && process.env.SHOPIFY_CLIENT_SECRET,
  );
}

function shopifyConfigured() {
  return Boolean(
    process.env.SHOPIFY_SHOP_DOMAIN &&
      (process.env.SHOPIFY_ADMIN_TOKEN || clientCredentialsConfigured()),
  );
}

// Tokens from the client credentials grant last 24 hours, so they cannot be
// pasted into .env and left alone. Mint on demand and cache until just before
// expiry. A static SHOPIFY_ADMIN_TOKEN still wins when one is set.
let _tokenCache = { token: null, expiresAt: 0 };
let _tokenInFlight = null;

async function mintAdminToken() {
  const res = await fetch(
    `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: process.env.SHOPIFY_CLIENT_ID,
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
      }),
    },
  );

  const json = await res.json().catch(() => null);
  if (!res.ok || !json?.access_token) {
    const err = new Error(
      `Shopify token request failed (${res.status})${json?.error ? `: ${json.error}` : ""}`,
    );
    err.status = res.status;
    throw err;
  }

  // expires_in is seconds; fall back to an hour if Shopify ever omits it.
  const ttlMs = (Number(json.expires_in) || 3600) * 1000;
  _tokenCache = {
    token: json.access_token,
    expiresAt: Date.now() + ttlMs,
  };

  log("info", "shopify_token_minted", {
    expires_in: json.expires_in ?? null,
    scope: json.scope ?? null,
  });

  return _tokenCache.token;
}

async function getAdminToken() {
  if (process.env.SHOPIFY_ADMIN_TOKEN) return process.env.SHOPIFY_ADMIN_TOKEN;
  if (!clientCredentialsConfigured()) {
    throw new Error(
      "No Shopify credentials. Set SHOPIFY_ADMIN_TOKEN, or SHOPIFY_CLIENT_ID and SHOPIFY_CLIENT_SECRET.",
    );
  }

  if (_tokenCache.token && Date.now() < _tokenCache.expiresAt - TOKEN_REFRESH_MARGIN_MS) {
    return _tokenCache.token;
  }

  // Concurrent callers share one mint rather than stampeding the token endpoint.
  if (!_tokenInFlight) {
    _tokenInFlight = mintAdminToken().finally(() => {
      _tokenInFlight = null;
    });
  }
  return _tokenInFlight;
}

function invalidateAdminToken() {
  _tokenCache = { token: null, expiresAt: 0 };
}

async function shopifyGraphQL(query, variables = {}, { retryOn401 = true } = {}) {
  const url = `https://${process.env.SHOPIFY_SHOP_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": await getAdminToken(),
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json().catch(() => null);

  // A minted token can be revoked before its stated expiry. Drop it and mint a
  // fresh one once, rather than failing every call until the cache ages out.
  if (res.status === 401 && retryOn401 && !process.env.SHOPIFY_ADMIN_TOKEN) {
    log("warn", "shopify_token_rejected", { retrying: true });
    invalidateAdminToken();
    return shopifyGraphQL(query, variables, { retryOn401: false });
  }

  if (!res.ok || !json) {
    const err = new Error(`Shopify ${res.status}`);
    err.status = res.status;
    throw err;
  }
  // Missing scope: the cached minted token predates a newly approved scope
  // (e.g. read_products). Mint a fresh token once and retry.
  if (isAccessDenied(json) && retryOn401 && !process.env.SHOPIFY_ADMIN_TOKEN) {
    log("warn", "shopify_access_denied", { retrying: true });
    invalidateAdminToken();
    return shopifyGraphQL(query, variables, { retryOn401: false });
  }
  if (Array.isArray(json.errors) && json.errors.length) {
    throw new Error(json.errors.map((e) => e.message).join("; "));
  }
  return json.data;
}

function throwIfUserErrors(userErrors, op) {
  if (Array.isArray(userErrors) && userErrors.length) {
    const msg = userErrors
      .map((e) => `${(e.field || []).join(".")}: ${e.message}`)
      .join("; ");
    throw new Error(`${op}: ${msg}`);
  }
}

module.exports = { SHOPIFY_API_VERSION, TOKEN_REFRESH_MARGIN_MS, clientCredentialsConfigured, shopifyConfigured, _tokenCache, _tokenInFlight, mintAdminToken, getAdminToken, invalidateAdminToken, shopifyGraphQL, throwIfUserErrors };

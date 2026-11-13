// Admin auth: Shopify session token / dashboard JWT → requireAdmin.
// Moved verbatim from index.js.
const fs = require("fs");
const path = require("path");
const jwt = require("jsonwebtoken");
const { log } = require("./log");
const { redactPath } = require("./chat");

// ── Admin auth (Shopify session token → dashboard JWT) ────────────────────────
// The portal only runs embedded in the Shopify admin. App Bridge gives it a
// Shopify session token: a JWT signed HS256 with this app's client secret,
// valid ~60s. POST /api/auth/shopify verifies that token and exchanges it for
// a short-lived dashboard JWT, which every admin route checks via requireAdmin.
const DASHBOARD_JWT = { issuer: "mediko-gateway", audience: "mediko-admin", ttlSec: 15 * 60 };

// Client ID is public (it's in shopify.app.toml); env wins if set.
function shopifyClientId() {
  if (process.env.SHOPIFY_CLIENT_ID) return process.env.SHOPIFY_CLIENT_ID;
  try {
    const toml = fs.readFileSync(path.join(__dirname, "..", "shopify.app.toml"), "utf8");
    const m = toml.match(/^client_id\s*=\s*"([^"]+)"/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// No fallback: without a real secret, admin auth is off rather than forgeable.
function dashboardSecret() {
  const s = process.env.DASHBOARD_JWT_SECRET;
  return s && s.length >= 32 ? s : null;
}

if (!dashboardSecret()) {
  log("error", "dashboard_jwt_secret_missing", {
    hint: "Set DASHBOARD_JWT_SECRET (32+ random characters). Admin routes return 503 until then.",
  });
}

// Returns the verified payload or throws. Follows Shopify's checks: HS256
// signature with the client secret, exp/nbf, aud = client ID, iss and dest on
// the same host. Also pins dest to this store so no other shop's token works.
function verifyShopifySessionToken(token) {
  const secret = process.env.SHOPIFY_CLIENT_SECRET;
  const clientId = shopifyClientId();
  if (!secret || !clientId) throw new Error("Shopify app credentials not configured");

  const payload = jwt.verify(token, secret, {
    algorithms: ["HS256"],
    audience: clientId,
    clockTolerance: 5, // seconds of clock skew
  });
  const destHost = new URL(payload.dest).hostname;
  const issHost = new URL(payload.iss).hostname;
  if (destHost !== issHost) throw new Error("iss/dest mismatch");
  const shop = String(process.env.SHOPIFY_SHOP_DOMAIN || "").toLowerCase();
  if (!shop || destHost.toLowerCase() !== shop) throw new Error("token is for another shop");
  if (!payload.sub) throw new Error("token has no user");
  return payload;
}

// Accepts either credential:
// - a Shopify session token, which App Bridge v4 attaches to every fetch() to
//   this domain automatically (the redesigned portal relies on this), or
// - a dashboard JWT from POST /api/auth/shopify (older portal builds).
function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing Bearer token" });
  }
  const token = authHeader.slice(7);

  const secret = dashboardSecret();
  if (secret) {
    try {
      req.admin = jwt.verify(token, secret, {
        algorithms: ["HS256"],
        issuer: DASHBOARD_JWT.issuer,
        audience: DASHBOARD_JWT.audience,
      });
      return next();
    } catch {
      /* not a dashboard JWT — try a Shopify session token */
    }
  }
  try {
    const shopify = verifyShopifySessionToken(token);
    req.admin = { sub: String(shopify.sub), shop: new URL(shopify.dest).hostname, sid: shopify.sid };
    return next();
  } catch (err) {
    log("warn", "admin_token_rejected", { reason: err.message, path: redactPath(req.path), ip: req.ip });
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

module.exports = { DASHBOARD_JWT, shopifyClientId, dashboardSecret, verifyShopifySessionToken, requireAdmin };

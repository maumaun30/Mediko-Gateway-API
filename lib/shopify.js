// Small pure helpers for Admin API responses.

/**
 * True when Shopify refused a field for lack of scope. A minted (client
 * credentials) token keeps the scopes granted when it was issued, so after
 * the merchant approves a new scope the cached token must be replaced.
 */
function isAccessDenied(json) {
  const errors = json && Array.isArray(json.errors) ? json.errors : []
  return errors.some((e) =>
    (e && e.extensions && e.extensions.code === 'ACCESS_DENIED') || /access denied/i.test(String(e && e.message)))
}

module.exports = { isAccessDenied }

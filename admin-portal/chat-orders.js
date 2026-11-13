// Order-number detection for the Chats page (browser + node tests, no build step).
// Only "#1042" or "order … 1042" count, so phone numbers and prices don't.
(function () {
  const ORDER_RE = /(?:#\s*|\border\s*(?:no\.?|number|num)?\s*[:#]?\s*)(\d{3,10})\b/i;

  /** First order number written in a message, digits only, or null. */
  function findOrderNumber(text) {
    const m = ORDER_RE.exec(String(text || ''));
    return m ? m[1] : null;
  }

  if (typeof window !== 'undefined') window.findOrderNumber = findOrderNumber;
  if (typeof module !== 'undefined') module.exports = { findOrderNumber };
})();

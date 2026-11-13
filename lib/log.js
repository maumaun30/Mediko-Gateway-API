// Structured logger (one JSON line per event).
// Moved verbatim from index.js.

// ── Structured logger ─────────────────────────────────────────────────────────
function log(level, event, data = {}) {
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      level,
      event,
      ...data,
    }),
  );
}

module.exports = { log };

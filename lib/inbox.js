// Moved verbatim from index.js.
const { queryAsync } = require("./db");

const RECORD_TABLES = {
  "submissions": "applications",
  "contact-submissions": "contact_submissions",
  "return-requests": "return_requests",
};

async function inboxCounts() {
  const out = {};
  for (const [key, table] of [["applications", "applications"], ["contact", "contact_submissions"], ["returns", "return_requests"]]) {
    const rows = await queryAsync(`SELECT status, COUNT(*) AS c FROM ${table} GROUP BY status`);
    const counts = { total: 0 };
    for (const r of rows) {
      counts[r.status || "pending"] = Number(r.c);
      counts.total += Number(r.c);
    }
    out[key] = counts;
  }
  return out;
}

module.exports = { RECORD_TABLES, inboxCounts };

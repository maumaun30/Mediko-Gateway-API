// Moved verbatim from index.js.
// TESTING_MODE bypasses rate limiter, time trap, and cooldown checks on form
// endpoints so you can submit repeatedly during local/staging testing.
// NEVER enable this in production.
const TESTING_MODE = String(process.env.TESTING_MODE || "").toLowerCase() === "true";

module.exports = { TESTING_MODE };

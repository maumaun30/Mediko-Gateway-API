// Moved verbatim from index.js.
const rateLimit = require("express-rate-limit");
const { TESTING_MODE } = require("./config");
const { log } = require("./log");

const { ipKeyGenerator } = rateLimit;

const submitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: { error: "Too many attempts. Please try again after 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req),
  skip: () => TESTING_MODE,
  handler(req, res, _next, options) {
    log("warn", "rate_limit_hit", { ip: req.ip });
    res.status(options.statusCode).json(options.message);
  },
});

module.exports = { ipKeyGenerator, submitLimiter };

"use strict";

const { rateLimit } = require("express-rate-limit");
const { body, validationResult } = require("express-validator");

// For multiple app instances, configure a shared rate-limit store (for example Redis).
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Try again later." },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Registration limit reached. Try again later." },
});

const orderLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many order requests. Try again shortly." },
});

const usernameRule = (field = "username") =>
  body(field)
    .isString()
    .withMessage("Username must be text")
    .bail()
    .trim()
    .isLength({ min: 3, max: 32 })
    .matches(/^[a-zA-Z0-9_-]+$/)
    .withMessage("Username must be 3-32 letters, numbers, underscores, or hyphens");

const registerRules = [
  usernameRule(),
  body("password")
    .isString()
    .withMessage("Password must be text")
    .bail()
    .custom((value) => {
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes < 12 || bytes > 72) {
        throw new Error("Password must be between 12 and 72 UTF-8 bytes");
      }
      return true;
    }),
];

const loginRules = [
  usernameRule(),
  body("password")
    .isString()
    .withMessage("Password must be text")
    .bail()
    .custom((value) => {
      const bytes = Buffer.byteLength(value, "utf8");
      if (bytes < 1 || bytes > 72) {
        throw new Error("Invalid credentials");
      }
      return true;
    }),
];

const orderRules = [
  body("serviceId").isInt({ min: 1 }).withMessage("Invalid service").toInt(),
  body("quantity")
    .isInt({ min: 1, max: 1000000 })
    .withMessage("Quantity is outside the allowed range")
    .toInt(),
  body("link")
    .isString()
    .withMessage("Link must be text")
    .bail()
    .trim()
    .isLength({ min: 1, max: 2048 })
    .isURL({ protocols: ["http", "https"], require_protocol: true })
    .withMessage("Enter a valid HTTP or HTTPS link"),
];

const orderStatusRules = [
  body("status")
    .isIn(["Pending", "In Progress", "Completed", "Cancelled"])
    .withMessage("Unsupported order status"),
];

function rejectInvalidInput(req, res, next) {
  const errors = validationResult(req)
    .array({ onlyFirstError: true })
    .map(({ location, path, param, msg }) => ({
      field: path || param,
      location,
      message: msg,
    }));

  if (errors.length > 0) {
    return res.status(400).json({ error: "Invalid request", details: errors });
  }
  return next();
}

module.exports = {
  loginLimiter,
  loginRules,
  orderLimiter,
  orderRules,
  orderStatusRules,
  rejectInvalidInput,
  registerLimiter,
  registerRules,
};
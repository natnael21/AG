/**
 * Typed application errors.
 *
 * Services throw these to state *what* went wrong; routes translate them into
 * an HTTP status via sendError(). Anything that is not an AppError is treated
 * as an internal fault: it is logged server-side and reported to the client as
 * a generic 500, so driver text, SQL and constraint names never reach the
 * browser.
 */

class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    this.expose = true;
  }
}

class ValidationError extends AppError {
  constructor(message) { super(message, 400); }
}

class NotFoundError extends AppError {
  constructor(message = 'Not found.') { super(message, 404); }
}

class ForbiddenError extends AppError {
  constructor(message = 'Access denied.') { super(message, 403); }
}

class ConflictError extends AppError {
  constructor(message) { super(message, 409); }
}

/* Postgres SQLSTATEs that map to a meaningful client-side status. */
const PG_STATUS = {
  '23505': [409, 'That record already exists.'],
  '23503': [409, 'That record is referenced by other data and cannot be changed.'],
  '23514': [400, 'That value is not allowed.'],
  '22P02': [400, 'One of the supplied values has the wrong format.'],
  '23502': [400, 'A required field is missing.'],
};

/**
 * Send an error response. Logs the full error, returns a safe message.
 */
function sendError(res, err, context) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message });
  }

  const mapped = err && err.code ? PG_STATUS[err.code] : null;
  if (mapped) {
    console.error(`[${context}]`, err.code, err.message);
    return res.status(mapped[0]).json({ error: mapped[1] });
  }

  console.error(`[${context}]`, err && err.stack ? err.stack : err);
  return res.status(500).json({ error: 'Something went wrong. Please try again.' });
}

/**
 * Wrap an async route handler so thrown errors become sendError responses.
 */
function route(context, handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (!res.headersSent) sendError(res, e, context);
    }
  };
}

/* ── Input normalisation ── */

/** Parse a positive integer id, or throw ValidationError. */
function parseId(value, field = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError(`${field} must be a positive integer.`);
  }
  return n;
}

/** Parse a non-negative money/quantity value, or throw ValidationError. */
function parseNumber(value, field, { min = 0, max = 1e9, integer = false } = {}) {
  if (value === '' || value === null || value === undefined) {
    throw new ValidationError(`${field} is required.`);
  }
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ValidationError(`${field} must be a number.`);
  if (integer && !Number.isInteger(n)) throw new ValidationError(`${field} must be a whole number.`);
  if (n < min) throw new ValidationError(`${field} must be at least ${min}.`);
  if (n > max) throw new ValidationError(`${field} is too large.`);
  return n;
}

/** Trim and require a non-empty string. */
function requireString(value, field, { max = 2000 } = {}) {
  const s = value == null ? '' : String(value).trim();
  if (!s) throw new ValidationError(`${field} is required.`);
  if (s.length > max) throw new ValidationError(`${field} must be ${max} characters or fewer.`);
  return s;
}

/** Trim to null when empty. */
function optionalString(value, { max = 2000 } = {}) {
  const s = value == null ? '' : String(value).trim();
  if (!s) return null;
  return s.slice(0, max);
}

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  ForbiddenError,
  ConflictError,
  sendError,
  route,
  parseId,
  parseNumber,
  requireString,
  optionalString,
};

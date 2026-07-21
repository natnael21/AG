/**
 * Unit tests for input parsing and the status workflow. These need no
 * database: they cover the pure logic the routes depend on.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseId,
  parseNumber,
  requireString,
  optionalString,
  AppError,
  ValidationError,
  NotFoundError,
  sendError,
} = require('../../services/errors');

const RepairOrderService = require('../../services/repair-order');

/* ── parseId ── */

test('parseId accepts positive integers in string or number form', () => {
  assert.equal(parseId(5), 5);
  assert.equal(parseId('42'), 42);
});

test('parseId rejects non-positive, fractional and non-numeric values', () => {
  for (const bad of [0, -1, 1.5, 'abc', '', null, undefined, {}, '1; DROP TABLE users']) {
    assert.throws(() => parseId(bad, 'id'), ValidationError, `should reject ${JSON.stringify(bad)}`);
  }
});

test('parseId names the field in its message', () => {
  assert.throws(() => parseId('x', 'customerId'), /customerId/);
});

/* ── parseNumber ── */

test('parseNumber accepts numeric strings and enforces bounds', () => {
  assert.equal(parseNumber('12.5', 'price'), 12.5);
  assert.throws(() => parseNumber(-1, 'price'), /at least/);
  assert.throws(() => parseNumber(1e12, 'price'), /too large/);
});

test('parseNumber enforces integer when asked', () => {
  assert.equal(parseNumber('3', 'qty', { integer: true }), 3);
  assert.throws(() => parseNumber('3.5', 'qty', { integer: true }), /whole number/);
});

test('parseNumber rejects empty and non-numeric input', () => {
  assert.throws(() => parseNumber('', 'qty'), /required/);
  assert.throws(() => parseNumber(null, 'qty'), /required/);
  assert.throws(() => parseNumber('abc', 'qty'), /must be a number/);
  assert.throws(() => parseNumber(NaN, 'qty'), /must be a number/);
});

test('parseNumber allows a negative value when the range permits it', () => {
  assert.equal(parseNumber(-5, 'adjustment', { min: -100, integer: true }), -5);
});

/* ── strings ── */

test('requireString trims and rejects blank input', () => {
  assert.equal(requireString('  hello  ', 'name'), 'hello');
  assert.throws(() => requireString('   ', 'name'), /required/);
  assert.throws(() => requireString(null, 'name'), /required/);
});

test('requireString enforces a maximum length', () => {
  assert.throws(() => requireString('x'.repeat(300), 'name', { max: 200 }), /200 characters/);
});

test('optionalString returns null for blank and truncates to max', () => {
  assert.equal(optionalString('  '), null);
  assert.equal(optionalString(null), null);
  assert.equal(optionalString(' kept '), 'kept');
  assert.equal(optionalString('x'.repeat(50), { max: 10 }).length, 10);
});

/* ── Error mapping ── */

test('sendError maps AppError subclasses to their status', () => {
  const captured = {};
  const res = {
    status(code) { captured.code = code; return this; },
    json(body) { captured.body = body; return this; },
  };

  sendError(res, new NotFoundError('Customer not found.'), 'test');
  assert.equal(captured.code, 404);
  assert.equal(captured.body.error, 'Customer not found.');
});

test('sendError maps a unique violation to 409 without leaking SQL', () => {
  const captured = {};
  const res = {
    status(code) { captured.code = code; return this; },
    json(body) { captured.body = body; return this; },
  };

  const pgErr = Object.assign(new Error('duplicate key value violates unique constraint "idx_parts_ws_part_number"'), { code: '23505' });
  sendError(res, pgErr, 'test');

  assert.equal(captured.code, 409);
  assert.ok(!/idx_parts|constraint|duplicate key/.test(captured.body.error), 'must not leak the constraint name');
});

test('sendError hides unexpected errors behind a generic 500', () => {
  const captured = {};
  const res = {
    status(code) { captured.code = code; return this; },
    json(body) { captured.body = body; return this; },
  };

  const original = console.error;
  console.error = () => {};
  try {
    sendError(res, new Error('connect ECONNREFUSED 10.0.0.5:5432'), 'test');
  } finally {
    console.error = original;
  }

  assert.equal(captured.code, 500);
  assert.ok(!/ECONNREFUSED|10\.0\.0\.5/.test(captured.body.error), 'must not leak internal detail');
});

test('AppError carries its status', () => {
  assert.equal(new AppError('x', 418).status, 418);
  assert.equal(new ValidationError('x').status, 400);
});

/* ── Status workflow ── */

const svc = new RepairOrderService({});

test('valid repair order status transitions are allowed', () => {
  assert.ok(svc.isValidStatusTransition('open', 'in_progress'));
  assert.ok(svc.isValidStatusTransition('open', 'awaiting_parts'));
  assert.ok(svc.isValidStatusTransition('in_progress', 'completed'));
  assert.ok(svc.isValidStatusTransition('awaiting_parts', 'in_progress'));
  assert.ok(svc.isValidStatusTransition('ready', 'completed'));
});

test('invalid repair order status transitions are refused', () => {
  assert.equal(svc.isValidStatusTransition('open', 'completed'), false);
  assert.equal(svc.isValidStatusTransition('open', 'ready'), false);
  assert.equal(svc.isValidStatusTransition('cancelled', 'open'), false);
  assert.equal(svc.isValidStatusTransition('completed', 'in_progress'), false);
});

test('terminal states allow no onward transition', () => {
  for (const target of ['open', 'in_progress', 'awaiting_parts', 'ready', 'completed', 'cancelled']) {
    assert.equal(svc.isValidStatusTransition('completed', target), false, `completed -> ${target}`);
    assert.equal(svc.isValidStatusTransition('cancelled', target), false, `cancelled -> ${target}`);
  }
});

test('an unknown status is never a valid source', () => {
  assert.equal(svc.isValidStatusTransition('nonsense', 'open'), false);
});

test('every non-terminal state can reach cancelled', () => {
  for (const from of ['draft', 'open', 'in_progress', 'awaiting_parts', 'ready']) {
    assert.ok(svc.isValidStatusTransition(from, 'cancelled'), `${from} -> cancelled`);
  }
});

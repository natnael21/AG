#!/usr/bin/env node
/**
 * Dependency-free lint pass.
 *
 * `npm run lint` used to be `echo "TODO" && exit 0`, so CI's lint step proved
 * nothing. This is deliberately narrow: it parses every source file and checks
 * the few rules this codebase has actually been bitten by. It is not a
 * replacement for ESLint — add that when the team is ready to agree a config —
 * but it fails on real problems rather than passing on none.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, '..', 'public');

const problems = [];

function walk(dir, filter) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, filter));
    else if (filter(entry.name)) out.push(full);
  }
  return out;
}

const isJs = (name) => name.endsWith('.js');

const apiFiles = [
  ...walk(path.join(ROOT, 'services'), isJs),
  ...walk(path.join(ROOT, 'src'), isJs),
  ...walk(path.join(ROOT, 'scripts'), isJs),
  ...walk(path.join(ROOT, 'test'), isJs),
  path.join(ROOT, 'server.js'),
].filter((f) => fs.existsSync(f));

const publicFiles = walk(PUBLIC_DIR, isJs);

function report(file, message) {
  problems.push(`${path.relative(path.join(ROOT, '..'), file)}: ${message}`);
}

/* 1. Everything must parse. */
for (const file of [...apiFiles, ...publicFiles]) {
  const source = fs.readFileSync(file, 'utf8');
  try {
    new vm.Script(source, { filename: file });
  } catch (e) {
    report(file, `syntax error: ${e.message}`);
  }
}

/* 2. Server code must not send a raw error message to the client: it leaks
      driver text, SQL and constraint names. Use sendError()/route() instead. */
for (const file of apiFiles) {
  if (file.includes(`${path.sep}test${path.sep}`)) continue;
  const source = fs.readFileSync(file, 'utf8');
  source.split('\n').forEach((line, i) => {
    if (/res\.(status\([0-9]+\)\.)?json\(\s*\{\s*error:\s*(e|err|error)\.message/.test(line)) {
      report(file, `${i + 1}: sends a raw error message to the client; use sendError(res, e, context)`);
    }
    if (/error:\s*['"`][^'"`]*['"`]\s*\+\s*(e|err|error)\.message/.test(line)) {
      report(file, `${i + 1}: concatenates a raw error message into the response; use sendError()`);
    }
  });
}

/* 3. No credentials in the browser bundle. auth.js previously shipped real
      accounts with plaintext passwords to every visitor. */
for (const file of publicFiles) {
  const source = fs.readFileSync(file, 'utf8');
  source.split('\n').forEach((line, i) => {
    if (/password\s*:\s*['"][^'"]{3,}['"]/.test(line)) {
      report(file, `${i + 1}: literal password in client-side code`);
    }
  });
}

/* 4. SQL built by interpolating caller-supplied object keys is an injection
      risk; assignments must be parameterised. */
for (const file of apiFiles) {
  if (file.includes(`${path.sep}test${path.sep}`)) continue;
  const source = fs.readFileSync(file, 'utf8');
  if (/SET \$\{Object\.keys\(/.test(source)) {
    report(file, 'builds a SET clause from raw object keys; whitelist columns instead');
  }
}

if (problems.length) {
  console.error(`[lint] ${problems.length} problem(s):\n`);
  problems.forEach((p) => console.error('  ' + p));
  process.exit(1);
}

console.log(`[lint] ok — ${apiFiles.length} api file(s), ${publicFiles.length} public file(s)`);

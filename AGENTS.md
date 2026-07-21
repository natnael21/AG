# Repository Guidelines

## Project Structure & Module Organization

AG Shop Pro combines a Node.js/Express API with a static browser frontend. Backend code lives in `api/`: `server.js` defines the application and routes, `services/` contains business logic, `src/routes/` holds modular routes, `migrations/` contains ordered PostgreSQL schema changes, and `scripts/` contains operational utilities. Static HTML and JavaScript are in `public/`; there is no frontend compilation step. Deployment configuration is under `infra/` and `.github/workflows/`. Treat `KNOWLEDGE_TRANSFER.md` as operational context, not application code.

## Build, Test, and Development Commands

Run Node commands from `api/`:

- `npm ci` installs the exact dependency versions from `package-lock.json` (Node 24 is used in CI).
- `npm run dev` starts the API with `node server.js`, normally on port 3000. It also serves `public/`, so the whole app is reachable at `http://localhost:3000/login.html` with no second server.
- `npm run migrate:latest` applies pending SQL migrations using the configured PostgreSQL connection.
- `npm test` runs `test:unit` then `test:integration`.
- `npm run test:unit` runs the database-free tests (input parsing, error mapping, RO status workflow).
- `npm run test:integration` boots the real app against a real PostgreSQL and drives it over HTTP. It needs a database it may drop and recreate — see `api/test/README.md`.
- `npm run lint` parses every source file and enforces the rules this codebase has been bitten by: no raw `e.message` in a client response, no literal passwords in `public/`, no SQL built from caller-supplied object keys.

There is no build command for `public/`; it is plain HTML/JS with no compile step.

## Coding Style & Naming Conventions

Use CommonJS (`require`, `module.exports`) and follow nearby JavaScript style: two-space indentation, semicolons, single quotes, `camelCase` variables/functions, and `PascalCase` classes. Use kebab-case filenames such as `customer-portal.js`. Keep route handlers thin and place reusable database/business operations in `api/services/`. Use parameterized PostgreSQL queries (`$1`, `$2`) and transactions for multi-step writes. Name migrations with a zero-padded sequence and description, for example `007_add_invoice_status.sql`.

## Testing Guidelines

Tests use the built-in `node:test` runner — no framework dependency. Unit tests live in `api/test/unit/*.test.js`; route, auth, tenant-isolation and migration coverage lives in `api/test/integration.test.js`, which runs against a real PostgreSQL built from `api/migrations`.

Prefer integration tests over mocks for anything touching the database. Workspace isolation is enforced by the `WHERE workspace_id = $1` clauses themselves, so a stubbed pool proves nothing about it; every new read path should be asserted against a second seeded workspace. `api/test/README.md` documents the setup and what is covered.

Before submitting, run `npm test` and `npm run lint`, and exercise `/api/health` with appropriate environment configuration.

## Commit & Pull Request Guidelines

History uses short imperative summaries, sometimes with a ticket prefix (for example, `AGSP-22: CSV bulk import...` or `fix: correct license_plate...`). Keep commits focused and use the relevant issue key when available. Pull requests should explain the change and validation performed, link issues, call out migrations or configuration changes, and include screenshots for updates under `public/`. Never commit `.env`, credentials, customer data, or production secrets; update `api/.env.example` with safe placeholders when adding configuration.

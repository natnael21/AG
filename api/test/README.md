# Tests

Two suites, both run by `npm test`:

| Command | What it does | Needs a database |
|---|---|---|
| `npm run test:unit` | Input parsing, error→HTTP mapping, repair-order status workflow | No |
| `npm run test:integration` | Boots the real Express app against a real PostgreSQL and drives it over HTTP | **Yes** |

The integration suite deliberately uses a real database. Workspace isolation is
enforced by the `WHERE workspace_id = $1` clauses themselves, so a stubbed pool
would assert nothing about the thing most worth protecting. Every read path is
checked against a second seeded workspace to prove there is no cross-tenant
leakage.

## Running the integration tests

`test/helpers.js` drops and recreates a database (`agshop_test` by default) and
applies every file in `api/migrations` in order, so it also serves as a
migration check on a fresh schema.

Point it at any PostgreSQL you can create databases on:

```bash
export TEST_DB_HOST=127.0.0.1
export TEST_DB_PORT=5432
export TEST_DB_USER=postgres
export TEST_DB_PASS=postgres
export TEST_DB_SSL=0          # local postgres has no TLS; RDS needs it
npm run test:integration
```

| Variable | Default | Notes |
|---|---|---|
| `TEST_DB_HOST` / `TEST_DB_PORT` / `TEST_DB_USER` / `TEST_DB_PASS` | falls back to `DB_*` | Connection |
| `TEST_DB_NAME` | `agshop_test` | **Dropped and recreated on every run** |
| `TEST_DB_ADMIN` | `postgres` | Database used to issue `CREATE DATABASE` |
| `TEST_DB_SSL` | falls back to `DB_SSL` | `0` disables TLS |

`TEST_DB_NAME` is destroyed on each run — never point it at a database you care
about.

Integration tests run with `--test-concurrency=1`: they share one app instance
and one database, and the fixtures are order-dependent.

## Docker

If you have no local PostgreSQL:

```bash
docker run --rm -d --name agshop-test-db \
  -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
TEST_DB_HOST=127.0.0.1 TEST_DB_USER=postgres TEST_DB_PASS=postgres TEST_DB_SSL=0 \
  npm run test:integration
docker stop agshop-test-db
```

## What is covered

- **Auth**: login/logout, token expiry, identical failure messages for a wrong
  password and an unknown email (no account enumeration).
- **Authorization**: role gates per route; a manager cannot grant `super_admin`,
  reset a super_admin's password, or change their own role.
- **Workspace isolation**: customers, vehicles, repair orders, parts,
  appointments, reports and the user directory are each checked against a
  second workspace.
- **Customer + vehicle**: creation, validation, duplicate email/VIN, VIN
  normalisation, a vehicle may not be attached to another tenant's customer.
- **Repair orders**: creation, the customer↔vehicle pairing rule, concurrent
  RO-number allocation, updates, and the full status workflow incl. terminal
  states.
- **Parts, labor, totals**: catalog and ad-hoc lines, stock draw-down,
  cross-workspace part rejection, and recalculated totals.
- **Time tracking**: clock in/out, duration, one open entry per technician.
- **Customer portal**: login scoping, `portal_enabled`, record isolation,
  appointments (incl. past-date rejection and double-submit), feedback rules,
  password change invalidating sessions, and that a staff token cannot
  authenticate the portal.
- **Reporting**: that revenue is not multiplied by the number of line items or
  vehicles (a real bug these tests pin).
- **Error handling**: no SQL/driver detail reaches the client.

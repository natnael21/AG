# AG Shop Pro — FAQ and Troubleshooting Guide

> **Audience:** Users and support personnel.
> **How to use:** Find the category, then the symptom. Each entry gives the likely cause,
> a **user-level** fix, an **admin-level** fix, when to **escalate**, and the relevant
> **logs/checks**. "Admin" means a `super_admin` / DevOps with server access.

## Table of Contents

1. [Login and accounts](#1-login-and-accounts)
2. [Roles and permissions](#2-roles-and-permissions)
3. [Customers](#3-customers)
4. [Vehicles](#4-vehicles)
5. [Repair orders](#5-repair-orders)
6. [Parts and inventory](#6-parts-and-inventory)
7. [Technician time tracking](#7-technician-time-tracking)
8. [Appointments](#8-appointments)
9. [Customer portal](#9-customer-portal)
10. [Reports](#10-reports)
11. [Imports](#11-imports)
12. [Deployment](#12-deployment)
13. [Database](#13-database)
14. [Application availability](#14-application-availability)

---

## 1. Login and accounts

**Q: I can't sign in — "Incorrect email or password."**
- **Cause:** Wrong password, or the account is deactivated, or the email doesn't exist.
- **User fix:** Re-check; use **Forgot password**.
- **Admin fix:** `SELECT active FROM users WHERE lower(email)=lower('…')`; reactivate or
  reset the password (`POST /api/users/:id/reset-password`, or SQL — see
  [`OPERATIONS_RUNBOOK.md` §16](OPERATIONS_RUNBOOK.md)).
- **Escalate:** If the account should exist but doesn't.
- **Checks:** `users.active`, `api-error.log`.

**Q: "Too many attempts. Please wait…"**
- **Cause:** Rate limit — 10 sign-in attempts per 15 minutes per IP.
- **User fix:** Wait a few minutes.
- **Admin fix:** Confirm `trust proxy` is set so the real client IP is used behind Nginx
  (it is, `trust proxy 1`). Shared-NAT sites may hit this collectively.
- **Escalate:** If legitimate users are repeatedly blocked from one office IP.

**Q: The password reset email never arrives.**
- **Cause:** SMTP not configured or failing.
- **User fix:** Ask your admin.
- **Admin fix:** Check logs for `[forgot-password] Email delivery failed … reset link:
  <url>` (the link is logged when email fails). Fix SMTP env and restart; verify with
  Super Admin → Settings → **email test** (`POST /api/admin/test-email`).
- **Checks:** `api-out.log`/`api-error.log`, `/api/health` `smtp` check.

**Q: I keep getting logged out ("Session expired").**
- **Cause:** Staff sessions last 8 hours (24h for portal); a role change or deactivation
  **ends your sessions immediately**; closing the tab ends the session.
- **User fix:** Sign in again.
- **Admin fix:** If unexpected, check whether the user's role was changed
  (`SELECT role FROM users WHERE …`).

**Q: How do I create the very first admin?**
- **Admin only:** Insert a bcrypt-hashed `super_admin` directly (no seeded account exists)
  — [`OPERATIONS_RUNBOOK.md` §16](OPERATIONS_RUNBOOK.md).

## 2. Roles and permissions

**Q: A button says "Insufficient permissions" or is missing.**
- **Cause:** Your role can't perform that action (route is role-gated).
- **User fix:** Check the permission matrix in [`USER_MANUAL.md`](USER_MANUAL.md) /
  [`TECHNICAL_ARCHITECTURE.md` §9](TECHNICAL_ARCHITECTURE.md). Ask a manager/admin to do it.
- **Note:** Advisors/technicians can't see reports; only managers/super_admins can.

**Q: A manager can't promote someone to super_admin.**
- **Cause:** Intentional — only a `super_admin` can grant `super_admin`.
- **Resolution:** A platform admin must do it (rarely appropriate — shops stay `manager`).

**Q: A shop owner can see other shops' data.**
- **Cause:** The owner was wrongly created as `super_admin` (an old bug).
- **Admin fix:** Run migration `008_signup_owner_role.sql` (demotes signup owners to
  `manager`), or `UPDATE users SET role='manager' …` for that account. See
  [`PRODUCT_OVERVIEW.md` §8](PRODUCT_OVERVIEW.md). **This is a security issue — escalate.**

## 3. Customers

**Q: "A customer with that email already exists."**
- **Cause:** Duplicate email within the shop (dedupe key).
- **User fix:** Search and reuse the existing customer.

**Q: I can't edit or delete a customer.**
- **Cause:** There is **no staff-side customer edit or delete** endpoint. Customers edit
  their **own** profile via the portal.
- **Resolution:** Not available; record as a limitation. (A future enhancement.)

**Q: Customer history is empty.**
- **Cause:** No repair orders yet, or wrong workspace selected.
- **User fix:** Confirm the active workspace; create/complete ROs.

## 4. Vehicles

**Q: "A vehicle with that VIN already exists in this workspace."**
- **Cause:** Duplicate VIN in the shop.
- **User fix:** The vehicle is already on file — use it.

**Q: "year must be at least 1900" / "…is too large."**
- **Cause:** Year outside 1900 … (current year + 2).
- **User fix:** Enter a valid year.

**Q: Can I move a vehicle to another customer / delete it?**
- **Cause:** No vehicle delete endpoint; update changes VIN/make/model/plate/year/mileage
  but not owner.
- **Resolution:** Not supported today.

## 5. Repair orders

**Q: "Cannot change status from X to Y."**
- **Cause:** Illegal status transition. Allowed: `open→in_progress/awaiting_parts`,
  `in_progress→awaiting_parts/ready/completed`, `awaiting_parts→in_progress/ready`,
  `ready→completed`; any non-terminal → `cancelled`; `completed`/`cancelled` are terminal.
- **User fix:** Take the allowed step (e.g. go via `in_progress`/`ready` before
  `completed`).

**Q: I added the wrong part/labor line — how do I remove it?**
- **Cause:** Lines are **add-only**; there is no edit/delete endpoint.
- **User fix:** None in-app. Options: add a compensating adjustment where relevant.
- **Admin fix:** A direct DB correction is possible but risky (must re-run
  `recalculate_ro_totals`); **escalate** rather than editing the DB casually.

**Q: Two repair orders created at once — did the numbers collide?**
- **Cause:** None — RO numbers are allocated under a per-workspace advisory lock and are
  unique (a test pins concurrent creation).

**Q: Can I delete a repair order?**
- **Cause:** No delete; use **cancel** (status). Customer/vehicle FKs are `RESTRICT`.

## 6. Parts and inventory

**Q: "That part number already exists in this workspace."**
- **Cause:** Unique `(workspace, part_number)`.
- **User fix:** Use a unique number or edit the existing part.

**Q: "Cannot reduce inventory below zero."**
- **Cause:** Adjustment would make stock negative.
- **User fix:** Reduce the adjustment magnitude.

**Q: Where do I import a parts CSV?**
- **Cause:** **No parts CSV import route exists** (only customers/vehicles).
- **User fix:** Enter parts by hand, or add ad-hoc parts on ROs.

**Q: Stock didn't go down when I added a part.**
- **Cause:** You added an **ad-hoc** part (custom number/name), not a **catalog** part.
  Only catalog parts (chosen `partId`) draw down stock.

## 7. Technician time tracking

**Q: "You are already clocked in to repair order N. Clock out first."**
- **Cause:** One open time entry per technician across all ROs.
- **User fix:** Clock out of the other RO first.

**Q: My older time entries aren't on the Time page.**
- **Cause:** There is no per-technician time report; the page reconstructs from ~25 recent
  ROs and says so on screen.
- **Resolution:** Expected behavior; managers can see aggregate technician performance in
  reports.

**Q: "You are not clocked in to this repair order."**
- **Cause:** Clocking out without an open entry on that RO.
- **User fix:** Clock in first.

## 8. Appointments

**Q: "preferredDate cannot be in the past."**
- **Cause:** Past date; must be today or later (`YYYY-MM-DD`).
- **User fix:** Choose a valid date.

**Q: I booked twice but only see one appointment.**
- **Cause:** Same vehicle/date/concern is deduped into one pending request.

**Q: I can't edit my appointment.**
- **Cause:** Only **pending** appointments are editable by the customer; confirmed ones
  aren't.
- **User fix:** Contact the shop; or cancel (pending/confirmed) and rebook.

**Q: Do appointments become repair orders / send reminders?**
- **Cause:** No — appointments are a **request inbox**; staff confirm them. No scheduler,
  no reminders, no auto-conversion to an RO.

## 9. Customer portal

**Q: A customer can't sign in to the portal.**
- **Cause:** Portal access not enabled, no `portal_password_hash`, wrong shop selected, or
  no email on file.
- **User fix:** Pick the correct shop.
- **Admin/manager fix:** Enable portal access (returns a temp password) or reset it
  (`POST /api/admin/customers/:id/enable-portal` / `…/reset-portal-password`). Ensure the
  customer has an email.

**Q: A staff member can't use their login on the portal.**
- **Cause:** Intentional — staff and customer sessions are separate and non-interchangeable.

**Q: "You have already left feedback for this repair order."**
- **Cause:** One rating per completed RO per customer.

**Q: Portal shows no history/vehicles.**
- **Cause:** The signed-in customer has none, or records belong to a different customer.
- **Resolution:** Confirm the ROs/vehicles are under that customer id in that shop.

## 10. Reports

**Q: Advisors/technicians can't open reports.**
- **Cause:** Reports are `super_admin`/`manager` only.

**Q: Revenue looks doubled/inflated.**
- **Cause:** This was a real fan-out bug and is **fixed** — reports roll up parts/labor in
  subqueries so revenue isn't multiplied by line-item/vehicle counts (a test pins this).
  If you still see it, **escalate** with the workspace and date range.

**Q: The Burn-rate charts are blank.**
- **Cause:** The chart library (`Chart.js`) is loaded from a CDN and couldn't load.
- **User fix:** Try a different network. The numbers still display.
- **Admin fix:** Ensure the browser can reach `cdn.jsdelivr.net` (CSP allows it).

**Q: Where are Square fees / refunds?**
- **Cause:** No payment processor is connected; those show "—" (`not_connected`), not
  zero.

## 11. Imports

**Q: Vehicles imported but aren't linked to customers.**
- **Cause:** A vehicle links only when its `customer_email` matches an existing customer in
  the shop.
- **User fix:** Import customers first; ensure `customer_email` matches exactly (case is
  normalized).

**Q: Some rows were skipped.**
- **Cause:** Missing required fields (customer needs `full_name`; vehicle needs
  `vin`/`make`/`model`) or a duplicate (email / VIN).
- **User fix:** Read the returned `errors[]` and `duplicates` count; fix and re-upload the
  failed rows.

**Q: The CSV upload was rejected.**
- **Cause:** File >10 MB, or the field name isn't `file`.
- **User fix:** Split the file; ensure the form uploads under field name `file`.

## 12. Deployment

**Q: A push to `main` didn't deploy.**
- **Cause:** The `production` environment **approval gate** is waiting.
- **Admin fix:** Approve the run in GitHub Actions.

**Q: The prod deploy failed and "rolled back."**
- **Cause:** The post-deploy healthcheck failed after go-live; the workflow ran
  `rollback.sh`.
- **Admin fix:** Read `api-error.log`; the previous release is live again. Fix forward and
  redeploy. See [`OPERATIONS_RUNBOOK.md` §13/§18](OPERATIONS_RUNBOOK.md).

**Q: SCP/SSH timeout in the workflow.**
- **Cause:** Security group blocks the runner or `EC2_HOST` is wrong.
- **Admin fix:** Verify inbound 22 and the `EC2_HOST`/`EC2_SSH_KEY` secrets.

**Q: Migrations fail on a brand-new database.**
- **Cause:** The `004`/`006` duplicate-migration issue.
- **Admin fix:** Pre-insert `004` into `schema_migrations`, then migrate
  ([`OPERATIONS_RUNBOOK.md` §8](OPERATIONS_RUNBOOK.md)).

## 13. Database

**Q: `/api/health` shows `database: error` (HTTP 503).**
- **Cause:** DB unreachable / bad credentials / TLS mismatch.
- **Admin fix:** Check `shared/.env` `DB_*`; RDS requires TLS (`DB_SSL` unset/≠0); confirm
  the EC2→RDS security group allows 5432. Test:
  `psql "host=<DB_HOST> … sslmode=require" -c 'SELECT 1'`.

**Q: A write fails with a generic "Something went wrong."**
- **Cause:** An unexpected server error; a mapped constraint error would give a specific
  message. Raw SQL detail is intentionally hidden from users.
- **Admin fix:** Find the logged SQLSTATE/stack in `api-error.log` with the route context.

**Q: I need to back up / restore.**
- **Admin:** No repo scripts exist — use RDS snapshots + `pg_dump`/`pg_restore`
  ([`OPERATIONS_RUNBOOK.md` §14](OPERATIONS_RUNBOOK.md)). **Confirm the backup policy is in
  place** (it's on the Manual Actions Checklist).

## 14. Application availability

**Q: The whole app is down.**
- **User:** Confirm the URL and your internet; try again shortly.
- **Admin:** `curl /api/health`; `pm2 list` (is `ag-api` online / crash-looping?); tail
  `api-error.log` and Nginx `error.log`; restart (`pm2 restart ag-api`) or roll back if a
  recent deploy caused it. See [`OPERATIONS_RUNBOOK.md` §22](OPERATIONS_RUNBOOK.md).

**Q: Site is up but every page 403s at `/`.**
- **Cause:** Nginx `index`/fallback not pointing at `login.html`.
- **Admin fix:** Confirm the deployed vhost matches `infra/nginx/agshopro.conf`.

**Q: App restarts itself periodically.**
- **Cause:** PM2 `max_memory_restart` at 512M, or crashes hitting `max_restarts`.
- **Admin fix:** `pm2 describe ag-api` (restart count/memory); investigate a leak or a
  heavy report query; check logs.

**When to escalate (all categories):** any suspected **cross-tenant data leak**, **data
loss**, **auth bypass**, or an outage you can't resolve in minutes → escalate to DevOps
immediately and preserve logs.

**Related:** [`USER_MANUAL.md`](USER_MANUAL.md) ·
[`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) ·
[`FEATURE_REFERENCE.md`](FEATURE_REFERENCE.md)

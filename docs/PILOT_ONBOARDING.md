# AG Shop Pro — Pilot Onboarding Guide

> **Audience:** The first repair shops participating in the pilot.
> **Purpose:** Set clear expectations for what the pilot includes, how a shop is set up,
> how support works, and how success is measured. Everything here reflects the software as
> it actually exists today.

## Table of Contents

1. [What the pilot includes](#1-what-the-pilot-includes)
2. [What is excluded](#2-what-is-excluded)
3. [Pilot goals](#3-pilot-goals)
4. [Responsibilities](#4-responsibilities)
5. [Supported devices and browsers](#5-supported-devices-and-browsers)
6. [Account and workspace setup](#6-account-and-workspace-setup)
7. [User-role setup](#7-user-role-setup)
8. [Initial data requirements & import](#8-initial-data-requirements--import)
9. [Training](#9-training)
10. [Recommended pilot workflow](#10-recommended-pilot-workflow)
11. [Support & issue reporting](#11-support--issue-reporting)
12. [Known pilot limitations](#12-known-pilot-limitations)
13. [Data protection expectations](#13-data-protection-expectations)
14. [Feedback schedule](#14-feedback-schedule)
15. [Pilot success & exit criteria](#15-pilot-success--exit-criteria)
16. [Pilot launch checklist](#16-pilot-launch-checklist)

---

## 1. What the pilot includes

The pilot covers the **operational core** of running a repair shop in AG Shop Pro:

- Customer and vehicle records.
- The full **repair-order lifecycle** (create → parts/labor → time tracking → status →
  complete) with automatic totals.
- **Parts catalog & inventory** with stock draw-down and low-stock visibility.
- **Technician time tracking** (clock in/out).
- **Business reports** (financial, technician, customer, parts) and a **burn-rate**
  dashboard.
- The **customer portal** (history, appointment requests, feedback, profile).
- **CSV import** of customers and vehicles.
- Staff **user management** within the shop.

## 2. What is excluded

Not part of the pilot because they are **not built** (see
[`FEATURE_REFERENCE.md`](FEATURE_REFERENCE.md)):

- Invoicing, payment capture, or any Square/POS integration.
- SMS/text reminders, marketing campaigns, call logging (Twilio).
- Estimate/parts integrations (Mitchell 1 live sync, CCC One, Worldpac speedDIAL) —
  Mitchell shows a **read-only status** panel only.
- Mobile apps (browser only).
- Parts CSV import (customers/vehicles only).
- Editing/deleting repair-order lines, and deleting customers/vehicles/ROs.

> The public help page `docs.html` describes some of the above as if available. **It is
> aspirational** — rely on the [`USER_MANUAL.md`](USER_MANUAL.md) for what works.

## 3. Pilot goals

- Validate that a real shop can run day-to-day operations end-to-end in AG Shop Pro.
- Confirm **workspace isolation** and role permissions behave correctly with real staff.
- Surface data-quality, usability, and stability issues before broader rollout.
- Establish support, backup, and operations procedures under real load.

## 4. Responsibilities

**Pilot shop:**
- Provide accurate initial data (customers, vehicles, parts).
- Use the system for real work during the pilot window.
- Report issues promptly with steps to reproduce.
- Attend training and submit scheduled feedback.
- Keep credentials secure and follow the portal-access hand-off process.

**AG Shop Pro team:**
- Provision the workspace and the shop's owner (manager) account.
- Deliver training and this documentation set.
- Operate and monitor the platform (deploys, backups, health) — see
  [`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md).
- Triage and prioritize reported issues; communicate releases.
- Protect pilot data and honor the data-protection expectations below.

## 5. Supported devices and browsers

- **Web only**, served over HTTPS. No installation.
- **Desktop/laptop** modern browsers (Chrome, Edge, Firefox, Safari) for manager/advisor
  consoles.
- **Mobile/tablet** browser works well for the **technician** page (`tech.html`, designed
  mobile-first) and the **customer portal** (`portal.html`).
- **Note:** the **Burn-rate** dashboard loads its chart library from a CDN
  (`cdn.jsdelivr.net`); on a network that blocks it, the numbers still show but the charts
  won't render.
- Sessions are stored per browser tab and end when the tab closes.

## 6. Account and workspace setup

1. **AG creates the first platform admin** (`super_admin`) directly in the database (one
   time — see [`OPERATIONS_RUNBOOK.md` §16](OPERATIONS_RUNBOOK.md)).
2. The shop submits a **signup** (via `/login.html` → sign-up wizard) **or** AG creates the
   request in Super Admin → Onboard shop.
3. AG **approves** the signup. This automatically:
   - creates the shop's **workspace**, and
   - creates the shop owner as a **`manager`** of that workspace,
   - and shows/e-mails a **temporary password**.
4. The owner signs in at `/login.html` and changes their password.

> The owner is a **manager**, never a `super_admin` — a manager controls their own shop
> and nothing else. This is by design (see [`PRODUCT_OVERVIEW.md` §8](PRODUCT_OVERVIEW.md)).

## 7. User-role setup

The shop manager (or AG super_admin) creates staff accounts:

| Person | Role | Console |
|---|---|---|
| Owner / manager | `manager` | `manager.html` |
| Front desk | `service_advisor` | `service.html` |
| Bay technician | `technician` | `tech.html` |

**How:** manager console → team → **Invite** (name, email, role). A **temporary password
is shown once** — hand it to the person (no email is sent). They sign in and set their own
password via profile.

## 8. Initial data requirements & import

Prepare, then import (manager/super_admin, via `integrations.html` or Super Admin → Data
import):

- **Customers CSV** — headers: `full_name` (or `name`), `email`, `phone`.
- **Vehicles CSV** — headers: `vin`, `make`, `model`, `year`, `plate` (or
  `license_plate`), `mileage`, `customer_email`.
  - A vehicle links to a customer **only if** `customer_email` matches an already-imported
    customer — **import customers first**.
- **Parts** — **no CSV import**; enter the initial catalog by hand in the manager console
  (or create parts ad-hoc on repair orders).

Import behavior: emails are lower-cased, VINs upper-cased, duplicates (email / VIN)
skipped and counted, bad rows reported. Review the returned `{ total, success, duplicates,
errors }` summary and reconcile.

## 9. Training

Run the [`TRAINING_WALKTHROUGH.md`](TRAINING_WALKTHROUGH.md) live with each role:
sign-in → dashboard → customer → vehicle → RO → parts → labor → assign tech → clock
in/out → status → complete → totals → reports → enable portal → portal sign-in → history →
appointment → feedback → sign out. Emphasize the **features that are not available** so
staff don't wait on non-existent functions.

## 10. Recommended pilot workflow

1. **Week 0:** setup (workspace, users, data import, training).
2. **Weeks 1–N (pilot window):** run **real** repair orders through the full lifecycle;
   enable the portal for a subset of willing customers; managers review reports weekly.
3. Keep a running issue log (see §11). Hold the scheduled feedback sessions (§14).
4. Daily: staff work ROs; manager checks the dashboard, appointments, and low-stock.
5. Weekly: AG reviews health, logs, backups, and the issue list; communicates any release.

## 11. Support & issue reporting

- **Support contact:** the AG Shop Pro team (email `support@agshopro.com` is the address
  configured in the app; **confirm the real pilot support channel/SLA** with your AG
  coordinator).
- **Report an issue with:** what you were doing (page + action), what you expected, what
  happened, the exact on-screen message, the time, the shop/workspace, and the role/user.
- **Escalation path:** shop staff → shop manager → AG support → DevOps.
- Administrators can correlate reports against `/api/health` and server logs
  (see [`OPERATIONS_RUNBOOK.md` §12](OPERATIONS_RUNBOOK.md)).

## 12. Known pilot limitations

- First `super_admin` and any DB-level fixes are manual.
- **Temporary passwords are handed over out-of-band** (shown once; emailed only where SMTP
  is configured). **There is no staff invite email.**
- **Email depends on SMTP being configured** — verify with the Super Admin **email test**
  before relying on approval/reset emails.
- Repair-order **lines can't be edited or deleted**; there are **no delete** operations for
  customers/vehicles/ROs (ROs can be cancelled).
- Reports have **no pagination cap** on some queries (fine at pilot scale).
- **Single EC2 host** runs prod + preprod; there is no multi-AZ HA. Backups/monitoring
  must be confirmed (see the Manual Actions Checklist).
- The Mitchell/Square/Twilio/CCC One integrations are **not connected**.

## 13. Data protection expectations

- Real customer PII (names, emails, phones, addresses, vehicles) will be stored. Treat the
  database and the shared `.env` as sensitive.
- **Isolation:** each shop's data is confined to its workspace; only AG `super_admin` staff
  can cross workspaces, and only for platform administration.
- **Secrets** live only in the server-side `shared/.env`, never in Git; TLS protects data
  in transit; the DB connection to RDS uses TLS.
- **Passwords** are bcrypt-hashed (cost 12); session tokens are random and server-checked.
- **Confirm before pilot:** RDS backup policy, a tested restore, secret rotation for any
  previously exposed credentials, and who at AG can access production
  (see [`MANUAL_ACTIONS_CHECKLIST.md`](MANUAL_ACTIONS_CHECKLIST.md)).

## 14. Feedback schedule

| When | What |
|---|---|
| End of Week 0 | Setup + training sign-off; confirm data imported and roles working |
| Weekly (during pilot) | 30-min review: issues raised, data quality, what's working/not |
| Mid-pilot | Go/adjust checkpoint against success criteria (§15) |
| End of pilot | Final review, metrics, decision (expand / pause / end) |

> Exact dates are set by the AG pilot coordinator; record them in the Manual Actions
> Checklist.

## 15. Pilot success & exit criteria

**Success criteria (target):**
- The shop runs the majority of real repair orders through the full lifecycle in AG Shop
  Pro.
- No cross-tenant data leakage observed; roles behave as documented.
- No unresolved **blocking** defects (data loss, auth failure, isolation breach).
- Staff can complete their daily workflow without workarounds for in-scope features.
- The customer portal is used by at least a small set of real customers.
- Reports reconcile with the shop's own understanding of revenue for the period.

**Exit criteria (end the pilot when):**
- Success criteria are met (→ recommend **expand**), **or**
- A blocking defect cannot be resolved in the window (→ **pause**), **or**
- The shop determines the fit is wrong (→ **end**).
- In all cases: export/retain the shop's data as agreed, review incidents and feedback, and
  record the decision and roadmap follow-ups.

## 16. Pilot launch checklist

Use this before going live with a pilot shop. (The exhaustive, evidence-tracked version is
[`MANUAL_ACTIONS_CHECKLIST.md`](MANUAL_ACTIONS_CHECKLIST.md).)

**Platform readiness (AG):**
- [ ] Production secrets set in `shared/.env`; app healthy (`/api/health` = ok).
- [ ] DNS + HTTPS valid for `agshopro.com` (and `preprod` if used).
- [ ] AWS security groups reviewed (80/443 public; 22 restricted; EC2→RDS 5432).
- [ ] RDS backups enabled **and a restore tested**.
- [ ] Monitoring/uptime check on `/api/health` in place.
- [ ] GitHub `production` environment approval configured; deploy user/keys verified.
- [ ] First `super_admin` created and login verified.
- [ ] SMTP configured and **email test passed** (Super Admin → Settings → email test).
- [ ] Staging/production separation confirmed (separate DB for preprod).

**Shop setup:**
- [ ] Signup approved → workspace + manager owner created; owner signed in and changed
      password.
- [ ] Staff invited with correct roles; each signed in.
- [ ] Customers CSV imported and reviewed; vehicles CSV imported and reviewed.
- [ ] Initial parts catalog entered.
- [ ] Portal access enabled for selected pilot customers; credentials handed over.
- [ ] Business info (shop name) confirmed on the workspace.
- [ ] Support contact and issue-reporting process shared with the shop.

**Training & acceptance:**
- [ ] Training walkthrough completed for every role.
- [ ] Full RO lifecycle tested end-to-end by the shop.
- [ ] Restricted/invalid actions tested (e.g. advisor can't reach reports; illegal status
      change refused).
- [ ] Portal login, appointment request, and feedback tested by a real/ test customer.
- [ ] Open issues logged; pilot approval obtained.

**Related:** [`TRAINING_WALKTHROUGH.md`](TRAINING_WALKTHROUGH.md) ·
[`USER_MANUAL.md`](USER_MANUAL.md) ·
[`MANUAL_ACTIONS_CHECKLIST.md`](MANUAL_ACTIONS_CHECKLIST.md) ·
[`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md)

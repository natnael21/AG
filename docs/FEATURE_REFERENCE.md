# AG Shop Pro — Feature and Functionality Reference

> **Audience:** Product owners, testers, support personnel, and developers.
> **Method:** Each feature was traced from frontend page → API route → service → database
> table, and cross-checked against the test suite. Status labels reflect the actual code
> on the `staging` branch.

## Status legend

| Label | Meaning |
|---|---|
| ✅ **Fully functional** | Implemented end-to-end and covered by tests |
| 🟡 **Functional with limitations** | Works, but with notable constraints |
| 🟠 **Partially implemented** | Core exists; parts missing |
| 🔵 **Hidden/disabled** | Code exists but no route/UI reaches it |
| ⚪ **Mocked/placeholder** | Returns canned/empty data |
| ❌ **Not implemented** | Described somewhere but absent |
| 🗺 **Planned/inferred** | Roadmap or aspirational only |

## Table of Contents

1. [Authentication & sessions](#1-authentication--sessions)
2. [Shop signup & provisioning](#2-shop-signup--provisioning)
3. [User management](#3-user-management)
4. [Customers](#4-customers)
5. [Vehicles](#5-vehicles)
6. [Repair orders](#6-repair-orders)
7. [Parts lines & labor lines](#7-parts-lines--labor-lines)
8. [Technician time tracking](#8-technician-time-tracking)
9. [Parts catalog & inventory](#9-parts-catalog--inventory)
10. [Appointments](#10-appointments)
11. [Customer portal](#11-customer-portal)
12. [Reporting & analytics](#12-reporting--analytics)
13. [Burn-rate dashboard](#13-burn-rate-dashboard)
14. [CSV data import](#14-csv-data-import)
15. [Email notifications](#15-email-notifications)
16. [Integrations](#16-integrations)
17. [Static reference & help](#17-static-reference--help)
18. [Feature status summary table](#18-feature-status-summary-table)

---

## 1. Authentication & sessions

- **Purpose:** Sign staff in/out; protect every API route.
- **Users:** All staff roles.
- **Pages:** `login.html`, `reset.html`.
- **API:** `POST /api/auth/login`, `POST /api/auth/logout`,
  `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`.
- **Services:** inline in `server.js`; `email.js` for reset delivery.
- **Tables:** `users`, `sessions`.
- **Permissions:** public (rate-limited).
- **Inputs:** email + password (login); email (forgot); token + password (reset).
- **Outputs:** `{ token, user }`; reset returns a fresh session.
- **Validation:** password ≥8 chars on reset; generic responses to avoid account
  enumeration.
- **Business rules:** opaque 32-byte token, 8-hour expiry; role re-read from DB each
  request; reset token single-use, 1-hour expiry; reset deletes all prior sessions.
- **Errors:** 400 missing fields, 401 wrong credentials, 410 expired reset link,
  429 rate-limited.
- **Tests:** login/logout, token expiry, identical failure messages, reset flow.
- **Status:** ✅ Fully functional.
- **Limitations:** SMTP must be configured for reset emails to send; otherwise the link
  is logged server-side. Sessions live in `sessionStorage` (end on tab close).
- **Pilot readiness:** Ready.

## 2. Shop signup & provisioning

- **Purpose:** A shop requests to join; AG staff review; approval creates the workspace
  and owner account.
- **Users:** Prospective shops (public form); `super_admin` (review).
- **Pages:** `login.html` (signup wizard), `superadmin.html` (queue).
- **API:** `POST /api/signup`; `GET /api/admin/signups`, `GET /api/admin/signups/:id`,
  `POST /api/admin/signups/:id/approve|reject|reinstate`.
- **Services:** `signup.js` (`provisionSignup`, `rejectSignup`, `reinstateSignup`),
  `email.js`.
- **Tables:** `shop_signups`, `signup_audit_log`, `workspaces`, `users`.
- **Permissions:** signup public; review `super_admin` only.
- **Inputs:** contact + shop profile fields (name, email, shop name required).
- **Outputs:** approval returns `{ workspace, user, tempPassword, emailSent }`.
- **Validation:** required first/email/shop; duplicate pending/approved email → 409.
- **Business rules:** approval provisions the owner as **`manager`** (not `super_admin`);
  status machine pending→approved/rejected→(reinstate)→pending; every action audited.
- **Status transitions:** `pending → approved` (provision) / `pending → rejected` /
  `rejected → pending` (reinstate).
- **Errors:** 400 missing fields, 409 duplicate, 404 unknown signup.
- **Tests:** "an approved shop owner is a manager of their own shop, not a platform admin."
- **Status:** ✅ Fully functional.
- **Limitations:** The signup wizard collects marketing/profiling fields (revenue,
  tools, pain point) stored on `shop_signups` but not otherwise used. Approval email only
  sends if SMTP is configured.
- **Pilot readiness:** Ready; first `super_admin` reviewer must be seeded manually.

## 3. User management

- **Purpose:** Invite staff, change roles, deactivate/reactivate, reset passwords,
  self-service profile.
- **Users:** `super_admin`, `manager` (most); the user themselves (profile).
- **Pages:** `superadmin.html` (full), `manager.html` (team), profile via each console.
- **API:** `POST /api/users/invite`, `PATCH /api/users/:id/role`,
  `DELETE /api/users/:id/workspace`, `POST /api/users/:id/deactivate|reactivate`,
  `POST /api/users/:id/reset-password`, `PATCH /api/users/profile`,
  `GET /api/users`, `GET /api/users/workspace`.
- **Services:** `user-management.js`.
- **Tables:** `users`, `sessions`.
- **Permissions:** invite/role/remove/reset — `super_admin`+`manager`;
  deactivate/reactivate — `super_admin` only; profile — any auth.
- **Inputs:** email, name, role for invite; role for role change; name/phone/password for
  profile.
- **Outputs:** invite returns a temp password (for new users); reset returns a temp
  password.
- **Validation:** valid email + valid role; can't grant `super_admin` as a manager; can't
  change your own role or deactivate yourself; can't touch a `super_admin` as a manager.
- **Business rules:** role change and removal delete the user's sessions; removing the
  last workspace deactivates the user.
- **Errors:** 403 authority violations, 404 not in workspace, 409 duplicate email/already
  member.
- **Tests:** manager cannot promote to super_admin / reset super_admin / change own role;
  invite creates temp password; existing-member conflict.
- **Status:** ✅ Fully functional.
- **Limitations:** **No invite email is sent** — the temp password is shown once in the UI
  and handed over manually. **No admin edit** of another user's name/email/phone (only
  role/status/password). No hard delete (deactivate only).
- **Pilot readiness:** Ready.

## 4. Customers

- **Purpose:** Maintain customer records and view their full history.
- **Users:** `super_admin`, `manager`, `service_advisor` (create); all staff (read).
- **Pages:** `service.html` (create/search), `manager.html`, `customer-history.html`.
- **API:** `GET /api/customers`, `POST /api/customers`, `GET /api/customers/:id`,
  `GET /api/customers/:id/history`.
- **Services:** `customer.js`.
- **Tables:** `customers`, `vehicles`, `repair_orders`, `ro_*_lines`.
- **Permissions:** create — advisor+; read — any staff.
- **Inputs:** `fullName` (required), email, phone, address/city/state/zip.
- **Outputs:** customer + roll-ups (vehicle count, RO count, total spent, last service).
- **Validation:** name required; email lower-cased; duplicate email in workspace → 409.
- **Business rules:** workspace-scoped; email is the dedupe key (also used by vehicle
  import to link vehicles).
- **Errors:** 400 missing name, 409 duplicate email, 404 not found.
- **Tests:** create requires name; create+read; duplicate email rejected; cross-workspace
  not readable.
- **Status:** ✅ Fully functional.
- **Limitations:** No customer **update** or **delete** endpoint on the staff side
  (customers edit their own profile only via the portal). History depends on `CustomerService`,
  not the Mitchell placeholder.
- **Pilot readiness:** Ready (note: no staff-side edit of an existing customer's name/contact).

## 5. Vehicles

- **Purpose:** Register and update vehicles owned by a customer.
- **Users:** `super_admin`, `manager`, `service_advisor`.
- **Pages:** `service.html` (new RO wizard).
- **API:** `GET /api/vehicles`, `POST /api/vehicles`, `PATCH /api/vehicles/:id`.
- **Services:** `vehicle.js`.
- **Tables:** `vehicles`, `customers`.
- **Inputs:** `customerId`, `vin` (required), `make`, `model` (required), year, plate,
  mileage.
- **Validation:** VIN upper-cased; year 1900..currentYear+2; mileage 0..2,000,000;
  customer must be in the same workspace; duplicate VIN in workspace → 409.
- **Errors:** 400 invalid year/VIN, 404 customer not found, 409 duplicate VIN.
- **Tests:** cross-workspace customer rejected; created & filtered by customer; duplicate
  VIN; invalid year.
- **Status:** ✅ Fully functional.
- **Limitations:** No vehicle **delete**. One current odometer per vehicle (no mileage
  history).
- **Pilot readiness:** Ready.

## 6. Repair orders

- **Purpose:** The central job record: create, view, update, and drive status.
- **Users:** create/update — advisor+; status — all staff.
- **Pages:** `service.html`, `manager.html`, `tech.html`.
- **API:** `GET/POST /api/repair-orders`, `GET/PATCH /api/repair-orders/:id`,
  `PATCH /api/repair-orders/:id/status`.
- **Services:** `repair-order.js`.
- **Tables:** `repair_orders`, `customers`, `vehicles`, plus lines/time/feedback on read.
- **Inputs:** `customerId`, `vehicleId`, `concern` (required); optional priority, notes,
  estimatedCompletion, totalEstimate.
- **Outputs:** the RO; detail includes parts, labor, time entries, feedback.
- **Validation:** vehicle must belong to the customer in the workspace; priority ∈
  {low,normal,high,urgent}; only whitelisted fields updatable.
- **Business rules:** created as `open`; `ro_number` unique per workspace, allocated under
  an advisory lock (no millisecond collisions); status machine enforced (see below);
  `completed`/`cancelled` are terminal; completing stamps `actual_completion`.
- **Status transitions:** `draft→open/cancelled`; `open→in_progress/awaiting_parts/cancelled`;
  `in_progress→awaiting_parts/ready/completed/cancelled`;
  `awaiting_parts→in_progress/ready/cancelled`; `ready→completed/cancelled`.
- **Errors:** 400 bad input/invalid status value, 404 wrong workspace/not found, 409
  illegal transition.
- **Tests:** creation/open status/unique number, concurrent numbering, pairing rule,
  cross-workspace, updates ignore unknown fields, full status workflow incl. terminals.
- **Status:** ✅ Fully functional.
- **Limitations:** No delete (cancel only). `customer_approval_required` field exists but
  there is no approval workflow endpoint.
- **Pilot readiness:** Ready.

## 7. Parts lines & labor lines

- **Purpose:** Record parts and labor on an RO; keep totals correct.
- **Users:** All 4 staff roles.
- **Pages:** `service.html`, `manager.html`, `tech.html` (labor).
- **API:** `POST /api/repair-orders/:id/parts`, `POST /api/repair-orders/:id/labor`.
- **Services:** `repair-order.js` (`addPartToRepairOrder`, `addLaborToRepairOrder`),
  `recalculate_ro_totals()`.
- **Tables:** `ro_parts_lines`, `ro_labor_lines`, `parts`, `users`.
- **Inputs (parts):** `partId` (catalog) OR `partNumber`+`partName` (ad-hoc); quantity,
  unit cost/price. **Inputs (labor):** `description`, `hours`, `hourlyRate`,
  `technicianId`.
- **Business rules:** catalog part draws down `quantity_on_hand` (never below 0) and
  inherits cost/retail price; `line_total = qty×price` / `hours×rate`; totals recomputed
  after each change; a labor technician must be an active member of the workspace.
- **Validation:** quantity ≥1 integer; hours 0.01..1000; rate 0..100000; part must be in
  the workspace.
- **Errors:** 400 missing fields, 404 RO/part not found or cross-workspace, 400 tech not
  in workspace.
- **Tests:** ad-hoc & catalog part lines, stock draw-down, cross-workspace part rejected,
  labor validation, tech-from-another-workspace rejected.
- **Status:** ✅ Fully functional.
- **Limitations:** No endpoint to **edit or delete** an existing line (add-only). Totals
  set `total_estimate` = `total_final` (no separate approved estimate vs final).
- **Pilot readiness:** Ready (staff should double-check a line before adding — it cannot
  be removed via the UI/API).

## 8. Technician time tracking

- **Purpose:** Clock technicians on/off a repair order.
- **Users:** All 4 staff roles (technician primarily).
- **Pages:** `tech.html`, `manager.html` (view).
- **API:** `POST /api/repair-orders/:id/time/clock-in|clock-out`, `GET /api/time/open`.
- **Services:** `repair-order.js` (`clockIn`, `clockOut`, `getOpenTimeEntry`).
- **Tables:** `time_entries`.
- **Business rules:** at most **one open entry per technician** across all ROs (partial
  unique index); clock-out computes `duration_minutes`.
- **Errors:** 409 already clocked in / not clocked in, 404 cross-workspace RO.
- **Tests:** clock in/out + duration; cannot clock in twice; clock-out without clock-in;
  cross-workspace refused.
- **Status:** ✅ Fully functional.
- **Limitations:** **No per-technician time report endpoint.** `tech.html` reconstructs a
  time view by scanning up to 25 recent ROs client-side and says so on screen. Team
  performance (`/api/reports/technician-performance`) is manager-only.
- **Pilot readiness:** Ready (with the reporting caveat).

## 9. Parts catalog & inventory

- **Purpose:** Maintain a parts catalog and stock levels.
- **Users:** `super_admin`, `manager` (write); all staff (read/search).
- **Pages:** `manager.html` (inventory, low-stock).
- **API:** `GET /api/parts` (list/search/lowStock), `POST /api/parts`,
  `PATCH /api/parts/:id`, `POST /api/parts/:id/adjust-inventory`.
- **Services:** `parts.js`.
- **Tables:** `parts`, `ro_parts_lines`.
- **Inputs:** part number + name (required), pricing, quantities, category, location.
- **Business rules:** unique `(workspace_id, part_number)`; adjustment must be non-zero
  and cannot drive stock below 0; low-stock = `quantity_on_hand ≤ minimum_stock`.
- **Errors:** 409 duplicate part number, 400 zero/negative-below-zero adjustment, 404 not
  found.
- **Tests:** listed/searched in-workspace only, duplicate part number, same number
  allowed in another workspace, adjustment floor at zero, update ignores unknown keys.
- **Status:** ✅ Fully functional.
- **Limitations:** **No parts CSV import route** wired (the service has `bulkImportParts`,
  but only customer/vehicle import routes exist → 🔵 hidden). No part delete
  (`active=false` instead).
- **Pilot readiness:** Ready (parts must be entered by hand or created ad-hoc on ROs).

## 10. Appointments

- **Purpose:** Customers request appointments; staff confirm/advance them.
- **Users:** customers (create/manage own); advisor+ (confirm).
- **Pages:** `portal.html` (customer), `service.html`/`manager.html` (staff).
- **API:** customer — `POST/GET /api/customer/appointments`,
  `PATCH/DELETE /api/customer/appointments/:id`; staff — `GET /api/appointments`,
  `PATCH /api/appointments/:id`.
- **Services:** `customer-portal.js`; staff side inline in `server.js` + `appointment_summary` view.
- **Tables:** `appointments`, `appointment_summary` view.
- **Business rules:** date must be today or future (`YYYY-MM-DD`); appointment against the
  customer's **own** vehicle; duplicate same-vehicle/date/concern pending request is
  deduped; only pending appointments editable by the customer; cancel allowed from
  pending/confirmed; staff status ∈ {pending,confirmed,in_progress,completed,cancelled}.
- **Errors:** 400 past/malformed date, 404 not owner's vehicle / not found, 409 not
  pending.
- **Tests:** scheduled against own vehicle; DATE returned as plain date; another
  customer's vehicle rejected; past date rejected; malformed date; dedupe; cancel by
  owner only; staff confirm.
- **Status:** ✅ Fully functional.
- **Limitations:** Appointments are **requests**, not a calendar/scheduler; no
  time-slot capacity, no reminders/notifications, no conversion to a repair order.
- **Pilot readiness:** Ready as a request inbox.

## 11. Customer portal

- **Purpose:** Customer self-service: history, vehicles, appointments, profile, feedback.
- **Users:** customers with portal access enabled.
- **Pages:** `portal-login.html`, `portal.html`.
- **API:** `GET /api/customer/workspaces`, `POST /api/customer/login|logout`,
  `GET /api/customer/service-history|vehicles|profile|appointments`,
  `PATCH /api/customer/profile|change-password`, appointment routes,
  `POST /api/customer/feedback`; admin enablement:
  `POST /api/admin/customers/:id/enable-portal|reset-portal-password`.
- **Services:** `customer-portal.js`.
- **Tables:** `customers`, `customer_sessions`, `appointments`, `feedback`,
  `repair_orders`, `vehicles`.
- **Business rules:** portal login needs `portal_enabled` + hash + workspace; sessions
  24h; every read keyed by the signed-in `customer_id`; workspace taken from the customer
  row, never the request; feedback only on a **completed** RO, once (unique index);
  password change ends all portal sessions.
- **Errors:** 401 invalid/expired session or credentials (generic), 404 not owner's
  record, 409 duplicate feedback / non-pending edit.
- **Tests:** login scoping, `portal_enabled` gate, record isolation, appointment rules,
  feedback rules, password change invalidates sessions, staff token rejected.
- **Status:** ✅ Fully functional.
- **Limitations:** A manager must **enable portal access** (returns a temp password to
  hand over); the customer must have an email. No self-registration for customers. No
  document/invoice download.
- **Pilot readiness:** Ready.

## 12. Reporting & analytics

- **Purpose:** Business intelligence from real repair-order data.
- **Users:** `super_admin`, `manager`.
- **Pages:** `manager.html`, `superadmin.html`, `customer-history.html`.
- **API:** `GET /api/reports/financial-summary|technician-performance|customer-analytics|
  parts-analytics|revenue-trends|shop-kpis|export`.
- **Services:** `reporting.js`.
- **Tables:** `repair_orders`, `ro_*_lines`, `time_entries`, `customers`, `vehicles`,
  `parts`, `feedback`.
- **Inputs:** optional `startDate`/`endDate`; `months` (revenue-trends); `format`
  (export: json/csv).
- **Business rules:** parts/labor rolled up in LATERAL subqueries to avoid row
  multiplication (a real fan-out bug the tests pin); revenue-trends and burn-rate count
  only `completed` ROs; export renders CSV as a file download.
- **Errors:** 403 for non-manager roles.
- **Tests:** revenue not multiplied by line-item/vehicle count.
- **Status:** ✅ Fully functional.
- **Limitations:** No pagination cap on some report queries; CSV export is a simplified
  flatten (nested parts/labor JSON-stringified into cells).
- **Pilot readiness:** Ready.

## 13. Burn-rate dashboard

- **Purpose:** Revenue/margin trend from completed ROs, with period comparison.
- **Users:** `super_admin`, `manager`.
- **Pages:** `burnrate.html` (Chart.js from CDN).
- **API:** `GET /api/analytics/burn-rate?days=`.
- **Services:** `analytics.js`.
- **Tables:** `repair_orders`, `ro_parts_lines`, `ro_labor_lines`, `parts`, `customers`.
- **Business rules:** revenue booked on completion date; period-over-period comparison;
  daily series filled via `generate_series`; margin = revenue − parts cost.
- **Business rules (honesty):** payment-processor figures (Square fees, refunds) are
  reported as `null` with `paymentsIntegration: 'not_connected'` — the UI shows "—", not
  zeros.
- **Status:** 🟡 Functional with limitations.
- **Limitations:** Depends on the **Chart.js CDN** (`cdn.jsdelivr.net`) — the only page
  with an external dependency; behind a locked-down network the charts won't render. Card
  fees/refunds are unavailable (no processor).
- **Pilot readiness:** Ready if the browser can reach jsDelivr.

## 14. CSV data import

- **Purpose:** Bulk-load customers and vehicles.
- **Users:** `super_admin`, `manager`.
- **Pages:** `integrations.html`, `superadmin.html` (Data import).
- **API:** `POST /api/import/customers`, `POST /api/import/vehicles` (multipart `file`).
- **Services:** `import.js`.
- **Tables:** `customers`, `vehicles`.
- **Inputs:** CSV (≤10 MB). Customer headers: `full_name`/`name`, `email`, `phone`.
  Vehicle headers: `vin`, `make`, `model`, `year`, `plate`/`license_plate`, `mileage`,
  `customer_email`.
- **Business rules:** headers normalized (trim, lowercase, spaces→`_`); email lower-cased,
  VIN upper-cased to match manual entry; per-workspace dedupe on email / VIN; a bad row is
  reported and skipped, not aborting the batch; vehicle links to a customer only if
  `customer_email` matches an existing customer.
- **Outputs:** `{ total, success, duplicates, errors[] }`.
- **Status:** ✅ Fully functional (customers & vehicles).
- **Limitations:** **No parts import route.** Vehicles with no matching customer email are
  imported unlinked. No CSV template download in-app.
- **Pilot readiness:** Ready; prepare CSVs to the documented headers.

## 15. Email notifications

- **Purpose:** Transactional email for signup approval/rejection/reinstate and password
  reset.
- **Users:** system-triggered; `super_admin` can send a test.
- **API:** used by signup routes; `POST /api/admin/test-email`.
- **Services:** `email.js` (Nodemailer).
- **Business rules:** HTML emails; sender/support/app-url from env; failures are logged
  and non-fatal (the operation still succeeds and returns `emailSent: false`).
- **Status:** 🟡 Functional with limitations.
- **Limitations:** **Requires SMTP configured.** No invite email (temp password is shown
  in the UI). If SMTP is down, forgot-password logs the reset link server-side.
- **Pilot readiness:** Configure SMTP and verify with the test-email endpoint before
  pilot.

## 16. Integrations

- **Mitchell 1 ETL — ⚪ Placeholder.** `GET /api/integrations/mitchell/status` returns
  real record counts + `workspace_integrations`/`etl_sync_log` data, but
  `services/mitchell-etl.js` is a no-op returning `null`; nothing performs a live sync.
  `integrations.html` correctly labels it read-only ("contact support").
- **Square / payments — ❌ Not connected.** Burn-rate reports `not_connected`; no capture,
  invoicing, or POS.
- **Twilio, CCC One, Worldpac speedDIAL — ❌ Not implemented.** `integrations.html` lists
  them as "No integration built" with no controls.
- **Pilot readiness:** Do not promise integrations. (`docs.html` markets several of these
  — that page is aspirational; see [`docs/README.md`](README.md).)

## 17. Static reference & help

- **Parts vendor wiki (`vendors.html`) — ✅ static reference.** A hardcoded directory of
  suppliers with filter/search. **No API, cannot place orders or check stock** (states so
  explicitly). Roles: manager/advisor/super_admin.
- **Help center (`docs.html`) — 🟡 static, partly aspirational.** Public help pages. Some
  sections accurately describe portal auth/security; **many describe features that do not
  exist** (invoices/payments, SMS, call logs, CCC One, connectable integrations, plan
  tiers, user edit/delete, an ETL wizard). Treat as marketing, not a spec.
- **Pilot readiness:** Vendor wiki is fine. `docs.html` should be revised or captioned
  before showing pilot users, to avoid over-promising.

---

## 18. Feature status summary table

| # | Feature | Status | Key limitation |
|---|---|---|---|
| 1 | Authentication & sessions | ✅ | SMTP needed for reset email |
| 2 | Shop signup & provisioning | ✅ | Marketing fields unused; needs seeded super_admin |
| 3 | User management | ✅ | No invite email; no admin edit of name/email; deactivate not delete |
| 4 | Customers | ✅ | No staff-side edit/delete |
| 5 | Vehicles | ✅ | No delete; single odometer |
| 6 | Repair orders | ✅ | No delete; no approval workflow |
| 7 | Parts & labor lines | ✅ | Add-only (no edit/delete of a line) |
| 8 | Time tracking | ✅ | No per-tech time report endpoint |
| 9 | Parts catalog & inventory | ✅ | No parts CSV import; no delete |
| 10 | Appointments | ✅ | Request inbox, not a scheduler; no reminders |
| 11 | Customer portal | ✅ | Manager must enable access; needs email |
| 12 | Reporting & analytics | ✅ | Some queries unbounded |
| 13 | Burn-rate dashboard | 🟡 | Depends on Chart.js CDN |
| 14 | CSV import (customers/vehicles) | ✅ | No parts import; unlinked vehicles possible |
| 15 | Email notifications | 🟡 | Requires SMTP; no invite email |
| 16 | Mitchell 1 ETL | ⚪ | Placeholder; no live sync |
| 16 | Square / payments | ❌ | Not connected |
| 16 | Twilio / CCC One / Worldpac | ❌ | Not implemented |
| 17 | Vendor wiki | ✅ (static) | Reference only; no ordering |
| 17 | Help center (docs.html) | 🟡 (static) | Describes unbuilt features |
| — | `bulkImportParts` service | 🔵 | No route reaches it |
| — | `leads_inbox` table | 🔵 | No current route writes/reads it |
| — | `repair_order_feedback` table | 🔵 | Dead; superseded by `feedback` |
| — | Mobile apps | 🗺 | Roadmap (Phase 2) |
| — | Real-time/WebSocket | 🗺 | Deps present, nothing wired |

**Related:** [`PRODUCT_OVERVIEW.md`](PRODUCT_OVERVIEW.md) ·
[`TECHNICAL_ARCHITECTURE.md`](TECHNICAL_ARCHITECTURE.md) ·
[`USER_MANUAL.md`](USER_MANUAL.md)

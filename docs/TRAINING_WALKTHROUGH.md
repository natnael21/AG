# AG Shop Pro — Training Walkthrough

> **Audience:** Trainers, new shop employees, and pilot users.
> **Format:** A guided, end-to-end session you can run live. It follows one realistic
> repair from a new customer to a portal review. Every step names the **role**, the
> **starting page**, the **action**, the **expected result**, the **data created**, a
> **common mistake**, and a **troubleshooting note**.
> **All steps use features that exist today.** Steps that the app does **not** support are
> called out and skipped.

## Before you start (trainer setup)

- A working environment (local `http://localhost:3000` or preprod
  `https://preprod.agshopro.com`).
- Accounts to demo with:
  - one **manager** (or use a `super_admin`),
  - one **service advisor**,
  - one **technician**,
  - later, one **customer** you will enable during the session.
- If starting from an empty database, create the first `super_admin` first (see
  [`OPERATIONS_RUNBOOK.md` §16](OPERATIONS_RUNBOOK.md)), then use Super Admin → **Onboard
  shop** to approve a shop, which creates the manager. Then invite an advisor and a
  technician from the manager/super admin console.

Estimated time: **30–45 minutes.**

---

## Step 1 — Sign in

- **Role:** Service advisor (start here for the operational flow).
- **Page:** `/login.html`.
- **Action:** Enter email + password → **Sign in**.
- **Expected:** Redirect to the Service Advisor console (`service.html`).
- **Data:** A staff session token (in the browser tab).
- **Common mistake:** Using the customer portal URL. Staff use `/login.html`.
- **Troubleshooting:** "Incorrect email or password" → re-check; "Too many attempts" →
  wait (rate limit is 10 / 15 min).

## Step 2 — Understand the dashboard

- **Role:** Service advisor.
- **Page:** `service.html` (Dashboard).
- **Action:** Review the open / in-progress / awaiting-parts counts, "Needs immediate
  attention", today's appointments, and the RO status summary.
- **Expected:** All figures come from live API data for the active workspace.
- **Data:** None created (read-only view).
- **Common mistake:** Expecting invoices/payments — those don't exist here.
- **Troubleshooting:** Empty dashboard on a fresh shop is normal — you'll fill it in.

## Step 3 — Create a customer

- **Role:** Service advisor.
- **Page:** `service.html` → **New RO** wizard (or customer search).
- **Action:** Search the name first; if absent, **Create customer** with full name
  (required), email, phone.
- **Expected:** Customer created and selected.
- **Data:** A row in `customers` (workspace-scoped; email lower-cased).
- **Common mistake:** Skipping the search → duplicate customers. Note: a duplicate **email**
  is blocked, but two customers with no email and the same name are allowed.
- **Troubleshooting:** "fullName is required" → enter a name. "A customer with that email
  already exists" → reuse the existing one.

## Step 4 — Add a vehicle

- **Role:** Service advisor.
- **Page:** New RO wizard (with the customer selected).
- **Action:** **Add vehicle** — VIN (required), make, model (required), year, plate,
  mileage.
- **Expected:** Vehicle saved and attached to the customer.
- **Data:** A row in `vehicles` (VIN upper-cased).
- **Common mistake:** Entering a year outside 1900–(this year+2), or a duplicate VIN in the
  shop.
- **Troubleshooting:** "A vehicle with that VIN already exists in this workspace" → the
  vehicle is already on file.

## Step 5 — Create a repair order

- **Role:** Service advisor.
- **Page:** New RO wizard, final step.
- **Action:** Confirm customer + vehicle, enter the **concern** (required), set priority if
  needed → **Create**.
- **Expected:** A new RO in **open** status with a number like `RO-1001`.
- **Data:** A row in `repair_orders` (status `open`, unique `ro_number`).
- **Common mistake:** Picking a vehicle that belongs to a different customer.
- **Troubleshooting:** "That vehicle does not belong to the selected customer" → pick one
  of this customer's vehicles. "concern is required" → describe the problem.

## Step 6 — Add parts

- **Role:** Service advisor (or technician).
- **Page:** RO detail (`service.html` / `manager.html`).
- **Action:** **Add part** — choose a catalog part (auto-fills price and draws down stock)
  **or** enter a custom part number + name; set quantity and price.
- **Expected:** A parts line appears; the RO total updates.
- **Data:** A row in `ro_parts_lines`; if a catalog part, `parts.quantity_on_hand` drops.
- **Common mistake:** Adding the wrong line — ⚠️ **lines cannot be edited or deleted.**
- **Troubleshooting:** "Part not found" → the catalog part isn't in this shop; "partId, or
  both partNumber and partName, are required" → provide part identity.

## Step 7 — Add labor

- **Role:** Service advisor or technician.
- **Page:** RO detail.
- **Action:** **Add labor** — description, hours, hourly rate, and select the
  **technician**.
- **Expected:** A labor line appears; total combines parts + labor.
- **Data:** A row in `ro_labor_lines`; `line_total = hours × rate`.
- **Common mistake:** Selecting a technician who isn't a member of this shop.
- **Troubleshooting:** "That technician is not a member of this workspace" → invite/select
  a valid technician.

## Step 8 — Assign a technician

- **Role:** Service advisor.
- **Page:** RO detail.
- **Action:** Assignment happens **by choosing the technician on the labor line** (Step 7).
  There is no separate "assign" button.
- **Expected:** The technician can now see and work the RO.
- **Data:** `ro_labor_lines.technician_id` set.
- **Common mistake:** Expecting a dedicated assignment field — it's the labor technician.
- **Troubleshooting:** If the tech doesn't see the RO, confirm it isn't already
  `completed`/`cancelled` and that they're in the same shop.

## Step 9 — Clock in and out

- **Role:** Technician.
- **Page:** `tech.html` → **My ROs**.
- **Action:** On the RO card, **Clock in**; later, **Clock out**.
- **Expected:** An open time entry starts; clocking out records the duration.
- **Data:** A row in `time_entries` (`start_time`, then `end_time` + `duration_minutes`).
- **Common mistake:** Trying to clock into a second RO while still clocked in elsewhere.
- **Troubleshooting:** "You are already clocked in to repair order N. Clock out first."

## Step 10 — Update repair status

- **Role:** Technician or service advisor.
- **Page:** `tech.html` or RO detail.
- **Action:** Advance status: **Start** (`in_progress`) → optionally **Pause**
  (`awaiting_parts`) → **Ready**.
- **Expected:** Status changes; only valid transitions are accepted.
- **Data:** `repair_orders.status` updated, `updated_at` bumped.
- **Common mistake:** Trying to jump `open → completed` (not allowed).
- **Troubleshooting:** "Cannot change status from X to Y" → follow the allowed path
  (`open → in_progress → ready → completed`).

## Step 11 — Complete the repair order

- **Role:** Technician, advisor, or manager.
- **Page:** RO detail / `tech.html`.
- **Action:** Set status to **Completed** (from `in_progress` or `ready`).
- **Expected:** Status becomes `completed`; `actual_completion` is stamped; the RO is now
  **terminal** (no further status changes).
- **Data:** `repair_orders.status='completed'`, `actual_completion=NOW()`.
- **Common mistake:** Completing before all parts/labor are entered — lines can still be
  added after, but plan to finish the ticket first.
- **Troubleshooting:** If Complete is refused, the current status doesn't allow it
  (e.g. `awaiting_parts → completed` is not permitted; go via `in_progress`/`ready`).

## Step 12 — Review totals

- **Role:** Service advisor or manager.
- **Page:** RO detail.
- **Action:** Read the totals (parts total + labor total = RO total).
- **Expected:** Totals reflect every line added; they recalculated after each line.
- **Data:** `repair_orders.total_estimate` / `total_final` (both set equal).
- **Common mistake:** Expecting a separate invoice/payment step — there is none.
- **Troubleshooting:** If a total looks off, check the individual lines (remember lines
  can't be removed).

## Step 13 — View reports

- **Role:** Manager (or super_admin).
- **Page:** `manager.html` → Financials / Technicians; and `burnrate.html`.
- **Action:** Open the financial summary, technician performance, and the burn-rate
  dashboard (try the 30d/90d buttons).
- **Expected:** Revenue for the completed RO appears; margins computed. Payment-processor
  figures show "—" (no processor connected).
- **Data:** None created (reporting is read-only).
- **Common mistake:** Advisors/technicians expecting reports — reports are manager+.
- **Troubleshooting:** Burn-rate charts blank → the Chart.js CDN didn't load (network);
  the numbers still show.

## Step 14 — Enable customer portal access

- **Role:** Manager (or super_admin).
- **Page:** `manager.html`/`customer-history.html` → the customer.
- **Action:** **Enable portal access**.
- **Expected:** A **temporary portal password** is displayed.
- **Data:** `customers.portal_enabled=true`, `portal_password_hash` set.
- **Common mistake:** Enabling for a customer with no email — they can't sign in.
- **Troubleshooting:** "This customer has no email address…" → add an email first.
- **Hand-off:** Give the customer the shop name, the portal URL
  (`/portal-login.html`), their email, and the temporary password.

## Step 15 — Sign in to the customer portal

- **Role:** Customer.
- **Page:** `/portal-login.html`.
- **Action:** Pick the **shop**, enter email + the temporary password → **Sign in**.
- **Expected:** Lands on **My Vehicles**.
- **Data:** A customer session token (`customer_sessions`, 24h).
- **Common mistake:** Not selecting the shop, or using the staff login page.
- **Troubleshooting:** "Invalid email or password" → confirm the shop and that access was
  enabled.

## Step 16 — View service history

- **Role:** Customer.
- **Page:** `portal.html` → **Service history**.
- **Action:** Expand the completed RO to see parts and labor.
- **Expected:** The RO from Steps 5–11 appears, scoped to this customer only.
- **Data:** None created.
- **Common mistake:** Expecting to see other customers' work — you only see your own.
- **Troubleshooting:** Nothing shown → confirm the RO's customer matches the signed-in
  customer.

## Step 17 — Request an appointment

- **Role:** Customer.
- **Page:** `portal.html` → **Appointments → Book**.
- **Action:** Pick your vehicle, a date (today or later), optional time, describe the
  concern → **Submit**.
- **Expected:** A **pending** appointment appears.
- **Data:** A row in `appointments` (status `pending`).
- **Common mistake:** Choosing a past date.
- **Troubleshooting:** "preferredDate cannot be in the past." Re-book with a valid date.
- **Staff side (optional demo):** As advisor/manager, open Appointments and **Confirm** it
  (`PATCH /api/appointments/:id`).

## Step 18 — Submit feedback

- **Role:** Customer.
- **Page:** `portal.html` → **Service history** → **Rate this service** on the completed RO.
- **Action:** Give **1–5 stars** and an optional comment → submit.
- **Expected:** Feedback saved; you can rate this order **once**.
- **Data:** A row in `feedback` (unique per RO per customer).
- **Common mistake:** Rating an order that isn't completed yet.
- **Troubleshooting:** "You can leave feedback once the work is complete." / "You have
  already left feedback for this repair order."

## Step 19 — Sign out

- **Role:** Customer (then repeat for staff).
- **Page:** `portal.html` → **Profile → Sign out** (staff: sidebar/profile **Sign out**).
- **Action:** Sign out.
- **Expected:** Returned to the relevant login page; session cleared.
- **Data:** Session token deleted.
- **Common mistake:** Just closing the tab — that also ends the session, but explicit sign
  out is cleaner on shared devices.
- **Troubleshooting:** None.

---

## Steps this app does NOT support (skip in training)

Do **not** demo these — they are not implemented (see
[`FEATURE_REFERENCE.md`](FEATURE_REFERENCE.md)):

- **Invoicing / taking payment / Square** — no payment or invoice step exists.
- **Editing or deleting a parts/labor line** — lines are add-only.
- **Deleting a customer, vehicle, or repair order** — you can only cancel an RO (status).
- **SMS/text reminders, call logs, marketing campaigns** — not built.
- **Connecting Mitchell 1 / CCC One / Twilio / Worldpac** — Mitchell shows read-only
  status only; the rest are labelled "not available."
- **Parts CSV import** — only customer and vehicle CSV import exist.
- **A per-technician time report** — the tech Time page reconstructs from recent ROs.

## Trainer wrap-up checklist

- [ ] Every trainee signed in and reached their role's home page.
- [ ] A customer → vehicle → RO → parts → labor → time → completed flow was completed.
- [ ] Totals reviewed and understood (parts + labor).
- [ ] A manager ran reports and the burn-rate dashboard.
- [ ] A customer signed into the portal, viewed history, booked an appointment, left
      feedback.
- [ ] Everyone signed out.
- [ ] Trainees know which features are **not** available (list above).

**Related:** [`USER_MANUAL.md`](USER_MANUAL.md) · [`PILOT_ONBOARDING.md`](PILOT_ONBOARDING.md)
· [`FAQ_TROUBLESHOOTING.md`](FAQ_TROUBLESHOOTING.md)

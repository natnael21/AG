# AG Shop Pro — End-User Manual

> **Audience:** Shop staff and customers.
> **How to read it:** Find your role, follow its section. Every page, control, and
> step below exists in the current application (verified against the code). Features that
> do **not** exist are labelled so you are never sent looking for a button that isn't
> there.

## Conventions

- **Staff** sign in at `/login.html`; **customers** at `/portal-login.html`.
- Your **session ends when you close the browser tab** (it is stored in the tab, not on
  disk). Staff sessions also expire after 8 hours; customer sessions after 24 hours.
- After signing in you land on **your role's home page** automatically.
- ⚠️ **Some actions cannot be undone** (adding a parts/labor line, completing a repair
  order). These are flagged.

## Table of Contents

1. [All roles: signing in, signing out, common errors](#1-all-roles-signing-in-signing-out-common-errors)
2. [Shop Owner / Manager](#2-shop-owner--manager)
3. [Service Advisor](#3-service-advisor)
4. [Technician](#4-technician)
5. [Customer (Portal)](#5-customer-portal)
6. [Platform Administrator (super_admin)](#6-platform-administrator-super_admin)
7. [Page directory](#7-page-directory)
8. [What to do when something fails](#8-what-to-do-when-something-fails)

---

## 1. All roles: signing in, signing out, common errors

### 1.1 Sign in (staff)
1. Go to `https://agshopro.com/login.html` (or `http://localhost:3000/login.html` in dev).
2. Enter your **email** and **password**.
3. Click **Sign in**.
4. **Expected:** you are redirected to your role's home page (super admin → super admin
   console, manager → manager portal, advisor → advisor console, technician → technician
   console).

### 1.2 Forgot password
1. On the login page, click **Forgot password**.
2. Enter your email and submit.
3. **Expected:** a generic message ("if that email is registered, a reset link has been
   sent") — the same whether or not the email exists.
4. Open the emailed link (valid **1 hour, one use**), set a new password (≥8 characters),
   and you are signed in automatically.
   > If email isn't configured, ask an administrator — the reset link is written to the
   > server log.

### 1.3 Sign out
- Use the **Sign out** button in your console (profile area / sidebar). You are returned
  to the login page and your session is cleared.

### 1.4 Common errors (all roles)
| Message | Meaning | What to do |
|---|---|---|
| "Incorrect email or password." | Wrong credentials or inactive account | Re-check; use Forgot password; ask an admin if your account may be deactivated |
| "Too many attempts. Please wait…" | More than 10 sign-in attempts in 15 minutes | Wait a few minutes |
| "Session expired." / bounced to login | Session timed out or your role changed | Sign in again |
| "Insufficient permissions." | Your role can't do that action | It's not available to your role — see the permission tables below |

---

## 2. Shop Owner / Manager

**Role name in the system:** `manager`. A shop that signs up becomes a manager of its own
workspace. **Home page:** `manager.html` (Manager Portal).

### 2.1 What the dashboard shows
KPI stat tiles, active repair orders, technician performance, upcoming appointments (with
a pending badge), and a low-stock parts alert bar. A **workspace switcher** in the sidebar
lets you change shop if you belong to more than one.

### 2.2 Pages/sections available to you
Dashboard · Repair orders · Workflow view (visual pipeline) · Appointments · Financials ·
Technicians · Parts inventory · Customers. You can also open: `service.html`,
`tech.html`, `customer-history.html`, `burnrate.html`, `integrations.html`,
`vendors.html`.

### 2.3 Your permissions
You can do **everything a service advisor and technician can**, plus: manage parts and
inventory, run all reports and the burn-rate dashboard, manage your team (invite, change
roles, reset passwords, remove from workspace), enable customer portal access, and import
customer/vehicle CSVs. You **cannot**: deactivate/reactivate users, review the shop signup
queue, or reach another shop's data (those are platform-admin only).

### 2.4 Daily workflow
1. Open the dashboard; scan active ROs, pending appointments, and low-stock alerts.
2. Confirm or advance appointments.
3. Check in on repair-order progress in the Workflow view.
4. Review financials / burn-rate as needed.
5. Reorder low-stock parts (using the [Vendor wiki](#page-directory) for supplier info)
   and adjust inventory when stock arrives.

### 2.5 Manage inventory
- **View low stock:** Parts inventory section (uses `GET /api/parts?lowStock=true`).
- **Add a part:** create with part number + name (+ pricing, quantities, category,
  location). Duplicate part number in your shop is rejected.
- **Adjust stock:** enter a signed amount (e.g. `+10` received, `-2` damaged) and a
  reason. Stock cannot go below zero.

### 2.6 Reviewing reports
Financials shows revenue mix and a 12-month trend; Technicians shows per-tech performance;
the Customers section flags at-risk customers. For a cash/margin view open **Burn rate**
(period buttons 7d/30d/90d/12mo). Payment-processor figures show "—" because no processor
is connected.

### 2.7 Creating and managing users (your shop)
1. Open the team section.
2. **Invite:** enter name, email, role (service_advisor / technician / manager). A
   **temporary password is shown once** — copy it and give it to the person (no email is
   sent).
3. **Change role / reset password / remove from workspace** as needed. Changing a role or
   removing someone **signs them out immediately**.
   > You cannot promote anyone to `super_admin`, cannot manage a `super_admin`, and cannot
   > change your own role.

### 2.8 Enabling customer portal access
1. Open a customer (Customers section / customer history).
2. Choose **Enable portal access**.
3. A **temporary portal password is shown** — give it to the customer along with the shop
   name and the portal URL (`/portal-login.html`). The customer must have an email on file.

### 2.9 Importing data
Open `integrations.html` (or Super Admin's Data import). Upload a **customers** CSV
(headers: `full_name`/`name`, `email`, `phone`) and/or a **vehicles** CSV (`vin`, `make`,
`model`, `year`, `plate`, `mileage`, `customer_email`). Bad rows are skipped and reported;
duplicates (email / VIN) are counted. A vehicle links to a customer only if its
`customer_email` matches an existing customer.

### 2.10 Common manager errors
| Message | Cause | Fix |
|---|---|---|
| "That part number already exists in this workspace." | Duplicate part number | Use a unique number or edit the existing part |
| "Cannot reduce inventory below zero." | Adjustment too large | Reduce the amount |
| "Only a super admin can grant the super admin role." | You tried to set super_admin | Not allowed |
| "workspaceId is required." | No active workspace selected | Pick a shop in the switcher |

---

## 3. Service Advisor

**Role name:** `service_advisor`. **Home page:** `service.html`.

### 3.1 Dashboard
Open / in-progress / awaiting-parts counts, "Needs immediate attention", today's
appointments, and a repair-order status summary.

### 3.2 Pages/sections
Dashboard · Repair orders (filterable list) · RO detail · **New RO** (3-step wizard) ·
Appointments. You can also open `customer-history.html`, `burnrate.html`, `vendors.html`.

### 3.3 Your permissions
Create/manage customers, vehicles, repair orders, and appointments; add parts and labor to
ROs; change RO status; clock in/out. You **cannot** manage parts inventory, run reports,
or manage users.

### 3.4 Create a customer
1. In the New RO wizard (or customer search), search first to avoid duplicates.
2. If not found, **Create customer**: enter full name (required), email, phone.
3. **Expected:** the customer is created and selected. Duplicate email in your shop is
   rejected.

### 3.5 Add a vehicle
1. With a customer selected, **Add vehicle**: VIN (required, auto-uppercased), make, model
   (required), year, plate, mileage.
2. **Expected:** vehicle saved and attached to the customer. Duplicate VIN in your shop is
   rejected.

### 3.6 Create a repair order
1. New RO wizard: pick the customer → pick/add the vehicle → describe the **concern**
   (required), set priority/notes if needed.
2. **Create.**
3. **Expected:** a new RO in **open** status with a number like `RO-1001`.

### 3.7 Add parts and labor
- **Add part:** choose a catalog part (draws down stock, fills price) **or** enter a custom
  part number + name; set quantity and price.
- **Add labor:** description, hours, hourly rate, and the **technician** (must be a member
  of your shop).
- ⚠️ **Lines cannot be edited or deleted** after adding — enter them carefully. Totals
  update automatically.

### 3.8 Assign a technician
Assign by selecting the technician on a **labor** line (there is no separate "assign"
button). The technician then sees the RO and can clock in.

### 3.9 Update repair-order status
On the RO detail, use the status control. Only valid transitions are offered/accepted
(e.g. `open → in_progress`, `in_progress → ready`, `ready → completed`). Illegal moves
show the server's message ("Cannot change status from X to Y").

### 3.10 Appointments
See workspace appointments; **Confirm** a pending request or **Cancel** it
(`PATCH /api/appointments/:id`).

### 3.11 Common advisor errors
| Message | Cause | Fix |
|---|---|---|
| "That vehicle does not belong to the selected customer." | Wrong vehicle picked | Choose one of that customer's vehicles |
| "concern is required." | Empty concern | Describe the problem |
| "Cannot change status from … to …" | Illegal transition | Follow the allowed path |
| "A customer with that email already exists." | Duplicate email | Search and reuse the existing customer |

---

## 4. Technician

**Role name:** `technician`. **Home page:** `tech.html` (mobile-friendly).

### 4.1 What you see
Bottom-nav sections: **My ROs** (clock card + active RO cards), **Time** (open entry +
completed entries), **History** (completed ROs), **Profile** (info + sign out). A live
clock updates on screen.

### 4.2 Your permissions
View repair orders; add labor; clock in/out; change RO status
(start/pause/ready/complete). You **cannot** create customers/vehicles/ROs or see reports
(the "team performance" block only appears for managers).

### 4.3 Clocking in and out
1. On an **active RO card**, tap **Clock in**.
   > You can only have **one open time entry at a time** across all ROs. The header
   > clock-in button is disabled until you're clocked in somewhere.
2. Work the job. Tap **Clock out** on the same RO when done — your duration is recorded.

### 4.4 Add labor / update status
- **Add labor:** description, hours, hourly rate (you are the technician by default).
  ⚠️ Cannot be edited/deleted after adding.
- **Status buttons:** Start (`in_progress`), Pause (`awaiting_parts`), Ready, Complete.
  Only valid moves are accepted.

### 4.5 Note on your time report
The Time page reconstructs your entries by scanning your recent repair orders (the app has
no dedicated per-technician time report). It scans up to ~25 recent ROs and says so on
screen. If an older entry doesn't appear, that's why.

### 4.6 Common technician errors
| Message | Cause | Fix |
|---|---|---|
| "You are already clocked in to repair order N. Clock out first." | Open entry elsewhere | Clock out of the other RO |
| "You are not clocked in to this repair order." | Clocking out without clocking in | Clock in first |
| "Cannot change status from … to …" | Illegal transition | Use the allowed step |

---

## 5. Customer (Portal)

Customers are **not** staff accounts. A shop must first **enable portal access** for you
and give you a temporary password.

### 5.1 Sign in
1. Go to `https://agshopro.com/portal-login.html`.
2. **Pick your shop** from the dropdown, enter your **email** and **password**.
3. **Sign in.** **Expected:** you land on **My Vehicles**.
   > If login fails, the message is deliberately generic. Make sure you picked the right
   > shop and that the shop has enabled your access.

### 5.2 What you can do
Bottom-nav sections:
- **Vehicles** — your vehicles with service roll-ups.
- **Service history** — your repair orders with parts and labor; **Rate this service** on
  a completed order.
- **Appointments** — request a new appointment and see/cancel existing ones.
- **Profile** — update your contact details, change your password, sign out.

### 5.3 View service history
Open **Service history**. Each completed order can be expanded to see parts and labor. This
is your own data only.

### 5.4 Request an appointment
1. **Appointments → Book.**
2. Pick one of **your** vehicles, a **date** (today or later), an optional time, and
   describe the **concern**.
3. Submit. **Expected:** a **pending** request the shop will confirm. Booking the same
   vehicle/date/concern twice won't create a duplicate.
4. **Cancel** a pending or confirmed appointment from the list. Only *pending* ones can be
   edited.

### 5.5 Update your profile
**Profile → edit** name, phone, address, city, state, zip → **Save**. To change your
password, use **Change password** (≥8 characters); this **signs you out of other
devices**.

### 5.6 Submit feedback
On a **completed** repair order in Service history, tap **Rate this service**, give
**1–5 stars** and an optional comment. **You can rate each order once.**

### 5.7 Sign out
**Profile → Sign out.**

### 5.8 Common customer errors
| Message | Cause | Fix |
|---|---|---|
| "Invalid email or password." | Wrong shop/credentials or access not enabled | Pick the right shop; ask the shop to enable/reset your access |
| "preferredDate cannot be in the past." | Past date chosen | Pick today or later |
| "You can leave feedback once the work is complete." | Order not completed yet | Wait until it's completed |
| "You have already left feedback for this repair order." | Already rated | One rating per order |

---

## 6. Platform Administrator (super_admin)

**Role name:** `super_admin` — **AG platform staff only**, created directly in the
database (never by signup). **Home page:** `superadmin.html`.

### 6.1 What you see / can do
- **All shops** — platform KPI aggregate and per-shop cards; open any shop's detail.
- **Onboard shop** — the signup request form **and** the signup **queue**:
  **Approve** (provisions a workspace + a `manager` owner and shows a temp password),
  **Reject** (with a comment), **Reinstate** a rejected signup. Emails are sent when SMTP
  is configured.
- **Technicians** — performance across all shops.
- **Data import** — Mitchell status (read-only) and CSV import.
- **All users** — the full directory; **Invite**, **Change role**, **Reset password**,
  **Deactivate/Reactivate**, **Remove from workspace**. Temp passwords are shown once and
  handed over manually (no invite email).
- **Settings** — your own profile + password, and an **email delivery test**
  (`POST /api/admin/test-email`).
- You can reach **any workspace** (the only role that can).

### 6.2 Approve a shop signup
1. **Onboard shop → queue → open a request → Approve.**
2. **Expected:** a workspace and an owner account (`manager`) are created; a temporary
   password is displayed (and emailed if SMTP works). Relay the credentials.

### 6.3 Restrictions & notes
- There is **no admin edit** of another user's name/email/phone — only role, status, and
  password.
- Deactivating a user or changing their role **ends their sessions**.
- You cannot change your **own** role or deactivate yourself.

---

## 7. Page directory

| Page | Who it's for | What it does | Live data? |
|---|---|---|---|
| `login.html` | All staff (public) | Sign in, signup wizard, forgot password | ✅ |
| `reset.html` | Staff w/ reset link | Set a new password | ✅ |
| `superadmin.html` | super_admin | Platform console | ✅ |
| `manager.html` | manager, super_admin | Shop management | ✅ |
| `service.html` | advisor, manager, super_admin | Front-desk / ROs | ✅ |
| `tech.html` | technician, manager, super_admin | Bay / time clock | ✅ |
| `customer-history.html` | manager, advisor, super_admin | Per-customer history | ✅ |
| `burnrate.html` | manager, advisor, super_admin | Cash/margin dashboard | ✅ (needs Chart.js CDN) |
| `integrations.html` | manager, super_admin | Mitchell status + CSV import | ✅ |
| `vendors.html` | manager, advisor, super_admin | **Static** parts-vendor directory | Reference only (no ordering) |
| `docs.html` | Public | Help center | ⚠️ **Static; describes some features not built** |
| `portal-login.html` | Customers | Portal sign-in | ✅ |
| `portal.html` | Customers | Portal app | ✅ |

> ⚠️ **About `docs.html`:** it is a public help/marketing page that mentions features AG
> Shop Pro does **not** currently have (invoices/payments, SMS/text automation, call logs,
> connectable integrations, plan tiers, user edit/delete). Rely on **this manual** for
> what actually works.

---

## 8. What to do when something fails

| Symptom | Try this | If it persists |
|---|---|---|
| Page won't load / spins | Refresh; check your internet | Ask an admin to check `/api/health` |
| "Session expired" repeatedly | Sign in again | Your role may have changed — confirm with an admin |
| A button does nothing / says "Insufficient permissions" | The action isn't allowed for your role | Check the role tables above; ask a manager/admin |
| Charts blank on Burn rate | The Chart.js library couldn't load (network) | Try another network; ask DevOps (CDN reachability) |
| Reset/approval email never arrives | Email may be unconfigured | Ask an admin to check SMTP / server logs |
| Data looks wrong / missing | Confirm you're in the right **workspace** (switcher) | Report to your manager/admin |
| Repeated "Something went wrong. Please try again." | A server-side error | Note the time and action; give it to support (they'll check `api-error.log`) |

**Escalation:** shop staff → shop manager → AG platform support/admin →
DevOps (see [`FAQ_TROUBLESHOOTING.md`](FAQ_TROUBLESHOOTING.md) and
[`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md)).

**Related:** [`PRODUCT_OVERVIEW.md`](PRODUCT_OVERVIEW.md) ·
[`TRAINING_WALKTHROUGH.md`](TRAINING_WALKTHROUGH.md) ·
[`FEATURE_REFERENCE.md`](FEATURE_REFERENCE.md)

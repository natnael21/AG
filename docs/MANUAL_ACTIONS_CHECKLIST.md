# AG Shop Pro — Manual Actions Checklist

> **Purpose:** Everything that **cannot be completed or fully verified from the repository
> alone** and must be done by a person — an owner, administrator, pilot coordinator,
> DevOps/AWS engineer, or repair-shop representative.
>
> **This is a required deliverable.** Items are derived from the actual repository and
> infrastructure findings (not generic best practice). Where the repository gives no
> evidence, the item is marked and an **Owner** is asked to confirm.
>
> **Do not tick an item complete unless it can be proven** from repository state or from
> validated environment evidence (a command output, a screenshot, a console setting).

## Legend

- **Priority:** 🔴 Required before pilot · 🟠 Required during pilot · 🟢 Recommended ·
  ⚪ Optional · ⛔ Currently blocked · ➖ Not applicable
- **Blocking:** whether the pilot should **not** launch/continue until it's done.
- Status checkboxes: `- [ ]` open, `- [x]` proven complete.

## Field template (used for each item)

Each item lists: **Why · Owner · When · Preconditions · Steps · Evidence · Blocking ·
Notes · Related docs · Repo/infra reference.**

## Table of Contents

- [Phase 1 — Before Pilot Deployment](#phase-1--before-pilot-deployment)
- [Phase 2 — Pilot Shop Setup](#phase-2--pilot-shop-setup)
- [Phase 3 — Training and User Acceptance](#phase-3--training-and-user-acceptance)
- [Phase 4 — Production Verification](#phase-4--production-verification)
- [Phase 5 — Pilot Operations](#phase-5--pilot-operations)
- [Phase 6 — Pilot Completion](#phase-6--pilot-completion)

---

## Phase 1 — Before Pilot Deployment

### 1.1 Review security-sensitive changes 🔴
- [ ] **Review the workspace-isolation / role model and migration 008**
  - **Why:** A prior bug provisioned shop owners as `super_admin`, exposing all tenants'
    data. Confirm the current code provisions `manager` and that `008` has been applied.
  - **Owner:** Platform admin / lead developer
  - **When:** Before pilot
  - **Preconditions:** Access to prod DB and repo
  - **Steps:** Confirm `services/signup.js` sets role `manager`; run
    `SELECT filename FROM schema_migrations WHERE filename='008_signup_owner_role.sql';`
    and `SELECT id,email,role FROM users WHERE role='super_admin';` (should be AG staff
    only).
  - **Evidence:** Query outputs showing no shop owner on `super_admin`; 008 applied
  - **Blocking:** Yes
  - **Notes:** Security-critical.
  - **Related:** PRODUCT_OVERVIEW §8, TECHNICAL_ARCHITECTURE §10
  - **Ref:** `api/services/signup.js`, `api/migrations/008_signup_owner_role.sql`

### 1.2 Confirm pilot scope & approve known limitations 🔴
- [ ] **Sign off on in-scope features and the exclusions list**
  - **Why:** Several advertised features are not built (payments, SMS, integrations, line
    edits, deletes). Stakeholders must accept this before pilot.
  - **Owner:** Product owner + pilot coordinator
  - **When:** Before pilot
  - **Steps:** Review FEATURE_REFERENCE §18 and PILOT_ONBOARDING §2; record sign-off.
  - **Evidence:** Written approval referencing the exclusions
  - **Blocking:** Yes
  - **Related:** FEATURE_REFERENCE, PILOT_ONBOARDING
  - **Ref:** `docs/FEATURE_REFERENCE.md`

### 1.3 Decide what to show/hide in the UI 🟠
- [ ] **Resolve the `docs.html` over-promise**
  - **Why:** The public help page describes features that don't exist (invoices/payments,
    SMS, connectable integrations, plan tiers, user edit/delete).
  - **Owner:** Product owner
  - **When:** Before pilot (or caption it)
  - **Steps:** Revise/caption `public/docs.html`, or hide it from pilot users; decide
    whether `vendors.html` (static reference) is shown.
  - **Evidence:** Updated page or an agreed decision note
  - **Blocking:** No (but reduces confusion)
  - **Related:** FEATURE_REFERENCE §17, USER_MANUAL §7
  - **Ref:** `public/docs.html`, `public/integrations.html`

### 1.4 Set production secrets 🔴
- [ ] **Populate `/var/www/agshopro/shared/.env` with real values**
  - **Why:** Real `DB_*`, `SMTP_*`, `CORS_ORIGINS`, `RESET_BASE_URL`, `APP_URL` are not in
    the repo (only `.env.example`).
  - **Owner:** DevOps
  - **When:** Before pilot
  - **Preconditions:** SSH to EC2; RDS + SMTP credentials
  - **Steps:** Edit the shared `.env`; `pm2 restart ag-api --update-env`; verify
    `/api/health`.
  - **Evidence:** `/api/health` = ok; no secrets committed to Git
  - **Blocking:** Yes
  - **Related:** OPERATIONS_RUNBOOK §5
  - **Ref:** `api/.env.example`, `infra/pm2/ecosystem.config.js`

### 1.5 Verify DNS and HTTPS 🔴
- [ ] **`agshopro.com` (+ `www`, and `preprod` if used) resolve and serve valid TLS**
  - **Why:** Nginx expects Let's Encrypt certs; a mismatch breaks the app.
  - **Owner:** DevOps
  - **When:** Before pilot
  - **Steps:** `curl -I https://agshopro.com`; check cert SANs
    (`openssl s_client -connect agshopro.com:443 -servername agshopro.com`); `certbot
    renew --dry-run`.
  - **Evidence:** 200/redirect with valid cert; dry-run renewal ok
  - **Blocking:** Yes
  - **Related:** OPERATIONS_RUNBOOK §17
  - **Ref:** `infra/nginx/agshopro.conf`

### 1.6 Confirm AWS security groups 🔴
- [ ] **80/443 public; 22 restricted to admins + GitHub runners; EC2→RDS 5432 only**
  - **Why:** Not defined in the repo (**UNVERIFIED**); deploys need SSH from runners; RDS
    must not be world-open.
  - **Owner:** AWS administrator
  - **When:** Before pilot
  - **Steps:** In the AWS console, review inbound rules for the EC2 and RDS security
    groups.
  - **Evidence:** Screenshot/export of the rules
  - **Blocking:** Yes
  - **Related:** OPERATIONS_RUNBOOK §2, §18
  - **Ref:** `.github/workflows/deploy-*.yml` (SSH/SCP), `KNOWLEDGE_TRANSFER.md` §8B

### 1.7 Confirm database access & TLS 🔴
- [ ] **App and migrations can reach RDS over TLS**
  - **Why:** `DB_SSL` must be TLS for RDS; pool uses `rejectUnauthorized:false`.
  - **Owner:** DevOps
  - **When:** Before pilot
  - **Steps:** `psql "host=<DB_HOST> … sslmode=require" -c 'SELECT 1'`; `/api/health`
    `database: ok`.
  - **Evidence:** Successful query + health
  - **Blocking:** Yes
  - **Related:** OPERATIONS_RUNBOOK §13
  - **Ref:** `api/server.js` pool config, `api/scripts/migrate.js`

### 1.8 Confirm production/staging separation 🔴
- [ ] **Preprod uses a separate database from production**
  - **Why:** Both apps share one EC2 host; a shared DB would let preprod corrupt prod
    data. **UNVERIFIED** in repo.
  - **Owner:** DevOps
  - **When:** Before pilot
  - **Steps:** Compare `DB_NAME`/`DB_HOST` in `/var/www/agshopro/shared/.env` vs
    `/var/www/agshopro-preprod/shared/.env`.
  - **Evidence:** Two distinct DB targets
  - **Blocking:** Yes
  - **Related:** OPERATIONS_RUNBOOK §24
  - **Ref:** `infra/pm2/ecosystem.config.js`

### 1.9 Confirm backup configuration 🔴
- [ ] **RDS automated backups (and/or snapshots) enabled with a defined retention**
  - **Why:** No backup scripts/policy exist in the repo. Data loss risk.
  - **Owner:** AWS administrator / DevOps
  - **When:** Before pilot
  - **Steps:** Enable RDS automated backups + PITR; document retention; take a manual
    pre-pilot snapshot.
  - **Evidence:** RDS backup settings screenshot; snapshot id
  - **Blocking:** Yes
  - **Related:** OPERATIONS_RUNBOOK §14, §23
  - **Ref:** (none in repo — infra action)

### 1.10 Test a database restore 🔴
- [ ] **Restore the latest backup into a throwaway DB and validate**
  - **Why:** A backup that hasn't been restored is unproven.
  - **Owner:** DevOps
  - **When:** Before pilot
  - **Steps:** `pg_restore` into a scratch DB; run `npm run migrate:latest` (all "skip");
    `/api/health` against it.
  - **Evidence:** Restore log + migration/health output
  - **Blocking:** Yes
  - **Related:** OPERATIONS_RUNBOOK §14
  - **Ref:** `api/scripts/migrate.js`

### 1.11 Verify monitoring & alerts 🟠
- [ ] **External uptime check on `/api/health` with alerting**
  - **Why:** No monitoring stack in the repo; only post-deploy curls exist.
  - **Owner:** DevOps
  - **When:** Before pilot (recommended); during pilot at latest
  - **Steps:** Configure an uptime monitor on `https://agshopro.com/api/health`; alert on
    non-200 / `degraded`.
  - **Evidence:** Monitor config + a test alert
  - **Blocking:** No (strongly recommended)
  - **Related:** OPERATIONS_RUNBOOK §25
  - **Ref:** `api/src/routes/health.js`

### 1.12 Review GitHub environment approvals 🔴
- [ ] **`production` environment requires approval; reviewers set**
  - **Why:** Prod deploy is gated by the GitHub `production` environment.
  - **Owner:** Repo admin
  - **When:** Before pilot
  - **Steps:** GitHub → Settings → Environments → `production` → required reviewers.
  - **Evidence:** Environment config screenshot
  - **Blocking:** Yes
  - **Related:** OPERATIONS_RUNBOOK §6
  - **Ref:** `.github/workflows/deploy-prod.yml` (`environment: production`)

### 1.13 Confirm deployment users & keys 🔴
- [ ] **`deploy` user + `EC2_HOST`/`EC2_USER`/`EC2_SSH_KEY` secrets valid**
  - **Why:** Deploys SSH as `deploy`; secrets must match `authorized_keys`.
  - **Owner:** DevOps
  - **When:** Before pilot
  - **Steps:** Trigger a preprod deploy (push to `staging`) and confirm it reaches the
    server and passes healthcheck.
  - **Evidence:** Green preprod workflow run
  - **Blocking:** Yes
  - **Related:** OPERATIONS_RUNBOOK §4, §6
  - **Ref:** `.github/workflows/deploy-preprod.yml`, `server-setup.sh`

### 1.14 Create/verify the platform administrator 🔴
- [ ] **First `super_admin` exists and can log in**
  - **Why:** No seeded account; must be inserted manually.
  - **Owner:** Platform admin
  - **When:** Before pilot
  - **Steps:** Insert bcrypt-hashed `super_admin` (OPERATIONS_RUNBOOK §16); log in at
    `/login.html`.
  - **Evidence:** Successful login; one `super_admin` row for AG staff
  - **Blocking:** Yes
  - **Related:** OPERATIONS_RUNBOOK §16, README quick start
  - **Ref:** `README.md`, `api/server.js` (`/api/auth/login`)

### 1.15 Verify email delivery 🔴
- [ ] **SMTP configured; test email sends**
  - **Why:** Approval/rejection/reset emails and portal handoffs rely on SMTP; there is no
    invite email.
  - **Owner:** Platform admin / DevOps
  - **When:** Before pilot
  - **Steps:** Set `SMTP_*`; Super Admin → Settings → **email test**
    (`POST /api/admin/test-email`); confirm receipt; check `/api/health` `smtp`.
  - **Evidence:** Received test email; health `smtp: ok`
  - **Blocking:** No (but resets/approvals degrade to logged links without it)
  - **Related:** FEATURE_REFERENCE §15, OPERATIONS_RUNBOOK §9
  - **Ref:** `api/services/email.js`, `api/server.js` (`/api/admin/test-email`)

### 1.16 Verify external credentials 🟢
- [ ] **Confirm no live third-party integrations are expected**
  - **Why:** Mitchell/Square/Twilio/CCC One are **not connected**; no external API keys are
    used by current code.
  - **Owner:** Product owner
  - **When:** Before pilot
  - **Steps:** Confirm expectations with stakeholders; ensure no one is promised an
    integration.
  - **Evidence:** Sign-off note
  - **Blocking:** No
  - **Related:** FEATURE_REFERENCE §16
  - **Ref:** `public/integrations.html`, `api/services/mitchell-etl.js`

### 1.17 Review data-retention expectations 🟢
- [ ] **Agree how long pilot data is kept and how it's exported/deleted at pilot end**
  - **Why:** Real PII is stored; the repo defines no retention policy.
  - **Owner:** Product owner + legal/coordinator
  - **When:** Before pilot
  - **Steps:** Document retention + deletion/export process; align with the shop.
  - **Evidence:** Retention policy note
  - **Blocking:** No
  - **Related:** PILOT_ONBOARDING §13
  - **Ref:** (policy — not in repo)

### 1.18 Rotate previously exposed secrets 🟠
- [ ] **Rotate any DB/SMTP/SSH secret that was ever committed or shared**
  - **Why:** `KNOWLEDGE_TRANSFER.md` §9 explicitly calls for rotating previously exposed
    credentials.
  - **Owner:** DevOps
  - **When:** Before pilot
  - **Steps:** Rotate creds; update `shared/.env` and GitHub secrets; verify.
  - **Evidence:** New creds in use; old ones invalidated
  - **Blocking:** No (Yes if any secret is known-exposed)
  - **Related:** OPERATIONS_RUNBOOK §15
  - **Ref:** `KNOWLEDGE_TRANSFER.md` §9

### 1.19 Remove leftover workflow artifacts ⚪
- [ ] **Delete root `github-workflows.yml` / `github-workflows.yml.backup`**
  - **Why:** Not active (only `.github/workflows/*` run); leftover files cause confusion.
  - **Owner:** Developer
  - **When:** Recommended before pilot
  - **Steps:** Confirm they aren't referenced; remove from repo root.
  - **Evidence:** Files removed; CI still green
  - **Blocking:** No
  - **Related:** OPERATIONS_RUNBOOK §26
  - **Ref:** `github-workflows.yml`, `github-workflows.yml.backup`

---

## Phase 2 — Pilot Shop Setup

### 2.1 Create the workspace 🔴
- [ ] **Approve the shop's signup to provision the workspace + owner (manager)**
  - **Why:** Approval is the only in-app path that creates a workspace + owner correctly.
  - **Owner:** Platform admin (super_admin)
  - **When:** Shop setup
  - **Steps:** Super Admin → Onboard shop → Approve; relay the temp password.
  - **Evidence:** Workspace + owner `manager` created; owner logged in
  - **Blocking:** Yes
  - **Related:** PILOT_ONBOARDING §6
  - **Ref:** `api/services/signup.js`, `/api/admin/signups/:id/approve`

### 2.2 Record the shop's official information 🟢
- [ ] **Confirm the workspace name (and any address/type) is correct**
  - **Why:** The workspace `name` is what customers see on the portal login picker.
  - **Owner:** Manager
  - **When:** Shop setup
  - **Steps:** Verify the name; **note:** there is no in-app workspace-edit screen — a name
    change is a DB update by an admin.
  - **Evidence:** Correct name in `GET /api/customer/workspaces`
  - **Blocking:** No
  - **Ref:** `api/migrations/001_initial.sql` (`workspaces`)

### 2.3 Create manager account(s) ✅ (covered by 2.1)
- [ ] **Owner signs in and changes the temporary password**
  - **Owner:** Manager · **When:** Shop setup
  - **Steps:** Log in; profile → change password.
  - **Evidence:** Successful password change
  - **Blocking:** Yes
  - **Ref:** `/api/users/profile`

### 2.4 Create staff accounts & assign roles 🔴
- [ ] **Invite advisors and technicians with correct roles**
  - **Why:** Roles gate what each person can do.
  - **Owner:** Manager
  - **When:** Shop setup
  - **Steps:** Team → Invite (name, email, role); hand over each temp password (no email).
  - **Evidence:** Each user signs in and reaches their console
  - **Blocking:** Yes
  - **Related:** USER_MANUAL §2.7
  - **Ref:** `/api/users/invite`

### 2.5 Import customers 🔴
- [ ] **Upload the customers CSV and review results**
  - **Owner:** Manager · **When:** Shop setup
  - **Preconditions:** CSV with `full_name`/`name`, `email`, `phone`
  - **Steps:** Integrations/Data import → customers; review `{success,duplicates,errors}`.
  - **Evidence:** Success count matches expected; errors reconciled
  - **Blocking:** Yes (for a data-backed pilot)
  - **Related:** FEATURE_REFERENCE §14
  - **Ref:** `/api/import/customers`, `api/services/import.js`

### 2.6 Import vehicles 🔴
- [ ] **Upload the vehicles CSV (after customers) and review results**
  - **Owner:** Manager · **When:** Shop setup
  - **Preconditions:** Customers imported; CSV with `vin,make,model,year,plate,mileage,customer_email`
  - **Steps:** Import → vehicles; confirm linkage via `customer_email`.
  - **Evidence:** Success count; linked vehicles verified
  - **Blocking:** Yes (for a data-backed pilot)
  - **Ref:** `/api/import/vehicles`

### 2.7 Enter inventory ⛔→🟠 (no import path)
- [ ] **Enter the initial parts catalog by hand**
  - **Why:** **There is no parts CSV import** — blocked as an import; must be manual.
  - **Owner:** Manager · **When:** Shop setup
  - **Steps:** Parts inventory → create each part (number, name, pricing, stock, min).
  - **Evidence:** Catalog visible; low-stock logic works
  - **Blocking:** No (parts can also be added ad-hoc on ROs)
  - **Related:** FEATURE_REFERENCE §9
  - **Ref:** `/api/parts`, `api/services/parts.js`

### 2.8 Review imported data 🟠
- [ ] **Spot-check customers/vehicles for accuracy and dedupe**
  - **Owner:** Manager · **When:** Shop setup
  - **Steps:** Search a few known customers/vehicles; confirm no obvious duplicates.
  - **Evidence:** Sign-off note
  - **Blocking:** No
  - **Ref:** `/api/customers`, `/api/vehicles`

### 2.9 Enable customer portal access (selected customers) 🟠
- [ ] **Enable portal access and hand over credentials for pilot customers**
  - **Owner:** Manager · **When:** Shop setup
  - **Preconditions:** Customer has an email
  - **Steps:** Customer → Enable portal access; relay shop name + URL + temp password.
  - **Evidence:** Customer logs in at `/portal-login.html`
  - **Blocking:** No
  - **Related:** USER_MANUAL §2.8
  - **Ref:** `/api/admin/customers/:id/enable-portal`

### 2.10 Select pilot users & confirm devices 🟢
- [ ] **Identify who uses which console and on what device**
  - **Owner:** Pilot coordinator + manager · **When:** Shop setup
  - **Steps:** Confirm technicians have a mobile/tablet browser; managers a desktop; note
    the Chart.js CDN caveat for burn-rate.
  - **Evidence:** Roster of users/devices
  - **Blocking:** No
  - **Related:** PILOT_ONBOARDING §5
  - **Ref:** `public/tech.html`, `public/burnrate.html`

### 2.11 Confirm business hours / operational settings ➖
- [ ] **N/A — the app has no business-hours or scheduling settings**
  - **Why:** No such configuration exists (appointments are a request inbox).
  - **Owner:** — · **When:** —
  - **Evidence:** Noted as N/A
  - **Blocking:** No
  - **Ref:** `api/services/customer-portal.js` (appointments)

### 2.12 Establish support contacts 🔴
- [ ] **Share the AG support channel and escalation path with the shop**
  - **Owner:** Pilot coordinator · **When:** Shop setup
  - **Steps:** Confirm the real support address/SLA (app default is
    `support@agshopro.com`); share issue-reporting template.
  - **Evidence:** Shop has the contact + template
  - **Blocking:** Yes
  - **Related:** PILOT_ONBOARDING §11, FAQ_TROUBLESHOOTING
  - **Ref:** `api/services/email.js` (`SUPPORT_EMAIL`)

---

## Phase 3 — Training and User Acceptance

### 3.1 Complete the training walkthrough 🔴
- [ ] **Run TRAINING_WALKTHROUGH end-to-end with each role**
  - **Owner:** Trainer · **When:** Before go-live
  - **Evidence:** Wrap-up checklist completed
  - **Blocking:** Yes · **Ref:** `docs/TRAINING_WALKTHROUGH.md`

### 3.2 Test every pilot role 🔴
- [ ] **Each of manager/advisor/technician/customer performs their core tasks**
  - **Owner:** Trainer + users · **When:** Before go-live
  - **Evidence:** Sign-off per role
  - **Blocking:** Yes · **Related:** USER_MANUAL

### 3.3 Test the complete repair-order lifecycle 🔴
- [ ] **Customer→vehicle→RO→parts→labor→time→status→completed→totals**
  - **Owner:** Advisor + technician · **When:** Before go-live
  - **Evidence:** A completed RO with correct totals
  - **Blocking:** Yes · **Ref:** `api/services/repair-order.js`

### 3.4 Test inventory behavior 🟠
- [ ] **Catalog part draws down stock; adjustment can't go below zero; low-stock shows**
  - **Owner:** Manager · **When:** Before go-live
  - **Evidence:** Stock changes observed
  - **Blocking:** No · **Ref:** `api/services/parts.js`

### 3.5 Test customer portal access 🟠
- [ ] **A customer logs in, views history/vehicles, updates profile**
  - **Owner:** Manager + test customer · **When:** Before go-live
  - **Evidence:** Portal session works, records scoped correctly
  - **Blocking:** No · **Ref:** `api/services/customer-portal.js`

### 3.6 Test appointment requests 🟠
- [ ] **Customer books; staff confirm; past-date rejected; dedupe works**
  - **Owner:** Customer + advisor · **When:** Before go-live
  - **Evidence:** Appointment appears and is confirmable
  - **Blocking:** No · **Ref:** `/api/customer/appointments`, `/api/appointments/:id`

### 3.7 Test reports 🟠
- [ ] **Manager opens financial/technician reports and burn-rate; revenue reconciles**
  - **Owner:** Manager · **When:** Before go-live
  - **Evidence:** Revenue matches the completed RO(s); charts render (or CDN caveat noted)
  - **Blocking:** No · **Ref:** `api/services/reporting.js`, `api/services/analytics.js`

### 3.8 Test invalid & restricted actions 🔴
- [ ] **Advisor blocked from reports; illegal status change refused; cross-tenant 404**
  - **Why:** Confirms security/role behavior with real accounts.
  - **Owner:** Trainer/admin · **When:** Before go-live
  - **Evidence:** Expected "Insufficient permissions" / "Cannot change status" / 404
  - **Blocking:** Yes · **Related:** TECHNICAL_ARCHITECTURE §9, §10

### 3.9 Record acceptance results & open issues 🔴
- [ ] **Document what passed, what failed, and remaining issues**
  - **Owner:** Pilot coordinator · **When:** Before go-live
  - **Evidence:** Acceptance record + issue log
  - **Blocking:** Yes

### 3.10 Obtain pilot approval 🔴
- [ ] **Stakeholders approve go-live given known limitations**
  - **Owner:** Product owner + shop · **When:** Before go-live
  - **Evidence:** Written go/no-go
  - **Blocking:** Yes

---

## Phase 4 — Production Verification

### 4.1 Verify the deployed release 🔴
- [ ] **`current` points at the intended release**
  - **Owner:** DevOps · **Steps:** `readlink /var/www/agshopro/current`
  - **Evidence:** Correct release id · **Blocking:** Yes · **Ref:** `server-setup.sh` deploy.sh

### 4.2 Run migrations 🔴
- [ ] **All migrations applied (idempotent re-run is "skip")**
  - **Owner:** DevOps · **Steps:** `NODE_ENV=production npm run migrate:latest`
  - **Evidence:** `[migrate] done`, prior files "skip"
  - **Blocking:** Yes · **Ref:** `api/scripts/migrate.js` (mind the 004/006 note)

### 4.3 Check application health 🔴
- [ ] **`/api/health` = ok (DB ok, SMTP ok/warn)**
  - **Owner:** DevOps · **Steps:** `curl -fsS https://agshopro.com/api/health`
  - **Evidence:** `status: ok` · **Blocking:** Yes · **Ref:** `api/src/routes/health.js`

### 4.4 Check PM2 🔴
- [ ] **`ag-api` online, low restart count**
  - **Owner:** DevOps · **Steps:** `pm2 list` / `pm2 describe ag-api`
  - **Evidence:** `online` · **Blocking:** Yes · **Ref:** `infra/pm2/ecosystem.config.js`

### 4.5 Check Nginx 🔴
- [ ] **Config valid; TLS serving; `/` → login**
  - **Owner:** DevOps · **Steps:** `sudo nginx -t`; `curl -I https://agshopro.com/`
  - **Evidence:** nginx test ok; login page served · **Blocking:** Yes · **Ref:** `infra/nginx/agshopro.conf`

### 4.6 Check database connectivity 🔴
- [ ] **App/psql reach RDS over TLS**
  - **Owner:** DevOps · **Steps:** `psql "host=<DB_HOST> … sslmode=require" -c 'SELECT 1'`
  - **Evidence:** Query returns · **Blocking:** Yes · **Ref:** `api/server.js` pool

### 4.7 Review application logs 🟠
- [ ] **No errors on startup / first requests**
  - **Owner:** DevOps · **Steps:** tail `shared/logs/api-error.log`
  - **Evidence:** Clean log · **Blocking:** No · **Ref:** OPERATIONS_RUNBOOK §12

### 4.8 Verify login 🔴
- [ ] **A real account signs in and loads a data page**
  - **Owner:** Admin · **Evidence:** Successful session + data · **Blocking:** Yes

### 4.9 Verify tenant isolation (smoke) 🔴
- [ ] **A manager cannot reach another workspace via `?workspaceId=`**
  - **Owner:** Admin · **Steps:** As a manager, request another shop's id → expect 403/404
  - **Evidence:** Access denied · **Blocking:** Yes · **Related:** TECHNICAL_ARCHITECTURE §10

### 4.10 Smoke test the full flow 🔴
- [ ] **Create→complete a test RO in production; view in portal**
  - **Owner:** Admin/manager · **Evidence:** RO completed + visible in portal
  - **Blocking:** Yes

### 4.11 Confirm backup completion 🔴
- [ ] **A production backup/snapshot exists post-launch**
  - **Owner:** DevOps · **Evidence:** Snapshot id/time · **Blocking:** Yes · **Related:** §1.9

### 4.12 Confirm alert delivery 🟠
- [ ] **The uptime monitor fires a test alert**
  - **Owner:** DevOps · **Evidence:** Received alert · **Blocking:** No · **Related:** §1.11

---

## Phase 5 — Pilot Operations

### 5.1 Daily checks 🟠
- [ ] **`/api/health` ok; PM2 online; error log scan**
  - **Owner:** DevOps/support · **Evidence:** Daily note · **Ref:** OPERATIONS_RUNBOOK §12

### 5.2 Weekly checks 🟠
- [ ] **Review deploys, disk, restart counts, and open issues**
  - **Owner:** DevOps · **Evidence:** Weekly note

### 5.3 Backup verification 🟠
- [ ] **Confirm backups ran; periodically re-test a restore**
  - **Owner:** DevOps · **Evidence:** Backup log / restore test · **Related:** §1.10

### 5.4 Disk-space checks 🟠
- [ ] **Disk <80%; ≤5 releases; logs rotated**
  - **Owner:** DevOps · **Steps:** `df -h`; `du -sh releases/*`
  - **Evidence:** Healthy disk · **Ref:** OPERATIONS_RUNBOOK §21

### 5.5 Error-log review 🟠
- [ ] **Scan `api-error.log` for recurring errors**
  - **Owner:** Support/DevOps · **Evidence:** Findings logged

### 5.6 Failed-login review 🟢
- [ ] **Watch for rate-limit hits / credential-stuffing patterns**
  - **Owner:** Support · **Evidence:** Notes; escalate anomalies

### 5.7 Pilot feedback collection 🟠
- [ ] **Hold the weekly feedback session (PILOT_ONBOARDING §14)**
  - **Owner:** Pilot coordinator · **Evidence:** Session notes

### 5.8 Issue prioritization 🟠
- [ ] **Triage reported issues; flag blockers**
  - **Owner:** Product owner · **Evidence:** Prioritized issue list

### 5.9 Data-quality review 🟢
- [ ] **Check for duplicate/incomplete records; coach on entry**
  - **Owner:** Manager · **Evidence:** Notes

### 5.10 Release communication 🟠
- [ ] **Notify the shop before/after any deploy**
  - **Owner:** Pilot coordinator · **Evidence:** Comms record · **Ref:** deploy workflows

### 5.11 Incident escalation 🟠
- [ ] **Follow the incident path for any outage/leak/data loss**
  - **Owner:** DevOps · **Evidence:** Incident record · **Ref:** OPERATIONS_RUNBOOK §22

---

## Phase 6 — Pilot Completion

### 6.1 Export pilot data (if required) 🟠
- [ ] **Export the shop's data (reports CSV/JSON and/or a DB dump)**
  - **Owner:** DevOps + manager · **Steps:** `GET /api/reports/export?format=csv`;
    `pg_dump` for a full copy
  - **Evidence:** Export files · **Ref:** `/api/reports/export`, OPERATIONS_RUNBOOK §14

### 6.2 Review pilot metrics 🟠
- [ ] **Compare against success criteria (PILOT_ONBOARDING §15)**
  - **Owner:** Product owner · **Evidence:** Metrics summary

### 6.3 Review incidents 🟠
- [ ] **Summarize incidents and their resolutions**
  - **Owner:** DevOps · **Evidence:** Incident log

### 6.4 Review user feedback 🟠
- [ ] **Consolidate feedback into themes**
  - **Owner:** Pilot coordinator · **Evidence:** Feedback summary

### 6.5 Confirm unresolved defects 🔴
- [ ] **List remaining defects, especially any blockers**
  - **Owner:** Product owner · **Evidence:** Defect list · **Blocking:** Yes (for the decision)

### 6.6 Decide expand / pause / end 🔴
- [ ] **Make and record the go-forward decision**
  - **Owner:** Stakeholders · **Evidence:** Decision record · **Blocking:** Yes

### 6.7 Update the roadmap 🟢
- [ ] **Fold findings into the product roadmap (e.g. line edits, deletes, integrations)**
  - **Owner:** Product owner · **Evidence:** Updated roadmap

### 6.8 Obtain stakeholder sign-off 🔴
- [ ] **Final sign-off from AG and the shop**
  - **Owner:** Product owner + shop · **Evidence:** Signed record · **Blocking:** Yes

---

## Summary: blocking items required BEFORE pilot

1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 1.10, 1.12, 1.13, 1.14 · 2.1, 2.3, 2.4, 2.5, 2.6,
2.12 · 3.1, 3.2, 3.3, 3.8, 3.9, 3.10.

**Recommended before pilot:** 1.11, 1.15, 1.16, 1.17, 1.18. **Optional:** 1.19.
**Not applicable:** 2.11.

**Related:** [`PILOT_ONBOARDING.md`](PILOT_ONBOARDING.md) ·
[`OPERATIONS_RUNBOOK.md`](OPERATIONS_RUNBOOK.md) ·
[`FEATURE_REFERENCE.md`](FEATURE_REFERENCE.md)

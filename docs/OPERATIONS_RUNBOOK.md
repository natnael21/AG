# AG Shop Pro — Administrator and Operations Runbook

> **Audience:** Platform administrators, DevOps engineers, and support personnel.
> **Scope:** Everything needed to deploy, verify, operate, troubleshoot, and recover AG
> Shop Pro. Commands are taken from the repository (`server-setup.sh`, the GitHub
> workflows, `infra/`, `api/scripts/`). **Placeholders** like `<EC2_PUBLIC_IP>` must be
> filled with your environment's values. Anything not confirmable from the repository is
> marked **UNVERIFIED**.

> ⚠️ **Safety first.** Never commit real secrets. Migrations and rollbacks touch
> production data — read the preconditions before running any command in the "destructive"
> class (flagged 🔴).

---

## Table of Contents

1. [Production architecture](#1-production-architecture)
2. [AWS resources](#2-aws-resources)
3. [On-server directory & release layout](#3-on-server-directory--release-layout)
4. [Access: SSH & EC2](#4-access-ssh--ec2)
5. [Environment variables & secrets](#5-environment-variables--secrets)
6. [GitHub Actions CI/CD](#6-github-actions-cicd)
7. [Deployment procedure](#7-deployment-procedure)
8. [Database migrations](#8-database-migrations)
9. [Health checks & deployment verification](#9-health-checks--deployment-verification)
10. [Application restart & PM2](#10-application-restart--pm2)
11. [Nginx](#11-nginx)
12. [Log review](#12-log-review)
13. [Rollback](#13-rollback)
14. [Backup & restore](#14-backup--restore)
15. [Password & secret rotation](#15-password--secret-rotation)
16. [User & workspace administration](#16-user--workspace-administration)
17. [HTTPS / certificate troubleshooting](#17-https--certificate-troubleshooting)
18. [GitHub Actions troubleshooting](#18-github-actions-troubleshooting)
19. [Database troubleshooting](#19-database-troubleshooting)
20. [Login troubleshooting](#20-login-troubleshooting)
21. [High CPU / memory / disk response](#21-high-cpu--memory--disk-response)
22. [Incident response](#22-incident-response)
23. [Disaster recovery expectations](#23-disaster-recovery-expectations)
24. [Staging & production separation](#24-staging--production-separation)
25. [Monitoring & alerting](#25-monitoring--alerting)
26. [Correction: KNOWLEDGE_TRANSFER.md vs current state](#26-correction-knowledge_transfermd-vs-current-state)

---

## 1. Production architecture

```
        Internet
           │  443 (TLS, Let's Encrypt)
           ▼
   ┌────────────────┐   /api/  proxy → 127.0.0.1:3000
   │     Nginx      │────────────────────────────────┐
   │  (EC2 host)    │   static → /var/www/.../public  │
   └────────────────┘                                 ▼
                                          ┌────────────────────────┐
   prod:    agshopro.com        PM2 ──►   │ Node/Express ag-api     │  :3000
   preprod: preprod.agshopro.com PM2 ─►   │ Node/Express ag-api-preprod │ :3001
                                          └───────────┬────────────┘
                                                      │ pg pool (TLS)
                                                      ▼
                                          ┌────────────────────────┐
                                          │  AWS RDS PostgreSQL     │
                                          └────────────────────────┘
   (Redis is installed locally per KNOWLEDGE_TRANSFER.md but the app code does not use it — UNVERIFIED whether it runs.)
```

- **One EC2 host** runs both prod (`:3000`) and preprod (`:3001`) via PM2.
- **Nginx** terminates TLS, serves `public/`, proxies `/api/` (and `/socket.io/`, unused)
  to the Node process, and applies a `15r/s` rate limit (burst 30).
- **AWS RDS PostgreSQL** is the database (TLS required).

## 2. AWS resources

| Resource | Purpose | Source of truth |
|---|---|---|
| EC2 instance | Hosts Nginx + PM2 (prod + preprod) | `server-setup.sh`, `KNOWLEDGE_TRANSFER.md` |
| RDS PostgreSQL | Application database | `.env` `DB_*`, `KNOWLEDGE_TRANSFER.md` |
| Elastic IP / DNS | `agshopro.com`, `www.agshopro.com`, `preprod.agshopro.com` | `infra/nginx`, workflows |
| Let's Encrypt certs | TLS for both domains | `infra/nginx/agshopro.conf`, certbot |
| Security groups | Inbound 80/443 (public), 22 (SSH from admins/GitHub) | **UNVERIFIED** — confirm in AWS console |

> Exact instance IDs, region, RDS endpoint, and security-group rules are **not in the
> repository** — capture them in your environment records and the
> [`MANUAL_ACTIONS_CHECKLIST.md`](MANUAL_ACTIONS_CHECKLIST.md).

## 3. On-server directory & release layout

Created by `server-setup.sh`. Immutable, timestamped releases with a `current` symlink.

```
/var/www/agshopro/                      (production)
├── current            → releases/<latest>   (symlink; the live release)
├── releases/          (immutable release dirs, keep last 5)
│   └── 20260720_140312_6317a66/
│       ├── api/  public/  infra/ ...
│       └── api/.env       → ../../shared/.env   (symlink)
├── shared/
│   ├── .env           (REAL secrets — never in Git)
│   └── logs/          (api-out.log, api-error.log)
└── scripts/
    ├── deploy.sh
    ├── rollback.sh
    └── healthcheck.sh

/var/www/agshopro-preprod/              (preprod — same shape)
├── current → releases/<latest>
├── releases/  shared/  scripts/deploy.sh
```

## 4. Access: SSH & EC2

- **Bootstrap/admin user:** `ubuntu@<EC2_PUBLIC_IP>` (used to run `server-setup.sh`).
- **CI/CD deploy user:** `deploy@<EC2_PUBLIC_IP>` — created by `server-setup.sh` with
  limited sudo (nginx test/reload) and `authorized_keys` matching the GitHub
  `EC2_SSH_KEY` secret.

**Connect (admin):**
```bash
ssh -i ~/Ag-Shop-Pro.pem ubuntu@<EC2_PUBLIC_IP>
```
> If you need the user to run an interactive login themselves, they can type
> `! ssh -i ~/Ag-Shop-Pro.pem ubuntu@<EC2_PUBLIC_IP>` in this session.

- **PEM key** location per `KNOWLEDGE_TRANSFER.md`: `~/Ag-Shop-Pro.pem` (WSL) /
  `C:\Users\nzeme\Ag-Shop-Pro.pem` (Windows). Keep it `chmod 600` and out of Git.
- **Assumption:** SSH (port 22) inbound must be reachable from admin IPs and from the
  GitHub Actions runner for deploys.

## 5. Environment variables & secrets

**Server-side real values live only in** `/var/www/<app>/shared/.env` (symlinked into each
release's `api/.env`). The template is `api/.env.example`. Keys (see
[`TECHNICAL_ARCHITECTURE.md` §16](TECHNICAL_ARCHITECTURE.md)):

`PORT, NODE_ENV, DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASS, DB_SSL, CORS_ORIGINS,
RESET_BASE_URL, SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, FROM_EMAIL,
SUPPORT_EMAIL, APP_URL, HEALTH_SKIP_DB, HEALTH_SKIP_SMTP`.

**GitHub repository secrets** (used by both deploy workflows):

| Secret | Purpose |
|---|---|
| `EC2_HOST` | EC2 public host/IP |
| `EC2_USER` | Deploy user (`deploy`) |
| `EC2_SSH_KEY` | Private key matching `/home/deploy/.ssh/authorized_keys` |

**Edit the shared `.env` (🔴 changes production behaviour):**
```bash
ssh -i ~/Ag-Shop-Pro.pem ubuntu@<EC2_PUBLIC_IP>
sudo nano /var/www/agshopro/shared/.env
# then restart the app so it re-reads env:
pm2 restart ag-api --update-env
curl -fsS https://agshopro.com/api/health   # verify
```

## 6. GitHub Actions CI/CD

| Workflow | Trigger | Target | Notes |
|---|---|---|---|
| `ci.yml` | PR + push to `main`/`develop`/`staging` | — | Lint, unit tests, fresh-DB migration check (runs twice = idempotency), integration tests (services: postgres:16), frontend folder check |
| `deploy-preprod.yml` | push to `staging` | `preprod.agshopro.com` (:3001) | SCP repo → `/tmp/agshopro-release-preprod`, run preprod `deploy.sh`, healthcheck |
| `deploy-prod.yml` | push to `main` | `agshopro.com` (:3000) | GitHub `production` **environment approval gate**, SCP → `/tmp/agshopro-release`, run prod `deploy.sh`, healthcheck, **rollback on healthcheck failure** |

Concurrency: preprod cancels in-progress; **prod does not** (`cancel-in-progress: false`)
so a half-finished prod deploy is never abandoned.

The rollback step only fires when the deploy step **succeeded** and the subsequent
healthcheck failed (`failure() && steps.deploy.outcome == 'success'`) — so a checkout/SCP
failure does not roll back a healthy release.

## 7. Deployment procedure

### 7.1 Normal deploy (via Git — preferred)

**Preprod:**
1. **Precondition:** change merged/pushed to `staging`; CI green.
2. `git push origin staging` (or merge into `staging`).
3. The `Deploy to Preprod` workflow runs `deploy.sh`, then curls
   `https://preprod.agshopro.com/api/health`.
4. **Expected:** workflow green; health returns `{"status":"ok",...}`.

**Production:**
1. **Precondition:** verified on preprod; PR merged into `main`.
2. `git push origin main` (or merge PR).
3. **Approve** the `production` environment in the GitHub Actions run when prompted.
4. Workflow runs prod `deploy.sh`, curls `https://agshopro.com/api/health`; on failure it
   runs `rollback.sh`.
5. **Expected:** workflow green; health ok. **Failure symptom:** workflow red with
   `Prod deploy FAILED and was rolled back`.

### 7.2 What `deploy.sh <release-id>` does (on EC2)

Exact steps from `server-setup.sh` (prod path):
```bash
mkdir -p releases/<id>
rsync -a --exclude=.git --exclude=node_modules --exclude=.env /tmp/agshopro-release/ releases/<id>/
ln -sfn shared/.env releases/<id>/api/.env
cd releases/<id>/api && npm ci --omit=dev
NODE_ENV=production npm run migrate:latest
ln -sfn releases/<id> current.next && mv -Tf current.next current   # atomic switch
pm2 reload ag-api --update-env || pm2 start .../ecosystem.config.js --only ag-api --env production
pm2 save
sudo nginx -t && sudo systemctl reload nginx
ls -dt releases/*/ | tail -n +6 | xargs -r rm -rf                    # keep last 5
```
Preprod is identical with `NODE_ENV=staging`, `ag-api-preprod`, and its own paths.

### 7.3 Manual deploy from EC2 (fallback if Actions is down)
1. **Precondition:** code present at `/tmp/agshopro-release` (SCP it up).
2. `ssh deploy@<EC2_PUBLIC_IP>`
3. `bash /var/www/agshopro/scripts/deploy.sh <YYYYmmdd_HHMMSS_sha>`
4. **Verify:** `curl -fsS https://agshopro.com/api/health`.

## 8. Database migrations

- **Tool:** `api/scripts/migrate.js` (`npm run migrate:latest`). Creates
  `schema_migrations`, applies each unapplied `*.sql` in order (each in a transaction),
  records the filename. **Re-running is a no-op.**
- Migrations run automatically inside `deploy.sh`. To run manually:
```bash
cd /var/www/agshopro/current/api
NODE_ENV=production npm run migrate:latest
```
- **Preconditions:** `shared/.env` has valid `DB_*`; the DB user can `CREATE TABLE`.
- **Expected result:** `[migrate] apply 00N_...` for new files, `[migrate] skip` for
  applied ones, then `[migrate] done`.

> 🔴 **Fresh-database caution (migration 004/006).** On a brand-new database the
> `004_enhanced_repair_orders.sql` file can abort because `001` created stub line tables.
> The working redo is `006_fix_ro_lines_schema.sql`. On any environment whose
> `schema_migrations` does **not** already contain `004`, first run:
> ```sql
> INSERT INTO schema_migrations (filename) VALUES ('004_enhanced_repair_orders.sql')
>   ON CONFLICT DO NOTHING;
> ```
> so `migrate.js` skips the broken file, then run `migrate:latest`. (CI builds
> `001..008` from scratch and passes; **UNVERIFIED** whether it pre-inserts `004` or the
> current sequence simply succeeds on its Postgres — confirm before standing up a new DB.)

## 9. Health checks & deployment verification

**Endpoint:** `GET /api/health` (`src/routes/health.js`).

```bash
curl -fsS https://agshopro.com/api/health | jq
```
Returns:
```json
{ "status": "ok", "timestamp": "...", "uptime": 123.4,
  "checks": { "database": {"status":"ok","latencyMs":5},
              "smtp": {"status":"ok","latencyMs":40} } }
```
- **`status: ok`** → healthy. **`degraded` + HTTP 503** → the database check failed
  (critical). SMTP failure is `warn` (non-critical) and does not fail health.
- `HEALTH_SKIP_DB=1` / `HEALTH_SKIP_SMTP=1` skip those checks (used in CI/local).

**Post-deploy verification checklist:**
1. `curl -fsS https://agshopro.com/api/health` → `status: ok`.
2. `pm2 list` → `ag-api` `online`, low restart count.
3. `readlink /var/www/agshopro/current` → points at the new release id.
4. Log in at `https://agshopro.com/login.html` and load a data page.
5. Tail logs for errors (see §12).

## 10. Application restart & PM2

PM2 config: `infra/pm2/ecosystem.config.js` — `ag-api` (:3000, `env_production`) and
`ag-api-preprod` (:3001, `env_staging`), fork mode, 1 instance, `max_memory_restart 512M`,
logs in `shared/logs/`.

```bash
pm2 list                         # status of both apps
pm2 restart ag-api --update-env  # restart prod (re-reads env)
pm2 reload  ag-api --update-env  # zero-downtime reload
pm2 logs ag-api --lines 100      # live logs
pm2 describe ag-api              # detail (restarts, memory, uptime)
pm2 save                         # persist process list across reboots
```
> **Split PM2 contexts caution** (`KNOWLEDGE_TRANSFER.md`): root vs deploy user can have
> separate PM2 daemons (`/root/.pm2` vs `/home/deploy/.pm2`). Always operate PM2 as the
> **same user the deploy uses** (`deploy`). `pm2 save` + `pm2 startup` should be
> configured for that user so processes survive a reboot. **UNVERIFIED:** current owner —
> confirm on the host.

## 11. Nginx

Template: `infra/nginx/agshopro.conf` (prod). Preprod vhost is generated by
`server-setup.sh`.

```bash
sudo nginx -t                    # test config (ALWAYS before reload)
sudo systemctl reload nginx      # apply
sudo systemctl status nginx
```
Key points from the config: TLS via Let's Encrypt; security headers (HSTS, X-Frame-Options
SAMEORIGIN, nosniff, Referrer-Policy); denies `/.env`, `/.git`, `/node_modules`; `/api/`
rate-limited and proxied to `127.0.0.1:3000`; SPA fallback `try_files ... /index.html`;
`index login.html index.html`; port 80 → 301 to HTTPS.

## 12. Log review

```bash
# Application logs (PM2)
tail -f /var/www/agshopro/shared/logs/api-out.log
tail -f /var/www/agshopro/shared/logs/api-error.log
pm2 logs ag-api --lines 200

# Nginx
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```
What to look for: `[DB] Connection failed`, `[login]`/`[signup]` errors, `[Inventory]`
adjustment lines, `[forgot-password] Email delivery failed ... reset link: <url>`
(SMTP down), stack traces from the last-resort error handler.

## 13. Rollback

🔴 **Production rollback repoints `current` to the previous release and reloads PM2.**

**Automatic:** the prod workflow runs it when a live deploy fails its healthcheck.

**Manual:**
```bash
ssh deploy@<EC2_PUBLIC_IP>
bash /var/www/agshopro/scripts/rollback.sh
```
`rollback.sh` finds the newest release that is **not** `current`, atomically symlinks
`current` to it, and `pm2 reload ag-api`. **It errors if there is no previous release.**

**Verify after rollback:** `curl -fsS https://agshopro.com/api/health` → ok;
`readlink current` → previous release.

> ⚠️ **Migrations are not auto-reverted.** Rollback restores code, not schema. If a bad
> deploy applied a migration, assess whether the previous code tolerates the new schema
> (usually yes — migrations are additive/idempotent here). There is **no down-migration
> tooling**; a schema revert is a manual DB operation.

## 14. Backup & restore

> **UNVERIFIED — not defined in the repository.** No backup/restore scripts or RDS
> snapshot policy exist in the repo. The following is the expected approach for an RDS
> PostgreSQL deployment; **confirm and record the actual policy** in
> [`MANUAL_ACTIONS_CHECKLIST.md`](MANUAL_ACTIONS_CHECKLIST.md).

**Recommended backup:** enable **RDS automated backups** (daily snapshots + PITR) and take
a manual snapshot before each production migration.

**Logical backup / restore (generic):**
```bash
# Backup (run from a host that can reach RDS; DB_* from shared/.env)
pg_dump "host=<DB_HOST> port=5432 dbname=<DB_NAME> user=<DB_USER> sslmode=require" \
  -Fc -f agshop_$(date +%Y%m%d).dump

# Restore into a fresh database (🔴 destructive to the target)
pg_restore --clean --if-exists -d "host=<DB_HOST> dbname=<DB_NAME> user=<DB_USER> sslmode=require" \
  agshop_YYYYMMDD.dump
```
**Restore test (required before pilot):** restore the latest backup into a throwaway DB
and run `npm run migrate:latest` (should be all "skip") + `/api/health` against it.

## 15. Password & secret rotation

- **App/DB/SMTP secrets:** edit `/var/www/<app>/shared/.env`, then `pm2 restart ag-api
  --update-env` and verify health. Rotate any credential that was ever exposed
  (`KNOWLEDGE_TRANSFER.md` §9 explicitly calls for rotating previously exposed
  DB/SMTP/keys).
- **`EC2_SSH_KEY` / deploy key:** generate a new keypair, update
  `/home/deploy/.ssh/authorized_keys`, update the GitHub `EC2_SSH_KEY` secret, test a
  preprod deploy.
- **Staff passwords:** admin reset via `POST /api/users/:id/reset-password` (returns a
  temp password) — see §16.
- **First super_admin / DB-level password:** update the `password_hash` directly with a
  new bcrypt hash (see §16).

## 16. User & workspace administration

**Create the first `super_admin`** (no seeded account exists):
```bash
# Generate a bcrypt hash (cost 12)
node -e "require('bcrypt').hash('YourStrongPassword!23',12).then(h=>console.log(h))"
```
```sql
-- In psql against the app DB:
INSERT INTO workspaces (name, active) VALUES ('AG Platform', true);
INSERT INTO users (name, email, password_hash, role, workspace_ids, active)
VALUES ('Platform Admin','admin@agshopro.com','<hash>','super_admin','{1}', true);
```
Then sign in at `/login.html`.

**Everyday admin (via the app, preferred over SQL):**
- Review shop signups: `superadmin.html` → Onboard shop → Approve/Reject/Reinstate.
- Invite staff, change roles, deactivate/reactivate, reset passwords: `superadmin.html`
  (or `manager.html` for a manager within their shop).
- Enable a customer's portal access: `manager.html`/`superadmin.html` (returns a temp
  password) — or `POST /api/admin/customers/:id/enable-portal`.

**Reset a stuck admin password via SQL** (🔴 last resort):
```sql
UPDATE users SET password_hash='<new bcrypt hash>', reset_token=NULL, reset_expiry=NULL
WHERE lower(email)=lower('admin@agshopro.com');
DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE lower(email)=lower('admin@agshopro.com'));
```

## 17. HTTPS / certificate troubleshooting

- Certs are Let's Encrypt (`/etc/letsencrypt/live/agshopro.com/`).
- **Renew / issue:**
```bash
sudo certbot --nginx -d agshopro.com -d www.agshopro.com
sudo certbot --nginx -d preprod.agshopro.com
sudo certbot renew --dry-run     # test auto-renewal
```
- **Verify SANs (per KNOWLEDGE_TRANSFER.md):**
```bash
echo | openssl s_client -connect preprod.agshopro.com:443 -servername preprod.agshopro.com 2>/dev/null \
  | openssl x509 -noout -subject -issuer -ext subjectAltName
```
- **Symptom: 403 on `/` but `/api/health` ok** — Nginx `index`/fallback not set to
  `login.html`. Fixed in the template (`index login.html index.html; try_files ...
  /login.html` for preprod). Confirm the deployed vhost matches
  `infra/nginx/agshopro.conf`.

## 18. GitHub Actions troubleshooting

| Symptom | Likely cause | Resolution |
|---|---|---|
| `dial tcp <host>:22: i/o timeout` on SCP/SSH | Security group blocks the runner, or `EC2_HOST` wrong | Confirm inbound 22 allows GitHub runners; verify `EC2_HOST` secret |
| Deploy runs but app unchanged | Wrong `deploy` user / path; `current` not switched | SSH in, check `readlink current`, re-run `deploy.sh <id>` |
| Prod deploy red + "rolled back" | Healthcheck failed after go-live | Read app logs (§12); the previous release is live again |
| Prod stuck awaiting approval | `production` environment gate | Approve in the Actions run (an authorized reviewer) |
| CI migration step fails | Fresh-DB `004`/`006` issue | See §8 caution |
| "Incorrect type. Expected string" YAML error | Unquoted `::error::` string | Quote the `run` value (already fixed in current workflows) |

## 19. Database troubleshooting

| Symptom | Check | Resolution |
|---|---|---|
| `/api/health` `database:error`, HTTP 503 | `shared/.env` `DB_*`; RDS reachable; `DB_SSL` | Fix creds/SSL; RDS needs TLS (`DB_SSL` unset/≠0). Security group must allow EC2→RDS 5432 |
| `[DB] Connection failed` in logs | RDS down / network / creds | `psql "host=<DB_HOST> ... sslmode=require" -c 'SELECT 1'` |
| Migration error on deploy | Bad/edited migration | See §8; never edit an applied migration; add a new one |
| App works but writes 500 with SQLSTATE in logs | Constraint/format violation | `sendError` maps `23505/23503/23514/22P02/23502` to safe messages; check the logged code |

Connectivity test:
```bash
psql "host=<DB_HOST> port=5432 dbname=<DB_NAME> user=<DB_USER> sslmode=require" -c "SELECT 1;"
```

## 20. Login troubleshooting

| Symptom | Cause | Resolution |
|---|---|---|
| "Incorrect email or password" for a known-good account | Wrong password, `active=false`, or no such user | Confirm `SELECT active FROM users WHERE lower(email)=lower('...')`; reset password (§16) |
| Immediately kicked back to login | 401 from API → `auth.js` clears session | Session expired (8h) or token invalid; sign in again |
| "Session expired" mid-use | 8h staff / 24h portal expiry, or `sessions` cleared by role change | Re-authenticate; role changes intentionally end sessions |
| Portal login fails for a real customer | `portal_enabled=false` or no `portal_password_hash` or wrong shop | Enable portal access; ensure the customer picked the right shop |
| Reset email never arrives | SMTP misconfigured | Check `[forgot-password] Email delivery failed ... reset link:` in logs; fix SMTP (§15); test with `POST /api/admin/test-email` |
| 429 Too many attempts | Rate limiter (10 attempts / 15 min per IP on credential routes) | Wait; behind proxy, `trust proxy 1` uses the real client IP |

## 21. High CPU / memory / disk response

```bash
top / htop                         # CPU / memory
pm2 describe ag-api                # per-process memory (auto-restart at 512M)
df -h                              # disk usage
du -sh /var/www/agshopro/releases/*   # release dirs (should be ≤5)
du -sh /var/www/agshopro/shared/logs/*
```
- **High memory:** PM2 auto-restarts `ag-api` at 512M. Persistent growth → investigate a
  leak / heavy report query; consider restarting: `pm2 restart ag-api`.
- **Disk full:** old releases are pruned to 5 by `deploy.sh`; if disk is full, remove
  stale releases and rotate/truncate large logs. Nginx access logs and PM2 logs are the
  usual culprits — ensure `logrotate` is active (set up by `server-setup.sh`).
- **High CPU:** check for an expensive report against a large workspace, or a tight retry
  loop in logs; correlate with Nginx access log spikes.

## 22. Incident response

1. **Detect:** `/api/health` non-ok, alert, or user report.
2. **Triage:** `curl /api/health`; `pm2 list`; tail `api-error.log` and Nginx `error.log`.
3. **Classify:**
   - App down/crash-looping → §10 (restart) or §13 (rollback if a recent deploy).
   - DB unreachable → §19.
   - TLS/403 → §17.
4. **Mitigate:** roll back to the last good release (§13) if a deploy caused it;
   restart PM2; fix env and `pm2 restart --update-env`.
5. **Verify:** health ok, login works, a data page loads.
6. **Record:** what happened, when, fix applied, follow-ups. If a hotfix was applied on
   EC2, **backport it to Git immediately** (`KNOWLEDGE_TRANSFER.md` §15).

## 23. Disaster recovery expectations

> **Largely UNVERIFIED — no DR runbook exists in the repository.** Realistic expectations
> given the current single-host design:

- **Single EC2 host** → it is a single point of failure. Loss of the host requires
  re-running `server-setup.sh` on a replacement, restoring `shared/.env`, and deploying
  the latest release from Git (`KNOWLEDGE_TRANSFER.md` §14 "How to recreate").
- **Database:** recoverable only as well as your RDS backup/snapshot policy allows
  (§14) — **confirm it exists**.
- **Recreate from scratch:** clone repo → run `server-setup.sh` on EC2 → set `deploy`
  authorized_keys → add GitHub secrets → point DNS → issue certs → push `staging` then
  `main`.
- **RTO/RPO:** not formally defined; establish and record targets before pilot.

## 24. Staging & production separation

- **Separate PM2 apps** (`ag-api` :3000 / `ag-api-preprod` :3001) and separate directory
  trees (`/var/www/agshopro` vs `/var/www/agshopro-preprod`).
- **Separate domains** and Nginx vhosts.
- **Separate shared `.env`** (preprod has `PORT=3001`, `NODE_ENV=staging`).
- **Separate branches:** `staging` → preprod, `main` → production (approval-gated).
- ⚠️ **They share the same EC2 host.** A resource exhaustion on the host affects both.
  **Confirm the preprod `.env` points at a separate database** — do not let preprod write
  to the production DB (**UNVERIFIED** — verify `DB_NAME` in each `shared/.env`).

## 25. Monitoring & alerting

> **UNVERIFIED — no monitoring/alerting stack is defined in the repository.** What exists:
> the workflows curl `/api/health` post-deploy and annotate failures. A
> `healthcheck.sh` is written to the prod host by `server-setup.sh` (curls prod + preprod
> health).

**Recommended minimum before pilot:**
- Scheduled external check of `https://agshopro.com/api/health` (uptime monitor) alerting
  on non-200/`degraded`.
- Alert on PM2 restart storms and on disk >80%.
- Weekly review of `api-error.log` and failed-login patterns.

## 26. Correction: KNOWLEDGE_TRANSFER.md vs current state

`KNOWLEDGE_TRANSFER.md` is a **historical migration narrative** and is partly out of date.
Corrections (verified against the current code):

| KNOWLEDGE_TRANSFER.md says | Current reality |
|---|---|
| "Replace placeholder migration script with real migration tool" | `api/scripts/migrate.js` is a real, tracked migration runner |
| "Replace placeholder tests/lint scripts with real checks" | `api/scripts/lint.js` and the `node:test` suites are real; CI runs them |
| "Remove legacy duplicate workflow files" | Current workflows are `ci.yml`, `deploy-preprod.yml`, `deploy-prod.yml`. A root `github-workflows.yml` (+ `.backup`) still exists in the repo root as leftover artifacts — **not** active workflows (only files under `.github/workflows/` run). Consider removing them |
| "Add IP allow/deny for preprod instead of basic auth" | Follow-up; not confirmed done |

Treat `KNOWLEDGE_TRANSFER.md` as background context, and this runbook + the repository as
current truth.

---

**Related:** [`TECHNICAL_ARCHITECTURE.md`](TECHNICAL_ARCHITECTURE.md) ·
[`MANUAL_ACTIONS_CHECKLIST.md`](MANUAL_ACTIONS_CHECKLIST.md) ·
[`FAQ_TROUBLESHOOTING.md`](FAQ_TROUBLESHOOTING.md)

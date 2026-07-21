# AG Shop Pro - Complete Knowledge Transfer

## 1) Executive Summary

I migrated this project from a manual EC2-first workflow into a Git-backed workflow with automated preprod/prod deployment foundations.

What is now in place:
- GitHub repo with app code + infra templates.
- GitHub Actions deploy workflows for:
  - `staging` -> preprod (`preprod.agshopro.com`)
  - `main` -> production (`agshopro.com`) with environment approval + rollback step.
- EC2 release-based deployment model:
  - `/var/www/agshopro/current` -> symlink to immutable release folder.
  - shared env files in `/var/www/.../shared/.env`.
- Preprod domain/cert/basic-auth wired and API health confirmed.

---

## 2) Core Infrastructure Context

- App type: Node.js + Express API + static HTML frontend (no frontend build step).
- Runtime process manager: PM2.
- Reverse proxy + static hosting: Nginx.
- Database: AWS RDS PostgreSQL.
- Redis: local on EC2.
- EC2 host user access used in setup:
  - bootstrap/admin path: `ubuntu@<EC2_PUBLIC_IP>`
  - CI/CD deploy path: `deploy@<EC2_PUBLIC_IP>` (after setup).

Current domains:
- Prod: `agshopro.com`
- Preprod: `preprod.agshopro.com`

---

## 3) Repository Layout (Current)

- `.github/workflows/deploy-preprod.yml`
- `.github/workflows/deploy-prod.yml`
- `server-setup.sh`
- `infra/pm2/ecosystem.config.js`
- `infra/nginx/agshopro.conf`
- `api/` (server code, `.env.example`, package files)
- `public/` (static HTML/JS)

Notable file changes implemented:
- `api/server.js`
  - switched to `require("dotenv").config()`
  - wired `/api/health` route module
  - moved reset URL base to env (`RESET_BASE_URL`) instead of hardcoded prod URL.
- `api/src/routes/health.js`
  - standardized health response: `status`, `timestamp`, `uptime`.
- `api/package.json`
  - added starter scripts for `dev`, `lint`, `test:unit`, `test:integration`, `migrate:latest` (placeholder-safe).
- `api/.env.example`
  - sanitized to placeholders; removed real secrets.

---

## 4) SSH + SCP Paths Used

## Local paths used

- Repo path (Windows): `C:\Users\nzeme\repos\AG`
- Repo path (WSL mount): `/mnt/c/Users/nzeme/repos/AG`
- EC2 PEM key path (WSL): `~/Ag-Shop-Pro.pem`
- Alternate PEM path used in Windows shell sessions: `C:\Users\nzeme\Ag-Shop-Pro.pem`

## EC2 connection pattern

```bash
ssh -i ~/Ag-Shop-Pro.pem ubuntu@<EC2_PUBLIC_IP>
```

## SCP pattern used

```bash
scp -i ~/Ag-Shop-Pro.pem /mnt/c/Users/nzeme/repos/AG/server-setup.sh ubuntu@<EC2_PUBLIC_IP>:~/server-setup.sh
```

We also used SCP to pull existing assets/config from EC2 to local during bootstrap.

---

## 5) How We Bootstrapped Server Side

`server-setup.sh` was uploaded and executed on EC2 (sudo). It performs:
- Tool preflight checks (`nginx`, `pm2`, `node`, `npm`, `certbot`, `htpasswd`).
- Deploy user creation:
  - creates `deploy` account.
  - sets `/home/deploy/.ssh/authorized_keys`.
  - limited sudo permissions for nginx test/reload.
- Production release-structure migration:
  - from flat app dirs to release model.
  - creates baseline release from existing `/var/www/agshopro/{api,public}`.
  - moves `.env` into `/var/www/agshopro/shared/.env`.
- Preprod structure creation:
  - `/var/www/agshopro-preprod/{releases,shared,scripts}`.
  - initial preprod `.env` copied from prod and adjusted (`PORT=3001`, `NODE_ENV=staging`).
- Writes deployment scripts:
  - `/var/www/agshopro/scripts/deploy.sh`
  - `/var/www/agshopro/scripts/rollback.sh`
  - `/var/www/agshopro-preprod/scripts/deploy.sh`
- Writes PM2 ecosystem config on server.
- Creates/updates preprod Nginx site.
- Applies security hardening steps (SSH settings, UFW/fail2ban/logrotate).

Important Ubuntu compatibility note:
- Script originally used `systemctl reload sshd`.
- On Ubuntu, service is usually `ssh`.
- This required manual adjustment (`sudo systemctl reload ssh`) and script patch for future reliability.

---

## 6) GitHub Actions CI/CD Implementation

## Preprod workflow (`deploy-preprod.yml`)

Trigger:
- push to `staging`

Steps:
1. Checkout.
2. Generate release ID.
3. SCP full repo to `/tmp/agshopro-release-preprod` on EC2.
4. SSH execute `/var/www/agshopro-preprod/scripts/deploy.sh <release-id>`.
5. Healthcheck `https://preprod.agshopro.com/api/health`.
6. Emit failure annotation if any step fails.

## Prod workflow (`deploy-prod.yml`)

Trigger:
- push to `main`

Controls:
- GitHub `production` environment gate for approval.

Steps:
1. Checkout.
2. Generate release ID.
3. SCP to `/tmp/agshopro-release`.
4. SSH execute `/var/www/agshopro/scripts/deploy.sh <release-id>`.
5. Healthcheck prod endpoint.
6. On failure: run rollback script and emit failure annotation.

## Node runtime warning handling

Added to both workflows:

```yaml
env:
  FORCE_JAVASCRIPT_ACTIONS_TO_NODE24: true
```

This mitigates Node 20 deprecation warning impact for JavaScript actions.

---

## 7) Deploy Script Runtime Model (EC2)

Both deploy scripts use the same pattern:
- create release folder under `releases/<id>`.
- rsync from temp upload dir.
- symlink `shared/.env` into release `api/.env`.
- install API prod deps (`npm ci --omit=dev`).
- run migration script (`npm run migrate:latest`).
- atomically repoint `current` symlink.
- reload/start PM2 app.
- cleanup old releases (keep last N).

This gives immutable releases + rollback path.

---

## 8) Issues Encountered and Fixes Applied

## A) YAML workflow schema issue
- Error: "Incorrect type. Expected string."
- Fix: quote `run` command string with `::error::...` in workflow.

## B) GitHub Actions timeout on SCP
- Error: `dial tcp <host>:22: i/o timeout`.
- Cause: host/SG SSH exposure not reachable from GitHub runner.
- Fix: ensure `EC2_HOST` is public reachable target and inbound SSH rule allows GitHub runner connectivity (temporarily broad for verification).

## C) Preprod cert mismatch
- Error: curl SSL host mismatch for `preprod.agshopro.com`.
- Fix: deployed proper cert via certbot for preprod vhost.
- Verified SAN includes `DNS:preprod.agshopro.com`.

## D) Preprod 403 on homepage while API health worked
- API `/api/health` returned ok, but `/` returned 403.
- Cause: preprod Nginx expected `index.html`, but app entry is `login.html`.
- Fix:
  - set index to `login.html index.html`
  - set fallback to `/login.html`
  - patch applied in `server-setup.sh` for future generated vhost.

## E) Script dependency missing (`htpasswd`)
- Preflight failed initially.
- Fix: `sudo apt install -y apache2-utils`

---

## 9) Secrets and Access Configuration

GitHub repository secrets used/required:
- `EC2_HOST`
- `EC2_USER` (targeted as `deploy` for workflow path)
- `EC2_SSH_KEY` (private key matching `/home/deploy/.ssh/authorized_keys`)

Operational guidance:
- rotate any previously exposed credentials (DB/API/SMTP/JWT/etc).
- keep real env values only in server-side shared `.env`.
- do not commit real `.env` to Git.

---

## 10) PM2 State and Process Notes

Observed during migration:
- Existing prod app had historical PM2 process contexts.
- Root/user PM2 contexts can diverge (`/root/.pm2` vs `/home/deploy/.pm2`).
- Preprod app launch succeeded via deploy script fallback:
  - starts `ag-api-preprod` when reload target does not yet exist.

Recommendation:
- standardize PM2 execution user and service ownership to avoid split contexts.

---

## 11) Current Validation Status (Latest Known)

Preprod:
- TLS cert valid for `preprod.agshopro.com`.
- API health endpoint returns expected JSON (`status=ok`).
- deploy pipeline reached full server deployment successfully.
- homepage 403 issue identified and fixed at config/template level.

Prod:
- Live site serving.
- prod app/env alignment may still need final verification if DB auth errors recur.

---

## 12) Exact Command Snippets We Used Frequently

## SSH
```bash
ssh -i ~/Ag-Shop-Pro.pem ubuntu@<EC2_PUBLIC_IP>
```

## Upload setup script
```bash
scp -i ~/Ag-Shop-Pro.pem /mnt/c/Users/nzeme/repos/AG/server-setup.sh ubuntu@<EC2_PUBLIC_IP>:~/server-setup.sh
```

## Run setup script
```bash
ssh -i ~/Ag-Shop-Pro.pem ubuntu@<EC2_PUBLIC_IP>
chmod +x ~/server-setup.sh
sudo bash ~/server-setup.sh
```

## Non-interactive run
```bash
printf 'y\n' | sudo bash ~/server-setup.sh
```

## Preprod certificate check
```bash
echo | openssl s_client -connect preprod.agshopro.com:443 -servername preprod.agshopro.com 2>/dev/null | openssl x509 -noout -subject -issuer -ext subjectAltName
```

## Preprod health
```bash
curl https://preprod.agshopro.com/api/health
```

---

## 13) Remaining Follow-Ups / Hardening Tasks

1. Standardize and document PM2 owner/process bootstrap for prod + preprod.
2. Replace placeholder migration script with real migration tool.
3. Replace placeholder tests/lint scripts with real checks.
4. Remove/retire legacy duplicate workflow files (if still present).
5. Confirm prod healthcheck stability after env migration to shared model.
6. If preprod needs a gate, add IP allow/deny rules in Nginx instead of HTTP basic auth.
7. Patch `server-setup.sh` ssh service reload line (`ssh`, not `sshd`) if not already committed.

---

## 14) Quick "How To Recreate" (From Scratch)

1. Clone/pull repo on local.
2. Upload `server-setup.sh` to EC2 and run with sudo.
3. Configure `deploy` SSH authorized_keys.
4. Add GitHub secrets listed above.
5. Ensure DNS:
   - `preprod.agshopro.com` -> EC2 public IP
6. Ensure cert:
   - `sudo certbot --nginx -d preprod.agshopro.com`
7. Push to `staging` and monitor preprod workflow.
8. Validate preprod health + UI.
9. Push/merge to `main`, approve production environment deployment.

---

## 15) Ownership Notes for Next Engineer/Agent

- Treat this repository as source of truth for deployment logic.
- EC2 should only be mutated by scripted deploy/setup paths.
- If manual hotfixes are applied on EC2, backport immediately to Git.
- Keep credentials out of repo, keep env in `shared/.env`, and rotate leaked historical secrets.


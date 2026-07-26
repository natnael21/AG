#!/usr/bin/env bash
#
# Release-based deploy for both environments, run from the copy of the repo that
# the workflow has just uploaded — so this script, the nginx vhost and the PM2
# ecosystem all come from the commit being deployed.
#
# Usage:  deploy.sh <prod|preprod> <release-id>
#
# WHY THIS LIVES IN THE REPO
#
# It used to live only on the EC2 host, as /var/www/agshopro{,-preprod}/scripts/
# deploy.sh, and it never installed nginx configuration. Production drifted as a
# result: `infra/nginx/agshopro.conf` in Git said the document root was
# `current/public`, while the live vhost pointed at a pre-git static directory
# from months earlier. Nothing in CI could see or correct that, so merges to main
# deployed code that the web server never served, and every deploy reported
# success. Keeping the script here means a merge can fix host config the same way
# it fixes application code.
#
# Three failure modes from that incident are now hard errors:
#   1. nginx serving a different tree than the release -> sync_nginx()
#   2. another process holding the app port, leaving the new release
#      crash-looping while the old one answered -> verify_local()
#   3. `sudo nginx -t && sudo systemctl reload nginx` failing silently, because
#      POSIX exempts a non-final AND-OR operand from `set -e` -> those are now
#      separate statements.
#
set -euo pipefail

usage() {
  echo "Usage: $(basename "$0") <prod|preprod> <release-id>" >&2
  exit 64
}

ENVIRONMENT="${1:-}"
RELEASE_ID="${2:-}"
[ -n "$ENVIRONMENT" ] && [ -n "$RELEASE_ID" ] || usage

case "$ENVIRONMENT" in
  prod)
    APP_ROOT=/var/www/agshopro
    SOURCE_DIR=/tmp/agshopro-release
    PM2_APP=ag-api
    PM2_ENV=production
    APP_PORT=3000
    NGINX_SITE=agshopro
    NGINX_TEMPLATE=infra/nginx/agshopro.conf
    ;;
  preprod)
    APP_ROOT=/var/www/agshopro-preprod
    SOURCE_DIR=/tmp/agshopro-release-preprod
    PM2_APP=ag-api-preprod
    PM2_ENV=staging
    APP_PORT=3001
    NGINX_SITE=agshopro-preprod
    NGINX_TEMPLATE=infra/nginx/agshopro-preprod.conf
    ;;
  *) usage ;;
esac

RELEASES_DIR="$APP_ROOT/releases"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
SHARED_DIR="$APP_ROOT/shared"
CURRENT_LINK="$APP_ROOT/current"
KEEP_RELEASES=5

log() { echo "[deploy:$ENVIRONMENT] $*"; }
fatal() { echo "[deploy:$ENVIRONMENT] FATAL: $*" >&2; exit 1; }

# nginx is only reachable through sudo, and the deploy user is granted a narrow
# allowlist (see infra/sudoers/agshopro-deploy).
#
# The probe is deliberately `true` and not `nginx -t`. Both fail with status 1 --
# one because sudo refused, the other because the *currently installed* config is
# invalid -- so probing with `nginx -t` would report "sudo is unavailable" on a
# host whose vhost is merely broken, sending you to fix a sudoers rule that was
# never the problem. `true` cannot fail for any reason except sudo refusing.
can_sudo() { sudo -n /usr/bin/true >/dev/null 2>&1 || sudo -n /bin/true >/dev/null 2>&1; }

sync_nginx() {
  local tracked="$RELEASE_DIR/$NGINX_TEMPLATE"
  local installed="/etc/nginx/sites-available/$NGINX_SITE"

  if [ ! -f "$tracked" ]; then
    log "nginx: $NGINX_TEMPLATE is absent from this release; $ENVIRONMENT vhost is not version-controlled yet, leaving it untouched"
    return 0
  fi

  if [ -f "$installed" ] && cmp -s "$tracked" "$installed"; then
    log "nginx: installed vhost already matches the release"
    return 0
  fi

  log "nginx: installed vhost differs from the release - applying"

  if ! can_sudo; then
    fatal "nginx vhost drift detected but passwordless sudo is unavailable.
    Deploying code without being able to correct the vhost is what let
    production serve a stale directory for months, so this is fatal rather
    than a warning. Install infra/sudoers/agshopro-deploy from this release:
      sudo install -o root -g root -m 0440 \\
        $RELEASE_DIR/infra/sudoers/agshopro-deploy /etc/sudoers.d/agshopro-deploy
      sudo visudo -cf /etc/sudoers.d/agshopro-deploy"
  fi

  # Keep a restorable copy: an invalid vhost that survives a reload takes the
  # site down, and `nginx -t` is the only thing standing between us and that.
  if [ -f "$installed" ]; then
    sudo /usr/bin/cp "$installed" "${installed}.bak-${RELEASE_ID}"
    log "nginx: previous vhost saved to ${installed}.bak-${RELEASE_ID}"
  fi

  sudo /usr/bin/install -o root -g root -m 0644 "$tracked" "$installed"

  if ! sudo /usr/sbin/nginx -t; then
    if [ -f "${installed}.bak-${RELEASE_ID}" ]; then
      sudo /usr/bin/install -o root -g root -m 0644 "${installed}.bak-${RELEASE_ID}" "$installed"
      log "nginx: config test failed; previous vhost restored"
    fi
    fatal "the vhost in $NGINX_TEMPLATE does not pass 'nginx -t' on this host (check ssl_certificate paths)"
  fi

  sudo /usr/bin/systemctl reload nginx
  log "nginx: vhost installed and nginx reloaded"
}

# Prove THIS release answers on the app port before handing off to the
# workflow's external check. Previously a foreign process owned :3000 and the
# newly started app crash-looped 98 times while PM2 still reported "online" and
# the external healthcheck passed against the other application.
verify_local() {
  local body i
  for i in $(seq 1 15); do
    body="$(curl -sf --max-time 5 "http://127.0.0.1:$APP_PORT/api/health" 2>/dev/null || true)"
    case "$body" in
      *'"checks"'*) log "local health ok on :$APP_PORT"; return 0 ;;
      ?*) log "local health on :$APP_PORT answered, but not with this app's payload; retrying ($i/15)" ;;
      *) log "waiting for :$APP_PORT ($i/15)" ;;
    esac
    sleep 2
  done

  echo "--- pm2 status ---" >&2
  pm2 list >&2 || true
  echo "--- last 30 log lines ---" >&2
  pm2 logs "$PM2_APP" --lines 30 --nostream >&2 || true
  echo "--- who owns :$APP_PORT ---" >&2
  ss -ltnp 2>/dev/null | grep ":$APP_PORT" >&2 || true
  fatal "port $APP_PORT never served this release's /api/health.
    If the listener above belongs to another process, that process is shadowing
    this deploy and must be stopped."
}

log "starting release $RELEASE_ID"

[ -d "$SOURCE_DIR" ] || fatal "upload directory $SOURCE_DIR is missing - did the scp step run?"
[ -d "$SHARED_DIR" ] || fatal "$SHARED_DIR is missing - host is not provisioned for $ENVIRONMENT"

mkdir -p "$RELEASE_DIR"
rsync -a --delete --exclude='.git' --exclude='node_modules' --exclude='.env' \
  "$SOURCE_DIR/" "$RELEASE_DIR/"

ln -sfn "$SHARED_DIR/.env" "$RELEASE_DIR/api/.env"

log "installing production dependencies"
( cd "$RELEASE_DIR/api" && npm ci --omit=dev )

log "running migrations"
( cd "$RELEASE_DIR/api" && NODE_ENV=production npm run migrate:latest )

# Atomic: `mv -T` over a symlink replaces it in one rename(2), so no request
# ever observes a missing `current`.
ln -sfn "$RELEASE_DIR" "${CURRENT_LINK}.next"
mv -Tf "${CURRENT_LINK}.next" "$CURRENT_LINK"
log "current -> $RELEASE_DIR"

sync_nginx

log "reloading $PM2_APP"
if pm2 describe "$PM2_APP" >/dev/null 2>&1; then
  pm2 reload "$PM2_APP" --update-env
else
  pm2 start "$CURRENT_LINK/infra/pm2/ecosystem.config.js" --only "$PM2_APP" --env "$PM2_ENV"
fi
pm2 save

verify_local

# Without a systemd hook, PM2's saved process list is never resurrected and a
# reboot leaves nothing listening. Not fatal - it does not affect this release -
# but it must not stay invisible.
if ! systemctl is-enabled "pm2-$(id -un)" >/dev/null 2>&1; then
  log "WARNING: systemd unit pm2-$(id -un) is not enabled, so this host will NOT"
  log "WARNING: restart the app after a reboot. Fix with: pm2 startup"
fi

log "pruning old releases (keeping $KEEP_RELEASES)"
ls -dt "$RELEASES_DIR"/*/ 2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf

log "complete: $RELEASE_ID"

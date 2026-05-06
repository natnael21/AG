#!/usr/bin/env bash
# =============================================================================
# AG Shop Pro — Server Setup Script
# Run as: ubuntu user on EC2
# Purpose: Set up preprod environment, deploy user, release structure,
#          Nginx preprod vhost, PM2 preprod process, and deploy scripts.
# =============================================================================
set -euo pipefail

# ─────────────────────────────────────────────
# CONFIGURATION — edit these before running
# ─────────────────────────────────────────────
PROD_DOMAIN="agshopro.com"
PREPROD_DOMAIN="preprod.agshopro.com"
PREPROD_BASIC_AUTH_USER="teamuser"          # username for preprod password wall
PREPROD_BASIC_AUTH_PASS="changeme123"       # change this to something strong
DEPLOY_USER="deploy"
APP_ROOT_PROD="/var/www/agshopro"
APP_ROOT_PREPROD="/var/www/agshopro-preprod"
PROD_PORT=3000
PREPROD_PORT=3001
KEEP_RELEASES=5

# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info()    { echo -e "${GREEN}[INFO]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }
section() { echo -e "\n${GREEN}══════════════════════════════════════${NC}"; \
            echo -e "${GREEN}  $*${NC}"; \
            echo -e "${GREEN}══════════════════════════════════════${NC}"; }

require_root() {
  if [[ $EUID -ne 0 ]]; then
    error "This script must be run with sudo. Use: sudo bash server-setup.sh"
  fi
}

# ─────────────────────────────────────────────
# 0. PREFLIGHT CHECKS
# ─────────────────────────────────────────────
section "0. Preflight Checks"

require_root

info "Checking required tools are installed..."
for cmd in nginx pm2 node npm certbot htpasswd; do
  if ! command -v "$cmd" &>/dev/null; then
    error "'$cmd' is not installed. Install it before running this script."
  fi
  info "  ✓ $cmd found"
done

info "Checking existing prod structure..."
if [[ ! -d "$APP_ROOT_PROD" ]]; then
  error "Prod app root $APP_ROOT_PROD does not exist. Is this the right server?"
fi
info "  ✓ Prod directory exists"

info "Checking prod API is reachable on port $PROD_PORT..."
if curl -sf "http://localhost:$PROD_PORT/api/health" > /dev/null; then
  info "  ✓ Prod API is healthy"
else
  warn "  ! Prod API health check failed. Proceeding anyway — prod will not be touched."
fi

echo ""
info "Configuration summary:"
echo "  Prod domain:       $PROD_DOMAIN"
echo "  Preprod domain:    $PREPROD_DOMAIN"
echo "  Deploy user:       $DEPLOY_USER"
echo "  Prod root:         $APP_ROOT_PROD"
echo "  Preprod root:      $APP_ROOT_PREPROD"
echo "  Prod port:         $PROD_PORT"
echo "  Preprod port:      $PREPROD_PORT"
echo ""
read -rp "$(echo -e "${YELLOW}Proceed with setup? [y/N]:${NC} ")" confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { info "Aborted."; exit 0; }

# ─────────────────────────────────────────────
# 1. CREATE DEPLOY USER
# ─────────────────────────────────────────────
section "1. Creating deploy user"

if id "$DEPLOY_USER" &>/dev/null; then
  info "Deploy user '$DEPLOY_USER' already exists — skipping creation."
else
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
  info "Created user: $DEPLOY_USER"
fi

# Add to www-data group for web directory access
usermod -aG www-data "$DEPLOY_USER"
info "Added $DEPLOY_USER to www-data group"

# Set up SSH directory for deploy user
DEPLOY_HOME=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)
mkdir -p "$DEPLOY_HOME/.ssh"
chmod 700 "$DEPLOY_HOME/.ssh"
touch "$DEPLOY_HOME/.ssh/authorized_keys"
chmod 600 "$DEPLOY_HOME/.ssh/authorized_keys"
chown -R "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_HOME/.ssh"

info "SSH directory ready at $DEPLOY_HOME/.ssh"
warn "  → You must manually add your GitHub Actions public key to:"
warn "    $DEPLOY_HOME/.ssh/authorized_keys"
warn "    (instructions in the 'After Running' section of the guide)"

# ─────────────────────────────────────────────
# 2. SUDO PERMISSIONS FOR DEPLOY USER
# ─────────────────────────────────────────────
section "2. Configuring sudo permissions"

SUDOERS_FILE="/etc/sudoers.d/deploy"
cat > "$SUDOERS_FILE" << EOF
# Allow deploy user to reload nginx only — nothing else
$DEPLOY_USER ALL=(ALL) NOPASSWD: /usr/bin/nginx -t, /bin/systemctl reload nginx, /usr/bin/systemctl reload nginx
EOF
chmod 440 "$SUDOERS_FILE"
info "Sudoers entry written: $SUDOERS_FILE"

# ─────────────────────────────────────────────
# 3. MIGRATE PROD TO RELEASE STRUCTURE
# ─────────────────────────────────────────────
section "3. Setting up prod release directory structure"

# Only migrate if prod is still using old flat structure
if [[ ! -L "$APP_ROOT_PROD/current" ]]; then
  info "Prod is using flat structure — migrating to release model..."

  RELEASE_ID="$(date +%Y%m%d_%H%M%S)_baseline"
  RELEASES_DIR="$APP_ROOT_PROD/releases"
  RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
  SHARED_DIR="$APP_ROOT_PROD/shared"

  mkdir -p "$RELEASES_DIR"
  mkdir -p "$SHARED_DIR/logs"

  # Move existing api and public into first release
  mkdir -p "$RELEASE_DIR"
  if [[ -d "$APP_ROOT_PROD/api" ]]; then
    cp -a "$APP_ROOT_PROD/api" "$RELEASE_DIR/api"
    info "  Copied api/ into release"
  fi
  if [[ -d "$APP_ROOT_PROD/public" ]]; then
    cp -a "$APP_ROOT_PROD/public" "$RELEASE_DIR/public"
    info "  Copied public/ into release"
  fi

  # Move .env to shared
  if [[ -f "$APP_ROOT_PROD/api/.env" ]]; then
    cp "$APP_ROOT_PROD/api/.env" "$SHARED_DIR/.env"
    chmod 600 "$SHARED_DIR/.env"
    info "  Moved .env to shared/"
  fi

  # Symlink shared .env into release
  ln -sfn "$SHARED_DIR/.env" "$RELEASE_DIR/api/.env"

  # Create current symlink
  ln -sfn "$RELEASE_DIR" "$APP_ROOT_PROD/current"
  info "  Created symlink: $APP_ROOT_PROD/current → $RELEASE_DIR"

  # Set ownership
  chown -R "$DEPLOY_USER:www-data" "$APP_ROOT_PROD/releases"
  chown -R "$DEPLOY_USER:www-data" "$APP_ROOT_PROD/shared"
  chmod -R 755 "$APP_ROOT_PROD/releases"
  chmod 600 "$APP_ROOT_PROD/shared/.env"

  info "Prod release structure created. Baseline release: $RELEASE_ID"
else
  info "Prod already has release structure — skipping migration."
fi

# Create scripts directory in prod root
mkdir -p "$APP_ROOT_PROD/scripts"
chown -R "$DEPLOY_USER:www-data" "$APP_ROOT_PROD/scripts"

# ─────────────────────────────────────────────
# 4. SET UP PREPROD DIRECTORY STRUCTURE
# ─────────────────────────────────────────────
section "4. Setting up preprod directory structure"

mkdir -p "$APP_ROOT_PREPROD/releases"
mkdir -p "$APP_ROOT_PREPROD/shared/logs"
mkdir -p "$APP_ROOT_PREPROD/scripts"

# Copy prod .env as preprod baseline if preprod .env doesn't exist yet
if [[ ! -f "$APP_ROOT_PREPROD/shared/.env" ]]; then
  if [[ -f "$APP_ROOT_PROD/shared/.env" ]]; then
    cp "$APP_ROOT_PROD/shared/.env" "$APP_ROOT_PREPROD/shared/.env"
    # Override port and env for preprod
    sed -i "s/^PORT=.*/PORT=$PREPROD_PORT/" "$APP_ROOT_PREPROD/shared/.env"
    # Add NODE_ENV=staging if not present
    grep -q "^NODE_ENV=" "$APP_ROOT_PREPROD/shared/.env" \
      && sed -i "s/^NODE_ENV=.*/NODE_ENV=staging/" "$APP_ROOT_PREPROD/shared/.env" \
      || echo "NODE_ENV=staging" >> "$APP_ROOT_PREPROD/shared/.env"
    info "Preprod .env created from prod .env (port set to $PREPROD_PORT, NODE_ENV=staging)"
  else
    warn "No prod .env found. You must manually create $APP_ROOT_PREPROD/shared/.env before deploying preprod."
    touch "$APP_ROOT_PREPROD/shared/.env"
  fi
else
  info "Preprod .env already exists — not overwriting."
fi

chmod 600 "$APP_ROOT_PREPROD/shared/.env"
chown -R "$DEPLOY_USER:www-data" "$APP_ROOT_PREPROD"
chmod -R 755 "$APP_ROOT_PREPROD/releases"
chmod 600 "$APP_ROOT_PREPROD/shared/.env"

info "Preprod directory structure ready at $APP_ROOT_PREPROD"

# ─────────────────────────────────────────────
# 5. WRITE DEPLOY SCRIPTS
# ─────────────────────────────────────────────
section "5. Writing deploy and rollback scripts"

# ── 5a. Prod deploy script ──────────────────────────────────────────────────
cat > "$APP_ROOT_PROD/scripts/deploy.sh" << 'DEPLOY_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

RELEASE_ID="${1:?Usage: deploy.sh <release-id>}"
APP_ROOT="/var/www/agshopro"
RELEASES_DIR="$APP_ROOT/releases"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
SHARED_DIR="$APP_ROOT/shared"
CURRENT_LINK="$APP_ROOT/current"
KEEP_RELEASES=5
SOURCE_DIR="/tmp/agshopro-release"

echo "[deploy] Starting prod deploy: $RELEASE_ID"

mkdir -p "$RELEASE_DIR"
rsync -a --exclude='.git' --exclude='node_modules' --exclude='.env' \
  "$SOURCE_DIR/" "$RELEASE_DIR/"

# Link shared .env
ln -sfn "$SHARED_DIR/.env" "$RELEASE_DIR/api/.env"

# Install prod dependencies
cd "$RELEASE_DIR/api"
npm ci --omit=dev

# Run migrations
NODE_ENV=production npm run migrate:latest

# Atomic symlink switch
ln -sfn "$RELEASE_DIR" "${CURRENT_LINK}.next"
mv -Tf "${CURRENT_LINK}.next" "$CURRENT_LINK"

# Reload PM2
pm2 reload ag-api --update-env || pm2 start "$APP_ROOT/current/infra/pm2/ecosystem.config.js" --only ag-api --env production
pm2 save

# Reload Nginx
sudo nginx -t && sudo systemctl reload nginx

# Clean old releases
ls -dt "$RELEASES_DIR"/*/  2>/dev/null | tail -n +$((KEEP_RELEASES + 1)) | xargs -r rm -rf

echo "[deploy] Prod deploy complete: $RELEASE_ID"
DEPLOY_SCRIPT

# ── 5b. Preprod deploy script ───────────────────────────────────────────────
cat > "$APP_ROOT_PREPROD/scripts/deploy.sh" << 'PREPROD_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

RELEASE_ID="${1:?Usage: deploy.sh <release-id>}"
APP_ROOT="/var/www/agshopro-preprod"
RELEASES_DIR="$APP_ROOT/releases"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
SHARED_DIR="$APP_ROOT/shared"
CURRENT_LINK="$APP_ROOT/current"
KEEP_RELEASES=5
SOURCE_DIR="/tmp/agshopro-release-preprod"

echo "[deploy-preprod] Starting preprod deploy: $RELEASE_ID"

mkdir -p "$RELEASE_DIR"
rsync -a --exclude='.git' --exclude='node_modules' --exclude='.env' \
  "$SOURCE_DIR/" "$RELEASE_DIR/"

# Link shared .env
ln -sfn "$SHARED_DIR/.env" "$RELEASE_DIR/api/.env"

# Install prod dependencies
cd "$RELEASE_DIR/api"
npm ci --omit=dev

# Run migrations (against preprod/staging DB)
NODE_ENV=staging npm run migrate:latest

# Atomic symlink switch
ln -sfn "$RELEASE_DIR" "${CURRENT_LINK}.next"
mv -Tf "${CURRENT_LINK}.next" "$CURRENT_LINK"

# Reload PM2
pm2 reload ag-api-preprod --update-env \
  || pm2 start /var/www/agshopro-preprod/current/infra/pm2/ecosystem.config.js \
     --only ag-api-preprod --env staging
pm2 save

echo "[deploy-preprod] Preprod deploy complete: $RELEASE_ID"
PREPROD_SCRIPT

# ── 5c. Prod rollback script ────────────────────────────────────────────────
cat > "$APP_ROOT_PROD/scripts/rollback.sh" << 'ROLLBACK_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

APP_ROOT="/var/www/agshopro"
RELEASES_DIR="$APP_ROOT/releases"
CURRENT_LINK="$APP_ROOT/current"

CURRENT=$(readlink "$CURRENT_LINK")
PREVIOUS=$(ls -dt "$RELEASES_DIR"/*/ | grep -v "^${CURRENT}/$" | head -1 | sed 's|/$||')

if [[ -z "$PREVIOUS" ]]; then
  echo "[rollback] ERROR: No previous release found."
  exit 1
fi

echo "[rollback] Rolling back from: $CURRENT"
echo "[rollback] Rolling back to:   $PREVIOUS"

ln -sfn "$PREVIOUS" "${CURRENT_LINK}.rollback"
mv -Tf "${CURRENT_LINK}.rollback" "$CURRENT_LINK"

pm2 reload ag-api --update-env
pm2 save

echo "[rollback] Prod rollback complete."
ROLLBACK_SCRIPT

# ── 5d. Healthcheck script ──────────────────────────────────────────────────
cat > "$APP_ROOT_PROD/scripts/healthcheck.sh" << HEALTH_SCRIPT
#!/usr/bin/env bash
set -euo pipefail

PROD_URL="https://$PROD_DOMAIN/api/health"
PREPROD_URL="https://$PREPROD_DOMAIN/api/health"

check() {
  local label="\$1" url="\$2"
  local status
  status=\$(curl -sf -o /dev/null -w "%{http_code}" --max-time 10 "\$url" 2>/dev/null || echo "000")
  if [[ "\$status" == "200" ]]; then
    echo "  ✓ \$label: OK (\$status)"
  else
    echo "  ✗ \$label: FAILED (HTTP \$status)"
    return 1
  fi
}

echo "=== Healthcheck ==="
check "Prod"    "\$PROD_URL"    || FAIL=1
check "Preprod" "\$PREPROD_URL" || FAIL=1

[[ -z "\${FAIL:-}" ]] && echo "All healthy." || { echo "One or more checks failed."; exit 1; }
HEALTH_SCRIPT

# Set permissions on all scripts
chmod +x "$APP_ROOT_PROD/scripts/"*.sh
chmod +x "$APP_ROOT_PREPROD/scripts/"*.sh
chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_ROOT_PROD/scripts/"*.sh
chown "$DEPLOY_USER:$DEPLOY_USER" "$APP_ROOT_PREPROD/scripts/"*.sh

info "Deploy scripts written and marked executable"

# ─────────────────────────────────────────────
# 6. PM2 ECOSYSTEM CONFIG
# ─────────────────────────────────────────────
section "6. Writing PM2 ecosystem config"

# Write to a known location — your repo will also have this file
PM2_CONFIG_DIR="$APP_ROOT_PROD"
cat > "$PM2_CONFIG_DIR/ecosystem.config.js" << ECOSYSTEM
module.exports = {
  apps: [
    {
      name: 'ag-api',
      script: './api/server.js',
      cwd: '/var/www/agshopro/current',
      instances: 1,
      exec_mode: 'fork',
      env_production: {
        NODE_ENV: 'production',
        PORT: $PROD_PORT,
      },
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/var/www/agshopro/shared/logs/api-error.log',
      out_file:   '/var/www/agshopro/shared/logs/api-out.log',
      merge_logs: true,
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '10s',
    },
    {
      name: 'ag-api-preprod',
      script: './api/server.js',
      cwd: '/var/www/agshopro-preprod/current',
      instances: 1,
      exec_mode: 'fork',
      env_staging: {
        NODE_ENV: 'staging',
        PORT: $PREPROD_PORT,
      },
      max_memory_restart: '512M',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
      error_file: '/var/www/agshopro-preprod/shared/logs/api-error.log',
      out_file:   '/var/www/agshopro-preprod/shared/logs/api-out.log',
      merge_logs: true,
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '10s',
    }
  ]
};
ECOSYSTEM

chown "$DEPLOY_USER:$DEPLOY_USER" "$PM2_CONFIG_DIR/ecosystem.config.js"
info "PM2 ecosystem config written to $PM2_CONFIG_DIR/ecosystem.config.js"
warn "  → Copy this file into your repo at: infra/pm2/ecosystem.config.js"

# ─────────────────────────────────────────────
# 7. NGINX PREPROD VHOST
# ─────────────────────────────────────────────
section "7. Configuring Nginx preprod vhost"

# Set up basic auth
info "Setting up HTTP basic auth for preprod..."
apt-get install -y -q apache2-utils > /dev/null
htpasswd -bc /etc/nginx/.htpasswd "$PREPROD_BASIC_AUTH_USER" "$PREPROD_BASIC_AUTH_PASS"
chmod 640 /etc/nginx/.htpasswd
chown root:www-data /etc/nginx/.htpasswd
info "Basic auth created for user: $PREPROD_BASIC_AUTH_USER"

# Write preprod Nginx config (HTTP only — HTTPS added by certbot after DNS is live)
NGINX_PREPROD_CONF="/etc/nginx/sites-available/agshopro-preprod"
cat > "$NGINX_PREPROD_CONF" << NGINXCONF
# AG Shop Pro — Preprod
# HTTPS will be configured by certbot once DNS for $PREPROD_DOMAIN is active.

server {
    listen 80;
    server_name $PREPROD_DOMAIN;

    # Basic auth — keeps preprod private
    auth_basic "Preprod Access";
    auth_basic_user_file /etc/nginx/.htpasswd;

    # Static frontend (login.html is the real entry; no index.html in repo)
    root /var/www/agshopro-preprod/current/public;
    index login.html index.html;

    # Block sensitive files
    location ~ /\\.env         { deny all; return 404; }
    location ~ /\\.git         { deny all; return 404; }
    location ~ /node_modules   { deny all; return 404; }

    # API proxy
    location /api/ {
        proxy_pass         http://127.0.0.1:$PREPROD_PORT/api/;
        proxy_http_version 1.1;
        proxy_set_header   Host              \$host;
        proxy_set_header   X-Real-IP         \$remote_addr;
        proxy_set_header   X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header   X-Forwarded-Proto \$scheme;
        proxy_read_timeout 60s;
    }

    # Socket.IO proxy
    location /socket.io/ {
        proxy_pass         http://127.0.0.1:$PREPROD_PORT/socket.io/;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade    \$http_upgrade;
        proxy_set_header   Connection "upgrade";
        proxy_set_header   Host       \$host;
    }

    # Multi-page static site — fall back to login, not missing index.html
    location / {
        try_files \$uri \$uri/ /login.html;
    }
}
NGINXCONF

# Enable the site
ln -sfn "$NGINX_PREPROD_CONF" /etc/nginx/sites-enabled/agshopro-preprod

# Test config before reloading
if nginx -t 2>/dev/null; then
  systemctl reload nginx
  info "Nginx preprod vhost enabled and reloaded"
else
  error "Nginx config test failed. Check: sudo nginx -t"
fi

info "Preprod vhost written: $NGINX_PREPROD_CONF"
warn "  → HTTPS will be added by certbot AFTER DNS is pointed at this server."
warn "    Run after DNS propagates: sudo certbot --nginx -d $PREPROD_DOMAIN"

# ─────────────────────────────────────────────
# 8. SECURITY HARDENING
# ─────────────────────────────────────────────
section "8. Security hardening"

# Disable root SSH and password auth
info "Hardening SSH config..."
SSHD_CONFIG="/etc/ssh/sshd_config"
# Only patch if not already done
grep -q "^PermitRootLogin no" "$SSHD_CONFIG" \
  || sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin no/' "$SSHD_CONFIG"
grep -q "^PasswordAuthentication no" "$SSHD_CONFIG" \
  || sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "$SSHD_CONFIG"
systemctl reload sshd
info "  ✓ Root login disabled, password auth disabled"

# Unattended security upgrades
info "Enabling unattended security upgrades..."
apt-get install -y -q unattended-upgrades > /dev/null
dpkg-reconfigure -f noninteractive unattended-upgrades
info "  ✓ Unattended upgrades enabled"

# Fail2ban
info "Installing and enabling fail2ban..."
apt-get install -y -q fail2ban > /dev/null
systemctl enable fail2ban
systemctl start fail2ban
info "  ✓ fail2ban active"

# UFW firewall — only open needed ports
info "Configuring UFW firewall..."
ufw --force reset > /dev/null
ufw default deny incoming > /dev/null
ufw default allow outgoing > /dev/null
ufw allow 22/tcp   comment 'SSH'    > /dev/null
ufw allow 80/tcp   comment 'HTTP'   > /dev/null
ufw allow 443/tcp  comment 'HTTPS'  > /dev/null
ufw --force enable > /dev/null
info "  ✓ UFW enabled: ports 22, 80, 443 open"

# ─────────────────────────────────────────────
# 9. LOG ROTATION
# ─────────────────────────────────────────────
section "9. Configuring log rotation"

cat > /etc/logrotate.d/agshopro << LOGROTATE
/var/www/agshopro/shared/logs/*.log
/var/www/agshopro-preprod/shared/logs/*.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
    copytruncate
    su $DEPLOY_USER www-data
}
LOGROTATE

info "Log rotation configured (14-day retention)"

# ─────────────────────────────────────────────
# 10. PRINT SUMMARY AND NEXT STEPS
# ─────────────────────────────────────────────
section "✅ Setup Complete — Next Steps"

DEPLOY_HOME=$(getent passwd "$DEPLOY_USER" | cut -d: -f6)

echo ""
echo -e "${GREEN}Server setup finished successfully.${NC}"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  WHAT TO DO NOW (in order)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  1. ADD DEPLOY SSH KEY"
echo "     On your LOCAL machine, generate a key for GitHub Actions:"
echo "     $ ssh-keygen -t ed25519 -C 'github-actions-deploy' -f ~/.ssh/agshopro_deploy -N ''"
echo "     Then copy the PUBLIC key to the server:"
echo "     $ cat ~/.ssh/agshopro_deploy.pub"
echo "     Paste that output into: $DEPLOY_HOME/.ssh/authorized_keys"
echo "     (you can do this as ubuntu: sudo bash -c \"echo 'PASTE_KEY_HERE' >> $DEPLOY_HOME/.ssh/authorized_keys\")"
echo ""
echo "  2. ADD SECRETS TO GITHUB ACTIONS"
echo "     GitHub repo → Settings → Secrets and variables → Actions → New secret:"
echo "     EC2_HOST      → $(curl -sf http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo '<your EC2 public IP>')"
echo "     EC2_USER      → $DEPLOY_USER"
echo "     EC2_SSH_KEY   → (paste the PRIVATE key: cat ~/.ssh/agshopro_deploy)"
echo ""
echo "  3. POINT DNS FOR PREPROD"
echo "     Add an A record in your DNS provider:"
echo "     preprod.agshopro.com → $(curl -sf http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || echo '<EC2 public IP>')"
echo "     Wait for propagation (usually 5–30 min), then run:"
echo "     $ sudo certbot --nginx -d $PREPROD_DOMAIN"
echo ""
echo "  4. ADD GITHUB ACTIONS WORKFLOWS TO YOUR REPO"
echo "     Create .github/workflows/deploy-prod.yml    (triggers on push to main)"
echo "     Create .github/workflows/deploy-preprod.yml (triggers on push to staging)"
echo "     (templates are in the companion guide)"
echo ""
echo "  5. COPY ecosystem.config.js INTO YOUR REPO"
echo "     cp $APP_ROOT_PROD/ecosystem.config.js <your-local-repo>/infra/pm2/ecosystem.config.js"
echo ""
echo "  6. VERIFY PROD IS STILL HEALTHY"
echo "     $ curl https://$PROD_DOMAIN/api/health"
echo ""
echo "  7. CHANGE PREPROD BASIC AUTH PASSWORD (if you used the default)"
echo "     $ sudo htpasswd /etc/nginx/.htpasswd $PREPROD_BASIC_AUTH_USER"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  DIRECTORY LAYOUT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  $APP_ROOT_PROD/"
echo "  ├── current          → releases/<latest>   (symlink)"
echo "  ├── releases/        (immutable release dirs)"
echo "  ├── shared/"
echo "  │   ├── .env         (prod secrets — never in Git)"
echo "  │   └── logs/"
echo "  ├── scripts/"
echo "  │   ├── deploy.sh"
echo "  │   ├── rollback.sh"
echo "  │   └── healthcheck.sh"
echo "  └── ecosystem.config.js"
echo ""
echo "  $APP_ROOT_PREPROD/"
echo "  ├── current          → releases/<latest>   (symlink, empty until first deploy)"
echo "  ├── releases/"
echo "  ├── shared/"
echo "  │   ├── .env         (preprod secrets)"
echo "  │   └── logs/"
echo "  └── scripts/"
echo "      └── deploy.sh"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${YELLOW}  ⚠  Prod was NOT restarted. It is still running as-is.${NC}"
echo -e "${YELLOW}     The new release structure takes effect on next deploy.${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

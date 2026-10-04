#!/bin/bash
# Installs or updates thinker-server on the instance. Run at first boot by the stack's user data
# and again by `deploy.mjs` (through Systems Manager) for each new release. Idempotent.
#   /etc/thinker-sync/deploy.env   REGION, BUCKET, SECRET_ARN, HOSTNAME (written by user data)
#   /etc/thinker-sync/env          the server's secrets, from Secrets Manager
#   /opt/thinker-sync/releases/*   unpacked releases; `current` points at the one that runs
#   /var/lib/thinker-sync          the server's data (repositories, notes, sessions, tokens)
set -euo pipefail
. /etc/thinker-sync/deploy.env
export AWS_DEFAULT_REGION="$REGION"
log() { echo "$(date -u +%FT%TZ) $*"; }

log "packages"
dnf install -y -q nodejs22 git tar gzip >/dev/null
dnf install -y -q nodejs22-npm >/dev/null 2>&1 || true
command -v npm >/dev/null || { echo 'npm missing'; exit 1; }
if ! command -v caddy >/dev/null; then
  if ! dnf install -y -q caddy >/dev/null 2>&1; then
    arch=$(uname -m); case "$arch" in aarch64) carch=arm64 ;; x86_64) carch=amd64 ;; *) echo "unsupported arch $arch"; exit 1 ;; esac
    curl -fsSL "https://caddyserver.com/api/download?os=linux&arch=${carch}" -o /usr/bin/caddy && chmod 755 /usr/bin/caddy
    getent group caddy >/dev/null || groupadd --system caddy
    id caddy >/dev/null 2>&1 || useradd --system --gid caddy --home-dir /var/lib/caddy --create-home --shell /usr/sbin/nologin caddy
    mkdir -p /etc/caddy
    cat > /etc/systemd/system/caddy.service <<'UNIT'
[Unit]
Description=Caddy
After=network.target network-online.target
Requires=network-online.target
[Service]
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
[Install]
WantedBy=multi-user.target
UNIT
  fi
fi
id thinker >/dev/null 2>&1 || useradd --system --home-dir /var/lib/thinker-sync --create-home --shell /usr/sbin/nologin thinker
mkdir -p /var/lib/thinker-sync /opt/thinker-sync/releases
chown thinker:thinker /var/lib/thinker-sync

log "release"
key=$(aws s3 cp "s3://${BUCKET}/deployments/sync/current" - | tr -d '[:space:]')
[ -n "$key" ] || { echo "no current release in s3://${BUCKET}/deployments/sync/current"; exit 1; }
name=$(basename "$key" .tgz)
release="/opt/thinker-sync/releases/${name}"
if [ ! -f "${release}/.ready" ]; then
  rm -rf "$release"; mkdir -p "$release"
  aws s3 cp "s3://${BUCKET}/${key}" "/tmp/${name}.tgz"
  tar -xzf "/tmp/${name}.tgz" -C "$release"; rm -f "/tmp/${name}.tgz"
  (cd "$release" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null && npm install --no-save --ignore-scripts --no-audit --no-fund @anthropic-ai/sdk >/dev/null)
  touch "${release}/.ready"
fi
ln -sfn "$release" /opt/thinker-sync/current
# releases older than the three most recent go
ls -1dt /opt/thinker-sync/releases/*/ 2>/dev/null | tail -n +4 | xargs -r rm -rf

log "secrets"
secret=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ARN" --query SecretString --output text)
node -e '
const s = JSON.parse(process.argv[1]);
const lines = [`THINKER_SERVER_ADMIN_TOKEN=${s.adminToken || ""}`, `ANTHROPIC_API_KEY=${s.anthropicApiKey || ""}`, `THINKER_SERVER_GIT_TOKEN=${s.gitToken || ""}`, `THINKER_SERVER_GITHUB_TOKEN=${s.githubToken || ""}`];
if (s.dailyTokens) lines.push(`THINKER_SERVER_DAILY_TOKENS=${s.dailyTokens}`);
require("fs").writeFileSync("/etc/thinker-sync/env", lines.join("\n") + "\n", { mode: 0o600 });
' "$secret"
chown root:thinker /etc/thinker-sync/env; chmod 640 /etc/thinker-sync/env

log "services"
cat > /etc/systemd/system/thinker-sync.service <<UNIT
[Unit]
Description=thinker-server (team cache)
After=network-online.target
Wants=network-online.target
[Service]
User=thinker
Group=thinker
EnvironmentFile=/etc/thinker-sync/env
Environment=THINKER_SERVER_DATA=/var/lib/thinker-sync THINKER_LOG=local THINKER_TELEMETRY=off THINKER_HOME=/var/lib/thinker-sync/.thinker HOME=/var/lib/thinker-sync NODE_ENV=production
ExecStart=/usr/bin/node /opt/thinker-sync/current/src/server/cli.js start --host 127.0.0.1 --port 8787
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/thinker-sync
PrivateTmp=true
[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/caddy/Caddyfile <<CADDY
${HOSTNAME} {
	encode gzip
	reverse_proxy 127.0.0.1:8787
	request_body {
		max_size 24MB
	}
}
CADDY
systemctl daemon-reload
systemctl enable --now caddy >/dev/null
systemctl reload caddy || systemctl restart caddy
systemctl enable thinker-sync >/dev/null
systemctl restart thinker-sync
sleep 2
systemctl is-active --quiet thinker-sync || { journalctl -u thinker-sync -n 30 --no-pager; exit 1; }
curl -fsS http://127.0.0.1:8787/health && echo
log "done: release ${name}"

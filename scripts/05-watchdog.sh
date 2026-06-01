#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
require_root
ensure_state_dirs

WATCH_SCRIPT=/usr/local/bin/radio-health-watchdog.sh
cat > "${WATCH_SCRIPT}" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="__SERVER_DIR__/.env"
LOG_FILE="/var/log/radio/watchdog.log"
PORT=8080
if [[ -f "${ENV_FILE}" ]]; then
  p="$(grep -E '^PORT=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- | tr -d '"' || true)"
  [[ -n "${p}" ]] && PORT="${p}"
fi
URL="http://127.0.0.1:${PORT}/health"
TS="$(date -Iseconds)"
HTTP_CODE="$(curl -sS -o /tmp/radio-health.json -w '%{http_code}' --connect-timeout 3 --max-time 8 "${URL}" 2>/dev/null || echo 000)"
OK=false
if [[ "${HTTP_CODE}" == "200" ]] && grep -q '"ok"[[:space:]]*:[[:space:]]*true' /tmp/radio-health.json 2>/dev/null; then
  OK=true
fi
if [[ "${OK}" == "true" ]]; then
  exit 0
fi
BODY="$(head -c 200 /tmp/radio-health.json 2>/dev/null || true)"
echo "${TS} health_fail code=${HTTP_CODE} body=${BODY}" >> "${LOG_FILE}"
systemctl restart radio-server.service
EOS
sed -i.bak "s|__SERVER_DIR__|${SERVER_DIR}|g" "${WATCH_SCRIPT}"
rm -f "${WATCH_SCRIPT}.bak"
chmod 755 "${WATCH_SCRIPT}"

cat > /etc/systemd/system/radio-watchdog.service <<EOF
[Unit]
Description=Radio server health watchdog
After=radio-server.service

[Service]
Type=oneshot
ExecStart=${WATCH_SCRIPT}
EOF

cat > /etc/systemd/system/radio-watchdog.timer <<'EOF'
[Unit]
Description=Poll Radio server /health every 30s

[Timer]
OnBootSec=45
OnUnitActiveSec=30
AccuracySec=5

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable radio-watchdog.timer
systemctl start radio-watchdog.timer
log "radio-watchdog.timer enabled (30s /health poll)."

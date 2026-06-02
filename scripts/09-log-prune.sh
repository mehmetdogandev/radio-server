#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
require_root
ensure_state_dirs

LOG_FILE="${LOG_DIR}/log.txt"
MAX_BYTES=$((1024 * 1024 * 1024)) # 1GB
PRUNE_PERCENT=2

mkdir -p "${LOG_DIR}"
touch "${LOG_FILE}"
chmod 644 "${LOG_FILE}"

PRUNE_SCRIPT=/usr/local/bin/radio-log-prune.sh
cat > "${PRUNE_SCRIPT}" <<'EOS'
#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="/var/log/radio/log.txt"
MAX_BYTES=$((1024 * 1024 * 1024))
PRUNE_PERCENT=2

[[ -f "${LOG_FILE}" ]] || exit 0

size="$(stat -c%s "${LOG_FILE}" 2>/dev/null || echo 0)"
if [[ "${size}" -lt "${MAX_BYTES}" ]]; then
  exit 0
fi

total_lines="$(wc -l < "${LOG_FILE}" | tr -d ' ')"
if [[ -z "${total_lines}" || "${total_lines}" -lt 1 ]]; then
  : > "${LOG_FILE}"
  exit 0
fi

prune_lines="$(( (total_lines * PRUNE_PERCENT + 99) / 100 ))"
if [[ "${prune_lines}" -lt 1 ]]; then
  prune_lines=1
fi
keep_lines="$(( total_lines - prune_lines ))"
if [[ "${keep_lines}" -lt 1 ]]; then
  : > "${LOG_FILE}"
  exit 0
fi

tmp="${LOG_FILE}.tmp.$$"
tail -n "${keep_lines}" "${LOG_FILE}" > "${tmp}"
mv "${tmp}" "${LOG_FILE}"
EOS
chmod 755 "${PRUNE_SCRIPT}"

SERVICE=/etc/systemd/system/radio-log-prune.service
cat > "${SERVICE}" <<EOF
[Unit]
Description=Prune AksiyonSoft Radio log.txt when oversized

[Service]
Type=oneshot
ExecStart=${PRUNE_SCRIPT}
EOF

TIMER=/etc/systemd/system/radio-log-prune.timer
cat > "${TIMER}" <<'EOF'
[Unit]
Description=Run radio log prune every 2 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
AccuracySec=10s

[Install]
WantedBy=timers.target
EOF

systemctl daemon-reload
systemctl enable radio-log-prune.timer
systemctl restart radio-log-prune.timer
log "radio-log-prune.timer enabled (2min, 1GB threshold, drop oldest 2% lines)."

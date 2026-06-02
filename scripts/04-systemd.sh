#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
require_root
ensure_state_dirs

TARGET_USER="$(resolve_target_user)"
TARGET_HOME="$(resolve_target_home "${TARGET_USER}")"

UNIT=/etc/systemd/system/radio-server.service
cat > "${UNIT}" <<EOF
[Unit]
Description=AksiyonSoft Radio Server
After=network-online.target avahi-daemon.service
Wants=network-online.target

[Service]
Type=simple
User=${TARGET_USER}
WorkingDirectory=${SERVER_DIR}
EnvironmentFile=${SERVER_DIR}/.env
ExecStart=/bin/bash -lc 'source "${TARGET_HOME}/.nvm/nvm.sh" && cd "${SERVER_DIR}" && exec node dist/index.js'
Restart=on-failure
RestartSec=5
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
StandardOutput=append:${LOG_DIR}/server.log
StandardError=append:${LOG_DIR}/server.err.log

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable radio-server.service
systemctl restart radio-server.service
log "radio-server.service enabled and started."

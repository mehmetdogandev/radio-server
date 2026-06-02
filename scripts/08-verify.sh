#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
require_root

TARGET_USER="$(resolve_target_user)"
TARGET_HOME="$(resolve_target_home "${TARGET_USER}")"
PORT="$(read_env_var PORT || echo 8080)"
VOICE_RTP_PORT="$(read_env_var VOICE_RTP_PORT || echo 5004)"
MODE="${RADIO_SETUP_MODE:-prod}"

log "Verifying runtime versions for ${TARGET_USER}..."
run_as_target_user "${TARGET_USER}" env HOME="${TARGET_HOME}" bash -lc '
set -euo pipefail
export NVM_DIR="$HOME/.nvm"
. "$NVM_DIR/nvm.sh"
node -v
npm -v
pnpm -v
'

[[ -f "${SERVER_DIR}/dist/index.js" ]] || fail "dist/index.js missing; build failed."

log "Checking service status..."
if [[ "${MODE}" == "prod" ]]; then
  systemctl is-active --quiet radio-server.service || fail "radio-server.service is not active."
  systemctl is-active --quiet radio-watchdog.timer || fail "radio-watchdog.timer is not active."
else
  warn "Skipping systemd checks in mode=${MODE}."
fi

log "Checking health endpoint..."
curl -sf "http://127.0.0.1:${PORT}/health" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' \
  || fail "/health did not return ok=true on port ${PORT}."

log "Checking status endpoint..."
curl -sf "http://127.0.0.1:${PORT}/status" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' \
  || fail "/status did not return ok=true on port ${PORT}."

log "Checking UDP RTP listen port..."
ss -lun | grep -Eq ":${VOICE_RTP_PORT}[[:space:]]" \
  || fail "UDP RTP port ${VOICE_RTP_PORT} is not listening."

if [[ "${MODE}" == "prod" ]] && systemctl is-active --quiet avahi-daemon; then
  log "Checking mDNS publication..."
  avahi-browse -a -t 2>/dev/null | grep -q "_radio._tcp" \
    || warn "mDNS _radio._tcp service not found in avahi browse output."
else
  warn "Skipping mDNS verify in mode=${MODE} (or avahi inactive)."
fi

log "Verification checks passed."

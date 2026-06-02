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
LOG_FILE="${LOG_DIR}/log.txt"

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
systemctl is-active --quiet radio-server.service || fail "radio-server.service is not active."
systemctl is-active --quiet radio-watchdog.timer || fail "radio-watchdog.timer is not active."
systemctl is-active --quiet radio-log-prune.timer || fail "radio-log-prune.timer is not active."

log "Checking health endpoint..."
curl -sf "http://127.0.0.1:${PORT}/health" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' \
  || fail "/health did not return ok=true on port ${PORT}."

log "Checking status endpoint..."
curl -sf "http://127.0.0.1:${PORT}/status" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' \
  || fail "/status did not return ok=true on port ${PORT}."

log "Checking UDP RTP listen port..."
ss -lun | grep -Eq ":${VOICE_RTP_PORT}[[:space:]]" \
  || fail "UDP RTP port ${VOICE_RTP_PORT} is not listening."

log "Checking log file and prune configuration..."
[[ -f "${LOG_FILE}" ]] || fail "Log file missing: ${LOG_FILE}"
[[ -w "${LOG_FILE}" ]] || fail "Log file is not writable: ${LOG_FILE}"
[[ -x "/usr/local/bin/radio-log-prune.sh" ]] || fail "Prune script not executable: /usr/local/bin/radio-log-prune.sh"
[[ -f "/etc/systemd/system/radio-log-prune.service" ]] || fail "Missing systemd unit: radio-log-prune.service"
[[ -f "/etc/systemd/system/radio-log-prune.timer" ]] || fail "Missing systemd unit: radio-log-prune.timer"

if systemctl is-active --quiet avahi-daemon; then
  log "Checking mDNS publication..."
  avahi-browse -a -t 2>/dev/null | grep -q "_radio._tcp" \
    || warn "mDNS _radio._tcp service not found in avahi browse output."
else
  warn "avahi-daemon not active; skipping mDNS verify."
fi

log "Verification checks passed."

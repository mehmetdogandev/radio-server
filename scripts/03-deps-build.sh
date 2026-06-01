#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

TARGET_USER="${SUDO_USER:-${USER}}"
if [[ "${EUID}" -eq 0 && -n "${SUDO_USER:-}" ]]; then
  log "Installing server dependencies as ${TARGET_USER}..."
  sudo -u "${TARGET_USER}" bash <<EOS
set -euo pipefail
cd "${SERVER_DIR}"
export NVM_DIR="\${HOME}/.nvm"
# shellcheck source=/dev/null
. "\${NVM_DIR}/nvm.sh"
npm ci
npm run build
EOS
else
  cd "${SERVER_DIR}"
  load_nvm 2>/dev/null || true
  npm ci
  npm run build
fi

node "${SCRIPT_DIR}/verify-server-rtp-dist.cjs"
log "Server build OK."

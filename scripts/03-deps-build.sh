#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

TARGET_USER="$(resolve_target_user)"
TARGET_HOME="$(resolve_target_home "${TARGET_USER}")"
if [[ "${EUID}" -eq 0 && "${TARGET_USER}" != "root" ]]; then
  log "Installing server dependencies as ${TARGET_USER}..."
  run_as_target_user "${TARGET_USER}" env HOME="${TARGET_HOME}" bash <<EOS
set -euo pipefail
cd "${SERVER_DIR}"
export NVM_DIR="\${HOME}/.nvm"
# shellcheck source=/dev/null
. "\${NVM_DIR}/nvm.sh"
npm ci
npm run build
node "${SCRIPT_DIR}/verify-server-rtp-dist.cjs"
EOS
else
  cd "${SERVER_DIR}"
  load_nvm
  npm ci
  npm run build
  node "${SCRIPT_DIR}/verify-server-rtp-dist.cjs"
fi

log "Server build OK."

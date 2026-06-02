#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
require_root

log "Removing apt nodejs/npm if present (nvm will own Node)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
if dpkg -l nodejs 2>/dev/null | grep -q '^ii'; then
  apt-get remove -y nodejs npm || true
fi
apt-get install -y curl ca-certificates build-essential python3

TARGET_USER="$(resolve_target_user)"
TARGET_HOME="$(resolve_target_home "${TARGET_USER}")"
export NVM_DIR="${TARGET_HOME}/.nvm"

if [[ ! -s "${NVM_DIR}/nvm.sh" ]]; then
  log "Installing nvm v0.40.4 for ${TARGET_USER}..."
  run_as_target_user "${TARGET_USER}" env HOME="${TARGET_HOME}" bash -lc \
    'cd "$HOME" && curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh | bash'
fi

run_as_target_user "${TARGET_USER}" env HOME="${TARGET_HOME}" TARGET_HOME="${TARGET_HOME}" SERVER_DIR="${SERVER_DIR}" bash <<'EOS'
set -euo pipefail
export NVM_DIR="${HOME}/.nvm"
# shellcheck source=/dev/null
. "${NVM_DIR}/nvm.sh"
cd "${TARGET_HOME}"
nvm install 24
nvm alias default 24
nvm use default
node -v
npm -v
corepack enable
corepack prepare pnpm@10.23.0 --activate
pnpm -v
EOS

NODE_PATH="$(run_as_target_user "${TARGET_USER}" env HOME="${TARGET_HOME}" bash -lc 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; command -v node')"
[[ -n "${NODE_PATH}" ]] || fail "Node binary could not be resolved for ${TARGET_USER}"
log "Node installed at: ${NODE_PATH}"

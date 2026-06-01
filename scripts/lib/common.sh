#!/usr/bin/env bash
# Shared helpers for Raspberry Pi setup (sourced, not executed directly).

set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$(cd "${SERVER_DIR}/.." && pwd)"
STATE_DIR="/var/lib/radio"
LOG_DIR="/var/log/radio"
MDNS_HOST_FILE="${STATE_DIR}/mdns-hostname"

log() { echo "[radio-setup] $*"; }
warn() { echo "[radio-setup] WARN: $*" >&2; }
fail() { echo "[radio-setup] ERROR: $*" >&2; exit 1; }

require_root() {
  if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
    fail "Run setup.sh with sudo (root required for systemd, avahi, apt)."
  fi
}

ensure_state_dirs() {
  mkdir -p "${STATE_DIR}" "${LOG_DIR}"
  chmod 755 "${STATE_DIR}" "${LOG_DIR}"
}

# Hostname: aksiyonsoft-radio-<6 hex> — no "raspberry" in name.
compute_mdns_hostname() {
  local id
  if [[ -f /etc/machine-id ]]; then
    id="$(head -c 6 /etc/machine-id | tr -d '\n')"
  else
    id="$(openssl rand -hex 3)"
  fi
  echo "aksiyonsoft-radio-${id}"
}

load_nvm() {
  export NVM_DIR="${NVM_DIR:-/root/.nvm}"
  if [[ -f "${NVM_DIR}/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    . "${NVM_DIR}/nvm.sh"
  elif [[ -f "/home/${SUDO_USER:-pi}/.nvm/nvm.sh" ]]; then
    NVM_DIR="/home/${SUDO_USER:-pi}/.nvm"
    # shellcheck source=/dev/null
    . "${NVM_DIR}/nvm.sh"
  else
    fail "nvm not found. Run 01-node.sh first."
  fi
}

node_bin_path() {
  load_nvm
  command -v node
}

read_env_var() {
  local key="$1" file="${SERVER_DIR}/.env"
  [[ -f "${file}" ]] || return 1
  grep -E "^${key}=" "${file}" | tail -n1 | cut -d= -f2- | tr -d '"' | tr -d "'"
}

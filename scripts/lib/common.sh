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

resolve_target_user() {
  if [[ -n "${RADIO_TARGET_USER:-}" ]]; then
    echo "${RADIO_TARGET_USER}"
    return
  fi
  if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    echo "${SUDO_USER}"
    return
  fi
  local guessed
  guessed="$(logname 2>/dev/null || true)"
  if [[ -n "${guessed}" && "${guessed}" != "root" ]]; then
    echo "${guessed}"
    return
  fi
  echo "root"
}

resolve_target_home() {
  local user="${1:-}"
  [[ -n "${user}" ]] || fail "resolve_target_home requires user"
  local home
  home="$(getent passwd "${user}" | cut -d: -f6 || true)"
  [[ -n "${home}" ]] || fail "Could not resolve home directory for user '${user}'"
  echo "${home}"
}

run_as_target_user() {
  local target_user="${1:-}"
  shift || true
  [[ -n "${target_user}" ]] || fail "run_as_target_user requires user"
  if [[ "${target_user}" == "root" ]]; then
    "$@"
  else
    sudo -u "${target_user}" "$@"
  fi
}

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
  local target_user target_home
  target_user="$(resolve_target_user)"
  target_home="$(resolve_target_home "${target_user}")"
  export NVM_DIR="${NVM_DIR:-${target_home}/.nvm}"
  if [[ -f "${NVM_DIR}/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    . "${NVM_DIR}/nvm.sh"
  else
    fail "nvm not found at ${NVM_DIR}. Run 01-node.sh first."
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

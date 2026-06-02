#!/usr/bin/env bash
# AksiyonSoft Radio — Raspberry Pi one-shot setup.
# Usage: cd server && sudo ./setup.sh [--skip-node]
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SERVER_DIR}"

# shellcheck source=scripts/lib/common.sh
source "${SERVER_DIR}/scripts/lib/common.sh"
require_root

SKIP_NODE=0
MODE="prod"
for arg in "$@"; do
  case "${arg}" in
    --skip-node) SKIP_NODE=1 ;;
    --mode=*) MODE="${arg#*=}" ;;
    -h|--help)
      echo "Usage: sudo ./setup.sh [--skip-node] [--mode=prod|dev|wsl]"
      exit 0
      ;;
  esac
done

SCRIPTS="${SERVER_DIR}/scripts"
if [[ ! -f /etc/os-release ]]; then
  fail "Unsupported OS: /etc/os-release missing."
fi
# shellcheck disable=SC1091
source /etc/os-release
if [[ "${ID:-}" != "debian" && "${ID:-}" != "ubuntu" && "${ID_LIKE:-}" != *"debian"* ]]; then
  fail "Unsupported OS '${ID:-unknown}'. Supported: Debian/Ubuntu, Raspberry Pi OS."
fi
TARGET_USER="$(resolve_target_user)"
TARGET_HOME="$(resolve_target_home "${TARGET_USER}")"
log "Install target user: ${TARGET_USER} (home: ${TARGET_HOME})"
log "Install mode: ${MODE}"

if [[ "${MODE}" != "prod" && "${MODE}" != "dev" && "${MODE}" != "wsl" ]]; then
  fail "Invalid mode '${MODE}'. Use --mode=prod|dev|wsl"
fi

if grep -qi microsoft /proc/version 2>/dev/null; then
  log "WSL environment detected."
fi

run() {
  echo ""
  echo "======== $(basename "$1") ========"
  bash "$1"
}

if [[ "${SKIP_NODE}" -eq 0 ]]; then
  run "${SCRIPTS}/01-node.sh"
fi
if [[ "${MODE}" != "wsl" ]]; then
  run "${SCRIPTS}/06-mdns.sh"
fi
run "${SCRIPTS}/02-env.sh"
run "${SCRIPTS}/03-deps-build.sh"
if [[ "${MODE}" == "prod" ]]; then
  run "${SCRIPTS}/04-systemd.sh"
  run "${SCRIPTS}/05-watchdog.sh"
  run "${SCRIPTS}/07-firewall.sh"
elif [[ "${MODE}" == "dev" ]]; then
  log "dev mode: skipping systemd/watchdog/firewall steps."
elif [[ "${MODE}" == "wsl" ]]; then
  log "wsl mode: skipping systemd/watchdog/mdns/firewall steps."
fi
export RADIO_SETUP_MODE="${MODE}"
run "${SCRIPTS}/08-verify.sh"

MDNS_HOST="$(tr -d '\n' < "${MDNS_HOST_FILE}" 2>/dev/null || compute_mdns_hostname)"
PORT="$(grep -E '^PORT=' "${SERVER_DIR}/.env" | tail -n1 | cut -d= -f2- || echo 8080)"
BASE="http://${MDNS_HOST}.local:${PORT}"
LOCAL_BASE="http://127.0.0.1:${PORT}"
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
LAN_BASE=""
if [[ -n "${LAN_IP}" ]]; then
  LAN_BASE="http://${LAN_IP}:${PORT}"
fi

echo ""
echo "=============================================="
echo " AksiyonSoft Radio — kurulum tamamlandı"
echo " Local:    ${LOCAL_BASE}"
echo " Health:   ${LOCAL_BASE}/health"
echo " Status:   ${LOCAL_BASE}/status"
if [[ -n "${LAN_BASE}" ]]; then
  echo " LAN:      ${LAN_BASE}"
  echo " Health:   ${LAN_BASE}/health"
  echo " Status:   ${LAN_BASE}/status"
fi
echo " mDNS:     ${BASE}"
echo " Health:   ${BASE}/health"
echo " Status:   ${BASE}/status"
echo " systemd:  systemctl status radio-server"
echo " Log:      tail -f /var/log/radio/server.log"
echo "=============================================="

sleep 2
if curl -sf "http://127.0.0.1:${PORT}/health" | grep -q '"ok"'; then
  echo "Health check: OK"
else
  echo "Health check: FAILED — see journalctl -u radio-server"
  exit 1
fi

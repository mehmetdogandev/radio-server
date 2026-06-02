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
for arg in "$@"; do
  case "${arg}" in
    --skip-node) SKIP_NODE=1 ;;
    --mode=*|--dev|--wsl)
      fail "Mode options were removed. setup.sh always runs in production mode."
      ;;
    -h|--help)
      echo "Usage: sudo ./setup.sh [--skip-node]"
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

run() {
  echo ""
  echo "======== $(basename "$1") ========"
  bash "$1"
}

if [[ "${SKIP_NODE}" -eq 0 ]]; then
  run "${SCRIPTS}/01-node.sh"
fi
run "${SCRIPTS}/06-mdns.sh"
run "${SCRIPTS}/02-env.sh"
run "${SCRIPTS}/03-deps-build.sh"
run "${SCRIPTS}/04-systemd.sh"
run "${SCRIPTS}/05-watchdog.sh"
run "${SCRIPTS}/07-firewall.sh"
run "${SCRIPTS}/09-log-prune.sh"
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
echo " Log:      tail -f /var/log/radio/log.txt"
echo "=============================================="

sleep 2
if curl -sf "http://127.0.0.1:${PORT}/health" | grep -q '"ok"'; then
  echo "Health check: OK"
else
  echo "Health check: FAILED — see journalctl -u radio-server"
  exit 1
fi

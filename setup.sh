#!/usr/bin/env bash
# AksiyonSoft Radio — Raspberry Pi one-shot setup.
# Usage: cd server && sudo ./setup.sh [--skip-node]
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SERVER_DIR}"

SKIP_NODE=0
for arg in "$@"; do
  case "${arg}" in
    --skip-node) SKIP_NODE=1 ;;
    -h|--help)
      echo "Usage: sudo ./setup.sh [--skip-node]"
      exit 0
      ;;
  esac
done

SCRIPTS="${SERVER_DIR}/scripts"
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

# shellcheck source=scripts/lib/common.sh
source "${SCRIPTS}/lib/common.sh"
MDNS_HOST="$(tr -d '\n' < "${MDNS_HOST_FILE}" 2>/dev/null || compute_mdns_hostname)"
PORT="$(grep -E '^PORT=' "${SERVER_DIR}/.env" | tail -n1 | cut -d= -f2- || echo 8080)"
BASE="http://${MDNS_HOST}.local:${PORT}"

echo ""
echo "=============================================="
echo " AksiyonSoft Radio — kurulum tamamlandı"
echo " mDNS URL: ${BASE}"
echo " Health:   ${BASE}/health"
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

#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
require_root

PORT=8080
RTP=5004
if [[ -f "${SERVER_DIR}/.env" ]]; then
  p="$(grep -E '^PORT=' "${SERVER_DIR}/.env" | tail -n1 | cut -d= -f2- || true)"
  r="$(grep -E '^VOICE_RTP_PORT=' "${SERVER_DIR}/.env" | tail -n1 | cut -d= -f2- || true)"
  [[ -n "${p}" ]] && PORT="${p}"
  [[ -n "${r}" ]] && RTP="${r}"
fi

if ! command -v ufw >/dev/null 2>&1; then
  warn "ufw not installed; skipping firewall rules."
  exit 0
fi

ufw allow "${PORT}/tcp" comment 'Radio HTTP/WS' || true
ufw allow "${RTP}/udp" comment 'Radio voice RTP' || true
ufw allow 5353/udp comment 'mDNS' || true
log "ufw rules added for TCP ${PORT}, UDP ${RTP}, mDNS 5353."

#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
require_root
ensure_state_dirs

log "Ensuring openssl CLI..."
export DEBIAN_FRONTEND=noninteractive
apt-get install -y openssl
apt-get install --reinstall -y openssl

ENV_FILE="${SERVER_DIR}/.env"
EXAMPLE="${SERVER_DIR}/.env.example"
if [[ ! -f "${ENV_FILE}" ]]; then
  cp "${EXAMPLE}" "${ENV_FILE}"
  log "Created ${ENV_FILE} from example."
fi

PORT="${PORT:-8080}"
if grep -qE '^PORT=' "${ENV_FILE}"; then
  PORT="$(grep -E '^PORT=' "${ENV_FILE}" | tail -n1 | cut -d= -f2-)"
fi

MDNS_HOST=""
if [[ -f "${MDNS_HOST_FILE}" ]]; then
  MDNS_HOST="$(tr -d '\n' < "${MDNS_HOST_FILE}")"
else
  MDNS_HOST="$(compute_mdns_hostname)"
  echo "${MDNS_HOST}" > "${MDNS_HOST_FILE}"
fi

upsert_env() {
  local key="$1" val="$2"
  local tmp="${ENV_FILE}.tmp.$$"
  grep -v -E "^${key}=" "${ENV_FILE}" > "${tmp}" 2>/dev/null || true
  printf '%s=%s\n' "${key}" "${val}" >> "${tmp}"
  mv "${tmp}" "${ENV_FILE}"
}

JWT_PLACEHOLDER='change-me-long-random-string-REPLACE-WITH-SECURE-VALUE'
CURRENT_JWT="$(grep -E '^JWT_SECRET=' "${ENV_FILE}" | tail -n1 | cut -d= -f2- || true)"
if [[ -z "${CURRENT_JWT}" || "${CURRENT_JWT}" == "${JWT_PLACEHOLDER}" || ${#CURRENT_JWT} -lt 32 ]]; then
  NEW_JWT="$(openssl rand -base64 48 | tr -d '\n')"
  upsert_env JWT_SECRET "${NEW_JWT}"
  log "Generated new JWT_SECRET (${#NEW_JWT} chars)."
else
  log "Keeping existing JWT_SECRET."
fi

upsert_env PORT "${PORT}"
upsert_env HTTP_LISTEN_HOST "0.0.0.0"
upsert_env VOICE_RTP_PORT "5004"
upsert_env DATABASE_PATH "./data/radio.db"
upsert_env MDNS_HOSTNAME "${MDNS_HOST}"
upsert_env CORS_ORIGINS "http://${MDNS_HOST}.local:${PORT}"
upsert_env NODE_ENV "production"
upsert_env MESSAGE_MAX_LENGTH "500"
upsert_env RATE_LIMIT_WINDOW_MS "60000"
upsert_env RATE_LIMIT_MAX_REQUESTS "100"

log "mDNS host: ${MDNS_HOST}.local  CORS: http://${MDNS_HOST}.local:${PORT}"

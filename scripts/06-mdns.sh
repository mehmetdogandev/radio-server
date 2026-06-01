#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"
require_root
ensure_state_dirs

export DEBIAN_FRONTEND=noninteractive
apt-get install -y avahi-daemon avahi-utils

MDNS_HOST="$(compute_mdns_hostname)"
if [[ -f "${MDNS_HOST_FILE}" ]]; then
  MDNS_HOST="$(tr -d '\n' < "${MDNS_HOST_FILE}")"
else
  echo "${MDNS_HOST}" > "${MDNS_HOST_FILE}"
fi

PORT=8080
if [[ -f "${SERVER_DIR}/.env" ]]; then
  p="$(grep -E '^PORT=' "${SERVER_DIR}/.env" | tail -n1 | cut -d= -f2- | tr -d '"' || true)"
  [[ -n "${p}" ]] && PORT="${p}"
fi

AVAHI_CONF=/etc/avahi/avahi-daemon.conf
if grep -qE '^#?host-name=' "${AVAHI_CONF}"; then
  sed -i.bak "s/^#\\?host-name=.*/host-name=${MDNS_HOST}/" "${AVAHI_CONF}"
else
  echo "host-name=${MDNS_HOST}" >> "${AVAHI_CONF}"
fi
rm -f "${AVAHI_CONF}.bak"

mkdir -p /etc/avahi/services
cat > /etc/avahi/services/aksiyonsoft-radio.service <<EOF
<?xml version="1.0" standalone='no'?>
<!DOCTYPE service-group SYSTEM "avahi-service.dtd">
<service-group>
  <name replace-wildcards="yes">AksiyonSoft Radio %h</name>
  <service>
    <type>_radio._tcp</type>
    <port>${PORT}</port>
    <txt-record>product=aksiyonsoft-radio</txt-record>
    <txt-record>version=1</txt-record>
  </service>
</service-group>
EOF

avahi-set-host-name "${MDNS_HOST}" 2>/dev/null || true
systemctl enable avahi-daemon
systemctl restart avahi-daemon

log "mDNS: ${MDNS_HOST}.local  service _radio._tcp port ${PORT}"

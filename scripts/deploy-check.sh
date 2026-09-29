#!/usr/bin/env bash
# Read-only audit of an existing deployment. Do not print .env or credentials.
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
test -x .venv/bin/python
test -f frontend/dist/index.html
PYTHONPATH=backend .venv/bin/python -c 'from app.config import get_settings; from acps_sdk.aip.aip_group_leader import GroupLeader; from acps_sdk.aip.aip_group_partner import GroupPartnerMqClient; s=get_settings(); print("MQ configured:", bool(s.aip_group_mq_host or s.aip_group_mq_url)); print("Partner enabled:", s.aip_group_partner_enabled); print("AIP TLS port:", s.aip_tls_port)'
for unit in aegismesh aegismesh-mtls aegismesh-fluentbit; do
    systemctl show "$unit" --property=ActiveState --property=WorkingDirectory
done
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8000/api/health
echo
PYTHONPATH=backend .venv/bin/python -m scripts.check_aip_tls
echo "This is a read-only check. Existing nginx, certificates, data and services were not replaced."

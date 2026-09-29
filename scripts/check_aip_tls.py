"""Read-only TLS preflight. Does not issue certificates or submit tasks."""
from __future__ import annotations

from app.config import get_settings
from app.services.certificates import CertificateError
from scripts.serve import listener_options


def main() -> None:
    settings = get_settings()
    ids = list(settings.aip_agent_public_urls) or [settings.aip_tls_agent_id]
    failures = 0
    for agent_id in ids:
        try:
            options = listener_options(settings.model_copy(update={"aip_tls_agent_id": agent_id}))
            print(f"{agent_id or 'default'}: validated serverAuth, AIC, hostname and chain (port {options['port']})")
        except CertificateError as exc:
            failures += 1
            print(f"{agent_id or 'default'}: NOT READY: {exc}")
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    main()

# Additive agents and role-only selection

The service catalog adds eight distinct capabilities: two coordinators and six executors.
Travel covers culture, dining and logistics; news covers retrieval, timelines and verification.
These are coverage areas, **not fixed teams, discovery filters or menu groups**. Coordinators
query official ADP and choose candidates by task fit, historical quality and availability.
Explicit user targets retain priority. Compatibility mode still uses official transport;
normal mode may use the existing local execution path.

The composer selector shows coordinators at the first level and one flat executor sub-menu.
Canvas retains its existing coordinator-only entry point; execution is delegated by routing.
Upload and selector controls share typography, pill radius and hover/focus treatment.

## Registration and rollout

1. `apply_service_catalog` adds missing records only. It never overwrites existing identities,
   approval IDs, model configuration, administrator edits or quality history. New records
   are local/internal until approval.
2. Assign each new hosted AIC a unique HTTPS authority in `AIP_AGENT_PUBLIC_URLS`. Test the
   public DNS and port before submitting. A certificate identifies an AIC during TLS,
   before the server sees the HTTP path, so paths alone cannot isolate identities.
3. Check that ACS includes the endpoint hostname in `certificate.altNames.dns` and declares
   mutual TLS. Configured new group-enabled agents declare `inbox_{AIC}` in their AMQPS URL;
   the registry replaces the literal placeholder when approving the record.
4. Run `PYTHONPATH=backend .venv/bin/python -m scripts.provision_service_agents` for a read-only
   preview, then explicitly use `--submit`. The script only allows these eight catalog IDs,
   recovers matching drafts by name plus endpoint/SAN, saves IDs before submission, and
   never updates, cancels or re-registers a pending/approved record.
   A matching DRAFT can be corrected in place before submission. Both JSONRPC and AMQP
   endpoints must reference `securitySchemes.mtls`; local validation checks both.
5. `--sync` reads approval status. `--certificates` syncs and issues missing clientAuth and
   serverAuth certificates, validating their AIC, chain, usage, key and DNS before activation.
   A pending review is not readiness and must not be reported as approval.
6. Start a dedicated `scripts.serve` process with `AIP_TLS_AGENT_ID=<id>` per new authority.
   TLS workers disable background seeding, probes, inbox consumers and periodic heartbeats;
   the primary API owns those jobs. Access reporting remains enabled in each worker.
7. Verify all TLS identities and hostnames, plus rejection of requests targeting another AIC
   or missing a client identity. Verify MQ listener readiness separately from HTTPS.

Keep previous API overrides, the database snapshot and the previous UI release for rollback.
Do not use `scripts/reapply_agents.py`: it recreates existing registry records and is unsuitable
when preserving approved identities and rankings. Never publish credentials in rollout output.

## Deployment — 2026-09-29

- API: `/home/zcode/aegismesh-release-service-agents-20260929`.
- UI release: `service-agents-default-20260929`; previous UI retained as
  `rollback-20260928-161923`, and the pre-catalog UI as `rollback-20260928-160849`.
  Normal chats still default to the discovery assistant; canvas defaults to the research
  coordinator. Adding a coordinator does not silently change these defaults.
- New registry submissions: **8 APPROVED**. All eight clientAuth and eight serverAuth
  certificates were issued by the official CA and validated for identity, chain, usage,
  private-key match and DNS SAN `aip.demmo.cc.cd`.
- Eight dedicated TLS services are installed, enabled and running on ports 8450–8457.
  Server-local tests use loopback connections with real hostname verification and the
  official CA: all eight AIC identities pass. Actual RPC commands without a client identity
  return 401, a mismatched sender returns 403, and a request for another listener's target
  returns 421. No business tasks or ranking-generating test calls were submitted.
- MQ listeners report `group_partner_ready` for all eight new agents and the four existing
  research agents (12 total), reconfirmed from the current API process's startup logs after
  the firewall change. MQ readiness is checked separately from public HTTPS readiness.
- **Public HTTPS blocker resolved after the user's firewall update.** All eight ports
  (8450–8457) now pass an external TLS 1.3 check with the official CA, hostname validation,
  exact expected AIC identity and HTTP 200 JSON-RPC ping response. Each agent's clientAuth
  certificate also completes a separate mTLS ping via the public hostname and port from
  the server; private keys never leave the server.
- Public authentication rejection checks still pass: no client certificate returns 401,
  a sender AIC differing from the presented certificate returns 403, and using another
  agent's path on the wrong TLS listener returns 421. API, legacy TLS and all eight new TLS
  workers are active with zero automatic restarts. These are connectivity/authentication
  checks, not a completed end-to-end business collaboration or evidence of ranking credit.
- Historical note: the initial TCP-connect-only probe did not prove traffic reached the VM;
  strict public TLS checks failed until the firewall update. Cloud firewall rules remain
  outside the VM account's inspection/change permissions. No AIC or certificate validation
  policy was changed to work around that limitation.
- Original research AICs/registration IDs were not changed or resubmitted. Their legacy
  8443 listener remains unchanged; this rollout does not claim to repair its missing SAN.
- Dedicated listener template: `/etc/systemd/system/aegismesh-aip-agent@.service`, with a
  copy in the release. The primary API's MQ/heartbeat workers were refreshed after checking
  for active tasks. Compatibility mode remains at its pre-rollout value (off); this release
  does not silently change the user's dispatch policy.
- Regression checks: 302 backend tests and 55 frontend tests pass; production build passes.
  Desktop and 390px mobile selector checks cover role-only hierarchy, keyboard navigation,
  bounds and matching upload/selector typography and interaction sizes.

| ID | Registration ID | Port |
| --- | --- | --- |
| travel_coordinator | 01a0e8c9-4664-7416-8500-34a7435e3803 | 8450 |
| heritage_guide | 01a0e8c9-4ad9-75d5-a5e9-0ea12ca10a8c | 8451 |
| food_guide | 01a0e8c9-5257-7739-a843-87f5251b273d | 8452 |
| travel_logistics | 01a0e8c9-5eaf-752a-8a39-e53e7c465ceb | 8453 |
| news_coordinator | 01a0e8c9-6673-719f-b124-b37f5753227c | 8454 |
| news_retrieval | 01a0e8c9-713d-710d-9d5a-650db11e9cfa | 8455 |
| news_timeline | 01a0e8c9-7b28-74a0-88ae-911fcd7ff273 | 8456 |
| news_verification | 01a0e8c9-88a3-7210-b51b-fbdc497a8ef6 | 8457 |

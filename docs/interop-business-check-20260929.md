# Official AIP business check — 2026-09-29

## Result

**Transport and completion confirmation passed; the Huawei research-report acceptance did not.**
The three executors all reported that their inbound AIP runtime lacked `web_search`.
Their actual tool traces contain only `current_time`; no retrieved sources were produced.
The final coordinator response correctly states that a reliable factual report cannot be delivered.

Session / audit trace: `official-huawei-d000867a24e8`.
The raw verification record is preserved at `/tmp/official-huawei-d000867a24e8.json`
on the deployment server and the local workstation.

## Scope and method

- The user authorized a real business test after the new public ports became reachable.
- The news coordinator produced three task definitions through official HTTPS AIP.
- A bounded verification script queried official ADP, joined existing local quality scores,
  selected distinct executors from this newly approved batch, and dispatched using
  `AipSdkTransport` with `interop_compatibility=True`. No local model execution shortcut
  or insecure certificate fallback was used by the caller.
- Broad ADP queries returned too few distinct candidates. A subsequent filtered ADP search
  used capability-name constraints (`时间线`, `检索`, `核验`); it did not substitute cached-only
  agents or bypass eligibility checks. The completed planning request was reused, not repeated.
- Caller certificates stayed on the server. Every network call checked the official CA,
  DNS hostname, expected callee AIC and authenticated sender, and required the AIP Complete
  handshake. The global compatibility policy remained **false** throughout.
- This was a script-driven workflow exercising ADP and real inbound AIP endpoints. It is
  **not** evidence that an inbound coordinator autonomously discovers and dispatches through
  the normal chat orchestrator. It also does not exercise MQ business delivery.

## Completed calls

| Phase | Target | AIP task ID |
| --- | --- | --- |
| Plan | news_coordinator | task-09f01bf9-c6e3-4ed4-8f25-24c352bd2190 |
| History / timeline | news_timeline | task-3423f083-9455-4acd-9c3b-2221e57bccec |
| Business / disclosures | news_retrieval | task-ae124c79-72f1-47c0-b149-96e9fa91dace |
| Source verification | news_verification | task-c1d2b8a5-8123-496f-8643-4a1f7af0ca6a |
| Synthesis | news_coordinator | task-536c473c-2345-4636-a023-744e9799d3e3 |

All five persisted HostedTask records reached `completed`. The bounded AMP audit lookup
found 15 Access events, all HTTP 200: per task, one caller-side record and two receiver-side
records (Start and Complete), joined by the real task ID and this session's trace ID.
These records establish local two-sided correspondence, **not official receipt or ranking credit**.

## Diagnosed gap (not changed by this test)

`HostedAipService._run` calls the provider runtime without a `tool_registry`. The provider
therefore constructs the base `ToolRegistry`, which has no `web_search` implementation.
The normal chat orchestrator adds provider-backed search in `_runtime_registry`, but the
inbound AIP path does not use it. Merely listing `web_search` in agent metadata does not
make the tool callable. AIP coordinators also do not receive the normal orchestrator's
discovery/delegation registry in this path.

Follow-up: align inbound AIP runtime/tool construction with the real chat execution path,
preserve caller identity, task isolation and transport policy, add regression coverage,
then rerun a source-producing task. Do not mark protocol completion as report-quality success.

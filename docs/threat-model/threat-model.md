# Threat model (summary)

Scope: multi-tenant authorization/approval SaaS — gateway API, console, Orbis iOS, SDKs. Status reflects this repository.

| Threat | Mitigation in this build | Test / evidence | Residual risk |
|---|---|---|---|
| Cross-tenant IDOR / broken object authorization | Tenant derived from credential; every lookup filtered by tenant; integrations can only read their own approvals | smoke test "other key reading approval → 404"; iOS `testTenantMismatchIsNotFound` | Single-tenant demo data; add multi-tenant fixtures when a second tenant exists |
| Stolen / overprivileged API key | Keys hashed at rest, scoped, revocable, prefix-only display, `last_used_at` tracking, revoke audited | Developer → API keys | No per-key rate limit yet (public protect endpoint is rate-limited) |
| Forged / replayed webhook | HMAC-SHA256 over `t.body`, 5-minute window, constant-time compare (TS + Python helpers) | `sdk.test.ts`, `test_sdk.py` webhook tests | Demo backend simulates delivery; no outbound calls |
| Replayed / stale approval response | One response per user, state + expiry checked on every response, 409/410 errors | `respond()` checks; iOS double-submit + expired tests | — |
| Approval race / double submit | Server state machine; client guards with explicit `State` | iOS `testDoubleSubmitIsIgnored` | Single process; a DB-backed build needs row locks/transactions |
| Compromised or removed approver | Device revocation ends sessions; step-up on iOS requires a registered, non-revoked device; quorum for extreme actions | Settings → devices; seeded revoked device | Biometric proof is a local signal, not server-verifiable attestation (App Attest is the next step) |
| Policy version confusion / TOCTOU | Every action records the exact policy versions evaluated; receipts include policy id + version | Receipt viewer, simulator | Approval resolves against the decision-time evaluation by design |
| Actor spoofing by an integration | Actors are caller-asserted; registry + per-integration actor list shown in console | Agents & Actors | Enforce actor ↔ integration binding at the gateway (follow-up) |
| Approval phishing / misleading summary | Titles derived from structured fields when absent; evidence carries source + confidence; policy reason is Orbis-authored | Approval card anatomy | Caller-supplied titles are still shown; consider server-rendered summaries only |
| Sensitive payload leakage (logs, push, analytics) | Envelopes are redacted summaries; push body = title + risk only; no payloads in logs | `NotificationService`, `present.ts` | Demo store persists envelopes to disk |
| Receipt tampering | Ed25519 over canonical JSON + SHA-256; revision chain; browser-side verification | Receipt viewer "tamper" demo, seed test verifies every receipt | Key in demo store; production needs KMS + rotation |
| Freeze bypass | Freeze checked first in `evaluate()`, before any policy; pending approvals cancelled | golden fixture "frozen actor is denied" | — |
| Privilege escalation in policy publish | `policy_admin` role + distinct second approver required | publish endpoint | — |
| SSRF via callback URLs | https only; localhost, `.local/.internal`, private/loopback/link-local IPs, credentials rejected | Developer → webhook tester | DNS rebinding needs resolve-time checks in a real sender |
| Malicious / oversized JSON | 64 KB body limit, schema validation with typed errors, field length caps | `http.ts` | — |
| Queue retry duplicates | Idempotent preflight + outcome endpoints | API smoke test | Real webhook retries need dedupe keys on the consumer side (header provided) |
| AI enrichment altering policy semantics | No model in the enforcement path; Protect models are advisory and explained | `policy-core` has no model calls | — |

## v2 — Endpoint intelligence threats (blueprint §23–24)

| Threat | Mitigation | Test |
|---|---|---|
| Forged / tampered model manifest | Ed25519 over exact payload bytes, pinned key id | `testTamperedPayloadIsRejected`, `testUnknownOrWrongKeyIsRejected`, console tamper button |
| Replay / downgrade to a vulnerable model | Monotonic `manifest_seq`; rollback is a *new* higher-seq manifest | `testReplayAndDowngradeAreRejected` |
| Corrupted or swapped artifact | sha256 in the signed payload; smoke test before activation | `testCorruptArtifactIsNeverActivated`, `testSmokeTestRejectsWrongModel` |
| Stale / incompatible model | `expires_at`, feature schema, minimum app version; endpoint falls back to policy | `testExpiredIncompatibleAndTooNewAreRejected`, `testKillSwitchAndStaleModelFallBack` |
| Compromised endpoint submitting "safe" signals | Gateway recomputes a cloud score; more severe signal wins; model can only raise | `fusion.test.ts` (combineSignals) |
| Fabricated telemetry | Telemetry bodies limited to whitelisted summary fields; endpoint id bound to the owning integration | `events/batch` route validation |
| Prompt injection via action text | Intent text is not a model input | adversarial suite: *malicious instruction inside intent text* |
| Feature manipulation (asserted ticket, misstated class) | Deterministic thresholds remain authoritative; documented limitations; 1.1.0 trained on the red-team finding | adversarial suite |
| Training-data poisoning via feedback | Proxies down-weighted; feedback never applied online; gold-set gate on every candidate | adversarial suite: *feedback poisoning* |
| OOD / unknown enums treated as safe | Explicit `unknown` buckets, abstain, high-impact unknowns escalate | adversarial OOD cases, `testUnknownEnumsAbstainAndEscalateHighImpact` |
| Unauthorised model promotion | Admin role + passkey step-up + passing gate report; audit-chained | `promote` route, `ml_promote` op |

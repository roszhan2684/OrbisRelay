# ADR-001: Tenancy, authentication and the decision lifecycle

- Status: accepted (demo build)
- Date: 2026-10-04

## Context

Orbis Relay sits between software intent and execution. Every design choice below protects one property: **a decision returned to a caller must be explainable, attributable and impossible to forge or replay.**

This repository is a portfolio-grade build. The blueprint's production stack (FastAPI, PostgreSQL, Temporal, Redis) is replaced by a single Next.js process with an in-memory store persisted to `apps/web/.data/store.json`. The *domain* logic (`packages/policy-core`, `apps/web/src/lib/server/gateway.ts`) is written so the storage and workflow layers can be swapped without touching it.

## Decisions

### 1. Tenant is derived from the credential, never the payload
- Integration (machine) calls authenticate with `Authorization: Bearer orb_live_…`. Keys are SHA-256 hashed at rest and looked up by hash; the matching integration determines the tenant.
- Any `tenant_id` in a request body is ignored. Every query filters on the authenticated principal's tenant.
- Approval reads by integrations are additionally scoped to the integration that created them (IDOR guard; covered by tests).

### 2. Humans and machines use separate auth paths
- Console: `orbis_session` httpOnly cookie issued by SSO (demo personas stand in for OIDC).
- Orbis iOS: `orbu_…` bearer tokens bound to a registered device; device revocation ends sessions and invalidates step-up from that device.
- Integration keys cannot respond to approvals; user sessions call the gateway only as the sandbox integration.

### 3. Deterministic policy owns enforcement
- `policy-core` is pure: same envelope + context ⇒ same evaluation. No I/O, no model calls.
- All enabled policies are evaluated; the most severe matching effect wins. A frozen actor is always denied.
- The contextual risk score prioritises and routes; it never overrides a rule.
- Published policy versions are immutable; drafts are simulated against real history and published with a second admin.

### 4. Decision state machine
```
received → evaluating → allow | warn | deny | approval_required
approval_required → pending → approved | approved_modified | rejected | expired | cancelled
final authorization → outcome: succeeded | failed | not_executed | unknown
```
- `approved_modified` carries `approved_parameters` (edits or a safe alternative); callers must execute with them.
- Responses are verified server-side: tenant, assignment/route membership, state, expiry, one response per user, required step-up proof, editable-field constraints. Client UI state is never authority.
- Quorum approvals resolve when N distinct approvers sign; any rejection rejects.
- A background tick expires approvals at TTL and escalates at 50% TTL.

### 5. Idempotency
- `request_id` (or `Idempotency-Key`) is unique per integration. A replay with the same payload hash returns the original decision; a different payload returns `409 idempotency_conflict`.
- Outcome reports are idempotent for the same status.

### 6. Evidence and integrity
- Every final decision issues a receipt: canonical JSON (sorted keys) signed with Ed25519, plus its SHA-256. Outcome reports issue revision 2 committing to revision 1's hash. The public JWK is published for offline verification.
- The audit trail is append-only and hash-chained; `GET /v1/audit/verify` recomputes the chain.

## Consequences

- Swapping in PostgreSQL means implementing `getDb/persist` against tables with tenant-scoped row access; the gateway functions keep their signatures.
- Swapping in Temporal means moving `tick()` (expiry/escalation) and webhook delivery into workflows; the approval state machine stays in `gateway.ts`.
- Signing keys live in the demo store; production must use a KMS/HSM with key rotation (`key_id` is already carried on every receipt).

# ADR-002 — Orbis Endpoint Intelligence (v2)

**Status:** accepted · **Date:** 2026-10-06 · **Supersedes:** nothing (extends ADR-001)

## Context
v2 adds a locally deployed risk model, a behavioural anomaly signal, a model lifecycle (registry, gates, signed distribution, rollout, rollback, drift, retraining) and an iOS evidence UX. The blueprint suggests FastAPI, PostgreSQL, Temporal and a cloud MLflow. The v1 demo backend is a Next.js gateway on Vercel serverless, made consistent by a deterministic seed plus a replicated op log (ADR-001).

## Decision
1. **Deterministic policy stays the authority.** ML is fused *after* policy evaluation by a pure function, `fuse()` in `@orbis/policy-core`. It can raise allow→warn→approval_required. It never lowers an outcome, never touches deny/freeze, and falls back to policy when the model is unavailable, stale, incompatible, killed or disabled. Every fused decision records the rule that applied, and receipts carry model version, feature schema, class, risk and fusion rule.
2. **Offline ML in Python, online inference in three ports.** Training, evaluation, gates, conversion, drift and retraining run in `ml/orbis_ml` (Python 3.11, numpy/sklearn/torch). Inference runs as:
   - Core ML on the macOS endpoint (Swift),
   - a TypeScript port in the gateway (cloud-side scoring, shadow and canary),
   - a C++20 port of the feature calculator for parity.

   All of them are parity-tested against fixtures the Python reference generates.
3. **The gateway owns the model control plane.** Lifecycle state, manifest sequence, the model-signing key, the fleet, predictions and feedback live in the replicated DB (`db.ml`). Every mutation is an op, so serverless replicas agree. Model metrics come from a registry snapshot (`apps/web/src/lib/ml/edge/registry.json`) exported by the pipeline. MLflow (sqlite, local) is the system of record for experiments.
4. **Endpoint signals are advisory and untrusted.** A local signal is accepted only from a registered endpoint with a known model version and the current feature schema. It is combined with the gateway's own cloud score, and the more severe of the two wins. A compromised endpoint can therefore only add friction, never remove it.
5. **Signed distribution.** Manifests are Ed25519-signed over the exact payload bytes (no canonicalisation needed across languages). They carry the artifact and policy sha256, an expiry, a minimum app version and a monotonic `manifest_seq`. The endpoint rejects anything unsigned, tampered, expired, incompatible, for another tenant, or replayed with a lower sequence. Activation is an atomic `rename(2)` of a symlink after a compile and smoke test.

## Consequences
- The whole lifecycle can be demonstrated and tested without cloud infrastructure; production would move `db.ml` to PostgreSQL and the registry to a hosted MLflow.
- Three inference ports must stay in lockstep — enforced by the parity fixtures in CI (Swift, TypeScript, C++).
- Fleet telemetry for the 23 demo endpoints is simulated from measured benchmarks and labelled as such; a real `orbis-endpoint` registers alongside them.

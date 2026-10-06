# Deep-dive Q&A — answered from this repository

Every answer points at code or a measured artifact. If a number isn't in a report file, it isn't claimed.

## Model
- **Why this architecture over a larger neural model?** A 3,348-parameter MLP had the lowest *validation* security cost among models with an edge path (0.0106, against 0.016 for logistic regression). HistGB was marginally better on test but has no Core ML/ONNX path (`baselines_report.md`, ADR-003). The data is 85 structured features; a larger network bought nothing (64×32 scored 0.0115).
- **Class imbalance?** The data is intentionally ~88/5/6/1.5%. Training uses inverse-sqrt-frequency weights multiplied by security weights [1, 2, 6, 12] (`models.sample_weights`), and the decision thresholds come from a cost matrix rather than argmax.
- **Threshold choice?** τ_review and τ_high are swept on validation to minimise the cost matrix. Then, within 5% of the optimum, the most escalating point is taken, because validation only has trained variants (`decision.select_thresholds`). The console threshold explorer replays the test split. For 1.1.0 this rule picked τ_review 0.04 on a flat cost surface, which is one reason its false escalations doubled.
- **Why is precision/recall different in security?** A missed high-risk action costs 50; reviewing a safe one costs 1. We report escalation recall per class, the false-escalation rate and the cost, never accuracy alone.
- **Calibration?** Temperature scaling on validation NLL (T = 0.912), versioned separately as the decision policy. Test ECE goes from 0.0227 uncalibrated to 0.0146. One-vs-rest isotonic reaches 0.0012 but needs lookup tables on the edge (`evaluation_report.json → calibration_comparison`).
- **Hardest false positive?** On-call and incident traffic: off-hours runbook bursts and secret reads with a ticket. The actor's own history plus `has_ticket` keep these un-escalated. 1.1.0 regressed here (+3.5 pts on the hard-negative slice) and the gate caught it.
- **Hardest false negative?** Secret material labelled `internal` and emailed to a new domain (gold g-k01, test-only template). Metadata cannot reveal a misstated class, so classification must come from DLP/policy. Second hardest: an agent-asserted `ticket` flag on $40k–$90k refunds, which 1.0.0 misses and 1.1.0 catches.

## Edge
- **Core ML vs ONNX Runtime?** Both are at parity (Core ML |Δp| 4.3e-7, ONNX 4.8e-7). Core ML ships because it is native, compiles on device from a signed `.mlpackage`, and is ready for the ANE/GPU for future larger models.
- **P95 latency?** 57 µs warm batch-1 and 63 µs for the full event→signal pipeline on an M4 Pro. Under paced 50 events/s for 10 minutes, the pipeline p95 is 285 µs. The budget is 20 ms.
- **What limited performance?** Two things. For the model, Core ML per-call overhead: a Swift forward pass takes 0.8 µs against Core ML's 38 µs. For the pipeline, a per-event `ISO8601DateFormatter` allocation in the staleness check. Profiling (`orbis-endpoint profile`) found it, and caching it took p50 from 235 to 51 µs.
- **After quantization?** FP16 stays in tolerance and saves 6 KB. INT8 weights exceed the bounded delta (5.2e-2). Latency is unchanged (~38 µs), so we ship FP32.
- **What did profiling show?** Stage timings (`orbis-endpoint profile`): inference 30 µs, JSON decode 11 µs, validation 9 µs, reasons 4 µs, features 2 µs, anomaly 2 µs. Instruments was not used; the in-process profiler was enough to find the hotspot.
- **Corrupt model?** The artifact sha256 is checked against the signed manifest before anything is unpacked, so a corrupt artifact is never activated (`testCorruptArtifactIsNeverActivated`). A compiled model that fails the smoke test is never activated either. A missing or unloadable model yields a `deterministic_fallback` signal with no score.
- **Rollback?** Locally, the retained previous version is re-symlinked with no network needed. Fleet-wide, the control plane issues a new manifest with a higher sequence pointing at the previous production version. Automatic rollback fires when a canary endpoint breaches p95 20 ms or reports more than 5 failures (latency drill in the console).

## MLOps
- **Reproducible training?** Dataset regeneration from manifest seed + config is hash-identical. Training is deterministic (torch single-thread with deterministic algorithms, float64), and `reproduce` yields bit-identical weights. Lineage is tracked in MLflow and `training_run.json`.
- **What blocks a bad model?** 17 gates in `release_gate_report.json`. The control plane refuses promotion beyond candidate without a passing report (`promote → gates_not_passed`), and CI fails on any gate. Example: 1.1.0 is blocked by a golden regression and a slice regression.
- **What triggers retraining?** Sustained warn windows (≥ 2) and ≥ 200 labels, or a known change such as a red-team finding. Drift alone never retrains.
- **Drift detection?** PSI per monitored feature and on the risk score (within one model), plus the OOD rate, over 7-day windows. Two bugs were found and fixed: weekend aliasing, and comparing across model versions.
- **Ground truth?** Analyst reviews (0.95), human approval proxies (0.5), weak labels (0.3), synthetic, gold. The active-review queue spends a fixed analyst budget on uncertain, disagreeing and novel cases.
- **Wrong labels?** Proxies are down-weighted and never applied online, and every candidate is re-gated on the immutable gold set. In the poisoning test, 600 fake approvals reduce gold high-risk recall to 0.87 when trusted, or 0.93 when weighted. Both candidates fail the gate.

## Systems
- **Feature parity?** One Python reference generates fixtures; Swift, TypeScript and C++ must match within 1e-9. C++ matched the full 33,274-event dataset (31,055 bit-identical). Integer-only date math and a fixed floating-point operation order make this possible.
- **Race conditions in activation?** Staging happens in a private directory, followed by an atomic `rename(2)` of the `current` symlink and an atomic state-file write. A crash leaves either the old or the new version, never half of one. Concurrent manifests are serialised by the monotonic `manifest_seq`.
- **Endpoint/cloud schema mismatch?** The feature schema is in the manifest, the Core ML metadata and the portable weights. The endpoint refuses an incompatible model, and the gateway rejects a local signal with a different schema (falling back to its own cloud score).
- **Cross-tenant leakage?** The tenant comes from the API key, never the payload. Manifests are tenant-bound and checked by the endpoint. Baselines are keyed per actor within one tenant DB, and feedback export is admin-only.

## Security
- **Attack surface of model updates?** It covers manifest forgery (Ed25519 with a pinned key), replay and downgrade (monotonic sequence), artifact tampering (sha256 in the signed payload), policy tampering (policy sha256), stale models (expiry), a compromised download host (integrity independent of transport), and kill-switch abuse (signed, audited, step-up).
- **Can an agent manipulate its features?** Partly, and that is measured. An asserted ticket hides large refunds in 1.0.0, and a misstated classification hides egress. Baseline warming (40 benign sends first) did *not* lower the hero risk below escalation. Mitigations: deterministic thresholds stay authoritative, the gateway verifies tickets, and classification comes from DLP.
- **Prompt injection?** Agent-supplied intent text is not a model input. The test confirms identical decisions with and without "ignore Orbis policy" text.
- **Why isn't ML the final authority?** It is wrong in measurable ways (the documented limitations), it can be manipulated, and it drifts. `fuse()` lets it add caution only.
- **Known limitations:** synthetic data only, metadata-only blindness to misclassification, slow ramps, simulated fleet telemetry, energy not measured.

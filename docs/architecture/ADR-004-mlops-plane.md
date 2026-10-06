# ADR-004 — MLOps plane for a portfolio deployment

**Status:** accepted · **Date:** 2026-10-06

- **Experiment tracking and registry:** MLflow 3 with a local sqlite store (`ml/mlruns/`, gitignored). Every run logs git SHA, dataset version, feature schema, seed, hyperparameters, dependency-lock hash, metrics and artifacts. Final candidates are registered as `orbis-edge-risk` versions.
- **Portable registry snapshot:** `python -m orbis_ml export` writes `registry.json`, the evaluation detail, model cards and the distributables into the web app. The gateway cannot reach a laptop's MLflow, so the snapshot plus the replicated lifecycle state is what production reads.
- **Datasets:** deterministic generator plus a committed manifest (seed, generator-config hash, file sha256s, class distribution, leakage and privacy review). Data files are regenerated, not committed. `verify-dataset` is the reproducibility gate.
- **Release gates:** `python -m orbis_ml gates` reads the machine-readable reports and exits non-zero on any failure. CI runs it. The control plane refuses to move a version past *candidate* unless its gate report passes.
- **No auto-promotion, ever:** drift *proposes* retraining, retraining *registers* a candidate, gates *decide eligibility*, and an authorised human with step-up *promotes* (shadow → canary → production). Health signals can only roll back.

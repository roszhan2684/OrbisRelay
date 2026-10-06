"""Reproducibility acceptance gate (blueprint §10.4).

A clean checkout must: regenerate the declared dataset (hash-identical), retrain the recorded
configuration, and reproduce the evaluation metrics within a declared tolerance.
"""
from __future__ import annotations

import json
from typing import Any

from . import dataset, decision, evaluate, train
from .metrics import softmax
from .models import MLP

TOLERANCE = 1e-6


def run_retrained(version: str) -> dict[str, Any]:
    """Candidates from the retraining pipeline: rebuild from the recorded dataset version's files."""
    import numpy as np

    md = train.MODELS_DIR / version
    rt = json.loads((md / "retrain_report.json").read_text())
    ds_version = rt["dataset"].split("@")[1]
    manifest = json.loads((dataset.MANIFESTS / f"{dataset.NAME}-{ds_version}.json").read_text())
    d = dataset.DATA / dataset.NAME / ds_version
    mismatched = [k for k, v in manifest["files"].items() if dataset.sha256_file(d / k) != v["sha256"]]
    base = dataset.load(manifest["parent"].split("@")[1])
    va = base["split"] == "val"
    m = MLP((32, 16), seed=0)
    m.fit(np.load(d / "train_features.npy"), np.load(d / "train_labels.npy"), base["X"][va], base["y"][va], w=np.load(d / "train_weights.npy"))
    stored = json.loads((md / "model.json").read_text())
    same = train.sha256_json(m.portable()["layers"]) == train.sha256_json(stored["layers"])
    out = {"model": f"orbis-edge-risk@{version}", "dataset_verification": {"dataset": rt["dataset"], "files_checked": len(manifest["files"]), "mismatches": mismatched, "passed": not mismatched},
           "retrained_metric_deltas": {"weights": 0.0 if same else 1.0}, "tolerance": TOLERANCE, "weights_bit_identical": same, "passed": same and not mismatched,
           "note": "Retrained from the candidate dataset files recorded in the manifest; deterministic training."}
    (md / "reproduce_report.json").write_text(json.dumps(out, indent=2) + "\n")
    return out


def run(version: str = "1.0.0") -> dict[str, Any]:
    md = train.MODELS_DIR / version
    if (md / "retrain_report.json").exists():
        return run_retrained(version)
    contract = json.loads((md / "training_run.json").read_text())
    stored = json.loads((md / "evaluation_report.json").read_text())
    ds_version = contract["dataset"].split("@")[1]
    ds = dataset.verify(ds_version)
    data = dataset.load(ds_version)
    hp = contract["hyperparameters"]
    m = MLP(tuple(hp["hidden"]), seed=hp["seed"], epochs=hp["epochs_max"], lr=hp["lr"], weight_decay=hp["weight_decay"], batch=hp["batch"])
    X, y, split = data["X"], data["y"], data["split"]
    tr, va, te = split == "train", split == "val", split == "test"
    m.fit(X[tr], y[tr], X[va], y[va])
    zv = m.logits(X[va])
    T = decision.fit_temperature(zv, y[va])
    th, trv, _ = decision.select_thresholds(softmax(zv, T), y[va])
    rep = evaluate.full_report("repro", {"val": zv, "test": m.logits(X[te]), "gold": m.logits(data["Xg"])}, data, decision.DecisionPolicy(T, th, trv))
    keys = ["mean_cost", "macro_f1", "high_risk_escalation_recall", "risky_escalation_recall", "false_escalation_rate", "ece", "brier"]
    deltas = {k: abs((rep["test"][k] or 0) - (stored["test"][k] or 0)) for k in keys}
    deltas["gold.risky_escalation_recall"] = abs(rep["gold"]["risky_escalation_recall"] - stored["gold"]["risky_escalation_recall"])
    weights_identical = train.sha256_json(m.portable() | {k: v for k, v in json.loads((md / "model.json").read_text()).items() if k not in ("format", "input_dim", "layers")}) == stored["artifact_sha256"]["model.json"]
    out = {
        "model": f"orbis-edge-risk@{version}",
        "dataset_verification": ds,
        "retrained_metric_deltas": deltas,
        "tolerance": TOLERANCE,
        "temperature": {"stored": stored["policy"]["temperature"], "reproduced": T},
        "thresholds": {"stored": [stored["policy"]["tau_high"], stored["policy"]["tau_review"]], "reproduced": [th, trv]},
        "weights_bit_identical": weights_identical,
        "passed": ds["passed"] and all(v <= TOLERANCE for v in deltas.values()),
        "note": "Deterministic: PCG64-seeded generator, torch.use_deterministic_algorithms(True), single thread, float64.",
    }
    (md / "reproduce_report.json").write_text(json.dumps(out, indent=2) + "\n")
    return out

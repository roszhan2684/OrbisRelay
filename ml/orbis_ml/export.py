"""Publish registry + artifacts to the places that consume them.

  apps/web/src/lib/ml/edge/registry.json        model registry snapshot (metrics, gates, parity, benchmarks, lineage)
  apps/web/src/lib/ml/edge/models/<v>.json      portable weights + decision policy (gateway cloud-side inference)
  apps/web/src/lib/ml/edge/eval/<v>.json        evaluation detail for the console (confusion, slices, sweep, gold)
  apps/web/src/lib/ml/edge/cards.json           model cards (markdown, keyed by version)
  apps/web/public/models/orbis-edge-risk/<v>/   signed-manifest distributables (zipped .mlpackage)
"""
from __future__ import annotations

import json
import shutil
from typing import Any

from . import dataset, gates, train

WEB = dataset.ROOT / "apps" / "web"
EDGE = WEB / "src" / "lib" / "ml" / "edge"
PUBLIC = WEB / "public" / "models" / "orbis-edge-risk"
KEYS = ("mean_cost", "macro_f1", "high_risk_escalation_recall", "risky_escalation_recall", "false_escalation_rate", "safe_precision", "ece", "brier", "risky_pr_auc", "risky_roc_auc", "abstention_rate", "n")


def _j(p):
    return json.loads(p.read_text()) if p.exists() else None


def run() -> dict[str, Any]:
    for d in ("models", "eval"):
        (EDGE / d).mkdir(parents=True, exist_ok=True)
    versions = sorted(p.name for p in train.MODELS_DIR.iterdir() if p.is_dir() and (p / "model.json").exists())
    entries = []
    for v in versions:
        md = train.MODELS_DIR / v
        model, pol, ev = _j(md / "model.json"), _j(md / "decision_policy.json"), _j(md / "evaluation_report.json")
        par, gate, tr, rt, adv, rep = (_j(md / f) for f in ("parity_report.json", "release_gate_report.json", "training_run.json", "retrain_report.json", "adversarial_report.json", "reproduce_report.json"))
        bench, bench_src = gates.latest_benchmark(v)
        (EDGE / "models" / f"{v}.json").write_text(json.dumps({"model": {k: model[k] for k in ("format", "input_dim", "layers", "model_name", "version", "feature_schema", "classes", "architecture")}, "policy": pol}, separators=(",", ":")))
        detail = {
            "version": v,
            "val": {k: ev["val"].get(k) for k in KEYS},
            "test": {k: ev["test"].get(k) for k in KEYS} | {"confusion_matrix": ev["test"]["confusion_matrix"], "per_class": ev["test"]["per_class"], "reliability_risky": ev["test"].get("reliability_risky", [])},
            "gold": {k: ev["gold"][k] for k in ("n", "high_risk_escalation_recall", "high_risk_strict_recall", "risky_escalation_recall", "safe_precision", "false_escalation_rate", "hard_negative_false_positive_rate")}
            | {"scenarios": [{k: s[k] for k in ("id", "title", "expect", "predicted", "risk", "correct_escalation", "known_limitation", "tags", "abstain")} for s in ev["gold"]["scenarios"]]},
            "slices": ev["slices"],
            "templates": ev.get("templates", {}),
            "threshold_sweep": ev["threshold_sweep"],
            "calibration_comparison": ev.get("calibration_comparison"),
            "window_holdout": {k: ev["window_holdout"].get(k) for k in KEYS} if "window_holdout" in ev else None,
            "policy": {k: pol[k] for k in ("temperature", "tau_high", "tau_review", "abstain_entropy", "version")},
            "adversarial": adv,
            "anomaly": _j(md / "anomaly_report.json"),
            "retrain": rt,
        }
        (EDGE / "eval" / f"{v}.json").write_text(json.dumps(detail, separators=(",", ":"), default=float))
        dist = {}
        if par:
            out = PUBLIC / v
            out.mkdir(parents=True, exist_ok=True)
            src = md / "dist" / "OrbisEdgeRisk-fp32.mlpackage.zip"
            shutil.copy(src, out / src.name)
            dist = {"coreml_fp32_zip": {"url": f"/models/orbis-edge-risk/{v}/{src.name}", **par["distributables"][src.name]}}
        entries.append({
            "version": v,
            "architecture": model["architecture"],
            "n_params": sum(len(l["b"]) + len(l["W"]) * len(l["W"][0]) for l in model["layers"]),
            "feature_schema": model["feature_schema"],
            "dataset": ev["dataset"],
            "policy_version": pol["version"],
            "origin": "retraining pipeline (drift → review queue → candidate)" if rt else "initial training run",
            "trained_at": (tr or {}).get("trained_at") or (rt or {}).get("trained_at"),
            "mlflow_run_id": model.get("mlflow_run_id"),
            "git_sha": (tr or {}).get("git_sha"),
            "metrics": {"test": {k: ev["test"].get(k) for k in KEYS}, "gold": {k: ev["gold"][k] for k in ("high_risk_escalation_recall", "risky_escalation_recall", "hard_negative_false_positive_rate")}, **({"window_holdout": {k: ev["window_holdout"].get(k) for k in KEYS}} if "window_holdout" in ev else {})},
            "gates": None if not gate else {"status": gate["status"], "baseline": gate.get("baseline"), "gates": [{k: g[k] for k in ("name", "status", "observed", "threshold", "source") if k in g} | ({"note": g["note"]} if "note" in g else {}) for g in gate["gates"]]},
            "parity": None if not par else {k: {"max_abs_probability_delta": p["max_abs_probability_delta"], "class_agreement": p["test_split_class_agreement"], "passed": p["passed"], "bytes": par["quantization"][k]["artifact_bytes"]} for k, p in par["parity"].items()},
            "benchmark": None if not bench else {
                "source": bench_src, "device": bench["device"], "runtime": bench["runtime"], "compute_units": bench["compute_units"], "measured_at": bench["measured_at"],
                "cold_ms": bench["cold"]["total_ms"], "warm_us": bench["warm_batch1_us"], "pipeline_us": bench["pipeline_event_to_signal_us"], "portable_swift_us": bench["portable_swift_batch1_us"],
                "memory_mb": bench["memory_mb"], "idle_cpu_percent": bench["idle_cpu_percent"], "cpu_ms_per_1k": bench["cpu_ms_per_1k_inferences"],
            },
            "reproducibility": None if not rep else {"passed": rep["passed"], "weights_bit_identical": rep["weights_bit_identical"]},
            "comparison": rt["comparison"] if rt else None,
            "artifacts": {"portable_sha256": ev["artifact_sha256"]["model.json"], "policy_sha256": ev["artifact_sha256"]["decision_policy.json"], **dist},
        })
    cards = {v: (train.MODELS_DIR / v / "MODEL_CARD.md").read_text() for v in versions if (train.MODELS_DIR / v / "MODEL_CARD.md").exists()}
    (EDGE / "cards.json").write_text(json.dumps(cards) + "\n")
    sus, sus_src = gates.sustained_benchmark()
    matrix = []
    for v in versions:
        import glob
        from pathlib import Path

        seen = {}
        for f in sorted(glob.glob(str(dataset.ML / "benchmarks" / "results" / "orbis-edge-risk" / v / "*" / "*.json"))):
            b = json.loads(Path(f).read_text())
            seen[(b["precision"], b["compute_units"])] = {"version": v, "precision": b["precision"], "compute_units": b["compute_units"], "warm_p50_us": b["warm_batch1_us"]["p50"], "warm_p95_us": b["warm_batch1_us"]["p95"], "pipeline_p95_us": b["pipeline_event_to_signal_us"]["p95"], "cold_ms": b["cold"]["total_ms"], "peak_mb": b["memory_mb"]["peak_footprint"], "artifact_bytes": b["artifact_bytes"]}
        matrix += list(seen.values())
    registry = {
        "model_name": "orbis-edge-risk",
        "feature_schema": "edge-features/1",
        "versions": entries,
        "benchmark_matrix": matrix,
        "sustained": None if not sus else {"source": sus_src, **sus["sustained"], "device": sus["device"]},
        "baselines": _j(train.MODELS_DIR / "baselines_report.json"),
        "dataset": _j(dataset.MANIFESTS / f"{dataset.NAME}-1.0.0.json"),
    }
    (EDGE / "registry.json").write_text(json.dumps(registry, indent=1, default=float) + "\n")
    hero = dataset.ROOT / "fixtures" / "endpoint-events" / "hero-signal.coreml.json"
    if hero.exists():
        shutil.copy(hero, EDGE / hero.name)
    return {"versions": versions, "registry": str(EDGE / "registry.json"), "public": str(PUBLIC)}

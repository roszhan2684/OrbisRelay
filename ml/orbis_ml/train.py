"""Training pipeline for the Orbis Edge Risk Classifier.

  python -m orbis_ml train --dataset 1.0.0 --version 1.0.0

1. Loads the versioned dataset (manifest-verified files).
2. Trains every baseline + candidate on `train`, calibrates (temperature) and selects thresholds on `val`.
3. Selects the final candidate by **validation** security cost among portable models (never on test/gold).
4. Evaluates val, test, slices and the gold set; writes evaluation_report.json + baselines_report.json.
5. Exports the portable model + separately-versioned decision policy, and the training contract.
6. Logs every run to MLflow (sqlite store under ml/mlruns, gitignored) with full lineage.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import subprocess
import time
from pathlib import Path
from typing import Any

import numpy as np

from . import dataset, decision, evaluate, features, models
from .metrics import nan_to_none, softmax

ML = dataset.ML
MODELS_DIR = ML / "models" / "risk_classifier"
MLRUNS = ML / "mlruns"
MODEL_NAME = "orbis-edge-risk"


def lock_hash() -> str:
    p = ML / "requirements.lock"
    return hashlib.sha256(p.read_bytes()).hexdigest() if p.exists() else "missing"


def hardware() -> dict[str, str]:
    try:
        cpu = subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True).strip()
    except Exception:
        cpu = platform.processor()
    return {"cpu": cpu, "machine": platform.machine(), "os": f"{platform.system()} {platform.release()}", "python": platform.python_version()}


def _mlflow():
    os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")
    import mlflow

    MLRUNS.mkdir(exist_ok=True)
    mlflow.set_tracking_uri(f"sqlite:///{MLRUNS / 'mlflow.db'}")
    if mlflow.get_experiment_by_name(MODEL_NAME) is None:
        mlflow.create_experiment(MODEL_NAME, artifact_location=(MLRUNS / "artifacts").as_uri())
    mlflow.set_experiment(MODEL_NAME)
    return mlflow


def candidates(seed: int) -> list[Any]:
    return [
        models.RuleBaseline(),
        models.LogReg(C=1.0, seed=seed),
        models.LogReg(C=10.0, seed=seed),
        models.HGB(seed=seed),
        models.MLP((32, 16), seed=seed),
        models.MLP((64, 32), seed=seed),
    ]


def label_of(m) -> str:
    if m.name == "logreg":
        return f"logreg-C{m.C:g}"
    if m.name == "mlp":
        return "mlp-" + "x".join(map(str, m.hidden))
    return m.name


def fit_and_evaluate(m, data: dict) -> dict[str, Any]:
    X, y, split = data["X"], data["y"], data["split"]
    tr, va, te = split == "train", split == "val", split == "test"
    m, secs = models.timed_fit(m, X[tr], y[tr], X[va], y[va])
    zv, zt, zg = m.logits(X[va]), m.logits(X[te]), m.logits(data["Xg"])
    T = 1.0 if m.name == "rule" else decision.fit_temperature(zv, y[va])
    th, trv, vcost = decision.select_thresholds(softmax(zv, T), y[va])
    policy = decision.DecisionPolicy(temperature=T, tau_high=th, tau_review=trv)
    report = evaluate.full_report(label_of(m), {"val": zv, "test": zt, "gold": zg}, data, policy)
    if m.name != "rule":
        report["calibration_comparison"] = evaluate.isotonic_comparison(zv, y[va], zt, y[te])
    portable = m.portable() if hasattr(m, "portable") else None
    report["model_info"] = {
        "name": label_of(m),
        "family": m.name,
        "params": m.params(),
        "fit_seconds": round(secs, 3),
        "portable": portable is not None,
        "n_params": models.n_params(portable) if portable else None,
        "portable_bytes": len(json.dumps(portable)) if portable else None,
        "conversion": "Core ML (MIL) + ONNX from portable weights" if portable else ("none — rule set" if m.name == "rule" else "no supported Core ML/ONNX path from sklearn 1.9 HistGradientBoosting; would need a tree-ensemble runtime"),
    }
    if m.name == "mlp":
        report["model_info"]["training_curve"] = m.history
    return {"model": m, "policy": policy, "report": nan_to_none(report), "portable": portable}


def select(results: list[dict]) -> dict:
    portable = [r for r in results if r["portable"] is not None]
    return min(portable, key=lambda r: (round(r["report"]["val"]["mean_cost"], 4), r["report"]["model_info"]["n_params"]))


def write_json(p: Path, obj: Any) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(nan_to_none(obj), indent=2, sort_keys=False) + "\n")


def sha256_json(obj: Any) -> str:
    return hashlib.sha256(json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def export_model(r: dict, version: str, data: dict, run_id: str, out: Path, previous: str | None = None) -> dict:
    out.mkdir(parents=True, exist_ok=True)
    portable = dict(r["portable"])
    manifest = data["manifest"]
    portable.update({
        "model_name": MODEL_NAME,
        "version": version,
        "task": "4-class edge risk classification of a canonical endpoint event",
        "classes": ["safe_normal", "safe_unusual", "suspicious_review", "high_risk"],
        "feature_schema": features.FEATURE_SCHEMA,
        "architecture": r["report"]["model_info"]["name"],
        "dataset": f"{manifest['name']}@{manifest['version']}",
        "mlflow_run_id": run_id,
        "outputs": "logits (apply decision policy for calibrated probabilities)",
    })
    write_json(out / "model.json", portable)
    pol = r["policy"].to_json()
    pol["version"] = f"{version}+cal1"
    pol["model_version"] = version
    write_json(out / "decision_policy.json", pol)
    rep = dict(r["report"])
    rep["model_version"] = version
    rep["dataset"] = portable["dataset"]
    rep["artifact_sha256"] = {"model.json": sha256_json(portable), "decision_policy.json": sha256_json(pol)}
    if previous:
        rep["compared_to"] = previous
    write_json(out / "evaluation_report.json", rep)
    return rep


def run(dataset_version: str = "1.0.0", version: str = "1.0.0", seed: int = 0, previous_version: str | None = "0.9.0") -> dict[str, Any]:
    mlflow = _mlflow()
    data = dataset.load(dataset_version)
    manifest = data["manifest"]
    git = dataset.git_sha()
    started = time.time()
    results = []
    with mlflow.start_run(run_name=f"{MODEL_NAME}/{manifest['name']}@{dataset_version}/{features.FEATURE_SCHEMA}") as parent:
        mlflow.set_tags({"git_sha": git, "dataset": f"{manifest['name']}@{dataset_version}", "feature_schema": features.FEATURE_SCHEMA, "dependency_lock_sha256": lock_hash()})
        for m in candidates(seed):
            with mlflow.start_run(run_name=label_of(m), nested=True) as child:
                r = fit_and_evaluate(m, data)
                r["run_id"] = child.info.run_id
                rep = r["report"]
                mlflow.log_params({k: str(v) for k, v in rep["model_info"]["params"].items()} | {"seed": seed, "temperature": r["policy"].temperature, "tau_high": r["policy"].tau_high, "tau_review": r["policy"].tau_review})
                for split in ("val", "test"):
                    for k in ("mean_cost", "macro_f1", "risky_escalation_recall", "high_risk_escalation_recall", "false_escalation_rate", "safe_precision", "ece", "brier", "risky_pr_auc", "risky_roc_auc"):
                        v = rep[split].get(k)
                        if isinstance(v, (int, float)):
                            mlflow.log_metric(f"{split}.{k}", v)
                for k in ("high_risk_escalation_recall", "risky_escalation_recall", "hard_negative_false_positive_rate"):
                    mlflow.log_metric(f"gold.{k}", rep["gold"][k])
                mlflow.log_dict(rep, "evaluation_report.json")
                results.append(r)
        final = select(results)
        prev = next((r for r in results if label_of(r["model"]) == "logreg-C1"), None)
        out = MODELS_DIR / version
        rep = export_model(final, version, data, final["run_id"], out, previous=previous_version)
        if previous_version and prev is not None and not (MODELS_DIR / previous_version / "model.json").exists():
            export_model(prev, previous_version, data, prev["run_id"], MODELS_DIR / previous_version)
        comparison = {
            "dataset": f"{manifest['name']}@{dataset_version}",
            "selection_rule": "lowest validation mean security cost among models with a portable (Core ML/ONNX/TS/Swift) export; tie-break fewer parameters. Test and gold were not used for selection.",
            "selected": label_of(final["model"]),
            "models": [
                {
                    "name": label_of(r["model"]),
                    "run_id": r["run_id"],
                    "portable": r["portable"] is not None,
                    "n_params": r["report"]["model_info"]["n_params"],
                    "fit_seconds": r["report"]["model_info"]["fit_seconds"],
                    "temperature": r["policy"].temperature,
                    "tau_review": r["policy"].tau_review,
                    "tau_high": r["policy"].tau_high,
                    **{f"val_{k}": r["report"]["val"].get(k) for k in ("mean_cost", "macro_f1", "risky_escalation_recall", "false_escalation_rate", "ece")},
                    **{f"test_{k}": r["report"]["test"].get(k) for k in ("mean_cost", "macro_f1", "high_risk_escalation_recall", "risky_escalation_recall", "false_escalation_rate", "safe_precision", "ece", "brier", "risky_pr_auc", "risky_roc_auc")},
                    **{f"gold_{k}": r["report"]["gold"][k] for k in ("high_risk_escalation_recall", "risky_escalation_recall", "hard_negative_false_positive_rate")},
                }
                for r in results
            ],
        }
        write_json(MODELS_DIR / "baselines_report.json", comparison)
        (MODELS_DIR / "baselines_report.md").write_text(baselines_markdown(comparison))
        contract = {
            "model": f"{MODEL_NAME}@{version}",
            "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "git_sha": git,
            "dataset": f"{manifest['name']}@{dataset_version}",
            "dataset_manifest_files": {k: v["sha256"] for k, v in manifest["files"].items()},
            "feature_schema": features.FEATURE_SCHEMA,
            "random_seed": seed,
            "hyperparameters": final["report"]["model_info"]["params"],
            "dependency_lock_sha256": lock_hash(),
            "training_duration_seconds": round(time.time() - started, 2),
            "final_fit_seconds": final["report"]["model_info"]["fit_seconds"],
            "hardware": hardware(),
            "mlflow": {"experiment": MODEL_NAME, "parent_run_id": parent.info.run_id, "run_id": final["run_id"], "tracking_uri": "sqlite:///ml/mlruns/mlflow.db"},
            "metrics": {k: rep["test"].get(k) for k in ("mean_cost", "macro_f1", "high_risk_escalation_recall", "risky_escalation_recall", "false_escalation_rate", "ece", "brier")},
            "gold": {k: rep["gold"][k] for k in ("high_risk_escalation_recall", "risky_escalation_recall", "hard_negative_false_positive_rate")},
            "calibration_method": f"temperature scaling (T={final['policy'].temperature}) fit on validation NLL; stored separately in decision_policy.json",
            "threshold_configuration": {"tau_high": final["policy"].tau_high, "tau_review": final["policy"].tau_review, "rule": decision.select_thresholds.__doc__.strip().splitlines()[0], "cost_tolerance": decision.COST_TOLERANCE},
            "artifacts": sorted(p.name for p in out.iterdir()),
        }
        write_json(out / "training_run.json", contract)
        mlflow.log_dict(contract, "training_run.json")
        mlflow.log_artifact(str(out / "model.json"))
        mlflow.log_artifact(str(out / "decision_policy.json"))
        try:
            mv = mlflow.register_model(f"runs:/{final['run_id']}/evaluation_report.json", MODEL_NAME, tags={"version": version, "dataset": contract["dataset"]})
            contract["mlflow"]["registered_version"] = mv.version
            write_json(out / "training_run.json", contract)
        except Exception as e:  # registry is optional for the portable path
            contract["mlflow"]["registry_error"] = str(e)[:200]
    (out / "error-analysis.md").write_text(error_analysis(rep, comparison))
    return {"selected": comparison["selected"], "version": version, "out": str(out), "test": contract["metrics"], "gold": contract["gold"]}


def pct(x) -> str:
    return "—" if x is None else f"{100 * x:.1f}%"


def baselines_markdown(c: dict) -> str:
    rows = ["| Model | Portable | Params | Val cost | Test cost | Test macro-F1 | Test high-risk esc. recall | Test risky recall | Test false-esc. rate | Test ECE | Gold risky recall | Gold hard-neg FPR |", "|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for m in c["models"]:
        sel = " **(selected)**" if m["name"] == c["selected"] else ""
        ece = "—" if m["test_ece"] is None else f"{m['test_ece']:.3f}"
        rows.append(f"| {m['name']}{sel} | {'yes' if m['portable'] else 'no'} | {m['n_params'] or '—'} | {m['val_mean_cost']:.4f} | {m['test_mean_cost']:.4f} | {m['test_macro_f1']:.3f} | {pct(m['test_high_risk_escalation_recall'])} | {pct(m['test_risky_escalation_recall'])} | {pct(m['test_false_escalation_rate'])} | {ece} | {pct(m['gold_risky_escalation_recall'])} | {pct(m['gold_hard_negative_false_positive_rate'])} |")
    return f"# Edge risk model — baseline comparison\n\nDataset `{c['dataset']}`. {c['selection_rule']}\n\n" + "\n".join(rows) + "\n\nCost = mean of the security cost matrix in `ml/orbis_ml/metrics.py` (false allow of high-risk = 50, of suspicious = 10; false review of safe work = 1).\n"


def error_analysis(rep: dict, comparison: dict) -> str:
    t = rep["test"]
    cm = t["confusion_matrix"]
    worst = sorted(((k, v) for k, v in rep["slices"].items() if v.get("risky_escalation_recall") is not None), key=lambda kv: kv[1]["risky_escalation_recall"])[:6]
    noisy = sorted(((k, v) for k, v in rep["slices"].items() if v.get("false_escalation_rate") is not None and v["n"] >= 30), key=lambda kv: -kv[1]["false_escalation_rate"])[:6]
    tmpl = sorted(((k, v) for k, v in rep["templates"].items()), key=lambda kv: kv[1]["escalated"] if kv[1]["label"] in ("suspicious_review", "high_risk") else 1 - kv[1]["escalated"])[:10]
    lines = [
        f"# Error analysis — {rep['model']} ({rep.get('model_version', '')})",
        "",
        "Generated by `python -m orbis_ml train` from the test split and the gold set. Commentary is written by hand below the tables.",
        "",
        "## Test confusion matrix (rows = truth, cols = prediction)",
        "",
        "| | safe_normal | safe_unusual | suspicious_review | high_risk |",
        "|---|---|---|---|---|",
        *[f"| **{n}** | " + " | ".join(str(v) for v in row) + " |" for n, row in zip(["safe_normal", "safe_unusual", "suspicious_review", "high_risk"], cm)],
        "",
        "## Weakest risky-recall slices (test)",
        "",
        "| Slice | n | risky | escalation recall | false-escalation rate |",
        "|---|---|---|---|---|",
        *[f"| {k} | {v['n']} | {v['risky']} | {pct(v['risky_escalation_recall'])} | {pct(v['false_escalation_rate'])} |" for k, v in worst],
        "",
        "## Noisiest slices (highest false-escalation rate, n ≥ 30)",
        "",
        "| Slice | n | false-escalation rate |",
        "|---|---|---|",
        *[f"| {k} | {v['n']} | {pct(v['false_escalation_rate'])} |" for k, v in noisy],
        "",
        "## Scenario templates the model handles worst (test)",
        "",
        "| Template | family | label | n | escalated |",
        "|---|---|---|---|---|",
        *[f"| {k} | {v['family']} | {v['label']} | {v['n']} | {pct(v['escalated'])} |" for k, v in tmpl],
        "",
        "## Gold set",
        "",
        f"Gated scenarios: {rep['gold']['n']}. Failures: {', '.join(f['id'] + ' (' + f['title'] + ' → ' + f['predicted'] + ')' for f in rep['gold']['failures']) or 'none'}.",
        "",
        "Documented limitations (reported, not gated):",
        "",
        *[f"- **{k['id']}** {k['title']} — expected {k['expect']}, predicted {k['predicted']} (risk {k['risk']})" for k in rep["gold"]["known_limitations"]],
        "",
        "## Commentary",
        "",
        "**Hardest false negative.** `disguised_classification` (test-only template). Secret material arrives labelled `internal`, so every feature the edge model sees describes a routine internal send to a new domain. The model cannot recover a classification that the event metadata misstates. That is why policy, not the model, must own DLP classification, and why the gateway combines model output with deterministic rules instead of trusting either alone. It accounts for most of the high-risk misses in the test split.",
        "",
        "**Hardest false positive.** On-call and incident traffic (`incident_runbook_burst`, `oncall_secret_read`, off-hours human work) looks like a rate spike or secret access off-hours. The model mostly keeps these un-escalated because `has_ticket` and the actor's own history carry the signal. When it does escalate, the cost is one human review.",
        "",
        "**A data bug found by error analysis.** The first dataset revision used `tool_risk_class=unknown` only inside attack templates, so models learned \"unregistered tool ⇒ risky\" and escalated an engineer emailing a public spec to a new vendor (gold g-n07). We fixed the *data*, not the model: benign unregistered-tool traffic was added for engineers, ops, procurement and sales, and tool-registry gaps were removed from the OOD count. Because this fix was prompted by a gold failure, the gold set is no longer a fully blind holdout for that one behaviour; this is disclosed in the model card.",
        "",
        "**Slow ramps.** Gold g-k03 (+10%/day export growth) is not caught: the actor's baseline absorbs a slow ramp. The behavioural anomaly detector (Model B) and the drift monitor are the intended controls for this, and they also have limits (see `docs/ml/drift.md`).",
    ]
    return "\n".join(lines) + "\n"

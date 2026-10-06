"""Release gates (blueprint §12): when is a model safe to become a deployable candidate?

Reads the machine-readable reports produced by the pipeline (evaluation, parity, benchmark,
adversarial, reproducibility, model card) and writes release_gate_report.json. CI runs
`python -m orbis_ml gates` and fails the job — blocking promotion — when any gate fails.
Targets are project acceptance budgets, not universal security truths.
"""
from __future__ import annotations

import glob
import json
import shutil
import subprocess
from pathlib import Path
from typing import Any

from . import dataset, features, train

BUDGETS = {
    "gold_high_risk_escalation_recall": 0.97,
    "gold_risky_escalation_recall": 0.94,
    "test_safe_precision": 0.95,
    "gold_hard_negative_fpr": 0.05,
    "test_false_escalation_rate": 0.02,
    "test_ece": 0.05,
    "coreml_fp32_parity": 1e-4,
    "p95_inference_ms": 20.0,
    "p95_pipeline_ms": 20.0,
    "peak_memory_mb": 75.0,
    "model_artifact_kb": 5 * 1024,
    "sustained_cpu_percent": 10.0,
    "slice_regression": 0.02,
}
PROTECTED_SLICES = ["actor_type=agent", "actor_type=human", "sensitivity=confidential_plus", "destination=first_seen", "provider=external_ai", "difficulty=hard_negative", "difficulty=adversarial", "time=off_hours"]
CARD_SECTIONS = ["Model details", "Intended use", "Out of scope", "Training data", "Evaluation", "Calibration", "Runtime", "Known limitations", "Lineage"]


def latest_benchmark(version: str, precision: str = "fp32", compute: str = "cpu_only") -> tuple[dict | None, str | None]:
    files = sorted(glob.glob(str(dataset.ML / "benchmarks" / "results" / "orbis-edge-risk" / version / "*" / f"*-{precision}-{compute}.json")))
    if not files:
        return None, None
    return json.loads(Path(files[-1]).read_text()), str(Path(files[-1]).relative_to(dataset.ROOT))


def sustained_benchmark() -> tuple[dict | None, str | None]:
    files = sorted(glob.glob(str(dataset.ML / "benchmarks" / "results" / "sustained" / "10min-50eps" / "*.json")))
    if not files:
        return None, None
    return json.loads(Path(files[-1]).read_text()), str(Path(files[-1]).relative_to(dataset.ROOT))


def gate(name: str, passed: bool | None, observed: Any, threshold: Any, source: str, note: str = "") -> dict[str, Any]:
    return {"name": name, "passed": passed, "status": "pending" if passed is None else ("pass" if passed else "fail"), "observed": observed, "threshold": threshold, "source": source, **({"note": note} if note else {})}


def swift_parity() -> tuple[bool | None, str]:
    if not shutil.which("swift"):
        return None, "swift toolchain not available"
    p = subprocess.run(["swift", "test", "--filter", "ParityTests"], cwd=dataset.ROOT / "apps" / "macos-endpoint", capture_output=True, text=True, timeout=900)
    tail = [l for l in (p.stdout + p.stderr).splitlines() if "Executed" in l]
    return p.returncode == 0, tail[-1].strip() if tail else p.stderr[-200:]


def run(version: str = "1.0.0", baseline: str | None = None, run_swift: bool = True) -> dict[str, Any]:
    md = train.MODELS_DIR / version
    rel = lambda p: str(Path(p).relative_to(dataset.ROOT))
    ev = json.loads((md / "evaluation_report.json").read_text())
    model = json.loads((md / "model.json").read_text())
    parity = json.loads((md / "parity_report.json").read_text()) if (md / "parity_report.json").exists() else None
    adv = json.loads((md / "adversarial_report.json").read_text()) if (md / "adversarial_report.json").exists() else None
    repro = json.loads((md / "reproduce_report.json").read_text()) if (md / "reproduce_report.json").exists() else None
    bench, bench_src = latest_benchmark(version)
    sustained, sus_src = sustained_benchmark()
    g = []
    g.append(gate("schema_compatibility", model["feature_schema"] == features.FEATURE_SCHEMA and model["input_dim"] == features.N_FEATURES, {"feature_schema": model["feature_schema"], "input_dim": model["input_dim"]}, {"feature_schema": features.FEATURE_SCHEMA, "input_dim": features.N_FEATURES}, rel(md / "model.json")))
    g.append(gate("reproducibility", None if repro is None else repro["passed"], None if repro is None else {"dataset_hashes": repro["dataset_verification"]["passed"], "max_metric_delta": max(repro["retrained_metric_deltas"].values())}, {"tolerance": 1e-6}, rel(md / "reproduce_report.json") if repro else "run `orbis_ml reproduce`"))
    if parity:
        cm, ox = parity["parity"]["coreml-fp32"], parity["parity"]["onnx-fp32"]
        g.append(gate("coreml_parity", cm["max_abs_probability_delta"] <= BUDGETS["coreml_fp32_parity"] and cm["class_agreement"] == 1.0, {"max_probability_delta": cm["max_abs_probability_delta"], "class_agreement": cm["class_agreement"]}, {"max_probability_delta": BUDGETS["coreml_fp32_parity"]}, rel(md / "parity_report.json")))
        g.append(gate("onnx_parity", ox["max_abs_probability_delta"] <= BUDGETS["coreml_fp32_parity"], {"max_probability_delta": ox["max_abs_probability_delta"]}, {"max_probability_delta": BUDGETS["coreml_fp32_parity"]}, rel(md / "parity_report.json")))
    else:
        g.append(gate("coreml_parity", None, None, BUDGETS["coreml_fp32_parity"], "run `orbis_ml convert`"))
    sp, detail = swift_parity() if run_swift else (None, "skipped")
    g.append(gate("swift_feature_and_model_parity", sp, detail, "all fixtures within 1e-9 (features) / 1e-4 (Core ML)", "apps/macos-endpoint ParityTests"))
    gold_fail = [f["id"] for f in ev["gold"]["failures"]]
    g.append(gate("golden_scenarios_no_regression", not gold_fail, {"failures": gold_fail, "gated": ev["gold"]["n"]}, "0 failures", rel(md / "evaluation_report.json")))
    g.append(gate("gold_high_risk_escalation_recall", ev["gold"]["high_risk_escalation_recall"] >= BUDGETS["gold_high_risk_escalation_recall"], ev["gold"]["high_risk_escalation_recall"], f">= {BUDGETS['gold_high_risk_escalation_recall']}", rel(md / "evaluation_report.json")))
    g.append(gate("gold_suspicious_plus_high_recall", ev["gold"]["risky_escalation_recall"] >= BUDGETS["gold_risky_escalation_recall"], ev["gold"]["risky_escalation_recall"], f">= {BUDGETS['gold_risky_escalation_recall']}", rel(md / "evaluation_report.json")))
    g.append(gate("test_safe_action_precision", ev["test"]["safe_precision"] >= BUDGETS["test_safe_precision"], ev["test"]["safe_precision"], f">= {BUDGETS['test_safe_precision']}", rel(md / "evaluation_report.json")))
    g.append(gate("gold_hard_negative_false_positive_rate", ev["gold"]["hard_negative_false_positive_rate"] <= BUDGETS["gold_hard_negative_fpr"], ev["gold"]["hard_negative_false_positive_rate"], f"<= {BUDGETS['gold_hard_negative_fpr']}", rel(md / "evaluation_report.json")))
    g.append(gate("false_positive_budget", ev["test"]["false_escalation_rate"] <= BUDGETS["test_false_escalation_rate"], ev["test"]["false_escalation_rate"], f"<= {BUDGETS['test_false_escalation_rate']}", rel(md / "evaluation_report.json")))
    g.append(gate("calibration_ece", ev["test"]["ece"] <= BUDGETS["test_ece"], ev["test"]["ece"], f"<= {BUDGETS['test_ece']}", rel(md / "evaluation_report.json")))
    size_kb = (parity["quantization"]["coreml-fp32"]["artifact_bytes"] / 1024) if parity else None
    g.append(gate("model_size", None if size_kb is None else size_kb <= BUDGETS["model_artifact_kb"], None if size_kb is None else round(size_kb, 1), f"<= {BUDGETS['model_artifact_kb']} KB", rel(md / "parity_report.json") if parity else "pending"))
    if bench:
        p95_ms = bench["warm_batch1_us"]["p95"] / 1000
        pipe_ms = bench["pipeline_event_to_signal_us"]["p95"] / 1000
        g.append(gate("endpoint_latency_p95", p95_ms <= BUDGETS["p95_inference_ms"] and pipe_ms <= BUDGETS["p95_pipeline_ms"], {"inference_p95_ms": round(p95_ms, 4), "pipeline_p95_ms": round(pipe_ms, 4), "device": bench["device"]["cpu"]}, f"<= {BUDGETS['p95_inference_ms']} ms", bench_src))
        g.append(gate("endpoint_memory", bench["memory_mb"]["peak_footprint"] <= BUDGETS["peak_memory_mb"], {"peak_footprint_mb": round(bench["memory_mb"]["peak_footprint"], 2), "model_load_delta_mb": round(bench["memory_mb"]["model_load_delta"], 2)}, f"<= {BUDGETS['peak_memory_mb']} MB (whole process)", bench_src))
    else:
        g.append(gate("endpoint_latency_p95", None, None, f"<= {BUDGETS['p95_inference_ms']} ms", "run `orbis-endpoint bench`"))
        g.append(gate("endpoint_memory", None, None, f"<= {BUDGETS['peak_memory_mb']} MB", "run `orbis-endpoint bench`"))
    src = sustained or bench
    if src:
        cpu = src["sustained"]["cpu_percent"]
        g.append(gate("energy_proxy_sustained_cpu", cpu <= BUDGETS["sustained_cpu_percent"], {"cpu_percent_of_one_core": round(cpu, 3), "seconds": round(src["sustained"]["seconds"]), "rate_eps": src["sustained"]["target_rate_eps"], "cpu_ms_per_1k_inferences": round(src["cpu_ms_per_1k_inferences"], 2)}, f"<= {BUDGETS['sustained_cpu_percent']}% of one core at 50 events/s", sus_src or bench_src,
                      "PROXY — energy was not measured (needs powermetrics/Instruments on a physical session). CPU time is the reported stand-in."))
    else:
        g.append(gate("energy_proxy_sustained_cpu", None, None, BUDGETS["sustained_cpu_percent"], "pending"))
    g.append(gate("adversarial_suite", None if adv is None else adv["summary"]["status"] == "pass", None if adv is None else {"required": f"{adv['summary']['required_passed']}/{adv['summary']['required_total']}", "documented_limitations": adv["summary"]["documented_limitations"]}, "all required cases pass", rel(md / "adversarial_report.json") if adv else "run `orbis_ml adversarial`"))
    if baseline:
        base = json.loads((train.MODELS_DIR / baseline / "evaluation_report.json").read_text())
        regress = {}
        for s in PROTECTED_SLICES:
            a, b = base["slices"].get(s, {}), ev["slices"].get(s, {})
            if a.get("risky_escalation_recall") is not None and b.get("risky_escalation_recall") is not None:
                d = b["risky_escalation_recall"] - a["risky_escalation_recall"]
                if d < -BUDGETS["slice_regression"]:
                    regress[s] = round(d, 4)
            if a.get("false_escalation_rate") is not None and b.get("false_escalation_rate") is not None:
                d = b["false_escalation_rate"] - a["false_escalation_rate"]
                if d > BUDGETS["slice_regression"]:
                    regress[s + " (false-escalation)"] = round(d, 4)
        g.append(gate("protected_slice_regression", not regress, regress or "none", f"no protected slice worse than {BUDGETS['slice_regression']:.0%} vs {baseline}", rel(train.MODELS_DIR / baseline / "evaluation_report.json")))
    card = md / "MODEL_CARD.md"
    missing = [s for s in CARD_SECTIONS if card.exists() and f"## {s}" not in card.read_text()] if card.exists() else CARD_SECTIONS
    g.append(gate("model_card_complete", None if not card.exists() else not missing, {"missing_sections": missing}, CARD_SECTIONS, rel(card) if card.exists() else "run `orbis_ml card`"))
    status = "fail" if any(x["status"] == "fail" for x in g) else ("pending" if any(x["status"] == "pending" for x in g) else "pass")
    report = {"model": f"orbis-edge-risk@{version}", "status": status, "eligible_for": "candidate" if status == "pass" else None, "baseline": baseline, "budgets": BUDGETS, "gates": g,
              "promotion_rule": "Only the model control plane can mark a version deployable, and only when every gate passes. Passing gates never auto-promotes."}
    (md / "release_gate_report.json").write_text(json.dumps(report, indent=2, default=float) + "\n")
    return report

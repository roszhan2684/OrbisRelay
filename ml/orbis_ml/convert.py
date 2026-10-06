"""Core ML / ONNX conversion, quantization variants and Python-side parity (blueprint §13, §14).

Conversion starts from the portable weights (`model.json`), not from a live PyTorch object, so the
same path works for any dense model and is repeatable from the registry artifact alone:

  model.json ──MIL builder──▶ OrbisEdgeRisk.mlpackage (mlprogram; FP32 / FP16 / INT8-weights)
            └──onnx.helper──▶ model.onnx (FP32) ──onnxruntime.quantization──▶ model.int8.onnx

Every runtime outputs **logits**; calibration (temperature) and the decision policy are applied by the
host so they can be versioned and rolled independently of the weights.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import warnings
import zipfile
from pathlib import Path
from typing import Any

import numpy as np

from . import dataset, decision, features
from .metrics import softmax, summarize
from .models import portable_logits

warnings.filterwarnings("ignore")
os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")

ROOT = dataset.ROOT
FIXTURES = ROOT / "fixtures" / "parity"
INPUT, OUTPUT = "features", "logits"


def dir_bytes(p: Path) -> int:
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) if p.is_dir() else p.stat().st_size


def sha256_path(p: Path) -> str:
    h = hashlib.sha256()
    files = sorted(f for f in p.rglob("*") if f.is_file()) if p.is_dir() else [p]
    for f in files:
        if p.is_dir():
            h.update(str(f.relative_to(p)).encode())
        h.update(f.read_bytes())
    return h.hexdigest()


def build_coreml(model: dict, precision: str = "fp32"):
    import coremltools as ct
    from coremltools.converters.mil import Builder as mb

    layers = model["layers"]
    n = model["input_dim"]

    @mb.program(input_specs=[mb.TensorSpec(shape=(1, n))], opset_version=ct.target.macOS13)
    def prog(features):
        h = features
        for i, layer in enumerate(layers):
            W = np.asarray(layer["W"], dtype=np.float32)
            b = np.asarray(layer["b"], dtype=np.float32)
            last = i == len(layers) - 1
            h = mb.linear(x=h, weight=W, bias=b, name=OUTPUT if last and layer["activation"] == "none" else f"dense_{i}")
            if layer["activation"] == "relu":
                h = mb.relu(x=h, name=OUTPUT if last else f"relu_{i}")
        return h

    mlm = ct.convert(
        prog,
        convert_to="mlprogram",
        minimum_deployment_target=ct.target.macOS13,
        compute_precision=ct.precision.FLOAT16 if precision == "fp16" else ct.precision.FLOAT32,
    )
    if precision == "int8":
        import coremltools.optimize.coreml as cto

        cfg = cto.OptimizationConfig(global_config=cto.OpLinearQuantizerConfig(mode="linear_symmetric", dtype="int8", weight_threshold=0))
        mlm = cto.linear_quantize_weights(mlm, config=cfg)
    mlm.author = "Orbis Relay"
    mlm.short_description = f"{model['model_name']} {model['version']} ({precision}) — edge risk logits for {features.FEATURE_SCHEMA}"
    mlm.version = model["version"]
    mlm.user_defined_metadata.update({"feature_schema": features.FEATURE_SCHEMA, "classes": ",".join(model["classes"]), "precision": precision, "outputs": "logits"})
    mlm.input_description[INPUT] = f"{n}-dim feature vector ({features.FEATURE_SCHEMA})"
    mlm.output_description[OUTPUT] = "Uncalibrated class logits [safe_normal, safe_unusual, suspicious_review, high_risk]"
    return mlm


def build_onnx(model: dict, path: Path) -> None:
    import onnx
    from onnx import TensorProto, helper, numpy_helper

    nodes, inits = [], []
    prev = INPUT
    for i, layer in enumerate(model["layers"]):
        W = np.asarray(layer["W"], dtype=np.float32)
        b = np.asarray(layer["b"], dtype=np.float32)
        inits += [numpy_helper.from_array(W, f"W{i}"), numpy_helper.from_array(b, f"b{i}")]
        last = i == len(model["layers"]) - 1
        out = OUTPUT if last and layer["activation"] == "none" else f"dense_{i}"
        nodes.append(helper.make_node("Gemm", [prev, f"W{i}", f"b{i}"], [out], transB=1))
        prev = out
        if layer["activation"] == "relu":
            nodes.append(helper.make_node("Relu", [out], [f"relu_{i}"]))
            prev = f"relu_{i}"
    graph = helper.make_graph(
        nodes,
        "orbis_edge_risk",
        [helper.make_tensor_value_info(INPUT, TensorProto.FLOAT, ["batch", model["input_dim"]])],
        [helper.make_tensor_value_info(OUTPUT, TensorProto.FLOAT, ["batch", len(model["classes"])])],
        inits,
    )
    m = helper.make_model(graph, producer_name="orbis-relay", opset_imports=[helper.make_opsetid("", 17)])
    m.ir_version = 9
    m.doc_string = f"{model['model_name']} {model['version']} — logits for {features.FEATURE_SCHEMA}"
    onnx.checker.check_model(m)
    onnx.save(m, str(path))


def quantize_onnx(src: Path, dst: Path) -> None:
    from onnxruntime.quantization import QuantType, quantize_dynamic

    quantize_dynamic(str(src), str(dst), weight_type=QuantType.QInt8)


def parity_fixture_rows(data: dict, policy: decision.DecisionPolicy, ref_logits_test: np.ndarray, n_sample: int = 400) -> tuple[np.ndarray, list[dict]]:
    """Normal, boundary, hard-negative, high-risk and unknown/missing cases (blueprint §40 step 5)."""
    X, y, split, labels = data["X"], data["y"], data["split"], data["labels"]
    te = np.flatnonzero(split == "test")
    probs = softmax(ref_logits_test, policy.temperature)
    risk = probs[:, 2] + probs[:, 3]
    rng = np.random.Generator(np.random.PCG64(11))
    picks: dict[int, str] = {}

    def add(idx, kind):
        for i in idx:
            picks.setdefault(int(i), kind)

    add(rng.choice(te[y[te] == 0], 120, replace=False), "normal")
    add(te[np.argsort(np.abs(risk - policy.tau_review))[:40]], "boundary_review")
    add(te[np.argsort(np.abs(probs[:, 3] - policy.tau_high))[:20]], "boundary_high")
    hn = [i for i in te if labels[i]["difficulty"] == "hard_negative"]
    add(rng.choice(hn, min(60, len(hn)), replace=False), "hard_negative")
    add(te[y[te] == 3][:60], "high_risk")
    add(te[y[te] == 2][:60], "suspicious")
    ood = te[X[te, features.FEATURE_NAMES.index("unknown_fields")] > 0]
    add(ood[:40], "unknown_fields")
    idx = sorted(picks)[: n_sample]
    rows = [{"source": "test", "event_id": labels[i]["event_id"], "kind": picks[i], "label": labels[i]["security_label"]} for i in idx]
    Xf = X[idx]
    Xg = data["Xg"]
    rows += [{"source": "gold", "event_id": g["id"], "kind": "gold", "label": g["expect"]} for g in data["gold"]]
    return np.vstack([Xf, Xg]), rows


def run_coreml(mlm, X: np.ndarray) -> np.ndarray:
    out = np.zeros((len(X), 4))
    for i, x in enumerate(X.astype(np.float32)):
        out[i] = mlm.predict({INPUT: x[None, :]})[OUTPUT][0]
    return out


def run_onnx(path: Path, X: np.ndarray) -> np.ndarray:
    import onnxruntime as ort

    sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
    return sess.run([OUTPUT], {INPUT: X.astype(np.float32)})[0].astype(np.float64)


def convert(version: str = "1.0.0", dataset_version: str = "1.0.0") -> dict[str, Any]:
    import coremltools as ct

    mdir = dataset.ML / "models" / "risk_classifier" / version
    model = json.loads((mdir / "model.json").read_text())
    pol_json = json.loads((mdir / "decision_policy.json").read_text())
    policy = decision.DecisionPolicy(temperature=pol_json["temperature"], tau_high=pol_json["tau_high"], tau_review=pol_json["tau_review"], abstain_entropy=pol_json["abstain_entropy"])
    data = dataset.load(dataset_version)
    te = data["split"] == "test"
    Xte, yte = data["X"][te], data["y"][te]
    ref_te = portable_logits(model, Xte)

    cdir, odir = mdir / "coreml", mdir / "onnx"
    for d in (cdir, odir):
        shutil.rmtree(d, ignore_errors=True)
        d.mkdir(parents=True)
    variants: dict[str, Any] = {}
    for prec in ("fp32", "fp16", "int8"):
        mlm = build_coreml(model, prec)
        p = cdir / f"OrbisEdgeRisk-{prec}.mlpackage"
        mlm.save(str(p))
        loaded = ct.models.MLModel(str(p), compute_units=ct.ComputeUnit.CPU_ONLY)
        variants[f"coreml-{prec}"] = {"path": p, "runner": lambda X, m=loaded: run_coreml(m, X)}
    onnx32, onnx8 = odir / "model.onnx", odir / "model.int8.onnx"
    build_onnx(model, onnx32)
    quantize_onnx(onnx32, onnx8)
    variants["onnx-fp32"] = {"path": onnx32, "runner": lambda X: run_onnx(onnx32, X)}
    variants["onnx-int8"] = {"path": onnx8, "runner": lambda X: run_onnx(onnx8, X)}

    # Parity fixtures shared with Swift and TypeScript.
    Xp, meta = parity_fixture_rows(data, policy, ref_te)
    ref_p = portable_logits(model, Xp)
    ref_d = decision.decide(ref_p, Xp, policy)
    FIXTURES.mkdir(parents=True, exist_ok=True)
    fixture = {
        "model": f"{model['model_name']}@{version}",
        "feature_schema": features.FEATURE_SCHEMA,
        "policy_version": pol_json["version"],
        "tolerances": {"fp32_probability": 1e-4, "portable_float64_logit": 1e-9},
        "cases": [
            {**m, "features": [float(v) for v in x], "logits": [float(v) for v in z], "probs": [float(v) for v in p], "risk": float(r), "class": int(c), "abstain": bool(a), "guarded": bool(gd), "reasons": [r_["code"] for r_ in decision.reasons(x)]}
            for m, x, z, p, r, c, a, gd in zip(meta, Xp, ref_p, ref_d["probs"], ref_d["risk"], ref_d["pred"], ref_d["abstain"], ref_d["guarded"])
        ],
    }
    (FIXTURES / f"edge-risk-{version}.json").write_text(json.dumps(fixture, separators=(",", ":")))

    ref_full = decision.decide(ref_te, Xte, policy)
    ref_metrics = summarize(yte, ref_full["pred"], ref_full["probs"])
    parity, quant = {}, {}
    for name, v in variants.items():
        zp = v["runner"](Xp)
        pp = softmax(zp, policy.temperature)
        dd = decision.decide(zp, Xp, policy)
        zt = v["runner"](Xte)
        dt = decision.decide(zt, Xte, policy)
        mt = summarize(yte, dt["pred"], dt["probs"])
        parity[name] = {
            "cases": len(Xp),
            "max_abs_logit_delta": float(np.abs(zp - ref_p).max()),
            "max_abs_probability_delta": float(np.abs(pp - ref_d["probs"]).max()),
            "class_agreement": float((dd["pred"] == ref_d["pred"]).mean()),
            "test_split_class_agreement": float((dt["pred"] == ref_full["pred"]).mean()),
        }
        quant[name] = {
            "artifact_bytes": dir_bytes(v["path"]),
            "artifact_sha256": sha256_path(v["path"]),
            **{f"delta_{k}": (mt[k] - ref_metrics[k]) if isinstance(mt.get(k), float) and isinstance(ref_metrics.get(k), float) else None for k in ("mean_cost", "macro_f1", "risky_escalation_recall", "high_risk_escalation_recall", "false_escalation_rate", "ece", "brier")},
        }
    tol = {"coreml-fp32": 1e-4, "onnx-fp32": 1e-4, "coreml-fp16": 5e-3, "coreml-int8": 2e-2, "onnx-int8": 2e-2}
    for k, p in parity.items():
        p["tolerance"] = tol[k]
        p["passed"] = p["max_abs_probability_delta"] <= tol[k] and quant[k]["delta_risky_escalation_recall"] is not None and quant[k]["delta_risky_escalation_recall"] >= -0.002
    # Distributable artifacts: zipped mlpackages (endpoints download, verify sha256, unzip, compile).
    dist = mdir / "dist"
    shutil.rmtree(dist, ignore_errors=True)
    dist.mkdir()
    for prec in ("fp32", "fp16", "int8"):
        src = cdir / f"OrbisEdgeRisk-{prec}.mlpackage"
        z = dist / f"OrbisEdgeRisk-{prec}.mlpackage.zip"
        with zipfile.ZipFile(z, "w", zipfile.ZIP_DEFLATED) as zf:
            for f in sorted(src.rglob("*")):
                if f.is_file():
                    info = zipfile.ZipInfo(str(Path(src.name) / f.relative_to(src)), date_time=(2026, 1, 1, 0, 0, 0))
                    info.compress_type = zipfile.ZIP_DEFLATED
                    zf.writestr(info, f.read_bytes())
    report = {
        "model": f"{model['model_name']}@{version}",
        "reference": "portable float64 forward pass (orbis_ml.models.portable_logits)",
        "parity": parity,
        "fixture": f"fixtures/parity/edge-risk-{version}.json",
        "portable_json_bytes": (mdir / "model.json").stat().st_size,
        "quantization": quant,
        "reference_test_metrics": {k: ref_metrics[k] for k in ("mean_cost", "macro_f1", "risky_escalation_recall", "high_risk_escalation_recall", "false_escalation_rate", "ece", "brier")},
        "distributables": {p.name: {"bytes": p.stat().st_size, "sha256": hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(dist.iterdir())},
        "notes": [
            "Latency, memory and CPU are measured on-device by the Swift benchmark harness (apps/macos-endpoint), not here.",
            "INT8 is weight-only linear quantization (activations stay FP16/FP32); for a ~3k-parameter model the size win is small and inference is memory-trivial either way.",
        ],
    }
    (mdir / "parity_report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report

"""Command line for the Orbis ML lifecycle. Run from repo root: `pnpm ml <command>` or
`cd ml && .venv/bin/python -m orbis_ml <command>`."""
from __future__ import annotations

import argparse
import json
import sys


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="orbis_ml", description=__doc__)
    sub = p.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("dataset", help="generate + featurize + write manifest")
    s.add_argument("--version", default="1.0.0")
    s.add_argument("--seed", type=int, default=20261005)
    s = sub.add_parser("verify-dataset", help="reproducibility gate: regenerate and compare hashes")
    s.add_argument("--version", default="1.0.0")
    s = sub.add_parser("train", help="train baselines + candidates, select, export")
    s.add_argument("--dataset", default="1.0.0")
    s.add_argument("--version", default="1.0.0")
    s.add_argument("--seed", type=int, default=0)
    s = sub.add_parser("convert", help="Core ML + ONNX + quantization + parity")
    s.add_argument("--version", default="1.0.0")
    s.add_argument("--dataset", default="1.0.0")
    s = sub.add_parser("feature-fixtures", help="cross-language feature parity fixtures (Swift/TS/C++)")
    s = sub.add_parser("adversarial", help="adversarial + OOD + poisoning suite")
    s.add_argument("--version", default="1.0.0")
    s = sub.add_parser("anomaly", help="evaluate Model B (robust stats vs IsolationForest)")
    s = sub.add_parser("gates", help="compose release_gate_report.json (exit 1 on failure)")
    s.add_argument("--version", default="1.0.0")
    s.add_argument("--baseline", default=None, help="production version for slice-regression checks")
    s.add_argument("--allow-pending", action="store_true")
    s = sub.add_parser("card", help="write MODEL_CARD.md from reports")
    s.add_argument("--version", default="1.0.0")
    s = sub.add_parser("reproduce", help="retrain from manifest and compare metrics within tolerance")
    s.add_argument("--version", default="1.0.0")
    s = sub.add_parser("drift", help="drift report between a reference and a current window")
    s = sub.add_parser("retrain", help="candidate dataset (with reviewed feedback) → retrain → evaluate → register (never promote)")
    s.add_argument("--feedback", default=None, help="JSONL export from GET /v1/ml/feedback/export")
    s.add_argument("--base-dataset", default="1.0.0")
    s.add_argument("--dataset-version", default="1.1.0")
    s.add_argument("--version", default="1.1.0")
    s = sub.add_parser("export", help="publish registry + artifacts to the gateway, endpoint and fixtures")
    a = p.parse_args(argv)

    if a.cmd == "dataset":
        from . import dataset

        m = dataset.build(a.version, a.seed)
        print(json.dumps({k: m[k] for k in ("name", "version", "row_count", "split_counts", "gold", "leakage_checks", "privacy_review")}, indent=2))
    elif a.cmd == "verify-dataset":
        from . import dataset

        r = dataset.verify(a.version)
        print(json.dumps(r, indent=2))
        sys.exit(0 if r["passed"] else 1)
    elif a.cmd == "train":
        from . import train

        print(json.dumps(train.run(a.dataset, a.version, a.seed), indent=2))
    elif a.cmd == "convert":
        from . import convert

        r = convert.convert(a.version, a.dataset)
        print(json.dumps({"parity": r["parity"], "sizes": {k: v["artifact_bytes"] for k, v in r["quantization"].items()}}, indent=2))
    elif a.cmd == "feature-fixtures":
        from . import parity

        print(json.dumps(parity.write_feature_fixtures(), indent=2))
    elif a.cmd == "adversarial":
        from . import adversarial

        r = adversarial.run(a.version)
        print(json.dumps(r["summary"], indent=2))
    elif a.cmd == "anomaly":
        from . import anomaly_eval

        print(json.dumps(anomaly_eval.run(), indent=2))
    elif a.cmd == "gates":
        from . import gates

        r = gates.run(a.version, a.baseline)
        print(json.dumps({g["name"]: g["status"] for g in r["gates"]}, indent=2))
        print(f"\nrelease gate: {r['status']}")
        sys.exit(0 if r["status"] == "pass" or (a.allow_pending and r["status"] == "pending") else 1)
    elif a.cmd == "card":
        from . import card

        print(card.write(a.version))
    elif a.cmd == "reproduce":
        from . import reproduce

        r = reproduce.run(a.version)
        print(json.dumps(r, indent=2))
        sys.exit(0 if r["passed"] else 1)
    elif a.cmd == "drift":
        from . import drift

        print(json.dumps(drift.demo_report(), indent=2))
    elif a.cmd == "retrain":
        from . import retrain

        print(json.dumps(retrain.run(a.feedback, a.base_dataset, a.dataset_version, a.version), indent=2))
    elif a.cmd == "export":
        from . import export

        print(json.dumps(export.run(), indent=2))

"""Python drives the C++20 CLI over the full dataset stream and compares every feature vector."""
from __future__ import annotations

import json
import subprocess
import time
from pathlib import Path

import numpy as np

from . import dataset

CLI = dataset.ROOT / "packages" / "cxx-risk-core" / "build" / "orbis-risk-core"


def run(version: str = "1.0.0") -> dict:
    subprocess.run(["make", "-s", "build/orbis-risk-core"], cwd=CLI.parent.parent, check=True)
    events = (dataset.DATA / dataset.NAME / version / "events.jsonl").read_bytes()
    t = time.perf_counter()
    out = subprocess.run([str(CLI), "features"], input=events, capture_output=True, check=True).stdout.decode().splitlines()
    secs = time.perf_counter() - t
    X = np.load(dataset.DATA / dataset.NAME / version / "features.npy")
    C = np.asarray([json.loads(l)["features"] for l in out])
    delta = np.abs(C - X)
    report = {"dataset": f"{dataset.NAME}@{version}", "vectors": int(len(C)), "max_abs_delta": float(delta.max()), "vectors_over_1e-9": int((delta.max(axis=1) > 1e-9).sum()),
              "bit_identical_vectors": int((delta.max(axis=1) == 0).sum()), "cxx_wall_seconds_incl_json_io": round(secs, 3), "passed": bool(delta.max() <= 1e-9)}
    (CLI.parent.parent / "parity_report.json").write_text(json.dumps(report, indent=2) + "\n")
    return report

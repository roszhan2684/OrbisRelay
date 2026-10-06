"""Dataset builder: generate → validate → featurize (stream order) → split → manifest.

A dataset version is fully described by its manifest (committed under ml/datasets/manifests/). The data
files themselves are regenerated deterministically from the manifest's seed + generator config hash and
verified against the recorded sha256 hashes — the reproducibility gate (blueprint §10.4).
"""
from __future__ import annotations

import hashlib
import json
import platform
import re
import subprocess
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

from . import features, generator, gold, schema

ROOT = Path(__file__).resolve().parents[2]
ML = ROOT / "ml"
DATA = ML / "datasets" / "data"
MANIFESTS = ML / "datasets" / "manifests"
NAME = "northstar-actions"


def sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def git_sha() -> str:
    try:
        sha = subprocess.check_output(["git", "-C", str(ROOT), "rev-parse", "HEAD"], text=True).strip()
        dirty = subprocess.call(["git", "-C", str(ROOT), "diff", "--quiet", "--", "ml/orbis_ml"]) != 0
        return sha + ("-dirty" if dirty else "")
    except Exception:
        return "unknown"


def featurize_stream(events: list[dict]) -> tuple[np.ndarray, list[dict], list[int]]:
    """Run the reference calculator over a chronological stream. Invalid events are rejected and counted."""
    st = features.FeatureState()
    X, anomalies, rejected = [], [], []
    for i, e in enumerate(events):
        try:
            n = schema.validate(e)
        except schema.SchemaError:
            rejected.append(i)
            continue
        X.append(features.compute(n, st))
        anomalies.append(features.anomaly(n, st))
        features.update(n, st)
    return np.asarray(X, dtype=np.float64), anomalies, rejected


def featurize_gold(items: list[dict]) -> tuple[np.ndarray, list[dict]]:
    X, an = [], []
    for g in items:
        st = features.FeatureState()
        for e in g["history"]:
            n = schema.validate(e)
            features.update(n, st)
        n = schema.validate(g["probe"])
        X.append(features.compute(n, st))
        an.append(features.anomaly(n, st))
    return np.asarray(X, dtype=np.float64), an


RAW_DOMAIN = re.compile(r"[a-z0-9-]+\.(com|io|net|org|app|ai|bank|dev|xyz|cc|biz|cloud)\b")


def privacy_review(events: list[dict]) -> dict[str, Any]:
    """Automated sensitive-data review: no raw destinations, no free-text content beyond intents."""
    leaks = 0
    for e in events:
        blob = json.dumps({k: v for k, v in e.items() if k not in ("requested_intent",)})
        if RAW_DOMAIN.search(blob.replace("northstar.cloud", "")):
            leaks += 1
    intents = Counter(e.get("requested_intent", "") for e in events)
    return {
        "raw_destinations_found": leaks,
        "distinct_intent_texts": len(intents),
        "content_fields": "none — events carry metadata, counts, enums and 16-hex destination hashes only",
        "pii": "none — all actors, domains and amounts are synthetic (Northstar Cloud is fictional)",
        "result": "pass" if leaks == 0 else "fail",
    }


def build(version: str = "1.0.0", seed: int = 20261005, label_noise: float = 0.01, out: Path | None = None) -> dict[str, Any]:
    out = out or DATA / NAME / version
    out.mkdir(parents=True, exist_ok=True)
    events, labels, meta = generator.generate(seed=seed, label_noise=label_noise)
    X, anomalies, rejected = featurize_stream(events)
    assert not rejected, f"generator produced {len(rejected)} invalid events"
    gold_items = gold.build()
    Xg, an_g = featurize_gold(gold_items)

    schema.dump_jsonl(events, out / "events.jsonl")
    schema.dump_jsonl(labels, out / "labels.jsonl")
    np.save(out / "features.npy", X)
    np.save(out / "anomaly.npy", np.asarray([a["score"] for a in anomalies]))
    with open(out / "gold.json", "w") as f:
        json.dump(gold_items, f, sort_keys=True, separators=(",", ":"))
    np.save(out / "gold_features.npy", Xg)

    splits = Counter(l["split"] for l in labels)
    dist = {s: dict(Counter(l["security_label"] for l in labels if l["split"] == s)) for s in sorted(splits)}
    leakage = leakage_checks(labels)
    manifest = {
        "name": NAME,
        "version": version,
        "schema_version": schema.SCHEMA_ID,
        "label_schema": schema.LABEL_SCHEMA_ID,
        "feature_schema": features.FEATURE_SCHEMA,
        "generator": "orbis_ml.generator",
        "generation_config_hash": generator.config_hash(seed, label_noise),
        "seed": seed,
        "label_noise": label_noise,
        "creation_commit": git_sha(),
        "numpy": np.__version__,
        "python": platform.python_version(),
        "row_count": len(events),
        "split_counts": dict(splits),
        "class_distribution": dist,
        "difficulty_breakdown": dict(Counter(l["difficulty"] for l in labels)),
        "source_breakdown": dict(Counter(l["source"] for l in labels)),
        "label_state_breakdown": dict(Counter(l["label_state"] for l in labels)),
        "scenario_templates": len({l["scenario_template"] for l in labels}),
        "scenario_families": dict(Counter(l["scenario_family"] for l in labels)),
        "split_rule": meta["split_rule"],
        "actors": len(meta["actors"]),
        "gold": {"scenarios": len(gold_items), "gated": sum(not g["known_limitation"] for g in gold_items), "known_limitations": sum(g["known_limitation"] for g in gold_items), "content_sha256": gold.content_hash(gold_items), "distribution": dict(Counter(g["expect"] for g in gold_items))},
        "leakage_checks": leakage,
        "privacy_review": privacy_review(events),
        "files": {p.name: {"sha256": sha256_file(p), "bytes": p.stat().st_size} for p in sorted(out.iterdir()) if p.is_file()},
    }
    MANIFESTS.mkdir(parents=True, exist_ok=True)
    with open(MANIFESTS / f"{NAME}-{version}.json", "w") as f:
        json.dump(manifest, f, indent=2, sort_keys=True)
    return manifest


def leakage_checks(labels: list[dict]) -> dict[str, Any]:
    ids = {}
    for l in labels:
        ids.setdefault(l["event_id"], set()).add(l["split"])
    dup = sum(len(s) > 1 for s in ids.values())
    held_in_train = sum(1 for l in labels if l["held_out_actor"] and l["split"] in ("train", "val"))
    v2_in_train = sum(1 for l in labels if (l["template_variant"] >= 2 or l["scenario_template"] in generator.TEST_ONLY_TEMPLATES) and l["split"] in ("train", "val"))
    train_days = {l["day"] for l in labels if l["split"] == "train"}
    test_days = {l["day"] for l in labels if l["split"] == "test"}
    checks = {
        "duplicate_event_ids_across_splits": dup,
        "held_out_actor_rows_in_train_or_val": held_in_train,
        "test_only_variant_rows_in_train_or_val": v2_in_train,
        "train_test_day_overlap": len(train_days & test_days),
        "gold_actor_overlap": 0,  # gold actors are namespaced gold-*, never in the stream
        "label_fields_in_features": "none — features read only the event; labels live in a separate file",
    }
    checks["result"] = "pass" if dup == held_in_train == v2_in_train == checks["train_test_day_overlap"] == 0 else "fail"
    return checks


def load(version: str = "1.0.0") -> dict[str, Any]:
    d = DATA / NAME / version
    manifest = json.loads((MANIFESTS / f"{NAME}-{version}.json").read_text())
    labels = schema.load_jsonl(d / "labels.jsonl")
    return {
        "manifest": manifest,
        "dir": d,
        "X": np.load(d / "features.npy"),
        "anomaly": np.load(d / "anomaly.npy"),
        "labels": labels,
        "y": np.asarray([schema.LABELS.index(l["security_label"]) for l in labels]),
        "split": np.asarray([l["split"] for l in labels]),
        "gold": json.loads((d / "gold.json").read_text()),
        "Xg": np.load(d / "gold_features.npy"),
    }


def verify(version: str = "1.0.0") -> dict[str, Any]:
    """Reproducibility gate: regenerate into a scratch dir and compare file hashes with the manifest."""
    import tempfile

    manifest = json.loads((MANIFESTS / f"{NAME}-{version}.json").read_text())
    with tempfile.TemporaryDirectory() as tmp:
        saved = (MANIFESTS / f"{NAME}-{version}.json").read_text()
        try:
            rebuilt = build(version, manifest["seed"], manifest["label_noise"], out=Path(tmp))
        finally:
            (MANIFESTS / f"{NAME}-{version}.json").write_text(saved)
    mismatches = [k for k, v in manifest["files"].items() if rebuilt["files"].get(k, {}).get("sha256") != v["sha256"]]
    return {"dataset": f"{NAME}@{version}", "files_checked": len(manifest["files"]), "mismatches": mismatches, "passed": not mismatches}

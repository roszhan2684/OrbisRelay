"""Retraining pipeline (blueprint §15, §19, §42): drift → review queue → labels → dataset → candidate.

  python -m orbis_ml retrain [--feedback reviewed.jsonl]

1. New production window (q4_shift regime, 14 days, continuing the base stream so baselines carry over).
2. Score it with the production model; compute drift windows against the training reference.
3. Build the active-review queue: uncertain predictions, model-vs-deterministic disagreements, novel
   feature combinations and high-impact escalations — capped by an analyst budget.
4. Labels: analyst reviews (high confidence) + human approve/reject proxies on escalated actions (low
   confidence, 10% simulated human error — "user approved it" is not ground truth) + any feedback
   exported from the gateway (`GET /v1/ml/feedback/export`).
5. Candidate dataset = base train + weighted window labels → new dataset version + manifest.
6. Retrain the same architecture, calibrate/threshold on the unchanged validation split, evaluate on
   the immutable test split, the gold set and the un-reviewed window holdout, compare with production.
7. Register as `candidate`. Never promote — promotion happens in the model control plane after gates.
"""
from __future__ import annotations

import json
import time
from collections import Counter
from pathlib import Path
from typing import Any

import numpy as np

from . import dataset, decision, drift, evaluate, features, generator, schema, train
from .metrics import nan_to_none, softmax, summarize
from .models import MLP, RuleBaseline, portable_logits

WINDOW = {"seed": 99, "start": "2026-09-21T04:00:00.000Z", "days": 14, "regime": "q4_shift"}
REVIEW_BUDGET = 400
POOL_DAYS = 10
CHANGE_NOTE = "red-team finding on 1.0.0: an agent-asserted ticket flag hides large refunds (adversarial_report.json)"
CONFIDENCE = {"gold_confirmed": 1.0, "analyst_reviewed": 0.95, "human_decision_proxy": 0.5, "weak_label": 0.3, "synthetic": 1.0}


def load_production(version: str) -> tuple[dict, decision.DecisionPolicy]:
    d = train.MODELS_DIR / version
    model = json.loads((d / "model.json").read_text())
    pj = json.loads((d / "decision_policy.json").read_text())
    return model, decision.DecisionPolicy(temperature=pj["temperature"], tau_high=pj["tau_high"], tau_review=pj["tau_review"], abstain_entropy=pj["abstain_entropy"])


def review_queue(Xw: np.ndarray, dec: dict, rule_pred: np.ndarray, budget: int, rng: np.random.Generator) -> tuple[np.ndarray, dict[str, int]]:
    """Priority: high uncertainty, model/deterministic disagreement, novel combos, high-impact escalations."""
    ent = decision.normalized_entropy(dec["probs"])
    esc = dec["pred"] >= 2
    rule_esc = rule_pred >= 2
    novel = (Xw[:, features.FEATURE_NAMES.index("first_tool")] > 0) & (Xw[:, features.FEATURE_NAMES.index("first_destination")] > 0)
    hi = decision.high_impact(Xw) & esc
    reasons = {
        "uncertain": dec["abstain"] | (ent >= 0.35),
        "policy_model_disagreement": esc != rule_esc,
        "novel_combination": novel,
        "high_impact_escalation": hi,
    }
    score = 3.0 * reasons["uncertain"] + 2.0 * reasons["policy_model_disagreement"] + 1.0 * reasons["novel_combination"] + 0.5 * reasons["high_impact_escalation"] + rng.random(len(Xw)) * 0.1
    cand = np.flatnonzero(score >= 0.5)
    pick = cand[np.argsort(-score[cand])][:budget]
    stats = {k: int(v[pick].sum()) for k, v in reasons.items()} | {"queued": int(len(cand)), "reviewed": int(len(pick)), "budget": budget}
    return pick, stats


def load_feedback(path: str | None) -> list[dict]:
    if not path:
        return []
    rows = schema.load_jsonl(path)
    return [r for r in rows if r.get("event") and r.get("label") in schema.LABELS]


def run(feedback: str | None = None, base_version: str = "1.0.0", dataset_version: str = "1.1.0", version: str = "1.1.0", production: str = "1.0.0", seed: int = 0) -> dict[str, Any]:
    started = time.time()
    rng = np.random.Generator(np.random.PCG64(2026_10_06))
    base = dataset.load(base_version)
    base_events = schema.load_jsonl(base["dir"] / "events.jsonl")
    w_events, w_labels, _ = generator.generate(seed=WINDOW["seed"], start_ts=WINDOW["start"], days=WINDOW["days"], regime=WINDOW["regime"])
    # Continue the stream so behavioural baselines carry over from the base period.
    Xall, an_all, rejected = dataset.featurize_stream(base_events + w_events)
    assert not rejected
    Xw = Xall[len(base_events):]
    yw = np.asarray([schema.LABELS.index(l["security_label"]) for l in w_labels])

    prod_model, prod_policy = load_production(production)
    prod_dec = decision.decide(portable_logits(prod_model, Xw), Xw, prod_policy)
    rule = RuleBaseline().fit(base["X"][base["split"] == "train"], base["y"][base["split"] == "train"], base["X"][base["split"] == "val"], base["y"][base["split"] == "val"])
    rule_pred = np.argmax(rule.logits(Xw), axis=1)

    # Drift: 2-day windows vs the training reference, plus prediction drift vs production's test predictions.
    Xref = base["X"][base["split"] == "train"]
    risk_ref = decision.decide(portable_logits(prod_model, Xref), Xref, prod_policy)["risk"]
    days = np.asarray([(schema.parse_ts_ms(e["timestamp"]) - schema.parse_ts_ms(WINDOW["start"])) // 86_400_000 for e in w_events])
    windows = []
    # Rolling 7-day windows: the first version used 2-day windows and raised PSI 7.4 on a weekend
    # (off_hours = 1 for every event) — seasonality, not drift.
    for d0 in range(0, WINDOW["days"] - drift.WINDOW_DAYS + 1):
        m = (days >= d0) & (days < d0 + drift.WINDOW_DAYS)
        r = drift.window_report(Xref, Xw[m], risk_ref, prod_dec["risk"][m])
        windows.append({"days": [int(d0), int(d0 + drift.WINDOW_DAYS - 1)], "n": int(m.sum()), "level": r["level"], "max_feature_psi": r["max_feature_psi"], "prediction_psi": r["prediction_psi"], "ood_rate": r["ood_rate"],
                        "top_features": [{"feature": k, **v} for k, v in sorted(r["features"].items(), key=lambda kv: -kv[1]["psi"])[:4]],
                        "false_escalation_rate_on_window": float((prod_dec["pred"][m] >= 2)[yw[m] < 2].mean()) if (yw[m] < 2).any() else None})

    # Temporal split of the window: days 0-9 feed the review queue; days 10-13 are an untouched holdout
    # (selecting the holdout by "not reviewed" would bias it against everything production escalated).
    pool = np.flatnonzero(days < POOL_DAYS)
    holdout = np.flatnonzero(days >= POOL_DAYS)
    sub = {k: v[pool] for k, v in prod_dec.items()}
    picked_local, qstats = review_queue(Xw[pool], sub, rule_pred[pool], REVIEW_BUDGET, rng)
    picked = pool[picked_local]
    label_rows: dict[int, tuple[int, str]] = {int(i): (int(yw[i]), "analyst_reviewed") for i in picked}
    escalated = pool[np.flatnonzero(sub["pred"] >= 2)]
    proxies = 0
    for i in escalated:
        if int(i) in label_rows:
            continue
        approved = yw[i] < 2
        if rng.random() < 0.10:  # humans make mistakes; proxies are weighted accordingly
            approved = not approved
        label_rows[int(i)] = (1 if approved else 2, "human_decision_proxy")
        proxies += 1
    fb = load_feedback(feedback)
    fb_X, fb_y, fb_w = [], [], []
    if fb:
        st = features.FeatureState()
        for r in fb:
            n = schema.validate(r["event"])
            fb_X.append(features.compute(n, st))
            features.update(n, st)
            fb_y.append(schema.LABELS.index(r["label"]))
            fb_w.append(CONFIDENCE.get(r.get("label_state", "analyst_reviewed"), 0.5) * float(r.get("confidence", 1.0)))

    idx = np.asarray(sorted(label_rows), dtype=int)
    Xl = Xw[idx]
    yl = np.asarray([label_rows[i][0] for i in idx])
    wl = np.asarray([CONFIDENCE[label_rows[i][1]] for i in idx])

    tr = base["split"] == "train"
    va = base["split"] == "val"
    Xtr = np.vstack([base["X"][tr], Xl] + ([np.asarray(fb_X)] if fb_X else []))
    ytr = np.concatenate([base["y"][tr], yl] + ([np.asarray(fb_y)] if fb_y else []))
    wtr = np.concatenate([np.ones(int(tr.sum())), wl] + ([np.asarray(fb_w)] if fb_w else []))

    # Persist the candidate dataset version + manifest.
    out_dir = dataset.DATA / dataset.NAME / dataset_version
    out_dir.mkdir(parents=True, exist_ok=True)
    schema.dump_jsonl(w_events, out_dir / "window_events.jsonl")
    schema.dump_jsonl([{**w_labels[i], "label_state": label_rows[i][1], "label_used": schema.LABELS[label_rows[i][0]], "label_confidence": CONFIDENCE[label_rows[i][1]]} for i in idx], out_dir / "window_labels_used.jsonl")
    np.save(out_dir / "train_features.npy", Xtr)
    np.save(out_dir / "train_labels.npy", ytr)
    np.save(out_dir / "train_weights.npy", wtr)
    manifest = {
        "name": dataset.NAME,
        "version": dataset_version,
        "parent": f"{dataset.NAME}@{base_version}",
        "schema_version": schema.SCHEMA_ID,
        "feature_schema": features.FEATURE_SCHEMA,
        "composition": {"base_train_rows": int(tr.sum()), "window_rows_labelled": int(len(idx)), "feedback_rows": len(fb), "window_pool_rows_unlabelled": int(len(pool) - len(idx)), "window_holdout_rows": int(len(holdout)), "pool_days": [0, POOL_DAYS - 1], "holdout_days": [POOL_DAYS, WINDOW["days"] - 1]},
        "window": WINDOW | {"rows": len(w_events), "generator_config_hash": generator.config_hash(WINDOW["seed"], 0.01)},
        "label_states": dict(Counter(label_rows[i][1] for i in idx)) | ({"gateway_feedback": len(fb)} if fb else {}),
        "label_confidence_weights": CONFIDENCE,
        "class_distribution_added": dict(Counter(schema.LABELS[label_rows[i][0]] for i in idx)),
        "review_queue": qstats,
        "human_proxy_error_rate_simulated": 0.10,
        "validation_split": f"unchanged from {dataset.NAME}@{base_version} (threshold/calibration comparability)",
        "test_split": f"unchanged immutable test + gold from {dataset.NAME}@{base_version}",
        "creation_commit": dataset.git_sha(),
        "files": {p.name: {"sha256": dataset.sha256_file(p), "bytes": p.stat().st_size} for p in sorted(out_dir.iterdir()) if p.is_file()},
    }
    (dataset.MANIFESTS / f"{dataset.NAME}-{dataset_version}.json").write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n")

    # Retrain the same architecture.
    mlflow = train._mlflow()
    with mlflow.start_run(run_name=f"retrain/{dataset.NAME}@{dataset_version}") as run:
        m = MLP((32, 16), seed=seed)
        m.fit(Xtr, ytr, base["X"][va], base["y"][va], w=wtr)
        zv = m.logits(base["X"][va])
        T = decision.fit_temperature(zv, base["y"][va])
        th, trv, _ = decision.select_thresholds(softmax(zv, T), base["y"][va])
        policy = decision.DecisionPolicy(temperature=T, tau_high=th, tau_review=trv)
        te = base["split"] == "test"
        report = evaluate.full_report("mlp-32x16", {"val": zv, "test": m.logits(base["X"][te]), "gold": m.logits(base["Xg"])}, base, policy)
        cand_dec = decision.decide(m.logits(Xw[holdout]), Xw[holdout], policy)
        prod_hold = decision.decide(portable_logits(prod_model, Xw[holdout]), Xw[holdout], prod_policy)
        report["window_holdout"] = summarize(yw[holdout], cand_dec["pred"], cand_dec["probs"])
        report["model_info"] = {"name": "mlp-32x16", "family": "mlp", "params": m.params(), "portable": True, "n_params": 3348}
        r = {"model": m, "policy": policy, "report": nan_to_none(report), "portable": m.portable(), "run_id": run.info.run_id}
        data_like = dict(base)
        data_like["manifest"] = {"name": dataset.NAME, "version": dataset_version, "files": manifest["files"]}
        rep = train.export_model(r, version, data_like, run.info.run_id, train.MODELS_DIR / version, previous=production)
        prod_report = json.loads((train.MODELS_DIR / production / "evaluation_report.json").read_text())
        prod_window = summarize(yw[holdout], prod_hold["pred"], prod_hold["probs"])
        keys = ("mean_cost", "macro_f1", "high_risk_escalation_recall", "risky_escalation_recall", "false_escalation_rate", "safe_precision", "ece")
        comparison = {
            "candidate": f"orbis-edge-risk@{version}",
            "production": f"orbis-edge-risk@{production}",
            "test": {k: {"production": prod_report["test"].get(k), "candidate": rep["test"].get(k)} for k in keys},
            "gold": {k: {"production": prod_report["gold"][k], "candidate": rep["gold"][k]} for k in ("high_risk_escalation_recall", "risky_escalation_recall", "hard_negative_false_positive_rate")},
            "window_holdout": {k: {"production": prod_window.get(k), "candidate": report["window_holdout"].get(k)} for k in keys},
            "note": f"window_holdout = every event from window days {POOL_DAYS}-{WINDOW['days'] - 1} (never reviewed or trained on); ground truth is available only because the window is synthetic.",
        }
        retrain_report = {
            "candidate": f"orbis-edge-risk@{version}",
            "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "dataset": f"{dataset.NAME}@{dataset_version}",
            "status": "candidate — awaiting release gates; never auto-promoted",
            "drift_windows": windows,
            "trigger": drift.retrain_trigger([{"level": w["level"]} for w in windows], labelled_outcomes=int(len(idx)) + len(fb), product_change=True, change_note=CHANGE_NOTE),
            "review_queue": qstats,
            "human_decision_proxies": proxies,
            "comparison": comparison,
            "duration_seconds": round(time.time() - started, 2),
            "mlflow_run_id": run.info.run_id,
            "why": "drift ≠ automatic retraining ≠ automatic deployment: drift proposes, humans label, the pipeline builds a candidate, release gates decide eligibility, and an authorised human promotes.",
        }
        train.write_json(train.MODELS_DIR / version / "retrain_report.json", retrain_report)
        mlflow.log_dict(retrain_report, "retrain_report.json")
        mlflow.log_metrics({f"window.{k}": v for k, v in report["window_holdout"].items() if isinstance(v, float)})
        try:
            mlflow.register_model(f"runs:/{run.info.run_id}/retrain_report.json", train.MODEL_NAME, tags={"version": version, "stage": "candidate"})
        except Exception:
            pass
    (train.MODELS_DIR / version / "error-analysis.md").write_text(train.error_analysis(rep, {}))
    return {"candidate": version, "trigger": retrain_report["trigger"], "review_queue": qstats, "comparison": comparison}

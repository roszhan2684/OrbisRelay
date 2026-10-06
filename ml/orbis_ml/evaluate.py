"""Evaluation harness: overall + per-class metrics, calibration, slices, gold set, adversarial suite."""
from __future__ import annotations

from typing import Any

import numpy as np

from . import features
from .decision import DecisionPolicy, decide, sweep
from .metrics import COST, summarize

F = features.FEATURE_NAMES.index


def slice_masks(X: np.ndarray, labels: list[dict]) -> dict[str, np.ndarray]:
    """Required slices (blueprint §11.3), derived from feature columns and label metadata."""
    col = lambda n: X[:, F(n)] > 0.5
    m: dict[str, np.ndarray] = {}
    for at in ("human", "agent", "service", "automation"):
        m[f"actor_type={at}"] = col(f"actor_type={at}")
    for act in ("external_send", "model_provider_send", "file_upload", "bulk_download", "payment", "refund", "privilege_grant", "production_deploy", "destructive_delete", "secrets_access", "database_query", "tool_invoke"):
        m[f"action={act}"] = col(f"action_type={act}")
    rank = X[:, F("class_rank")] * 4
    m["sensitivity=public_internal"] = rank <= 1
    m["sensitivity=confidential_plus"] = rank >= 2
    for tr in ("trusted", "approved", "unverified"):
        m[f"destination_trust={tr}"] = col(f"destination_trust={tr}") & ~col("destination_type=none")
    m["destination=first_seen"] = col("first_destination")
    m["destination=known"] = ~col("first_destination") & ~col("destination_type=none")
    m["time=business_hours"] = ~col("off_hours")
    m["time=off_hours"] = col("off_hours")
    rate = X[:, F("rate_1h")]
    m["activity=low"] = rate <= np.log1p(1) / 8
    m["activity=high"] = rate >= np.log1p(10) / 8
    m["provider=external_ai"] = col("destination_type=external_ai_provider")
    m["provider=internal_model"] = col("destination_type=internal_model")
    diff = np.asarray([l.get("difficulty", "easy") for l in labels])
    m["difficulty=hard_negative"] = diff == "hard_negative"
    m["difficulty=adversarial"] = diff == "adversarial"
    m["ood=unknown_fields"] = X[:, F("unknown_fields")] > 0
    held = np.asarray([bool(l.get("held_out_actor")) for l in labels])
    m["actor=held_out_instance"] = held
    variant = np.asarray([int(l.get("template_variant", 0)) for l in labels])
    m["template=unseen_variant"] = variant >= 2
    return m


def slice_table(X, y, pred, labels) -> dict[str, dict[str, Any]]:
    out = {}
    for name, mask in slice_masks(X, labels).items():
        n = int(mask.sum())
        if n == 0:
            continue
        yy, pp = y[mask], pred[mask]
        risky = yy >= 2
        esc = pp >= 2
        out[name] = {
            "n": n,
            "risky": int(risky.sum()),
            "risky_escalation_recall": float(esc[risky].mean()) if risky.any() else None,
            "false_escalation_rate": float(esc[~risky].mean()) if (~risky).any() else None,
            "mean_cost": float(COST[yy, pp].mean()),
            "accuracy": float((yy == pp).mean()),
        }
    return out


def gold_eval(Xg: np.ndarray, logits: np.ndarray, gold: list[dict], policy: DecisionPolicy) -> dict[str, Any]:
    d = decide(logits, Xg, policy)
    rows = []
    for i, g in enumerate(gold):
        expect_esc = g["expect"] in ("suspicious_review", "high_risk")
        pred = int(d["pred"][i])
        got_esc = pred >= 2
        rows.append({
            "id": g["id"], "title": g["title"], "expect": g["expect"], "predicted": ["safe_normal", "safe_unusual", "suspicious_review", "high_risk"][pred],
            "risk": round(float(d["risk"][i]), 4), "p_high": round(float(d["probs"][i, 3]), 4), "abstain": bool(d["abstain"][i]), "guarded": bool(d["guarded"][i]),
            "correct_escalation": got_esc == expect_esc, "exact": ["safe_normal", "safe_unusual", "suspicious_review", "high_risk"].index(g["expect"]) == pred or (not expect_esc and not got_esc),
            "tags": g["tags"], "known_limitation": g["known_limitation"],
        })
    gated = [r for r in rows if not r["known_limitation"]]
    hi = [r for r in gated if r["expect"] == "high_risk"]
    risky = [r for r in gated if r["expect"] in ("suspicious_review", "high_risk")]
    safe = [r for r in gated if r["expect"] in ("safe_normal", "safe_unusual")]
    hn = [r for r in safe if "hard_negative" in r["tags"]]
    pred_safe = [r for r in gated if r["predicted"] in ("safe_normal", "safe_unusual")]
    return {
        "n": len(gated),
        "high_risk_escalation_recall": sum(r["correct_escalation"] for r in hi) / len(hi),
        "high_risk_strict_recall": sum(r["predicted"] == "high_risk" for r in hi) / len(hi),
        "risky_escalation_recall": sum(r["correct_escalation"] for r in risky) / len(risky),
        "safe_precision": sum(r["expect"] in ("safe_normal", "safe_unusual") for r in pred_safe) / max(1, len(pred_safe)),
        "false_escalation_rate": sum(not r["correct_escalation"] for r in safe) / len(safe),
        "hard_negative_false_positive_rate": sum(not r["correct_escalation"] for r in hn) / max(1, len(hn)),
        "known_limitations": [r for r in rows if r["known_limitation"]],
        "failures": [r for r in gated if not r["correct_escalation"]],
        "scenarios": rows,
    }


def isotonic_comparison(zv, yv, zt, yt) -> dict[str, Any]:
    """Compare no calibration / temperature / one-vs-rest isotonic on the test split (report only)."""
    from sklearn.isotonic import IsotonicRegression

    from .decision import fit_temperature
    from .metrics import brier, ece, softmax

    p_raw_v, p_raw_t = softmax(zv), softmax(zt)
    T = fit_temperature(zv, yv)
    iso = []
    for k in range(4):
        r = IsotonicRegression(out_of_bounds="clip").fit(p_raw_v[:, k], (yv == k).astype(float))
        iso.append(r.predict(p_raw_t[:, k]))
    p_iso = np.clip(np.stack(iso, 1), 1e-6, 1)
    p_iso = p_iso / p_iso.sum(1, keepdims=True)
    return {
        "none": {"ece": ece(p_raw_t, yt), "brier": brier(p_raw_t, yt)},
        "temperature": {"T": T, "ece": ece(softmax(zt, T), yt), "brier": brier(softmax(zt, T), yt)},
        "isotonic_ovr": {"ece": ece(p_iso, yt), "brier": brier(p_iso, yt), "note": "4 monotone maps + renormalisation; not portable to the edge without a lookup table"},
    }


def full_report(name: str, logits_by_split: dict[str, np.ndarray], data: dict, policy: DecisionPolicy) -> dict[str, Any]:
    X, y, split, labels = data["X"], data["y"], data["split"], data["labels"]
    report: dict[str, Any] = {"model": name, "policy": policy.to_json()}
    for s in ("val", "test"):
        m = split == s
        d = decide(logits_by_split[s], X[m], policy)
        summ = summarize(y[m], d["pred"], d["probs"])
        summ["abstention_rate"] = float(d["abstain"].mean())
        summ["guard_escalations"] = int(d["guarded"].sum())
        report[s] = summ
        if s == "test":
            lab = [labels[i] for i in np.flatnonzero(m)]
            report["slices"] = slice_table(X[m], y[m], d["pred"], lab)
            sw = sweep(d["probs"], y[m])
            report["threshold_sweep"] = {
                "fixed_tau_high": [r for r in sw if abs(r["tau_high"] - policy.tau_high) < 1e-9],
                "fixed_tau_review": [r for r in sw if abs(r["tau_review"] - policy.tau_review) < 1e-9],
            }
            fam = {}
            for i, l in zip(np.flatnonzero(m), lab):
                fam.setdefault(l["scenario_template"], []).append(i)
            pred_full = np.full(len(y), -1)
            pred_full[m] = d["pred"]
            report["templates"] = {
                k: {"n": len(ix), "label": labels[ix[0]]["security_label"], "family": labels[ix[0]]["scenario_family"], "escalated": float((pred_full[ix] >= 2).mean())}
                for k, ix in sorted(fam.items())
            }
    report["gold"] = gold_eval(data["Xg"], logits_by_split["gold"], data["gold"], policy)
    return report

"""Model B evaluation: robust per-actor statistics vs an Isolation Forest baseline, and the value of
fusing the anomaly signal with Model A (blueprint §7 Model B, Phase 12 gate)."""
from __future__ import annotations

import json
from typing import Any

import numpy as np
from sklearn.ensemble import IsolationForest
from sklearn.metrics import average_precision_score, roc_auc_score

from . import dataset, decision, features, train
from .models import portable_logits

BEHAVIOURAL = {"outbound_burst", "gradual_export_ramp", "queue_breach", "split_exfiltration", "refund_spike", "refund_extreme", "just_under_threshold_payments", "privesc_then_export"}
IF_FEATURES = ["resource_z", "rate_ratio", "rate_1h", "rate_5m", "unique_dest_1h", "first_destination", "first_tool", "first_action", "amount_log", "resource_log"]
ANOMALY_ESCALATE = 0.85


def run(version: str = "1.0.0") -> dict[str, Any]:
    d = dataset.load("1.0.0")
    X, y, split, labels, an = d["X"], d["y"], d["split"], d["labels"], d["anomaly"]
    te, tr = split == "test", split == "train"
    templ = np.asarray([l["scenario_template"] for l in labels])
    pos = te & np.isin(templ, list(BEHAVIOURAL)) & (y >= 2)
    neg = te & (y < 2)
    m = pos | neg
    target = pos[m].astype(int)
    idx = [features.FEATURE_NAMES.index(n) for n in IF_FEATURES]
    iso = IsolationForest(n_estimators=200, random_state=0).fit(X[tr & (y == 0)][:, idx])
    if_score = -iso.score_samples(X[m][:, idx])
    robust = an[m]
    res = {
        "positives": int(pos.sum()),
        "negatives": int(neg.sum()),
        "definition": "positives = risky test events from behavioural templates (bursts, ramps, out-of-scope access, split exfiltration, amount outliers, structuring, post-elevation export); negatives = safe test events",
        "robust_median_mad": {"roc_auc": float(roc_auc_score(target, robust)), "pr_auc": float(average_precision_score(target, robust)), "portable": True, "state": "per-actor 200-sample rings"},
        "isolation_forest": {"roc_auc": float(roc_auc_score(target, if_score)), "pr_auc": float(average_precision_score(target, if_score)), "portable": False, "note": "global model over the same behavioural features; no per-actor context"},
    }
    # Fusion: escalate when Model A escalates OR (anomaly ≥ threshold on a high-impact action).
    md = train.MODELS_DIR / version
    model = json.loads((md / "model.json").read_text())
    pj = json.loads((md / "decision_policy.json").read_text())
    pol = decision.DecisionPolicy(pj["temperature"], pj["tau_high"], pj["tau_review"], pj["abstain_entropy"])
    dec = decision.decide(portable_logits(model, X[te]), X[te], pol)
    esc_a = dec["pred"] >= 2
    esc_f = esc_a | ((an[te] >= ANOMALY_ESCALATE) & decision.high_impact(X[te]))
    yt = y[te]
    diff = np.asarray([l["difficulty"] for l, t in zip(labels, te) if t])
    def stats(esc):
        return {
            "risky_escalation_recall": float(esc[yt >= 2].mean()),
            "false_escalation_rate": float(esc[yt < 2].mean()),
            "hard_negative_false_escalation_rate": float(esc[(yt < 2) & (diff == "hard_negative")].mean()),
            "behavioural_recall": float(esc[np.isin(templ[te], list(BEHAVIOURAL)) & (yt >= 2)].mean()),
        }
    res["fusion"] = {"model_a_only": stats(esc_a), "model_a_or_anomaly": stats(esc_f), "anomaly_threshold": ANOMALY_ESCALATE,
                     "decision": "Anomaly is shown to reviewers and used for routing; it escalates on its own only for high-impact actions, and only if it adds recall without breaching the hard-negative FPR budget."}
    a, f = res["fusion"]["model_a_only"], res["fusion"]["model_a_or_anomaly"]
    res["fusion"]["adopt_auto_escalation"] = bool(f["risky_escalation_recall"] > a["risky_escalation_recall"] and f["hard_negative_false_escalation_rate"] <= 0.05)
    (md / "anomaly_report.json").write_text(json.dumps(res, indent=2) + "\n")
    return res

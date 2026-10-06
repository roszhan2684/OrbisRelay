"""Security-oriented evaluation metrics (blueprint §11).

Accuracy is never reported on its own. The headline quantities are escalation recall for risky classes,
false-escalation rate on safe traffic (the productivity cost), calibration and an explicit cost matrix.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np
from sklearn.metrics import average_precision_score, roc_auc_score

from .schema import LABELS

K = len(LABELS)
SAFE = (0, 1)
RISKY = (2, 3)

# COST[true][pred] — false allow of high-risk is extremely expensive; false review of safe work is a
# productivity cost; safe-unusual sent to review is moderate friction; suspicious called high-risk is
# acceptable but costly (it blocks instead of asking).
COST = np.array(
    [
        [0.0, 0.2, 1.0, 2.0],   # safe_normal
        [0.5, 0.0, 0.5, 2.0],   # safe_unusual
        [10.0, 8.0, 0.0, 0.5],  # suspicious_review
        [50.0, 40.0, 3.0, 0.0],  # high_risk
    ]
)


def softmax(z: np.ndarray, T: float = 1.0) -> np.ndarray:
    z = z / T
    z = z - z.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e / e.sum(axis=1, keepdims=True)


def confusion(y: np.ndarray, pred: np.ndarray) -> np.ndarray:
    m = np.zeros((K, K), dtype=int)
    np.add.at(m, (y, pred), 1)
    return m


def per_class(cm: np.ndarray) -> dict[str, dict[str, float]]:
    out = {}
    for k, name in enumerate(LABELS):
        tp = cm[k, k]
        fp = cm[:, k].sum() - tp
        fn = cm[k, :].sum() - tp
        p = tp / (tp + fp) if tp + fp else 0.0
        r = tp / (tp + fn) if tp + fn else 0.0
        f = 2 * p * r / (p + r) if p + r else 0.0
        out[name] = {"precision": float(p), "recall": float(r), "f1": float(f), "support": int(cm[k, :].sum())}
    return out


def ece(probs: np.ndarray, y: np.ndarray, bins: int = 15) -> float:
    """Top-label expected calibration error."""
    conf = probs.max(axis=1)
    pred = probs.argmax(axis=1)
    edges = np.linspace(0, 1, bins + 1)
    total = 0.0
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (conf > lo) & (conf <= hi)
        if m.any():
            total += m.mean() * abs((pred[m] == y[m]).mean() - conf[m].mean())
    return float(total)


def reliability(scores: np.ndarray, target: np.ndarray, bins: int = 10) -> list[dict[str, float]]:
    """Reliability curve for the scalar risk (P(suspicious)+P(high)) vs observed risky rate."""
    edges = np.linspace(0, 1, bins + 1)
    out = []
    for lo, hi in zip(edges[:-1], edges[1:]):
        m = (scores >= lo) & (scores < hi if hi < 1 else scores <= hi)
        if m.any():
            out.append({"bin": [float(lo), float(hi)], "mean_predicted": float(scores[m].mean()), "observed": float(target[m].mean()), "n": int(m.sum())})
    return out


def brier(probs: np.ndarray, y: np.ndarray) -> float:
    onehot = np.eye(K)[y]
    return float(((probs - onehot) ** 2).sum(axis=1).mean())


def risky_scores(probs: np.ndarray) -> np.ndarray:
    return probs[:, 2] + probs[:, 3]


def summarize(y: np.ndarray, pred: np.ndarray, probs: np.ndarray | None) -> dict[str, Any]:
    cm = confusion(y, pred)
    pc = per_class(cm)
    risky_true = np.isin(y, RISKY)
    escalated = np.isin(pred, RISKY)
    safe_true = ~risky_true
    hi = y == 3
    out: dict[str, Any] = {
        "n": int(len(y)),
        "confusion_matrix": cm.tolist(),
        "labels": LABELS,
        "per_class": pc,
        "macro_f1": float(np.mean([pc[n]["f1"] for n in LABELS])),
        "weighted_f1": float(sum(pc[n]["f1"] * pc[n]["support"] for n in LABELS) / max(1, len(y))),
        "accuracy": float((y == pred).mean()),
        # Security headline metrics
        "high_risk_escalation_recall": float(escalated[hi].mean()) if hi.any() else None,
        "high_risk_strict_recall": float((pred[hi] == 3).mean()) if hi.any() else None,
        "risky_escalation_recall": float(escalated[risky_true].mean()) if risky_true.any() else None,
        "safe_precision": float(safe_true[~escalated].mean()) if (~escalated).any() else None,
        "false_escalation_rate": float(escalated[safe_true].mean()) if safe_true.any() else None,
        "false_allow_rate": float((~escalated[risky_true]).mean()) if risky_true.any() else None,
        "mean_cost": float(COST[y, pred].mean()),
        "total_cost": float(COST[y, pred].sum()),
    }
    if probs is not None:
        r = risky_scores(probs)
        out["ece"] = ece(probs, y)
        out["brier"] = brier(probs, y)
        if 0 < risky_true.sum() < len(y):
            out["risky_pr_auc"] = float(average_precision_score(risky_true, r))
            out["risky_roc_auc"] = float(roc_auc_score(risky_true, r))
        if 0 < hi.sum() < len(y):
            out["high_risk_pr_auc"] = float(average_precision_score(hi, probs[:, 3]))
        out["per_class_pr_auc"] = {LABELS[k]: (float(average_precision_score(y == k, probs[:, k])) if 0 < (y == k).sum() < len(y) else None) for k in range(K)}
        out["reliability_risky"] = reliability(r, risky_true.astype(float))
    return out


def nan_to_none(x):
    if isinstance(x, float) and (math.isnan(x) or math.isinf(x)):
        return None
    if isinstance(x, dict):
        return {k: nan_to_none(v) for k, v in x.items()}
    if isinstance(x, list):
        return [nan_to_none(v) for v in x]
    return x

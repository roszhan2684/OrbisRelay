"""Drift detection (blueprint §18) — interpretable statistics only.

  input drift       PSI (quantile bins from the reference window) for numeric features,
                    Jensen-Shannon divergence for one-hot categorical blocks, two-sample KS where useful
  prediction drift  PSI on the calibrated risk score and the predicted-class distribution
  OOD rate          share of events with unknown schema fields

Alert levels: info (PSI ≥ 0.1), warn (PSI ≥ 0.25 on an important feature in ≥ 2 consecutive windows),
critical (quality regression on a labelled sample, or OOD rate ≥ 5%).

Drift ≠ retraining ≠ deployment: a sustained alert only *proposes* a candidate retraining run, and
every retrained model still has to pass the full release gates before anyone can promote it.
"""
from __future__ import annotations

import math
from typing import Any

import numpy as np

from . import features

IMPORTANT = ["resource_log", "amount_log", "rate_1h", "rate_ratio", "first_destination", "x_sensitive_external", "x_sensitive_untrusted", "class_rank", "off_hours", "unique_dest_1h"]
PSI_INFO, PSI_WARN = 0.1, 0.25
WINDOW_DAYS = 7  # weekly windows: shorter ones alias weekly seasonality (weekends) into "drift"
OOD_CRITICAL = 0.05
EPS = 1e-4


def psi(ref: np.ndarray, cur: np.ndarray, bins: int = 10) -> float:
    qs = np.unique(np.quantile(ref, np.linspace(0, 1, bins + 1)))
    if len(qs) < 3:  # (near-)binary feature: compare category frequencies directly
        vals = np.unique(np.concatenate([ref, cur]))
        p = np.array([(ref == v).mean() for v in vals])
        q = np.array([(cur == v).mean() for v in vals])
    else:
        edges = np.concatenate([[-np.inf], qs[1:-1], [np.inf]])
        p = np.histogram(ref, edges)[0] / len(ref)
        q = np.histogram(cur, edges)[0] / len(cur)
    p, q = np.clip(p, EPS, None), np.clip(q, EPS, None)
    return float(((q - p) * np.log(q / p)).sum())


def js_divergence(p: np.ndarray, q: np.ndarray) -> float:
    p = np.clip(p / p.sum(), EPS, None)
    q = np.clip(q / q.sum(), EPS, None)
    m = (p + q) / 2
    kl = lambda a, b: float((a * np.log(a / b)).sum())
    return 0.5 * kl(p, m) + 0.5 * kl(q, m)


def ks(ref: np.ndarray, cur: np.ndarray) -> dict[str, float]:
    from scipy.stats import ks_2samp

    r = ks_2samp(ref, cur)
    return {"statistic": float(r.statistic), "p_value": float(r.pvalue)}


def window_report(Xref: np.ndarray, Xcur: np.ndarray, risk_ref: np.ndarray | None = None, risk_cur: np.ndarray | None = None) -> dict[str, Any]:
    names = features.FEATURE_NAMES
    feats = {}
    for n in IMPORTANT:
        i = names.index(n)
        feats[n] = {"psi": psi(Xref[:, i], Xcur[:, i]), "ref_mean": float(Xref[:, i].mean()), "cur_mean": float(Xcur[:, i].mean())}
    blocks = {}
    off = 0
    for block, vocab in features.ONE_HOT_BLOCKS:
        w = len(vocab) + 1
        blocks[block] = js_divergence(Xref[:, off : off + w].sum(0) + 1, Xcur[:, off : off + w].sum(0) + 1)
        off += w
    ood = float((Xcur[:, names.index("unknown_fields")] > 0).mean())
    out = {"n_ref": int(len(Xref)), "n_cur": int(len(Xcur)), "features": feats, "categorical_js": blocks, "ood_rate": ood}
    if risk_ref is not None and risk_cur is not None:
        out["prediction_psi"] = psi(risk_ref, risk_cur)
        out["prediction_ks"] = ks(risk_ref, risk_cur)
        out["mean_risk"] = {"ref": float(risk_ref.mean()), "cur": float(risk_cur.mean())}
    worst = max(v["psi"] for v in feats.values())
    out["max_feature_psi"] = worst
    out["level"] = "critical" if ood >= OOD_CRITICAL else "warn" if worst >= PSI_WARN or out.get("prediction_psi", 0) >= PSI_WARN else "info" if worst >= PSI_INFO else "ok"
    return out


def retrain_trigger(windows: list[dict[str, Any]], labelled_outcomes: int, product_change: bool = False, sustain: int = 2, min_labels: int = 200, change_note: str | None = None) -> dict[str, Any]:
    """Propose (never execute) a candidate retraining run."""
    streak = 0
    for w in windows:
        streak = streak + 1 if w["level"] in ("warn", "critical") else 0
    sustained = streak >= sustain
    enough = labelled_outcomes >= min_labels
    propose = (sustained and enough) or product_change
    return {
        "sustained_windows": streak,
        "sustained_required": sustain,
        "labelled_outcomes": labelled_outcomes,
        "labels_required": min_labels,
        "product_change": product_change,
        "propose_candidate_retraining": propose,
        "auto_promote": False,
        "reason": ("sustained drift with enough labelled outcomes" if sustained and enough else f"known change: {change_note or 'product change'}" if product_change else "insufficient evidence — keep monitoring"),
    }


def demo_report() -> dict[str, Any]:
    """Reference = training split; windows = the q4_shift production window, daily."""
    from . import dataset, generator, schema
    from .dataset import featurize_stream

    data = dataset.load("1.0.0")
    Xref = data["X"][data["split"] == "train"]
    events, labels, _ = generator.generate(seed=99, start_ts="2026-09-21T04:00:00.000Z", days=14, regime="q4_shift")
    Xw, _, _ = featurize_stream(events)
    days = np.asarray([(schema.parse_ts_ms(e["timestamp"]) - schema.parse_ts_ms("2026-09-21T04:00:00.000Z")) // 86_400_000 for e in events])
    windows = []
    for d0 in range(0, 14 - WINDOW_DAYS + 1):
        m = (days >= d0) & (days < d0 + WINDOW_DAYS)
        r = window_report(Xref, Xw[m])
        r["window"] = [int(d0), int(d0 + WINDOW_DAYS - 1)]
        windows.append({k: r[k] for k in ("window", "n_cur", "max_feature_psi", "ood_rate", "level")} | {"top": sorted(r["features"].items(), key=lambda kv: -kv[1]["psi"])[:3]})
    return {"reference": "northstar-actions@1.0.0 train split", "windows": windows, "trigger": retrain_trigger(windows, labelled_outcomes=0)}

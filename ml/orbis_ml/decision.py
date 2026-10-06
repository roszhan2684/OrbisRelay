"""Calibration + decision policy (the part of the model that turns logits into an edge risk signal).

Kept as a separate, separately-versioned artifact from the base model weights (blueprint §11.4):
  probs     = softmax(logits / T)                      (temperature scaling, fit on validation NLL)
  risk      = P(suspicious_review) + P(high_risk)      (calibrated scalar shown to humans)
  class     = high_risk          if P(high) ≥ τ_high
              suspicious_review  elif risk ≥ τ_review
              safe_unusual       elif P(unusual) > P(normal)
              safe_normal
  abstain   = any unknown field (OOD) or normalised entropy ≥ H_max
  guard     = abstained + high-impact action ⇒ at least suspicious_review (never silently safe)

τ_high and τ_review are chosen on the validation split by minimising the security cost matrix.
"""
from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np

from . import features
from .metrics import COST, softmax

POLICY_SCHEMA = "orbis-decision-policy/1"

LOW_IMPACT_ACTIONS = {"tool_invoke", "database_query"}


def _idx(name: str) -> int:
    return features.FEATURE_NAMES.index(name)


@dataclass
class DecisionPolicy:
    temperature: float
    tau_high: float
    tau_review: float
    abstain_entropy: float = 0.9
    schema: str = POLICY_SCHEMA
    version: str = "1.0.0"

    @property
    def unknown_index(self) -> int:
        return _idx("unknown_fields")

    @staticmethod
    def high_impact_spec() -> dict:
        acts = [n for n in features.FEATURE_NAMES if n.startswith("action_type=") and n.split("=", 1)[1] not in LOW_IMPACT_ACTIONS]
        return {
            "any_feature_set": [_idx(n) for n in acts],
            "any_feature_set_names": acts,
            "class_rank_index": _idx("class_rank"),
            "class_rank_min": 0.5,
            "resource_log_index": _idx("resource_log"),
            "resource_log_min": math.log1p(100) / 16.0,
        }

    def to_json(self) -> dict:
        d = asdict(self)
        d["unknown_fields_index"] = self.unknown_index
        d["high_impact"] = self.high_impact_spec()
        d["classes"] = ["safe_normal", "safe_unusual", "suspicious_review", "high_risk"]
        d["description"] = __doc__.strip().splitlines()[0]
        return d


def high_impact(X: np.ndarray) -> np.ndarray:
    spec = DecisionPolicy.high_impact_spec()
    return (X[:, spec["any_feature_set"]] > 0.5).any(axis=1) | (X[:, spec["class_rank_index"]] >= spec["class_rank_min"]) | (X[:, spec["resource_log_index"]] >= spec["resource_log_min"])


def normalized_entropy(p: np.ndarray) -> np.ndarray:
    return -(p * np.log(np.clip(p, 1e-12, 1))).sum(axis=1) / math.log(p.shape[1])


def classify(probs: np.ndarray, tau_high: float, tau_review: float) -> np.ndarray:
    risk = probs[:, 2] + probs[:, 3]
    pred = np.where(probs[:, 1] > probs[:, 0], 1, 0)
    pred = np.where(risk >= tau_review, 2, pred)
    pred = np.where(probs[:, 3] >= tau_high, 3, pred)
    return pred


def decide(logits: np.ndarray, X: np.ndarray, policy: DecisionPolicy) -> dict[str, np.ndarray]:
    probs = softmax(logits, policy.temperature)
    pred = classify(probs, policy.tau_high, policy.tau_review)
    ood = X[:, policy.unknown_index] > 0
    abstain = ood | (normalized_entropy(probs) >= policy.abstain_entropy)
    guard = abstain & high_impact(X) & (pred < 2)
    pred = np.where(guard, 2, pred)
    return {"probs": probs, "pred": pred, "risk": probs[:, 2] + probs[:, 3], "abstain": abstain, "ood": ood, "guarded": guard}


def fit_temperature(logits: np.ndarray, y: np.ndarray) -> float:
    """Minimise validation NLL over log T with golden-section search (convex in practice)."""

    def nll(logt: float) -> float:
        p = softmax(logits, math.exp(logt))
        return float(-np.log(np.clip(p[np.arange(len(y)), y], 1e-12, 1)).mean())

    lo, hi = -3.0, 3.0
    g = (math.sqrt(5) - 1) / 2
    a, b = hi - g * (hi - lo), lo + g * (hi - lo)
    fa, fb = nll(a), nll(b)
    for _ in range(80):
        if fa < fb:
            hi, b, fb = b, a, fa
            a = hi - g * (hi - lo)
            fa = nll(a)
        else:
            lo, a, fa = a, b, fb
            b = lo + g * (hi - lo)
            fb = nll(b)
    return round(math.exp((lo + hi) / 2), 6)


GRID = np.round(np.arange(0.04, 0.97, 0.02), 2)


def sweep(probs: np.ndarray, y: np.ndarray) -> list[dict]:
    """Full τ_review × τ_high sweep of the security cost — exported for the console threshold explorer."""
    rows = []
    for tr in GRID:
        for th in GRID:
            pred = classify(probs, th, tr)
            esc = pred >= 2
            risky = y >= 2
            rows.append({
                "tau_review": float(tr),
                "tau_high": float(th),
                "mean_cost": float(COST[y, pred].mean()),
                "risky_escalation_recall": float(esc[risky].mean()) if risky.any() else None,
                "high_risk_escalation_recall": float(esc[y == 3].mean()) if (y == 3).any() else None,
                "false_escalation_rate": float(esc[~risky].mean()) if (~risky).any() else None,
                "confusion": np.bincount(y * 4 + pred, minlength=16).reshape(4, 4).tolist(),
            })
    return rows


COST_TOLERANCE = 0.05


def select_thresholds(probs: np.ndarray, y: np.ndarray) -> tuple[float, float, float]:
    """Security-favouring operating point.

    The validation split only contains template variants the model was trained on, so its cost-optimal
    thresholds are optimistic about unseen attacks. Among all (τ_review, τ_high) whose validation cost is
    within COST_TOLERANCE of the optimum, take the one that escalates most (lowest τ_review, then lowest τ_high).
    """
    rows = sweep(probs, y)
    best = min(r["mean_cost"] for r in rows)
    ok = [r for r in rows if r["mean_cost"] <= best * (1 + COST_TOLERANCE) + 1e-12]
    pick = min(ok, key=lambda r: (r["tau_review"], r["tau_high"]))
    return pick["tau_high"], pick["tau_review"], pick["mean_cost"]


# ---------------------------------------------------------------- reason codes (portable, feature-only)

# Ordered by priority; each fires from the feature vector alone so every runtime produces the same list.
REASONS: list[tuple[str, str]] = [
    ("out_of_distribution", "Unrecognised fields — model confidence reduced"),
    ("secret_egress", "Secret-bearing data leaving the trust boundary"),
    ("sensitive_to_untrusted", "Sensitive data to an unverified destination"),
    ("blocked_destination", "Destination is on the block list"),
    ("external_identity", "Access for an external identity"),
    ("destructive_production", "Destructive change in production"),
    ("bulk_sensitive", "Bulk volume of sensitive records"),
    ("sensitive_external", "Sensitive data leaving the organisation"),
    ("privileged_new_destination", "Privileged actor, never-seen destination"),
    ("first_destination", "Destination never used by this actor"),
    ("rate_spike", "Action rate {rate:.1f}× this actor's baseline"),
    ("volume_outlier", "Volume far above this actor's history"),
    ("high_amount", "High monetary amount"),
    ("outside_change_window", "Production change outside an approved window"),
    ("new_tool", "Tool never used by this actor"),
    ("off_hours", "Outside business hours"),
]


def reasons(x: np.ndarray | list[float], limit: int = 4) -> list[dict]:
    f = lambda n: float(x[features.FEATURE_NAMES.index(n)])
    established = f("baseline_insufficient") < 0.5
    rate = 2.0 ** (f("rate_ratio") * 6.0)
    fired = {
        "out_of_distribution": f("unknown_fields") > 0,
        "secret_egress": f("x_secret_egress") > 0.5,
        "sensitive_to_untrusted": f("x_sensitive_untrusted") > 0.5,
        "blocked_destination": f("destination_trust=blocked") > 0.5,
        "external_identity": f("destination_type=external_identity") > 0.5,
        "destructive_production": f("x_destructive_production") > 0.5,
        "bulk_sensitive": f("x_bulk_sensitive") > 0.5,
        "sensitive_external": f("x_sensitive_external") > 0.5,
        "privileged_new_destination": f("x_privileged_new_dest") > 0.5 and established,
        "first_destination": f("first_destination") > 0.5 and established,
        "rate_spike": rate >= 3.0 and established,
        "volume_outlier": f("resource_z") >= 0.4,
        "high_amount": f("amount_log") >= 0.4,
        "outside_change_window": f("production_without_window") > 0.5,
        "new_tool": f("first_tool") > 0.5 and established,
        "off_hours": f("off_hours") > 0.5,
    }
    out = []
    for code, label in REASONS:
        if fired[code]:
            out.append({"code": code, "label": label.format(rate=rate)})
    return out[:limit]

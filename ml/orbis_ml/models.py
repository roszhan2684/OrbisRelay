"""Candidate models for the Orbis Edge Risk Classifier (Model A), baselines first (blueprint §10.1).

  rule      — hand-weighted score over interpretable features (no learning)
  logreg    — multinomial logistic regression (sklearn), class-weighted
  hgb       — HistGradientBoosting (sklearn), class-weighted
  mlp       — compact MLP (PyTorch), class-weighted cross-entropy, early stopping on validation cost

Every model exposes `logits(X)`. Linear models and MLPs export to the portable format
`orbis-portable-mlp/1` (dense layers + activations) that the Core ML / ONNX converters, the Swift
endpoint fallback and the TypeScript gateway all consume. Tree ensembles have no portable export — that
is a deliberate selection criterion, not an oversight.
"""
from __future__ import annotations

import time
from typing import Any

import numpy as np

from . import features
from .metrics import COST, softmax

PORTABLE_SCHEMA = "orbis-portable-mlp/1"
CLASS_WEIGHTS = np.array([1.0, 2.0, 6.0, 12.0])


def sample_weights(y: np.ndarray) -> np.ndarray:
    """Inverse-frequency balance tempered by security cost (risky classes up-weighted)."""
    freq = np.bincount(y, minlength=4) / len(y)
    w = (1.0 / np.maximum(freq, 1e-6)) ** 0.5 * CLASS_WEIGHTS
    w = w / (w[y].mean())
    return w[y]


class RuleBaseline:
    """Interpretable additive score (mirrors the v1 policy-core contextual risk heuristics)."""

    name = "rule"
    WEIGHTS = {
        "x_sensitive_external": 2.0,
        "x_sensitive_untrusted": 2.0,
        "x_secret_egress": 4.0,
        "x_bulk_sensitive": 1.5,
        "x_privileged_new_dest": 1.5,
        "x_destructive_production": 3.0,
        "x_high_amount_off_hours": 1.5,
        "x_new_tool_elevated": 1.0,
        "production_without_window": 1.5,
        "first_destination": 0.5,
        "first_tool": 0.5,
        "unknown_fields": 3.0,
        "destination_trust=blocked": 3.0,
        "destination_type=external_identity": 3.0,
        "amount_log": 3.0,
        "rate_ratio": 1.5,
        "has_ticket": -1.0,
        "destination_trust=approved": -1.0,
    }

    def __init__(self) -> None:
        self.w = np.zeros(features.N_FEATURES)
        for k, v in self.WEIGHTS.items():
            self.w[features.FEATURE_NAMES.index(k)] = v
        self.cuts = (1.0, 2.5, 4.0)

    def fit(self, X, y, Xv, yv):
        s = X @ self.w
        best = None
        for a in np.arange(0.5, 3.0, 0.25):
            for b in np.arange(a + 0.5, 5.0, 0.25):
                for c in np.arange(b + 0.5, 7.5, 0.25):
                    pred = np.digitize(Xv @ self.w, [a, b, c])
                    cost = COST[yv, pred].mean()
                    if best is None or cost < best[0]:
                        best = (cost, (a, b, c))
        self.cuts = best[1]
        return self

    def logits(self, X):
        pred = np.digitize(X @ self.w, self.cuts)
        z = np.full((len(X), 4), -4.0)
        z[np.arange(len(X)), pred] = 4.0
        return z

    def params(self):
        return {"weights": self.WEIGHTS, "cuts": [float(c) for c in self.cuts]}


class LogReg:
    name = "logreg"

    def __init__(self, C: float = 1.0, seed: int = 0) -> None:
        from sklearn.linear_model import LogisticRegression

        self.C = C
        self.m = LogisticRegression(C=C, max_iter=4000, random_state=seed)

    def fit(self, X, y, Xv=None, yv=None):
        self.m.fit(X, y, sample_weight=sample_weights(y))
        return self

    def logits(self, X):
        return X @ self.m.coef_.T + self.m.intercept_

    def params(self):
        return {"C": self.C}

    def portable(self) -> dict:
        return {"format": PORTABLE_SCHEMA, "input_dim": features.N_FEATURES, "layers": [{"W": self.m.coef_.tolist(), "b": self.m.intercept_.tolist(), "activation": "none"}]}


class HGB:
    name = "hgb"

    def __init__(self, seed: int = 0, **kw) -> None:
        from sklearn.ensemble import HistGradientBoostingClassifier

        self.kw = {"max_iter": 300, "learning_rate": 0.08, "max_leaf_nodes": 31, "l2_regularization": 1.0, **kw}
        self.m = HistGradientBoostingClassifier(random_state=seed, early_stopping=False, **self.kw)

    def fit(self, X, y, Xv=None, yv=None):
        self.m.fit(X, y, sample_weight=sample_weights(y))
        return self

    def logits(self, X):
        return np.log(np.clip(self.m.predict_proba(X), 1e-9, 1))

    def params(self):
        return self.kw


class MLP:
    name = "mlp"

    def __init__(self, hidden: tuple[int, ...] = (32, 16), seed: int = 0, epochs: int = 120, lr: float = 3e-3, weight_decay: float = 1e-4, batch: int = 512) -> None:
        self.hidden, self.seed, self.epochs, self.lr, self.wd, self.batch = hidden, seed, epochs, lr, weight_decay, batch
        self.history: list[dict[str, float]] = []

    def _net(self):
        import torch

        layers, d = [], features.N_FEATURES
        for h in self.hidden:
            layers += [torch.nn.Linear(d, h), torch.nn.ReLU()]
            d = h
        layers.append(torch.nn.Linear(d, 4))
        return torch.nn.Sequential(*layers)

    def fit(self, X, y, Xv, yv, w=None):
        """`w` optionally scales each row's loss (label-confidence weighting for reviewed/proxy labels)."""
        import torch

        torch.manual_seed(self.seed)
        torch.set_num_threads(1)
        torch.use_deterministic_algorithms(True)
        self.net = self._net().double()
        opt = torch.optim.AdamW(self.net.parameters(), lr=self.lr, weight_decay=self.wd)
        Xt, yt = torch.from_numpy(X), torch.from_numpy(y).long()
        wt = torch.from_numpy(sample_weights(y) * (np.ones(len(y)) if w is None else np.asarray(w, dtype=np.float64)))
        Xvt = torch.from_numpy(Xv)
        g = torch.Generator().manual_seed(self.seed)
        best = (float("inf"), None, -1)
        for epoch in range(self.epochs):
            self.net.train()
            perm = torch.randperm(len(Xt), generator=g)
            for i in range(0, len(perm), self.batch):
                idx = perm[i : i + self.batch]
                logits = self.net(Xt[idx])
                loss = (torch.nn.functional.cross_entropy(logits, yt[idx], reduction="none") * wt[idx]).mean()
                opt.zero_grad()
                loss.backward()
                opt.step()
            self.net.eval()
            with torch.no_grad():
                zv = self.net(Xvt).numpy()
            pv = softmax(zv)
            cost = float((pv * COST[yv]).sum(axis=1).mean())  # expected validation cost
            self.history.append({"epoch": epoch, "train_loss": float(loss), "val_expected_cost": cost})
            if cost < best[0] - 1e-6:
                best = (cost, {k: v.clone() for k, v in self.net.state_dict().items()}, epoch)
            elif epoch - best[2] > 20:
                break
        self.net.load_state_dict(best[1])
        self.best_epoch = best[2]
        return self

    def logits(self, X):
        import torch

        with torch.no_grad():
            return self.net(torch.from_numpy(np.asarray(X, dtype=np.float64))).numpy()

    def params(self):
        return {"hidden": list(self.hidden), "epochs_max": self.epochs, "best_epoch": getattr(self, "best_epoch", None), "lr": self.lr, "weight_decay": self.wd, "batch": self.batch, "seed": self.seed}

    def portable(self) -> dict:
        import torch

        layers = []
        mods = [m for m in self.net if isinstance(m, torch.nn.Linear)]
        for i, m in enumerate(mods):
            layers.append({"W": m.weight.detach().numpy().tolist(), "b": m.bias.detach().numpy().tolist(), "activation": "relu" if i < len(mods) - 1 else "none"})
        return {"format": PORTABLE_SCHEMA, "input_dim": features.N_FEATURES, "layers": layers}


def portable_logits(model: dict, X: np.ndarray) -> np.ndarray:
    """Reference forward pass for the portable format (what every runtime must reproduce)."""
    h = np.asarray(X, dtype=np.float64)
    for layer in model["layers"]:
        h = h @ np.asarray(layer["W"]).T + np.asarray(layer["b"])
        if layer["activation"] == "relu":
            h = np.maximum(h, 0.0)
    return h


def n_params(model: dict) -> int:
    return sum(len(l["b"]) + len(l["W"]) * len(l["W"][0]) for l in model["layers"])


def timed_fit(m, X, y, Xv, yv) -> tuple[Any, float]:
    t = time.perf_counter()
    m.fit(X, y, Xv, yv)
    return m, time.perf_counter() - t

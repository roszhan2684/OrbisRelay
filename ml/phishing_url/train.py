"""Train the Orbis Protect hostname phishing model from scratch (numpy only).

Data
  - PhiUSIIL Phishing URL Dataset (UCI #967, Prasad & Chandra 2024), CC BY 4.0
  - Tranco top sites list (id 647LX), used as additional legitimate hostnames

Model
  L2-regularised logistic regression over 16 standardised lexical features +
  16,384 hashed character 3/4-gram buckets, trained full-batch with Adam.
  No ML libraries: gradients, optimiser, metrics and ROC-AUC are implemented here.

Usage: python3 ml/phishing_url/train.py
Outputs: apps/web/src/lib/ml/url-model.json, ml/phishing_url/model_card.json,
         apps/web/src/lib/ml/__fixtures__/url-parity.json
"""
import csv
import json
import os
import random
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from features import DENSE_NAMES, HASH_BUCKETS, NGRAMS, dense_features, normalize_host, sparse_indices  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "ml", "data")
OUT_MODEL = os.path.join(ROOT, "apps", "web", "src", "lib", "ml", "url-model.json")
OUT_FIXTURES = os.path.join(ROOT, "apps", "web", "src", "lib", "ml", "__fixtures__", "url-parity.json")
OUT_CARD = os.path.join(os.path.dirname(__file__), "model_card.json")
OUT_CARD_WEB = os.path.join(ROOT, "apps", "web", "src", "lib", "ml", "cards", "url.json")
TRANCO_TOP = 60_000
SEED = 7


def load():
    hosts = {}
    with open(os.path.join(DATA, "PhiUSIIL_Phishing_URL_Dataset.csv"), encoding="utf-8-sig") as f:
        for row in csv.DictReader(f):
            h = normalize_host(row["URL"])
            if not h:
                continue
            y = 1 if row["label"] == "0" else 0  # PhiUSIIL: 1 = legitimate, 0 = phishing. We predict P(phishing).
            hosts.setdefault(h, set()).add(y)
    phi = len(hosts)
    with open(os.path.join(DATA, "top-1m.csv")) as f:
        for i, line in enumerate(f):
            if i >= TRANCO_TOP:
                break
            h = normalize_host(line.strip().split(",", 1)[1])
            if h:
                hosts.setdefault(h, set()).add(0)
    conflicted = [h for h, ys in hosts.items() if len(ys) > 1]
    for h in conflicted:
        del hosts[h]
    items = [(h, next(iter(ys))) for h, ys in hosts.items()]
    return items, {"phiusiil_unique_hosts": phi, "tranco_added": TRANCO_TOP, "conflicts_dropped": len(conflicted)}


def featurize(items):
    dense = np.array([dense_features(h) for h, _ in items], dtype=np.float64)
    rows, cols = [], []
    for i, (h, _) in enumerate(items):
        idx = sparse_indices(h)
        rows.extend([i] * len(idx))
        cols.extend(idx)
    y = np.array([lab for _, lab in items], dtype=np.float64)
    return dense, np.array(rows, dtype=np.int64), np.array(cols, dtype=np.int64), y


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -35, 35)))


def logits(params, dense, rows, cols, n):
    wd, ws, b = params
    return dense @ wd + np.bincount(rows, weights=ws[cols], minlength=n) + b


def train(dense, rows, cols, y, epochs=600, lr=0.05, l2=3e-4):
    n, d = dense.shape
    wd = np.zeros(d)
    ws = np.zeros(HASH_BUCKETS)
    b = 0.0
    m = [np.zeros(d), np.zeros(HASH_BUCKETS), 0.0]
    v = [np.zeros(d), np.zeros(HASH_BUCKETS), 0.0]
    b1, b2, eps = 0.9, 0.999, 1e-8
    pos_w = (n - y.sum()) / max(y.sum(), 1)  # class balance
    sw = np.where(y == 1, pos_w, 1.0)
    sw = sw / sw.mean()
    for t in range(1, epochs + 1):
        p = sigmoid(logits((wd, ws, b), dense, rows, cols, n))
        err = (p - y) * sw / n
        g = [dense.T @ err + l2 * wd, np.bincount(cols, weights=err[rows], minlength=HASH_BUCKETS) + l2 * ws, err.sum()]
        params = [wd, ws, b]
        for k in range(3):
            m[k] = b1 * m[k] + (1 - b1) * g[k]
            v[k] = b2 * v[k] + (1 - b2) * g[k] * g[k]
            mh = m[k] / (1 - b1**t)
            vh = v[k] / (1 - b2**t)
            params[k] = params[k] - lr * mh / (np.sqrt(vh) + eps)
        wd, ws, b = params
        if t % 60 == 0 or t == 1:
            loss = -np.mean(sw * (y * np.log(p + 1e-12) + (1 - y) * np.log(1 - p + 1e-12)))
            print(f"  epoch {t:4d}  weighted log-loss {loss:.4f}")
    return wd, ws, float(b)


def roc_auc(y, s):
    order = np.argsort(s)
    ranks = np.empty(len(s))
    ranks[order] = np.arange(1, len(s) + 1)
    pos = y == 1
    n_pos, n_neg = pos.sum(), (~pos).sum()
    return float((ranks[pos].sum() - n_pos * (n_pos + 1) / 2) / (n_pos * n_neg))


def metrics(y, p, thr=0.5):
    pred = p >= thr
    tp = int(((pred == 1) & (y == 1)).sum())
    tn = int(((pred == 0) & (y == 0)).sum())
    fp = int(((pred == 1) & (y == 0)).sum())
    fn = int(((pred == 0) & (y == 1)).sum())
    prec = tp / max(tp + fp, 1)
    rec = tp / max(tp + fn, 1)
    return {
        "accuracy": round((tp + tn) / len(y), 4),
        "precision": round(prec, 4),
        "recall": round(rec, 4),
        "f1": round(2 * prec * rec / max(prec + rec, 1e-12), 4),
        "roc_auc": round(roc_auc(y, p), 4),
        "confusion": {"tp": tp, "fp": fp, "tn": tn, "fn": fn},
        "n": int(len(y)),
    }


def main():
    t0 = time.time()
    items, stats = load()
    random.Random(SEED).shuffle(items)
    split = int(len(items) * 0.8)
    train_items, test_items = items[:split], items[split:]
    print(f"hosts={len(items)} train={len(train_items)} test={len(test_items)} phishing_share={np.mean([y for _, y in items]):.3f}")

    Xd, r, c, y = featurize(train_items)
    mean, std = Xd.mean(0), Xd.std(0) + 1e-9
    Xd = (Xd - mean) / std
    wd, ws, b = train(Xd, r, c, y)

    # Round exactly as exported so Python metrics/fixtures match the TS runtime bit-for-bit (to 1e-9).
    wd, ws, b = np.round(wd, 5), np.round(ws, 5), round(b, 5)
    mean, std = np.round(mean, 6), np.round(std, 6)

    def predict(its):
        d, rr, cc, yy = featurize(its)
        d = (d - mean) / std
        return yy, sigmoid(logits((wd, ws, b), d, rr, cc, len(its)))

    ytr, ptr = predict(train_items)
    yte, pte = predict(test_items)
    train_m, test_m = metrics(ytr, ptr), metrics(yte, pte)
    print("train", train_m)
    print("test ", test_m)

    top = sorted(zip(DENSE_NAMES, wd.tolist()), key=lambda kv: -abs(kv[1]))
    model = {
        "name": "orbis-protect-hostname-lr",
        "version": "1.0.0",
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "hash_buckets": HASH_BUCKETS,
        "ngrams": list(NGRAMS),
        "dense_names": DENSE_NAMES,
        "mean": mean.tolist(),
        "std": std.tolist(),
        "w_dense": wd.tolist(),
        "w_sparse": ws.tolist(),
        "bias": b,
        "threshold": 0.5,
        "metrics": {"test": test_m, "train": train_m},
    }
    os.makedirs(os.path.dirname(OUT_MODEL), exist_ok=True)
    with open(OUT_MODEL, "w") as f:
        json.dump(model, f, separators=(",", ":"))

    card = {
        "model": model["name"],
        "version": model["version"],
        "task": "P(phishing) for a URL hostname (scheme and leading www. removed)",
        "algorithm": "Logistic regression, full-batch Adam, L2=3e-4, class-balanced, implemented from scratch in numpy",
        "features": {"dense": DENSE_NAMES, "sparse": f"{HASH_BUCKETS} FNV-1a hashed char 3/4/5-grams + TLD token"},
        "data": {
            "sources": [
                {"name": "PhiUSIIL Phishing URL Dataset", "url": "https://archive.ics.uci.edu/dataset/967/phiusiil+phishing+url+dataset", "license": "CC BY 4.0"},
                {"name": "Tranco top sites list (647LX)", "url": "https://tranco-list.eu/list/647LX", "use": f"top {TRANCO_TOP} as legitimate hostnames"},
            ],
            **stats,
            "unique_hosts": len(items),
            "split": "random 80/20 by unique hostname, seed 7",
        },
        "metrics": {"test": test_m, "train": train_m},
        "top_dense_weights": [{"feature": k, "weight": round(v, 4)} for k, v in top],
        "limitations": [
            "PhiUSIIL legitimate samples are homepages only, so path/scheme are deliberately excluded; path-level signals are handled by deterministic rules in the analyzer.",
            "Legitimate training hostnames rarely contain subdomains; hosts like mail.example.com may be over-scored. The analyzer softens scores for allowlisted registrable domains.",
            "The score is advisory. Orbis never auto-enforces on model output: it feeds explanation and recommendation, and policy stays deterministic.",
        ],
        "training_seconds": round(time.time() - t0, 1),
    }
    for out in (OUT_CARD, OUT_CARD_WEB):
        with open(out, "w") as f:
            json.dump(card, f, indent=2)

    samples = [
        "https://www.github.com/orbis/relay", "http://paypal-account-verify.secure-login.xyz/session",
        "https://kilik-eb4d5.web.app/", "northstar.cloud", "http://192.168.10.4/admin",
        "https://microsoft365-login.weeblysite.com", "https://www.chmi.cz", "https://xn--pple-43d.com",
        "https://docs.google.com/forms/d/1", "https://wallet-connect-metamask.pages.dev",
        "https://acme-supplies.com/invoices", "https://login.okta-northstar-sso.com",
    ] + [h for h, _ in test_items[:40]]
    fx_items = [(normalize_host(s), 0) for s in samples]
    _, fx_p = predict(fx_items)
    os.makedirs(os.path.dirname(OUT_FIXTURES), exist_ok=True)
    with open(OUT_FIXTURES, "w") as f:
        json.dump([{"url": s, "host": h, "p": float(p)} for s, (h, _), p in zip(samples, fx_items, fx_p)], f, indent=1)
    for s, p in list(zip(samples, fx_p))[:12]:
        print(f"  {p:6.3f}  {s}")
    print(f"done in {time.time() - t0:.1f}s")


if __name__ == "__main__":
    main()

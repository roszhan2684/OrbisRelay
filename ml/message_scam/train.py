"""Train the Orbis Protect message model (multinomial Naive Bayes) from scratch.

Data: UCI SMS Spam Collection (Almeida & Hidalgo, 2011), CC BY 4.0.
      https://archive.ics.uci.edu/dataset/228/sms+spam+collection
Tokenizer is mirrored in apps/web/src/lib/ml/message-model.ts.

Usage: python3 ml/message_scam/train.py
"""
import json
import math
import os
import random
import re
import time
from collections import Counter

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(ROOT, "ml", "data", "SMSSpamCollection")
OUT_MODEL = os.path.join(ROOT, "apps", "web", "src", "lib", "ml", "message-model.json")
OUT_CARD = os.path.join(os.path.dirname(__file__), "model_card.json")
OUT_CARD_WEB = os.path.join(ROOT, "apps", "web", "src", "lib", "ml", "cards", "message.json")
OUT_FIXTURES = os.path.join(ROOT, "apps", "web", "src", "lib", "ml", "__fixtures__", "message-parity.json")
ALPHA = 0.5
MIN_COUNT = 2

_URL = re.compile(r"(https?://\S+|www\.\S+|\b[a-z0-9-]+\.(com|net|org|co|uk|io|ly|me|info|biz|xyz)\b\S*)")
_MONEY = re.compile(r"[£$€]\s?\d[\d,.]*|\d[\d,.]*\s?(usd|gbp|eur|pounds|dollars)\b")
_PHONE = re.compile(r"\b\d{5,}\b")
_NUM = re.compile(r"\b\d+\b")
_TOKEN = re.compile(r"[a-z<>_]+|[!?]")


def tokenize(text: str) -> list:
    t = text.lower()
    t = _URL.sub(" <url> ", t)
    t = _MONEY.sub(" <money> ", t)
    t = _PHONE.sub(" <phone> ", t)
    t = _NUM.sub(" <num> ", t)
    return [w for w in _TOKEN.findall(t) if len(w) > 1 or w in "!?"]


def main():
    t0 = time.time()
    rows = []
    with open(DATA, encoding="utf-8", errors="replace") as f:
        for line in f:
            label, text = line.rstrip("\n").split("\t", 1)
            rows.append((text, 1 if label == "spam" else 0))
    random.Random(11).shuffle(rows)
    split = int(len(rows) * 0.8)
    train, test = rows[:split], rows[split:]

    counts = [Counter(), Counter()]
    docs = [0, 0]
    for text, y in train:
        docs[y] += 1
        counts[y].update(tokenize(text))
    vocab_counts = counts[0] + counts[1]
    vocab = sorted(w for w, c in vocab_counts.items() if c >= MIN_COUNT)
    totals = [sum(counts[k][w] for w in vocab) for k in (0, 1)]
    V = len(vocab)
    loglik = {
        w: [
            math.log((counts[0][w] + ALPHA) / (totals[0] + ALPHA * V)),
            math.log((counts[1][w] + ALPHA) / (totals[1] + ALPHA * V)),
        ]
        for w in vocab
    }
    prior = [math.log(docs[0] / len(train)), math.log(docs[1] / len(train))]

    def score(text):
        s0, s1 = prior
        for w in tokenize(text):
            if w in loglik:
                a, b = loglik[w]
                s0 += a
                s1 += b
        d = max(min(s1 - s0, 50), -50)
        return 1 / (1 + math.exp(-d))

    def evaluate(data):
        tp = fp = tn = fn = 0
        scored = []
        for text, y in data:
            p = score(text)
            scored.append((p, y))
            pred = p >= 0.5
            tp += pred and y == 1
            fp += pred and y == 0
            tn += (not pred) and y == 0
            fn += (not pred) and y == 1
        scored.sort()
        pos = sum(y for _, y in scored)
        neg = len(scored) - pos
        rank_sum = sum(i + 1 for i, (_, y) in enumerate(scored) if y == 1)
        auc = (rank_sum - pos * (pos + 1) / 2) / (pos * neg)
        prec = tp / max(tp + fp, 1)
        rec = tp / max(tp + fn, 1)
        return {
            "accuracy": round((tp + tn) / len(data), 4),
            "precision": round(prec, 4),
            "recall": round(rec, 4),
            "f1": round(2 * prec * rec / max(prec + rec, 1e-12), 4),
            "roc_auc": round(auc, 4),
            "confusion": {"tp": tp, "fp": fp, "tn": tn, "fn": fn},
            "n": len(data),
        }

    m_train, m_test = evaluate(train), evaluate(test)
    print("train", m_train)
    print("test ", m_test)

    # Most indicative tokens for explanations in the UI.
    indicative = sorted(vocab, key=lambda w: loglik[w][0] - loglik[w][1])[:40]
    model = {
        "name": "orbis-protect-message-nb",
        "version": "1.0.0",
        "trained_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "alpha": ALPHA,
        "prior": [round(p, 6) for p in prior],
        "loglik": {w: [round(a, 6), round(b, 6)] for w, (a, b) in loglik.items()},
        "indicative": indicative,
        "metrics": {"test": m_test, "train": m_train},
    }
    with open(OUT_MODEL, "w") as f:
        json.dump(model, f, separators=(",", ":"))

    # Fixtures computed with the rounded, exported parameters.
    def score_rounded(text):
        s0, s1 = model["prior"]
        for w in tokenize(text):
            if w in model["loglik"]:
                a, b = model["loglik"][w]
                s0 += a
                s1 += b
        d = max(min(s1 - s0, 50), -50)
        return 1 / (1 + math.exp(-d))

    samples = [
        "URGENT! Your account has been suspended. Verify now at http://secure-verify.co to avoid closure",
        "Hey, are we still on for lunch at 1?",
        "Congratulations! You've won a $1000 gift card. Call 0800123456 to claim your prize now!",
        "This is your CEO. I need you to buy 5 Apple gift cards for a client today and send me the codes.",
        "Reminder: standup moved to 10:30 tomorrow.",
        "Your package could not be delivered. Pay the £1.99 fee here: www.dhl-redelivery.info",
    ] + [t for t, _ in test[:30]]
    with open(OUT_FIXTURES, "w") as f:
        json.dump([{"text": s, "tokens": tokenize(s), "p": score_rounded(s)} for s in samples], f, indent=1)

    card = {
        "model": model["name"],
        "version": model["version"],
        "task": "P(scam / unsolicited social-engineering) for a short message",
        "algorithm": f"Multinomial Naive Bayes, Laplace alpha={ALPHA}, vocab min count {MIN_COUNT}, implemented from scratch",
        "data": {
            "sources": [{"name": "UCI SMS Spam Collection", "url": "https://archive.ics.uci.edu/dataset/228/sms+spam+collection", "license": "CC BY 4.0"}],
            "messages": len(rows),
            "spam_share": round(sum(y for _, y in rows) / len(rows), 4),
            "vocab": V,
            "split": "random 80/20, seed 11",
        },
        "metrics": {"test": m_test, "train": m_train},
        "most_indicative_tokens": indicative[:20],
        "limitations": [
            "Trained on 2011-era UK SMS spam; business email compromise phrasing (gift cards, wire changes, CEO requests) is reinforced by deterministic cue rules in the analyzer.",
            "Advisory only. Output is explained to the user and never auto-enforced.",
        ],
        "training_seconds": round(time.time() - t0, 2),
    }
    for out in (OUT_CARD, OUT_CARD_WEB):
        with open(out, "w") as f:
            json.dump(card, f, indent=2)
    for s in samples[:6]:
        print(f"  {score_rounded(s):.3f}  {s[:70]}")


if __name__ == "__main__":
    main()

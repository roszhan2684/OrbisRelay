"""Hostname feature extraction for the Orbis Protect URL model.

This file is the reference implementation. It is ported 1:1 to
apps/web/src/lib/ml/url-features.ts and parity-tested against fixtures.
Any change here must be mirrored there and the model retrained.
"""
import math
import re

HASH_BUCKETS = 1 << 16
NGRAMS = (3, 4, 5)

FREE_HOSTING = (
    "web.app", "firebaseapp.com", "weeblysite.com", "weebly.com", "repl.co", "glitch.me",
    "000webhostapp.com", "github.io", "netlify.app", "vercel.app", "pages.dev", "workers.dev",
    "wixsite.com", "blogspot.com", "herokuapp.com", "azurewebsites.net", "myqcloud.com",
    "ipfs.io", "duckdns.org", "ngrok.io", "ngrok-free.app", "square.site", "webflow.io",
    "sites.google.com", "framer.app", "godaddysites.com", "mybluehost.me", "r2.dev",
)
BRANDS = (
    "paypal", "apple", "icloud", "microsoft", "office365", "outlook", "google", "amazon",
    "netflix", "facebook", "instagram", "whatsapp", "chase", "wellsfargo", "bankofamerica",
    "coinbase", "binance", "metamask", "dhl", "fedex", "usps", "docusign", "dropbox", "adobe",
    "linkedin", "okta", "steam", "att", "aol", "yahoo",
)
KEYWORDS = (
    "login", "signin", "secure", "verify", "account", "update", "wallet", "support",
    "auth", "bank", "confirm", "billing", "unlock", "recover", "webmail", "service",
)
DENSE_NAMES = [
    "length", "labels", "digit_ratio", "hyphens", "is_ip", "entropy", "longest_label",
    "punycode", "vowel_ratio", "max_digit_run", "max_consonant_run", "free_hosting",
    "brand_impersonation", "keyword", "tld_length", "sld_length",
]
_IP = re.compile(r"^[0-9]{1,3}(\.[0-9]{1,3}){3}$")
_VOWELS = set("aeiou")
_DIGITS = set("0123456789")
_LETTERS = set("abcdefghijklmnopqrstuvwxyz")


def _is_digit(c):
    return c in _DIGITS


def _is_letter(c):
    return c in _LETTERS


def normalize_host(url: str) -> str:
    u = url.strip().lower()
    if "://" not in u:
        u = "http://" + u
    rest = u.split("://", 1)[1]
    host = re.split(r"[/?#]", rest, maxsplit=1)[0]
    if "@" in host:
        host = host.rsplit("@", 1)[1]
    host = host.split(":")[0].strip(".")
    if host.startswith("www."):
        host = host[4:]
    return host


def fnv1a(s: str) -> int:
    h = 0x811C9DC5
    for b in s.encode("utf-8"):
        h ^= b
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def _runs(s: str, pred) -> int:
    best = cur = 0
    for ch in s:
        if pred(ch):
            cur += 1
            best = max(best, cur)
        else:
            cur = 0
    return best


def dense_features(host: str) -> list:
    labels = host.split(".") if host else [""]
    n = max(len(host), 1)
    letters = [c for c in host if _is_letter(c)]
    counts = {}
    for c in host:
        counts[c] = counts.get(c, 0) + 1
    entropy = -sum((v / n) * math.log2(v / n) for v in counts.values()) if host else 0.0
    tld = labels[-1] if len(labels) > 1 else ""
    sld = labels[-2] if len(labels) > 1 else labels[0]
    free = 1.0 if any(host == f or host.endswith("." + f) for f in FREE_HOSTING) else 0.0
    brand = 0.0
    for b in BRANDS:
        if b in host and sld != b:
            brand = 1.0
            break
    kw = 1.0 if any(k in host for k in KEYWORDS) else 0.0
    return [
        len(host) / 30.0,
        float(host.count(".")),
        sum(_is_digit(c) for c in host) / n,
        float(host.count("-")),
        1.0 if _IP.match(host) else 0.0,
        entropy / 4.0,
        max(len(l) for l in labels) / 20.0,
        1.0 if "xn--" in host else 0.0,
        (sum(c in _VOWELS for c in letters) / len(letters)) if letters else 0.0,
        _runs(host, _is_digit) / 10.0,
        _runs(host, lambda c: _is_letter(c) and c not in _VOWELS) / 10.0,
        free,
        brand,
        kw,
        len(tld) / 10.0,
        len(sld) / 20.0,
    ]


def sparse_indices(host: str) -> list:
    """Sorted unique hashed bucket indices for char n-grams + TLD token."""
    padded = "^" + host + "$"
    idx = set()
    for n in NGRAMS:
        for i in range(len(padded) - n + 1):
            idx.add(fnv1a(padded[i : i + n]) % HASH_BUCKETS)
    labels = host.split(".")
    if len(labels) > 1:
        idx.add(fnv1a("tld=" + labels[-1]) % HASH_BUCKETS)
    return sorted(idx)

"""Deterministic edge feature calculator — reference implementation of edge-features/1.

This file *is* the feature specification. The Swift (endpoint), TypeScript (gateway) and C++20 (parity
module) ports follow it line by line and are tested against fixtures generated from it.

Properties (blueprint §9.1): computable locally, deterministic, versioned, cheap (O(window) per event),
privacy-preserving (reads only metadata + destination hashes), stable across languages.

Statefulness: behavioural features compare an event with the same actor's earlier events. State is
bounded (24h timestamp window, capped novelty sets, Welford running stats, 200-sample rings) and is
updated *after* the event's features are computed, so an event never sees itself.
"""
from __future__ import annotations

import math
from collections import deque
from dataclasses import dataclass, field

from .schema import (
    ACTION_TYPES,
    ACTOR_TYPES,
    CLASSIFICATIONS,
    DESTINATION_TRUST,
    DESTINATION_TYPES,
    DEVICE_POSTURES,
    ENVIRONMENTS,
    PRIVILEGE_LEVELS,
    TOOL_RISK,
    NormalizedEvent,
)

FEATURE_SCHEMA = "edge-features/1"

HOUR_MS = 3_600_000
DAY_MS = 86_400_000
WINDOW_5M = 5 * 60_000
SEEN_CAP = 4096
RING_CAP = 200
TIMES_CAP = 10_000
MIN_BASELINE = 5
MIN_ANOMALY_BASELINE = 20
BUSINESS_START, BUSINESS_END = 8, 19

ONE_HOT_BLOCKS: list[tuple[str, list[str]]] = [
    ("actor_type", ACTOR_TYPES),
    ("action_type", ACTION_TYPES),
    ("classification", CLASSIFICATIONS),
    ("destination_type", DESTINATION_TYPES),
    ("destination_trust", DESTINATION_TRUST),
    ("privilege_level", PRIVILEGE_LEVELS),
    ("device_posture", DEVICE_POSTURES),
    ("tool_risk_class", TOOL_RISK),
    ("environment", ENVIRONMENTS),
]

NUMERIC_FEATURES = [
    "resource_log",
    "amount_log",
    "off_hours",
    "weekend",
    "production_without_window",
    "has_ticket",
    "rate_5m",
    "rate_1h",
    "rate_ratio",
    "unique_dest_1h",
    "first_destination",
    "first_tool",
    "first_action",
    "resource_z",
    "baseline_insufficient",
    "unknown_fields",
    "class_rank",
    "x_sensitive_external",
    "x_sensitive_untrusted",
    "x_privileged_new_dest",
    "x_high_amount_off_hours",
    "x_destructive_production",
    "x_new_tool_elevated",
    "x_secret_egress",
    "x_bulk_sensitive",
]

FEATURE_NAMES: list[str] = [f"{block}={v}" for block, vocab in ONE_HOT_BLOCKS for v in [*vocab, "unknown"]] + NUMERIC_FEATURES
N_FEATURES = len(FEATURE_NAMES)

# Unknown classification is treated as sensitive, unknown destination as external/untrusted and unknown
# privilege as elevated: the missing value never makes an event look safer (blueprint §24).
CLASS_RANK = {"public": 0, "internal": 1, "confidential": 2, "restricted": 3, "regulated": 3, "secret": 4, "unknown": 2}
EXTERNAL_DEST = {"approved_vendor", "external_domain", "external_ai_provider", "beneficiary", "external_identity", "partner", "unknown"}
UNTRUSTED = {"unverified", "blocked", "unknown"}
ELEVATED = {"elevated", "admin", "unknown"}


@dataclass
class ActorState:
    times: deque = field(default_factory=deque)  # (ts_ms, dest_hash) of prior events within 24h
    seen_dest: set = field(default_factory=set)
    seen_tool: set = field(default_factory=set)
    seen_action: set = field(default_factory=set)
    n: int = 0
    mean: float = 0.0
    m2: float = 0.0
    vol_ring: deque = field(default_factory=lambda: deque(maxlen=RING_CAP))
    rate_ring: deque = field(default_factory=lambda: deque(maxlen=RING_CAP))


class FeatureState:
    """Per-actor behavioural baselines. Partitioned by actor id (tenant partitioning happens upstream)."""

    def __init__(self) -> None:
        self.actors: dict[str, ActorState] = {}

    def get(self, actor_id: str) -> ActorState:
        st = self.actors.get(actor_id)
        if st is None:
            st = self.actors[actor_id] = ActorState()
        return st


@dataclass
class Window:
    n5: int
    n60: int
    n_base: int
    unique_dest_1h: int


def _clamp(x: float, lo: float, hi: float) -> float:
    return lo if x < lo else hi if x > hi else x


def _onehot(value: str, vocab: list[str]) -> list[float]:
    out = [0.0] * (len(vocab) + 1)
    out[vocab.index(value) if value in vocab else len(vocab)] = 1.0
    return out


def local_time(ts_ms: int, tz_offset_minutes: int) -> tuple[int, int]:
    """(hour 0-23, weekday 0=Sunday) in the event's local time, integer arithmetic only."""
    local = ts_ms + tz_offset_minutes * 60_000
    day = local // DAY_MS
    hour = (local - day * DAY_MS) // HOUR_MS
    weekday = (day + 4) % 7  # 1970-01-01 was a Thursday
    return int(hour), int(weekday)


def window_counts(st: ActorState, t: int) -> Window:
    n5 = n60 = n_base = 0
    dests: set[str] = set()
    for ts, dh in st.times:
        if ts > t or ts <= t - DAY_MS:
            continue
        if ts > t - WINDOW_5M:
            n5 += 1
        if ts > t - HOUR_MS:
            n60 += 1
            if dh:
                dests.add(dh)
        else:
            n_base += 1
    return Window(n5, n60, n_base, len(dests))


def unknown_count(ev: NormalizedEvent) -> int:
    """Schema-level unknowns (OOD). An unregistered tool's risk class is *not* counted: tool registry gaps
    are routine and are modelled by the tool_risk_class=unknown and first_tool features instead."""
    return sum(
        v == "unknown"
        for v in (ev.actor_type, ev.privilege_level, ev.action_type, ev.classification, ev.destination_type, ev.destination_trust, ev.device_posture, ev.environment)
    )


def compute(ev: NormalizedEvent, state: FeatureState) -> list[float]:
    """Feature vector for `ev` given prior state. Does not mutate state — call `update` afterwards."""
    st = state.get(ev.actor_id)
    w = window_counts(st, ev.ts_ms)
    hour, weekday = local_time(ev.ts_ms, ev.tz_offset_minutes)
    weekend = weekday == 0 or weekday == 6
    off_hours = weekend or hour < BUSINESS_START or hour >= BUSINESS_END

    has_dest = ev.destination_type != "none"
    first_dest = has_dest and (not ev.destination_hash or ev.destination_hash not in st.seen_dest)
    first_tool = (not ev.tool) or ev.tool not in st.seen_tool
    first_action = ev.action_type not in st.seen_action

    x = math.log1p(ev.resource_count)
    if st.n >= MIN_BASELINE:
        z = (x - st.mean) / math.sqrt(st.m2 / st.n + 0.25)
        resource_z = _clamp(z, -5.0, 5.0) / 5.0
    else:
        resource_z = 0.0
    base_rate = w.n_base / 23.0
    rate_ratio = _clamp(math.log2((w.n60 + 1.0) / (base_rate + 1.0)), -4.0, 6.0) / 6.0

    rank = CLASS_RANK[ev.classification]
    sensitive = rank >= 2
    external = ev.destination_type in EXTERNAL_DEST
    elevated = ev.privilege_level in ELEVATED

    vec: list[float] = []
    for block, vocab in ONE_HOT_BLOCKS:
        vec += _onehot(getattr(ev, block), vocab)
    vec += [
        min(x, 16.0) / 16.0,
        min(math.log10(1.0 + ev.amount_usd), 10.0) / 10.0,
        float(off_hours),
        float(weekend),
        float(ev.environment == "production" and ev.change_window is not True),
        float(ev.has_ticket),
        min(math.log1p(w.n5), 8.0) / 8.0,
        min(math.log1p(w.n60), 8.0) / 8.0,
        rate_ratio,
        min(math.log1p(w.unique_dest_1h), 6.0) / 6.0,
        float(first_dest),
        float(first_tool),
        float(first_action),
        resource_z,
        float(st.n < MIN_BASELINE),
        min(unknown_count(ev), 4) / 4.0,
        rank / 4.0,
        float(sensitive and external),
        float(sensitive and has_dest and ev.destination_trust in UNTRUSTED),
        float(elevated and first_dest),
        float(ev.amount_usd >= 10_000 and off_hours),
        float(ev.action_type == "destructive_delete" and ev.environment == "production"),
        float(first_tool and elevated),
        float(ev.classification == "secret" and ev.destination_type not in ("none", "internal")),
        float(ev.resource_count >= 1000 and sensitive),
    ]
    return vec


def update(ev: NormalizedEvent, state: FeatureState) -> None:
    st = state.get(ev.actor_id)
    t = ev.ts_ms
    w60 = sum(1 for ts, _ in st.times if t - HOUR_MS < ts <= t)
    while st.times and st.times[0][0] <= t - DAY_MS:
        st.times.popleft()
    st.times.append((t, ev.destination_hash))
    while len(st.times) > TIMES_CAP:
        st.times.popleft()
    if ev.destination_type != "none" and ev.destination_hash and len(st.seen_dest) < SEEN_CAP:
        st.seen_dest.add(ev.destination_hash)
    if ev.tool and len(st.seen_tool) < SEEN_CAP:
        st.seen_tool.add(ev.tool)
    if len(st.seen_action) < SEEN_CAP:
        st.seen_action.add(ev.action_type)
    x = math.log1p(ev.resource_count)
    st.n += 1
    d = x - st.mean
    st.mean += d / st.n
    st.m2 += d * (x - st.mean)
    st.vol_ring.append(x)
    st.rate_ring.append(float(w60))


# ---------------------------------------------------------------- Model B: behavioural anomaly (robust statistics)

ANOMALY_SCHEMA = "orbis-anomaly-robust/1"


def _median(xs: list[float]) -> float:
    s = sorted(xs)
    n = len(s)
    m = n // 2
    return s[m] if n % 2 else (s[m - 1] + s[m]) / 2.0


def anomaly(ev: NormalizedEvent, state: FeatureState) -> dict:
    """Robust (median/MAD) deviation from the actor's own history. Call before `update`."""
    st = state.get(ev.actor_id)
    n = len(st.vol_ring)
    w = window_counts(st, ev.ts_ms)
    if n < MIN_ANOMALY_BASELINE:
        return {"score": 0.0, "sufficient": False, "samples": n, "contributions": []}
    vols, rates = list(st.vol_ring), list(st.rate_ring)
    mv, mr = _median(vols), _median(rates)
    madv = _median([abs(v - mv) for v in vols])
    madr = _median([abs(r - mr) for r in rates])
    z_vol = (math.log1p(ev.resource_count) - mv) / (1.4826 * madv + 0.25)
    z_rate = (w.n60 - mr) / (1.4826 * madr + 1.0)
    has_dest = ev.destination_type != "none"
    novelty = [
        ("first_destination", float(has_dest and (not ev.destination_hash or ev.destination_hash not in st.seen_dest))),
        ("first_tool", float((not ev.tool) or ev.tool not in st.seen_tool)),
        ("first_action", float(ev.action_type not in st.seen_action)),
    ]
    contributions = [("volume", max(0.0, z_vol) / 4.0), ("rate", max(0.0, z_rate) / 4.0)] + [(k, 0.35 * v) for k, v in novelty]
    s = sum(c for _, c in contributions)
    contributions = sorted([c for c in contributions if c[1] > 0], key=lambda c: (-c[1], c[0]))
    return {
        "score": 1.0 - math.exp(-s),
        "sufficient": True,
        "samples": n,
        "z_volume": z_vol,
        "z_rate": z_rate,
        "contributions": [{"feature": k, "weight": v} for k, v in contributions],
    }


def spec() -> dict:
    """Machine-readable feature spec consumed by the Swift / TS / C++ ports and the docs."""
    return {
        "feature_schema": FEATURE_SCHEMA,
        "n_features": N_FEATURES,
        "names": FEATURE_NAMES,
        "one_hot_blocks": [{"field": b, "vocab": v, "unknown_index": len(v)} for b, v in ONE_HOT_BLOCKS],
        "numeric": NUMERIC_FEATURES,
        "constants": {
            "window_5m_ms": WINDOW_5M,
            "hour_ms": HOUR_MS,
            "day_ms": DAY_MS,
            "seen_cap": SEEN_CAP,
            "ring_cap": RING_CAP,
            "times_cap": TIMES_CAP,
            "min_baseline": MIN_BASELINE,
            "min_anomaly_baseline": MIN_ANOMALY_BASELINE,
            "business_hours": [BUSINESS_START, BUSINESS_END],
        },
        "class_rank": CLASS_RANK,
        "external_destinations": sorted(EXTERNAL_DEST),
        "untrusted": sorted(UNTRUSTED),
        "elevated": sorted(ELEVATED),
        "anomaly_schema": ANOMALY_SCHEMA,
        "unknown_policy": "Unknown/missing enum values map to an explicit 'unknown' one-hot column. Every field except action.tool_risk_class also counts toward unknown_fields (the OOD signal). For cross features unknown classification is sensitive, unknown destination is external+untrusted, unknown privilege is elevated.",
    }

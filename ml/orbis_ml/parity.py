"""Cross-language parity fixtures for the deterministic feature calculator + anomaly scorer.

Writes fixtures/endpoint-events/feature-parity.json, consumed by:
  - apps/macos-endpoint   (Swift, XCTest)          — exact categorical, 1e-9 floats
  - apps/web              (TypeScript, vitest)      — same
  - packages/cxx-risk-core (C++20, parity runner)   — same
Also writes the replayable demo streams the endpoint agent ships with (hero + Demo A/B).
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from . import dataset, features, gold, schema
from .generator import format_ts

OUT = dataset.ROOT / "fixtures" / "endpoint-events"

INVALID = [
    ("negative count", {"resource": {"classification": "internal", "count": -1}}, "resource.count"),
    ("boolean count", {"resource": {"classification": "internal", "count": True}}, "resource.count"),
    ("count too large", {"resource": {"classification": "internal", "count": 10_000_001}}, "resource.count"),
    ("malformed timestamp", {"timestamp": "2026-10-07 18:00:00"}, "timestamp"),
    ("timestamp out of range", {"timestamp": "2026-13-07T18:00:00Z"}, "timestamp"),
    ("raw domain instead of hash", {"destination": {"type": "external_domain", "trust": "unverified", "domain_hash": "quickscribe-ai.app"}}, "destination.domain_hash"),
    ("negative amount", {"business_context": {"amount_usd": -5}}, "business_context.amount_usd"),
    ("string amount", {"business_context": {"amount_usd": "100"}}, "business_context.amount_usd"),
    ("wrong schema", {"schema": "endpoint-event/0"}, "schema"),
    ("missing actor id", {"actor": {"type": "agent"}}, "actor.id"),
    ("tz offset out of range", {"tz_offset_minutes": 900}, "tz_offset_minutes"),
    ("non-boolean change window", {"business_context": {"change_window": "yes"}}, "business_context.change_window"),
]


def _base_event() -> dict:
    return {
        "schema": schema.SCHEMA_ID,
        "event_id": "evt_edge_base",
        "timestamp": "2026-10-07T18:00:00.000Z",
        "tz_offset_minutes": -240,
        "actor": {"id": "edge-actor", "type": "agent", "privilege_level": "standard"},
        "action": {"type": "external_send", "tool": "email.send", "tool_risk_class": "high"},
        "resource": {"classification": "confidential", "count": 3},
        "destination": {"type": "external_domain", "trust": "unverified", "domain_hash": schema.domain_hash("example.org")},
        "environment": "none",
        "device_posture": "managed",
        "business_context": {"amount_usd": 0, "change_window": None, "ticket": False},
    }


def _merge(base: dict, patch: dict) -> dict:
    out = json.loads(json.dumps(base))
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = {**out[k], **v}
            if v == {}:
                out[k] = {}
        else:
            out[k] = v
    return out


def edge_case_stream() -> list[dict]:
    """Hand-written stream exercising unknowns, empties, extremes, ordering quirks and time edges."""
    b = _base_event()
    t0 = schema.parse_ts_ms(b["timestamp"])
    specs = [
        {},
        {"timestamp": format_ts(t0 + 1000)[:-5] + "Z"},  # no millis
        {"timestamp": format_ts(t0 + 1000)},  # same instant as previous
        {"timestamp": format_ts(t0 - 30_000)},  # out of order (clock skew)
        {"action": {"type": "exfil_v2"}},  # unknown action
        {"resource": {"classification": "top_secret", "count": 0}},  # unknown class, zero count
        {"destination": {"type": "carrier_pigeon", "trust": "maybe", "domain_hash": ""}},
        {"destination": {}},  # no destination → type none
        {"action": {"type": "tool_invoke", "tool": ""}},  # empty tool
        {"actor": {"id": "edge-actor", "type": "robot", "privilege_level": "root"}},
        {"device_posture": "jailbroken", "environment": "moon"},
        {"resource": {"classification": "secret", "count": 10_000_000}},
        {"business_context": {"amount_usd": 9_999_999_999.99, "change_window": True, "ticket": True}},
        {"business_context": {"amount_usd": 12_500.5}, "timestamp": "2026-10-10T07:30:00.000Z"},  # Saturday
        {"environment": "production", "action": {"type": "destructive_delete", "tool": "psql.drop"}},
        {"environment": "production", "action": {"type": "production_deploy", "tool": "deploy.promote"}, "business_context": {"change_window": False}},
        {"actor": {"id": "edge-actor", "type": "human", "privilege_level": "admin"}, "destination": {"type": "external_identity", "trust": "unverified", "domain_hash": schema.domain_hash("contractor.dev")}},
        {"tz_offset_minutes": 330, "timestamp": "2026-10-07T23:59:59.999Z"},  # IST, crosses midnight
        {"tz_offset_minutes": -840, "timestamp": "2026-10-08T00:00:00.000Z"},
        {"timestamp": "2026-10-08T18:00:00.000Z"},  # +24h: window eviction
        {"timestamp": "2026-10-08T18:00:00.000Z", "actor": {"id": "other-actor", "type": "agent", "privilege_level": "standard"}},
    ]
    out = []
    for i, s in enumerate(specs):
        e = _merge(b, s)
        e["event_id"] = f"evt_edge_{i:02d}"
        out.append(e)
    # 30 quick repeats to cross the anomaly baseline threshold, then a spike.
    for i in range(30):
        e = _merge(b, {"timestamp": format_ts(t0 + 2 * 86_400_000 + i * 60_000), "resource": {"classification": "internal", "count": 2 + i % 3}})
        e["event_id"] = f"evt_edge_rep_{i:02d}"
        out.append(e)
    spike = _merge(b, {"timestamp": format_ts(t0 + 2 * 86_400_000 + 31 * 60_000), "resource": {"classification": "confidential", "count": 5000}})
    spike["event_id"] = "evt_edge_spike"
    out.append(spike)
    return out


def expected(stream: list[dict]) -> list[dict]:
    st = features.FeatureState()
    rows = []
    for e in stream:
        n = schema.validate(e)
        rows.append({"event_id": e["event_id"], "features": features.compute(n, st), "anomaly": features.anomaly(n, st)})
        features.update(n, st)
    return rows


def write_feature_fixtures() -> dict:
    OUT.mkdir(parents=True, exist_ok=True)
    g = gold.build()
    pick = ["g-h01", "g-h11", "g-h15", "g-h18", "g-h20", "g-s02", "g-s12", "g-s14", "g-s16", "g-s20", "g-s21", "g-s22", "g-n03", "g-n06", "g-n10", "g-n12", "g-n14", "g-k03"]
    streams = [{"name": f"gold:{x['id']}", "events": x["history"] + [x["probe"]]} for x in g if x["id"] in pick]
    events = schema.load_jsonl(dataset.DATA / dataset.NAME / "1.0.0" / "events.jsonl")
    actors = {"support-copilot-2", "procurement-agent-1", "engineer.ari"}
    sub = [e for e in events if e["actor"]["id"] in actors][:500]
    streams.append({"name": "dataset:northstar-actions@1.0.0[3 actors, first 500 events]", "events": sub})
    streams.append({"name": "edge-cases", "events": edge_case_stream()})
    for s in streams:
        s["expected"] = expected(s["events"])
    invalid = []
    for name, patch, field in INVALID:
        e = _merge(_base_event(), patch)
        e["event_id"] = "evt_invalid_" + name.replace(" ", "_")
        if name == "missing actor id":
            e["actor"] = {"type": "agent"}
        try:
            schema.validate(e)
            raise AssertionError(f"{name} unexpectedly valid")
        except schema.SchemaError as err:
            invalid.append({"name": name, "event": e, "field": field, "error": str(err)})
    doc = {
        "feature_schema": features.FEATURE_SCHEMA,
        "anomaly_schema": features.ANOMALY_SCHEMA,
        "n_features": features.N_FEATURES,
        "feature_names": features.FEATURE_NAMES,
        "tolerance": {"categorical": 0, "float": 1e-9},
        "streams": streams,
        "invalid": invalid,
    }
    (OUT / "feature-parity.json").write_text(json.dumps(doc, separators=(",", ":")))
    (OUT / "feature-spec.json").write_text(json.dumps(features.spec(), indent=2) + "\n")
    (OUT / "endpoint-event.v1.schema.json").write_text(json.dumps(schema.json_schema(), indent=2) + "\n")
    # Demo streams the endpoint agent can replay.
    by_id = {x["id"]: x for x in g}
    for name, gid, actor in (("hero", "g-h01", "procurement-agent"), ("demo-a-safe-unusual", "g-n06", "procurement-agent"), ("demo-b-behavioural-ramp", "g-s22", "support-copilot"), ("hero-redirected", "g-n14", "procurement-agent")):
        x = by_id[gid]
        stream = json.loads(json.dumps(x["history"] + [x["probe"]]))
        for e in stream:
            e["actor"]["id"] = actor
            e["endpoint_id"] = f"ep_{actor}_host"
            e["session_id"] = e["session_id"].replace(x["probe"]["actor"]["id"], actor)
        schema.dump_jsonl(stream, OUT / f"{name}.jsonl")
    return {"streams": len(streams), "vectors": sum(len(s["expected"]) for s in streams), "invalid": len(invalid), "bytes": (OUT / "feature-parity.json").stat().st_size}

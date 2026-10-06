"""Canonical endpoint event schema (endpoint-event/1) and the vocabularies shared by every runtime.

Design rules (blueprint §6, §24):
- Only metadata is carried. Destinations are hashed on the endpoint; raw document content never is.
- Unknown or missing enum values map to an explicit "unknown" bucket — never to a safe default.
- Impossible values (negative counts, malformed timestamps, wrong types) are rejected, not coerced.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any

SCHEMA_ID = "endpoint-event/1"
LABEL_SCHEMA_ID = "event-label/1"

ACTOR_TYPES = ["human", "agent", "service", "automation"]
ACTION_TYPES = [
    "external_send",
    "file_upload",
    "clipboard_export",
    "tool_invoke",
    "database_query",
    "privilege_grant",
    "payment",
    "refund",
    "production_deploy",
    "secrets_access",
    "model_provider_send",
    "bulk_download",
    "destructive_delete",
    "config_change",
    "physical_operation",
]
CLASSIFICATIONS = ["public", "internal", "confidential", "restricted", "regulated", "secret"]
DESTINATION_TYPES = [
    "none",
    "internal",
    "internal_model",
    "approved_vendor",
    "external_domain",
    "external_ai_provider",
    "beneficiary",
    "external_identity",
    "partner",
    "production_env",
]
DESTINATION_TRUST = ["trusted", "approved", "unverified", "blocked"]
PRIVILEGE_LEVELS = ["standard", "elevated", "admin"]
DEVICE_POSTURES = ["managed", "unmanaged"]
TOOL_RISK = ["low", "medium", "high"]
ENVIRONMENTS = ["none", "dev", "staging", "production"]

LABELS = ["safe_normal", "safe_unusual", "suspicious_review", "high_risk"]
DIFFICULTIES = ["easy", "hard_negative", "adversarial"]
LABEL_STATES = ["gold_confirmed", "analyst_reviewed", "human_decision_proxy", "weak_label", "synthetic", "unknown"]

# Fields that, if unknown, mark the event as out-of-distribution for the edge model.
CATEGORICAL_FIELDS = {
    "actor.type": ACTOR_TYPES,
    "actor.privilege_level": PRIVILEGE_LEVELS,
    "action.type": ACTION_TYPES,
    "action.tool_risk_class": TOOL_RISK,
    "resource.classification": CLASSIFICATIONS,
    "destination.type": DESTINATION_TYPES,
    "destination.trust": DESTINATION_TRUST,
    "device_posture": DEVICE_POSTURES,
    "environment": ENVIRONMENTS,
}

TS_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$")
MAX_COUNT = 10_000_000
MAX_AMOUNT = 1e10


def domain_hash(domain: str | None) -> str:
    """Endpoint-side destination pseudonym: first 16 hex chars of sha256(lowercased domain)."""
    if not domain:
        return ""
    return hashlib.sha256(domain.strip().lower().encode()).hexdigest()[:16]


def parse_ts_ms(ts: str) -> int:
    """Strict ISO-8601 UTC parser shared (by spec) with the Swift, C++ and TS ports."""
    m = TS_RE.match(ts)
    if not m:
        raise SchemaError(f"timestamp: expected YYYY-MM-DDTHH:MM:SS[.mmm]Z, got {ts!r}")
    y, mo, d, h, mi, s = (int(m.group(i)) for i in range(1, 7))
    ms = int((m.group(7) or "0").ljust(3, "0"))
    if not (1 <= mo <= 12 and 1 <= d <= 31 and h < 24 and mi < 60 and s < 60):
        raise SchemaError(f"timestamp out of range: {ts!r}")
    return days_from_civil(y, mo, d) * 86_400_000 + h * 3_600_000 + mi * 60_000 + s * 1000 + ms


def days_from_civil(y: int, m: int, d: int) -> int:
    """Howard Hinnant's days_from_civil: integer-only, so every language agrees exactly."""
    y -= m <= 2
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def format_ts(ms: int) -> str:
    import datetime as _dt

    return _dt.datetime.fromtimestamp(ms / 1000, tz=_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + f"{ms % 1000:03d}Z"


class SchemaError(ValueError):
    pass


def _enum(value: Any, vocab: list[str]) -> str:
    return value if isinstance(value, str) and value in vocab else "unknown"


@dataclass(frozen=True)
class NormalizedEvent:
    """The subset of an endpoint event the feature calculator reads, after validation."""

    event_id: str
    ts_ms: int
    tz_offset_minutes: int
    actor_id: str
    actor_type: str
    privilege_level: str
    action_type: str
    tool: str
    tool_risk_class: str
    classification: str
    resource_count: int
    destination_type: str
    destination_trust: str
    destination_hash: str
    environment: str
    device_posture: str
    amount_usd: float
    change_window: bool | None
    has_ticket: bool


def validate(event: dict[str, Any]) -> NormalizedEvent:
    """Validate an endpoint-event/1 document. Rejects impossible data; maps unknown enums to 'unknown'."""
    if not isinstance(event, dict):
        raise SchemaError("event must be an object")
    if event.get("schema") != SCHEMA_ID:
        raise SchemaError(f"schema: expected {SCHEMA_ID!r}")
    eid = event.get("event_id")
    if not isinstance(eid, str) or not (1 <= len(eid) <= 128):
        raise SchemaError("event_id: required string ≤128")
    ts = event.get("timestamp")
    if not isinstance(ts, str):
        raise SchemaError("timestamp: required string")
    ts_ms = parse_ts_ms(ts)
    tz = event.get("tz_offset_minutes", 0)
    if not isinstance(tz, int) or isinstance(tz, bool) or not (-840 <= tz <= 840):
        raise SchemaError("tz_offset_minutes: integer in [-840, 840]")

    actor = event.get("actor")
    if not isinstance(actor, dict) or not isinstance(actor.get("id"), str) or not actor["id"]:
        raise SchemaError("actor.id: required")
    action = event.get("action")
    if not isinstance(action, dict):
        raise SchemaError("action: required object")
    resource = event.get("resource") or {}
    if not isinstance(resource, dict):
        raise SchemaError("resource: must be an object")
    count = resource.get("count", 1)
    if not isinstance(count, int) or isinstance(count, bool) or count < 0 or count > MAX_COUNT:
        raise SchemaError("resource.count: integer in [0, 10^7]")
    dest = event.get("destination") or {}
    if not isinstance(dest, dict):
        raise SchemaError("destination: must be an object")
    dh = dest.get("domain_hash", "")
    if not isinstance(dh, str) or (dh and not re.fullmatch(r"[0-9a-f]{16}", dh)):
        raise SchemaError("destination.domain_hash: 16 lowercase hex chars (never the raw domain)")
    bc = event.get("business_context") or {}
    if not isinstance(bc, dict):
        raise SchemaError("business_context: must be an object")
    amount = bc.get("amount_usd", 0)
    if isinstance(amount, bool) or not isinstance(amount, (int, float)) or amount < 0 or amount > MAX_AMOUNT or amount != amount:
        raise SchemaError("business_context.amount_usd: number in [0, 1e10]")
    cw = bc.get("change_window")
    if cw is not None and not isinstance(cw, bool):
        raise SchemaError("business_context.change_window: boolean or null")
    tool = action.get("tool") or ""
    if not isinstance(tool, str) or len(tool) > 120:
        raise SchemaError("action.tool: string ≤120")

    return NormalizedEvent(
        event_id=eid,
        ts_ms=ts_ms,
        tz_offset_minutes=tz,
        actor_id=actor["id"],
        actor_type=_enum(actor.get("type"), ACTOR_TYPES),
        privilege_level=_enum(actor.get("privilege_level"), PRIVILEGE_LEVELS),
        action_type=_enum(action.get("type"), ACTION_TYPES),
        tool=tool,
        tool_risk_class=_enum(action.get("tool_risk_class"), TOOL_RISK),
        classification=_enum(resource.get("classification"), CLASSIFICATIONS),
        resource_count=count,
        destination_type=_enum(dest.get("type", "none"), DESTINATION_TYPES),
        destination_trust=_enum(dest.get("trust"), DESTINATION_TRUST) if dest.get("type", "none") != "none" else "trusted",
        destination_hash=dh,
        environment=_enum(event.get("environment", "none"), ENVIRONMENTS),
        device_posture=_enum(event.get("device_posture"), DEVICE_POSTURES),
        amount_usd=float(amount),
        change_window=cw,
        has_ticket=bool(bc.get("ticket", False)),
    )


def json_schema() -> dict[str, Any]:
    """JSON Schema (draft 2020-12) for endpoint-event/1, exported for SDKs and docs."""
    enum = lambda v: {"type": "string", "description": f"One of {v}; anything else is treated as 'unknown' (never safe)."}
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "$id": "https://orbis-relay.vercel.app/schemas/endpoint-event.v1.json",
        "title": "Orbis endpoint event (endpoint-event/1)",
        "description": "Privacy-preserving, metadata-only event emitted by the Orbis endpoint runtime before a sensitive action executes. Raw content and raw destinations are never included.",
        "type": "object",
        "required": ["schema", "event_id", "timestamp", "actor", "action"],
        "properties": {
            "schema": {"const": SCHEMA_ID},
            "event_id": {"type": "string", "maxLength": 128},
            "tenant_id": {"type": "string"},
            "timestamp": {"type": "string", "pattern": TS_RE.pattern},
            "tz_offset_minutes": {"type": "integer", "minimum": -840, "maximum": 840},
            "endpoint_id": {"type": "string"},
            "session_id": {"type": "string"},
            "app": {"type": "string"},
            "actor": {
                "type": "object",
                "required": ["id"],
                "properties": {"id": {"type": "string"}, "type": {**enum(ACTOR_TYPES), "examples": ACTOR_TYPES}, "owner": {"type": "string"}, "privilege_level": {**enum(PRIVILEGE_LEVELS), "examples": PRIVILEGE_LEVELS}},
            },
            "action": {
                "type": "object",
                "properties": {"type": {**enum(ACTION_TYPES), "examples": ACTION_TYPES}, "tool": {"type": "string", "maxLength": 120}, "tool_risk_class": {**enum(TOOL_RISK), "examples": TOOL_RISK}},
            },
            "resource": {
                "type": "object",
                "properties": {"types": {"type": "array", "items": {"type": "string"}}, "classification": {**enum(CLASSIFICATIONS), "examples": CLASSIFICATIONS}, "count": {"type": "integer", "minimum": 0, "maximum": MAX_COUNT}},
            },
            "destination": {
                "type": "object",
                "properties": {"type": {**enum(DESTINATION_TYPES), "examples": DESTINATION_TYPES}, "trust": {**enum(DESTINATION_TRUST), "examples": DESTINATION_TRUST}, "domain_hash": {"type": "string", "pattern": "^([0-9a-f]{16})?$"}},
            },
            "environment": {**enum(ENVIRONMENTS), "examples": ENVIRONMENTS},
            "device_posture": {**enum(DEVICE_POSTURES), "examples": DEVICE_POSTURES},
            "business_context": {
                "type": "object",
                "properties": {"amount_usd": {"type": "number", "minimum": 0, "maximum": MAX_AMOUNT}, "change_window": {"type": ["boolean", "null"]}, "ticket": {"type": "boolean"}},
            },
            "requested_intent": {"type": "string", "maxLength": 500, "description": "Untrusted, agent-supplied text. Not an input to the edge risk model."},
            "edge_model_version": {"type": "string"},
            "model_features_version": {"type": "string"},
        },
    }


def dump_jsonl(rows, path) -> None:
    with open(path, "w") as f:
        for r in rows:
            f.write(json.dumps(r, separators=(",", ":"), sort_keys=True) + "\n")


def load_jsonl(path):
    with open(path) as f:
        return [json.loads(line) for line in f if line.strip()]

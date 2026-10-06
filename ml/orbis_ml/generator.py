"""Northstar Cloud synthetic action-event generator (dataset family `northstar-actions`).

Deterministic from a seed. Simulates 28 days of a fictional company's agents, automations and people
(the same actors the Orbis demo tenant uses), then injects labelled scenario templates:

  normal          — everyday workflows per actor profile
  hard_negative   — look risky, are fine (approved vendor + ticket, on-call deploy in window, nightly export…)
  suspicious      — deserve human review (queue breach, refund spike, deploy outside window, outbound burst…)
  high_risk       — should not proceed (secret egress, bulk customer export, external admin grant…)
  adversarial     — deliberately evasive (split exfiltration, just-under-threshold payments, new tool to a
                    known destination, disguised classification, slow ramp, masked fields)

Labels come from the scenario that produced the event (ground truth by construction) — never from the
features — plus a small, documented amount of weak-label noise on the safe classes.

Splits (blueprint §8.5): never random. Time-based (train days 0-17, val 18-22, test 23-27), with whole
actor instances held out of train/val, and template variant v2 only ever generated in the test window.
"""
from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from .schema import SCHEMA_ID, domain_hash, format_ts, parse_ts_ms

TENANT = "ten_northstar"
TZ = -240  # US Eastern (EDT)
START = "2026-08-24T04:00:00.000Z"  # Monday 00:00 local
DAYS = 28
TRAIN_DAYS, VAL_DAYS = 18, 5

INTERNAL = ("internal", "trusted")
PRIVATE_LLM = "northstar-private-llm"
APPROVED_VENDORS = ["acme-supplies.com", "globex-logistics.com", "initech-hardware.com", "umbrella-auditors.com", "stark-industrial.com", "wayne-fabrication.com", "hooli-cloud.com", "vandelay-imports.com"]
APPROVED_AI = ["azure-openai.northstar.cloud"]
UNVERIFIED_AI = ["quickscribe-ai.app", "summarizr.io", "openwrite-ai.com", "quickgpt.app", "docuchat.ai", "gistly.io"]
PARTNERS = ["meridian-health.org", "lakeside-clinic.org", "harbor-care.net"]
ESP = ["mail.sendgrid-northstar.net"]
BLOCKED = ["pastebin-mirror.xyz", "anonfiles.cc"]


@dataclass
class Ctx:
    rng: np.random.Generator
    actor: "Actor"
    t: int  # ms
    variant: int = 0

    def pick(self, xs):
        return xs[int(self.rng.integers(len(xs)))]

    def between(self, lo: int, hi: int) -> int:
        return int(self.rng.integers(lo, hi + 1))


@dataclass
class Actor:
    id: str
    family: str
    type: str
    privilege: str
    posture: str
    instance: int
    held_out: bool
    vendors: list[str] = field(default_factory=list)
    tools: dict[str, str] = field(default_factory=dict)


# ------------------------------------------------------------------ event construction

def ev(c: Ctx, *, action: str, tool: str, risk: str | None = None, cls: str = "internal", count: int = 1, dest: tuple[str, str] | None = None, domain: str | None = None, env: str = "none", amount: float = 0.0, window: bool | None = None, ticket: bool = False, label: str = "safe_normal", family: str, template: str, difficulty: str = "easy", reasons: tuple[str, ...] = (), intent: str = "", privilege: str | None = None, posture: str | None = None, dt_ms: int = 0) -> tuple[dict, dict]:
    a = c.actor
    dest_type, trust = dest if dest else ("none", "trusted")
    t = c.t + dt_ms
    eid = "evt_" + hashlib.sha256(f"{a.id}|{t}|{tool}|{template}|{c.rng.integers(1 << 30)}".encode()).hexdigest()[:20]
    event = {
        "schema": SCHEMA_ID,
        "event_id": eid,
        "tenant_id": TENANT,
        "timestamp": format_ts(t),
        "tz_offset_minutes": TZ,
        "endpoint_id": f"ep_{a.family}_{a.instance}",
        "session_id": f"ses_{a.id}_{t // 3_600_000}",
        "app": f"{a.family}-host",
        "actor": {"id": a.id, "type": a.type, "owner": a.family, "privilege_level": privilege or a.privilege},
        "action": {"type": action, "tool": tool, "tool_risk_class": risk if risk is not None else a.tools.get(tool, "unknown")},
        "resource": {"types": ["document"], "classification": cls, "count": int(count)},
        "destination": {"type": dest_type, "trust": trust, "domain_hash": domain_hash(domain) if dest_type != "none" else ""},
        "environment": env,
        "device_posture": posture or a.posture,
        "business_context": {"amount_usd": round(float(amount), 2), "change_window": window, "ticket": ticket},
        "requested_intent": intent,
    }
    lab = {
        "event_id": eid,
        "security_label": label,
        "expected_policy_decision": {"safe_normal": "allow", "safe_unusual": "warn", "suspicious_review": "approval_required", "high_risk": "deny"}[label],
        "expected_review_requirement": label in ("suspicious_review", "high_risk"),
        "reason_codes": list(reasons),
        "scenario_family": family,
        "scenario_template": template,
        "template_variant": c.variant,
        "difficulty": difficulty,
        "source": "synthetic",
        "labeler": "generator:northstar-actions",
        "label_state": "synthetic",
        "label_confidence": 1.0,
        "actor_family": a.family,
        "actor_id": a.id,
        "held_out_actor": a.held_out,
    }
    return event, lab


Template = Callable[[Ctx], list[tuple[dict, dict]]]


def one(fn):
    return lambda c: [fn(c)]


# ------------------------------------------------------------------ normal behaviour, per actor family

def customer_domain(c: Ctx) -> str:
    return f"customer-{c.between(1, 2500)}.com"


def prospect_domain(c: Ctx) -> str:
    return f"prospect-{c.between(1, 6000)}.io"


NORMAL: dict[str, list[tuple[float, Template]]] = {
    "procurement-agent": [
        (7, one(lambda c: ev(c, action="tool_invoke", tool="docs.search", cls="internal", count=c.between(1, 8), dest=INTERNAL, domain="docs.northstar.cloud", family="normal", template="procurement_search"))),
        (5, one(lambda c: ev(c, action="model_provider_send", tool="llm.summarize", cls="confidential", count=c.between(1, 6), dest=("internal_model", "trusted"), domain=PRIVATE_LLM, family="normal", template="procurement_private_llm"))),
        (2, one(lambda c: ev(c, action="external_send", tool="email.send", cls=c.pick(["public", "internal"]), count=c.between(1, 3), dest=("approved_vendor", "approved"), domain=c.pick(c.actor.vendors), family="normal", template="procurement_vendor_email"))),
        (0.5, one(lambda c: ev(c, action="tool_invoke", tool=c.pick(["calendar.schedule", "sheets.read", "erp.lookup"]), risk="unknown", cls="internal", count=c.between(1, 5), family="normal", template="procurement_unregistered_tool"))),
    ],
    "ap-workflow": [
        (1, one(lambda c: ev(c, action="payment", tool="payments.release", cls="confidential", amount=float(np.exp(c.rng.normal(7.8, 0.8))), dest=("beneficiary", "approved"), domain=c.pick(c.actor.vendors), family="normal", template="ap_known_vendor"))),
    ],
    "support-copilot": [
        (9, one(lambda c: ev(c, action="refund", tool="billing.refund", cls="confidential", amount=float(np.exp(c.rng.normal(4.0, 0.7))), dest=INTERNAL, domain="billing.northstar.cloud", ticket=True, family="normal", template="support_refund_small"))),
        (8, one(lambda c: ev(c, action="external_send", tool="tickets.reply", cls="public", dest=("external_domain", "approved"), domain=customer_domain(c), ticket=True, family="normal", template="support_reply"))),
        (5, one(lambda c: ev(c, action="database_query", tool="crm.lookup", cls="internal", count=1, ticket=True, family="normal", template="support_lookup"))),
    ],
    "ci-deployer": [
        (4, one(lambda c: ev(c, action="tool_invoke", tool="deploy.promote", cls="internal", env="staging", dest=("production_env", "trusted"), domain="staging.northstar.cloud", family="normal", template="deploy_staging"))),
        (3, one(lambda c: ev(c, action="production_deploy", tool="deploy.promote", cls="internal", env="production", window=True, ticket=True, dest=("production_env", "trusted"), domain="prod.northstar.cloud", family="normal", template="deploy_prod_window"))),
    ],
    "access-broker": [
        (1, one(lambda c: ev(c, action="privilege_grant", tool="iam.grant", cls="internal", env=c.pick(["production", "staging"]), window=True, ticket=True, dest=INTERNAL, domain="iam.northstar.cloud", family="normal", template="access_jit"))),
    ],
    "export-workflow": [
        (1, one(lambda c: ev(c, action="bulk_download", tool="warehouse.export", cls=c.pick(["internal", "confidential"]), count=c.between(100, 5000), dest=INTERNAL, domain="sandbox.analytics.northstar.cloud", family="normal", template="export_nightly"))),
    ],
    "sales-agent": [
        (3, one(lambda c: ev(c, action="external_send", tool="email.send", cls="public", dest=("external_domain", "unverified"), domain=prospect_domain(c), family="normal", template="sales_outreach"))),
        (1, one(lambda c: ev(c, action="database_query", tool="crm.lookup", cls="internal", count=c.between(1, 20), family="normal", template="sales_crm"))),
    ],
    "records-exchange": [
        (1, one(lambda c: ev(c, action="external_send", tool="hie.release", cls="regulated", count=c.between(5, 300), dest=("partner", "approved"), domain=c.pick(PARTNERS), ticket=True, family="normal", template="records_release"))),
    ],
    "facility-ai": [
        (6, one(lambda c: ev(c, action="tool_invoke", tool="telemetry.read", cls="internal", count=c.between(1, 50), family="normal", template="facility_read"))),
        (0.15, one(lambda c: ev(c, action="physical_operation", tool="bms.stop_line", cls="internal", env="production", window=False, label="suspicious_review", family="suspicious", template="facility_stop", reasons=("physical_impact",)))),
    ],
    "ops-agent": [
        (8, one(lambda c: ev(c, action="tool_invoke", tool="runbook.exec", cls="internal", env="production", family="normal", template="ops_runbook"))),
        (2, one(lambda c: ev(c, action="config_change", tool="config.apply", cls="internal", env="production", window=True, ticket=True, family="normal", template="ops_config"))),
        (0.6, one(lambda c: ev(c, action="destructive_delete", tool="storage.delete", cls="internal", env="staging", ticket=True, family="normal", template="ops_cleanup_staging"))),
        (0.8, one(lambda c: ev(c, action="tool_invoke", tool=c.pick(["diag.collect", "trace.dump", "dns.lookup"]), risk="unknown", cls="internal", env="production", family="normal", template="ops_unregistered_tool"))),
    ],
    "growth-agent": [
        (1, one(lambda c: ev(c, action="external_send", tool="email.bulk_send", cls="public", count=c.between(20, 300), dest=("external_domain", "unverified"), domain=prospect_domain(c), family="normal", template="growth_outreach"))),
    ],
    "campaign-bot": [
        (1, one(lambda c: ev(c, action="external_send", tool="email.campaign", cls="public", count=c.between(1000, 20000), dest=("external_domain", "approved"), domain=ESP[0], family="normal", template="campaign_send"))),
    ],
    "engineer": [
        (5, one(lambda c: ev(c, action="database_query", tool="psql", cls="internal", count=c.between(1, 200), env=c.pick(["staging", "production"]), family="normal", template="eng_query"))),
        (3, one(lambda c: ev(c, action="tool_invoke", tool="kubectl", cls="internal", env=c.pick(["staging", "production"]), family="normal", template="eng_kubectl"))),
        (2, one(lambda c: ev(c, action="bulk_download", tool="logs.fetch", cls="internal", count=c.between(1, 40), dest=INTERNAL, domain="logs.northstar.cloud", family="normal", template="eng_logs"))),
        (1.2, one(lambda c: ev(c, action="secrets_access", tool="vault.read", cls="secret", count=1, env=c.pick(["staging", "production"]), ticket=bool(c.rng.random() < 0.7), family="normal", template="eng_secret_read"))),
        (1, one(lambda c: ev(c, action="clipboard_export", tool="ide.copy", cls="internal", count=1, family="normal", template="eng_clipboard"))),
        (0.8, one(lambda c: ev(c, action="file_upload", tool="drive.upload", cls="internal", count=c.between(1, 4), dest=INTERNAL, domain="drive.northstar.cloud", family="normal", template="eng_upload"))),
        # Unregistered tools are everyday engineering reality, not an attack signal on their own.
        (1.2, one(lambda c: ev(c, action=c.pick(["tool_invoke", "database_query"]), tool=c.pick(["jq", "httpie", "terraform.plan", "gh.cli", "make", "datadog.query", "pgcli"]), risk="unknown", cls="internal", count=c.between(1, 30), env=c.pick(["dev", "staging", "production"]), family="normal", template="eng_unregistered_tool"))),
        (0.4, one(lambda c: ev(c, action="external_send", tool=c.pick(["slack.connect", "email.send", "zoom.share"]), risk="unknown", cls="public", count=1, dest=("external_domain", "unverified"), domain=f"partner-dev-{c.between(1, 400)}.io", family="normal", template="eng_external_public"))),
    ],
    "finance-analyst": [
        (4, one(lambda c: ev(c, action="database_query", tool="erp.report", cls="confidential", count=c.between(10, 500), family="normal", template="fin_report"))),
        (2, one(lambda c: ev(c, action="bulk_download", tool="erp.export", cls="confidential", count=c.between(10, 800), dest=INTERNAL, domain="drive.northstar.cloud", family="normal", template="fin_export"))),
        (1, one(lambda c: ev(c, action="file_upload", tool="drive.share", cls="confidential", count=c.between(1, 5), dest=("approved_vendor", "approved"), domain="umbrella-auditors.com", ticket=True, family="normal", template="fin_auditor_share"))),
    ],
    "sales-rep": [
        (4, one(lambda c: ev(c, action="external_send", tool="email.send", cls="public", dest=("external_domain", "unverified"), domain=prospect_domain(c), family="normal", template="rep_email"))),
        (2, one(lambda c: ev(c, action="database_query", tool="crm.lookup", cls="internal", count=c.between(1, 30), family="normal", template="rep_crm"))),
        (1, one(lambda c: ev(c, action="file_upload", tool="drive.share", cls="public", count=1, dest=("external_domain", "unverified"), domain=prospect_domain(c), family="normal", template="rep_share_deck"))),
        (0.7, one(lambda c: ev(c, action="external_send", tool=c.pick(["linkedin.message", "gong.share"]), risk="unknown", cls="public", count=1, dest=("external_domain", "unverified"), domain=prospect_domain(c), family="normal", template="rep_unregistered_tool"))),
    ],
    "it-admin": [
        (2, one(lambda c: ev(c, action="privilege_grant", tool="iam.grant", cls="internal", env="production", window=True, ticket=True, dest=INTERNAL, domain="iam.northstar.cloud", family="normal", template="admin_grant"))),
        (2, one(lambda c: ev(c, action="config_change", tool="mdm.policy", cls="internal", env="production", window=True, ticket=True, family="normal", template="admin_config"))),
        (2, one(lambda c: ev(c, action="database_query", tool="directory.lookup", cls="internal", count=c.between(1, 20), family="normal", template="admin_lookup"))),
    ],
    "support-lead": [
        (3, one(lambda c: ev(c, action="refund", tool="billing.refund", cls="confidential", amount=float(np.exp(c.rng.normal(5.5, 0.8))), dest=INTERNAL, domain="billing.northstar.cloud", ticket=True, family="normal", template="lead_refund"))),
        (3, one(lambda c: ev(c, action="database_query", tool="crm.lookup", cls="internal", count=c.between(1, 10), family="normal", template="lead_lookup"))),
    ],
}

TOOLS = {
    "procurement-agent": {"docs.search": "low", "llm.summarize": "high", "email.send": "high"},
    "ap-workflow": {"payments.release": "high"},
    "support-copilot": {"billing.refund": "medium", "tickets.reply": "low", "crm.lookup": "low"},
    "ci-deployer": {"deploy.promote": "high"},
    "access-broker": {"iam.grant": "high"},
    "export-workflow": {"warehouse.export": "high"},
    "sales-agent": {"email.send": "medium", "crm.lookup": "low"},
    "records-exchange": {"hie.release": "high"},
    "facility-ai": {"telemetry.read": "low", "bms.stop_line": "high"},
    "ops-agent": {"runbook.exec": "medium", "config.apply": "medium", "storage.delete": "high"},
    "growth-agent": {"email.bulk_send": "high"},
    "campaign-bot": {"email.campaign": "medium"},
    "engineer": {"psql": "medium", "kubectl": "medium", "logs.fetch": "low", "vault.read": "high", "ide.copy": "low", "drive.upload": "low"},
    "finance-analyst": {"erp.report": "low", "erp.export": "medium", "drive.share": "medium"},
    "sales-rep": {"email.send": "low", "crm.lookup": "low", "drive.share": "medium"},
    "it-admin": {"iam.grant": "high", "mdm.policy": "medium", "directory.lookup": "low"},
    "support-lead": {"billing.refund": "medium", "crm.lookup": "low"},
}


@dataclass
class Family:
    type: str
    privilege: str
    instances: int
    rate: Callable[[int, int], float]  # (local hour, weekday) -> events/hour
    posture: str = "managed"


def biz(on: float, off: float, weekend: float | None = None):
    def f(h: int, wd: int) -> float:
        if wd in (0, 6):
            return off if weekend is None else weekend
        return on if 8 <= h < 19 else off
    return f


def nightly(h: int, wd: int) -> float:
    return 3.0 if 1 <= h < 3 else 0.05


FAMILIES: dict[str, Family] = {
    "procurement-agent": Family("agent", "standard", 3, biz(3.0, 0.4, 0.2)),
    "ap-workflow": Family("automation", "elevated", 2, lambda h, wd: 2.0 if wd not in (0, 6) and 9 <= h < 17 else 0.0),
    "support-copilot": Family("agent", "standard", 4, biz(4.0, 1.5, 1.2)),
    "ci-deployer": Family("automation", "elevated", 3, biz(2.0, 0.15, 0.1)),
    "access-broker": Family("service", "admin", 2, biz(0.6, 0.15)),
    "export-workflow": Family("automation", "elevated", 2, nightly),
    "sales-agent": Family("agent", "standard", 3, biz(2.0, 0.2, 0.0)),
    "records-exchange": Family("automation", "elevated", 2, biz(0.8, 0.1, 0.0)),
    "facility-ai": Family("agent", "elevated", 2, lambda h, wd: 1.0),
    "ops-agent": Family("agent", "elevated", 3, lambda h, wd: 3.0 if 8 <= h < 19 else 1.5),
    "growth-agent": Family("agent", "standard", 2, biz(1.5, 0.1, 0.0)),
    "campaign-bot": Family("automation", "standard", 2, lambda h, wd: 1.0 if 9 <= h < 18 else 0.0),
    "engineer": Family("human", "standard", 8, biz(2.5, 0.08, 0.04)),
    "finance-analyst": Family("human", "standard", 3, biz(2.0, 0.03, 0.0)),
    "sales-rep": Family("human", "standard", 4, biz(2.5, 0.05, 0.0)),
    "it-admin": Family("human", "admin", 2, biz(1.5, 0.05, 0.02)),
    "support-lead": Family("human", "standard", 2, biz(1.5, 0.05, 0.0)),
}


# ------------------------------------------------------------------ scenario injections

def seq(c: Ctx, n: int, gap: tuple[int, int], make: Callable[[Ctx, int], tuple[dict, dict]]) -> list[tuple[dict, dict]]:
    out, t0 = [], c.t
    for i in range(n):
        out.append(make(c, i))
        c.t += c.between(*gap) * 1000
    c.t = t0
    return out


def S_queue_breach(c: Ctx):
    n = c.between(3, 8)
    tool = ["crm.export_contacts", "crm.bulk_view", "crm.search_all"][c.variant % 3]
    return seq(c, n, (60, 300), lambda c, i: ev(c, action="database_query", tool=tool, cls="restricted", count=c.between(50, 400), label="suspicious_review", family="suspicious", template="queue_breach", reasons=("out_of_scope_access", "new_tool")))


def S_new_ai_provider(c: Ctx):
    if c.variant == 0:
        return [ev(c, action="model_provider_send", tool="llm.summarize", cls="confidential", count=c.between(2, 6), dest=("external_ai_provider", "unverified"), domain=c.pick(UNVERIFIED_AI), label="high_risk", family="high_risk", template="confidential_to_unapproved_ai", reasons=("sensitive_external", "untrusted_destination", "first_destination"), intent="Summarize vendor contracts for RFP response")]
    if c.variant == 1:
        return [ev(c, action="model_provider_send", tool="llm.summarize", cls="confidential", count=c.between(2, 6), dest=("external_ai_provider", "approved"), domain=APPROVED_AI[0], label="suspicious_review", family="suspicious", template="confidential_to_new_approved_ai", reasons=("sensitive_external", "first_destination"))]
    return [ev(c, action="model_provider_send", tool="llm.chat", cls="restricted", count=c.between(1, 4), dest=("external_ai_provider", "unverified"), domain=c.pick(UNVERIFIED_AI), label="high_risk", family="high_risk", template="restricted_to_unapproved_ai_new_tool", reasons=("sensitive_external", "untrusted_destination", "new_tool"))]


def S_outbound_burst(c: Ctx):
    n = c.between(15, 40)
    def mk(c, i):
        lab = "safe_unusual" if i < 4 else "suspicious_review"
        return ev(c, action="external_send", tool="email.send", cls="internal", count=c.between(1, 3), dest=("external_domain", "unverified"), domain=f"burst-{c.between(1, 100000)}.net", label=lab, family="suspicious", template="outbound_burst", reasons=("rate_spike",))
    return seq(c, n, (10, 60), mk)


def S_refund_spike(c: Ctx):
    if c.variant == 1:
        return [ev(c, action="refund", tool="billing.refund", cls="confidential", amount=c.between(25_000, 90_000), dest=INTERNAL, domain="billing.northstar.cloud", label="high_risk", family="high_risk", template="refund_extreme", reasons=("amount_outlier",))]
    return [ev(c, action="refund", tool="billing.refund", cls="confidential", amount=c.between(2_000, 24_000), dest=INTERNAL, domain="billing.northstar.cloud", label="suspicious_review", family="suspicious", template="refund_spike", reasons=("amount_outlier",))]


def S_deploy_outside(c: Ctx):
    return [ev(c, action="production_deploy", tool="deploy.promote", cls="internal", env="production", window=False, ticket=c.variant == 1, dest=("production_env", "trusted"), domain="prod.northstar.cloud", label="suspicious_review", family="suspicious", template="deploy_outside_window", reasons=("outside_change_window",))]


def S_privesc_export(c: Ctx):
    external = c.variant >= 1
    a = ev(c, action="privilege_grant", tool="iam.self_elevate", risk="high", cls="internal", env="production", window=False, dest=INTERNAL, domain="iam.northstar.cloud", label="safe_unusual", family="suspicious", template="privesc_then_export", reasons=("self_elevation",))
    c2 = Ctx(c.rng, c.actor, c.t + c.between(5, 50) * 60_000, c.variant)
    if external:
        b = ev(c2, action="file_upload", tool="drive.share", cls="restricted", count=c.between(2_000, 50_000), dest=("external_domain", "unverified"), domain=f"files-{c.between(1, 999)}.net", privilege="admin", label="high_risk", family="high_risk", template="privesc_then_export", reasons=("bulk_sensitive", "sensitive_external", "post_elevation"))
    else:
        b = ev(c2, action="bulk_download", tool="warehouse.export", risk="high", cls="restricted", count=c.between(2_000, 50_000), dest=INTERNAL, domain="drive.northstar.cloud", privilege="admin", label="suspicious_review", family="suspicious", template="privesc_then_export", reasons=("bulk_sensitive", "post_elevation"))
    return [a, b]


def H_secret_egress(c: Ctx):
    action = ["file_upload", "external_send", "clipboard_export"][c.variant]
    dest = ("external_domain", "unverified") if c.variant < 2 else ("external_domain", "blocked")
    return [ev(c, action=action, tool=["drive.share", "email.send", "browser.paste"][c.variant], risk="high" if c.variant < 2 else "unknown", cls="secret", count=c.between(1, 3), dest=dest, domain=c.pick(BLOCKED) if c.variant == 2 else f"share-{c.between(1, 999)}.io", label="high_risk", family="high_risk", template="secret_egress", reasons=("secret_egress", "untrusted_destination"))]


def H_bulk_customer_export(c: Ctx):
    return [ev(c, action="bulk_download", tool="warehouse.export", risk="high", cls=c.pick(["restricted", "regulated"]), count=c.between(10_000, 500_000), dest=("external_domain", "unverified"), domain=f"bucket-{c.between(1, 999)}.s3-sync.net", label="high_risk", family="high_risk", template="bulk_customer_export", reasons=("bulk_sensitive", "sensitive_external"))]


def H_external_identity_grant(c: Ctx):
    return [ev(c, action="privilege_grant", tool="iam.grant", cls="internal", env="production", window=c.variant == 1, ticket=c.variant == 1, dest=("external_identity", "unverified"), domain=f"contractor-{c.between(1, 999)}.dev", label="high_risk", family="high_risk", template="external_identity_grant", reasons=("external_identity", "privileged"))]


def H_destructive_prod(c: Ctx):
    if c.variant == 1:
        return [ev(c, action="destructive_delete", tool="psql.drop", risk="high", cls="restricted", count=c.between(1, 5), env="production", ticket=True, window=False, label="suspicious_review", family="suspicious", template="destructive_prod_ticketed", reasons=("destructive_production",))]
    return [ev(c, action="destructive_delete", tool="psql.drop", risk="high", cls="restricted", count=c.between(1, 20), env="production", window=False, label="high_risk", family="high_risk", template="destructive_prod", reasons=("destructive_production", "no_ticket"))]


def H_payment_unseen(c: Ctx):
    return [ev(c, action="payment", tool="payments.release", cls="confidential", amount=c.between(20_000, 400_000), dest=("beneficiary", "unverified"), domain=f"acct-{c.between(1, 99999)}.bank", label="high_risk", family="high_risk", template="payment_unseen_beneficiary", reasons=("first_destination", "high_amount", "untrusted_destination"))]


def H_disable_controls(c: Ctx):
    a = ev(c, action="secrets_access", tool="security.read_keys", risk="high", cls="secret", env="production", label="high_risk", family="high_risk", template="disable_security_controls", reasons=("secrets_access", "new_tool"))
    c2 = Ctx(c.rng, c.actor, c.t + c.between(20, 240) * 1000, c.variant)
    b = ev(c2, action="config_change", tool="security.disable_edr", risk="high", cls="internal", env="production", window=False, label="high_risk", family="high_risk", template="disable_security_controls", reasons=("control_tampering", "new_tool"))
    return [a, b]


def N_confidential_approved_vendor(c: Ctx):
    return [ev(c, action="external_send", tool="email.send", cls="confidential", count=c.between(1, 4), dest=("approved_vendor", "approved"), domain=c.pick(c.actor.vendors or APPROVED_VENDORS), ticket=True, label="safe_normal", family="hard_negative", template="confidential_to_approved_vendor", difficulty="hard_negative")]


def N_quarter_end_export(c: Ctx):
    return [ev(c, action="bulk_download", tool="warehouse.export", cls="confidential", count=c.between(10_000, 60_000), dest=INTERNAL, domain="sandbox.analytics.northstar.cloud", ticket=True, label="safe_unusual", family="hard_negative", template="quarter_end_export", difficulty="hard_negative")]


def N_oncall_deploy(c: Ctx):
    return [ev(c, action="production_deploy", tool="deploy.promote", cls="internal", env="production", window=True, ticket=True, dest=("production_env", "trusted"), domain="prod.northstar.cloud", label="safe_normal", family="hard_negative", template="oncall_deploy_in_window", difficulty="hard_negative")]


def N_public_new_vendor(c: Ctx):
    return [ev(c, action="external_send", tool="email.send", cls="public", count=1, dest=("external_domain", "unverified"), domain=f"newvendor-{c.between(1, 9999)}.com", label="safe_unusual", family="hard_negative", template="public_doc_new_vendor", difficulty="hard_negative")]


def N_big_refund_ticketed(c: Ctx):
    return [ev(c, action="refund", tool="billing.refund", cls="confidential", amount=c.between(3_000, 15_000), dest=INTERNAL, domain="billing.northstar.cloud", ticket=True, label="safe_unusual", family="hard_negative", template="enterprise_refund_ticketed", difficulty="hard_negative")]


def N_incident_burst(c: Ctx):
    n = c.between(15, 40)
    return seq(c, n, (10, 45), lambda c, i: ev(c, action="tool_invoke", tool="runbook.exec", cls="internal", env="production", ticket=True, label="safe_unusual", family="hard_negative", template="incident_runbook_burst", difficulty="hard_negative"))


def N_oncall_secret(c: Ctx):
    return [ev(c, action="secrets_access", tool="vault.read", cls="secret", count=1, env="production", ticket=True, label="safe_normal", family="hard_negative", template="oncall_secret_read", difficulty="hard_negative")]


def N_large_partner_release(c: Ctx):
    return [ev(c, action="external_send", tool="hie.release", cls="regulated", count=c.between(800, 3000), dest=("partner", "approved"), domain=c.pick(PARTNERS), ticket=True, label="safe_unusual", family="hard_negative", template="large_partner_release", difficulty="hard_negative")]


def A_split_exfil(c: Ctx):
    n = c.between(18, 40)
    domain = f"drop-{c.between(1, 99999)}.org"
    return seq(c, n, (90, 400), lambda c, i: ev(c, action="external_send", tool="email.send", cls="confidential", count=c.between(1, 2), dest=("external_domain", "unverified"), domain=domain, label="suspicious_review", family="adversarial", template="split_exfiltration", difficulty="adversarial", reasons=("split_exfiltration", "sensitive_external")))


def A_known_dest_new_tool(c: Ctx):
    return [ev(c, action="model_provider_send", tool=["llm.batch_export", "llm.fine_tune_upload", "llm.embed_all"][c.variant], risk="unknown", cls="restricted", count=c.between(20, 400), dest=("internal_model", "trusted"), domain=PRIVATE_LLM, label="suspicious_review", family="adversarial", template="known_destination_new_tool", difficulty="adversarial", reasons=("new_tool", "bulk_sensitive"))]


def A_disguised_class(c: Ctx):
    return [ev(c, action="external_send", tool="email.send", cls="internal", count=c.between(1, 3), dest=("external_domain", "unverified"), domain=f"mail-{c.between(1, 9999)}.xyz", label="high_risk", family="adversarial", template="disguised_classification", difficulty="adversarial", reasons=("mislabelled_classification",))]


def A_under_threshold(c: Ctx):
    n = c.between(3, 6)
    domain = f"acct-{c.between(1, 99999)}.bank"
    return seq(c, n, (600, 3600), lambda c, i: ev(c, action="payment", tool="payments.release", cls="confidential", amount=c.between(9_500, 9_990), dest=("beneficiary", "unverified"), domain=domain, label="suspicious_review", family="adversarial", template="just_under_threshold_payments", difficulty="adversarial", reasons=("structuring", "first_destination")))


def A_masked_fields(c: Ctx):
    high = c.rng.random() < 0.5
    e, l = ev(c, action="bulk_download" if high else "tool_invoke", tool="unknown.tool", risk="unknown", cls="unknown" if high else "internal", count=c.between(100, 5000) if high else 1, dest=("unknown", "unknown") if high else None, domain="opaque.example", label="suspicious_review" if high else "safe_unusual", family="adversarial", template="masked_fields_ood", difficulty="adversarial", reasons=("out_of_distribution",))
    if high:
        e["action"]["type"] = "exfil_v2"  # not in vocab → explicit unknown
    return [(e, l)]


# family, weight (expected injections over 28 days), eligible actor families, max variant
INJECTIONS: list[tuple[Callable, float, list[str], int]] = [
    (S_queue_breach, 40, ["support-copilot"], 2),
    (S_new_ai_provider, 100, ["procurement-agent"], 2),
    (S_outbound_burst, 26, ["sales-agent", "growth-agent", "support-copilot"], 0),
    (S_refund_spike, 60, ["support-copilot"], 1),
    (S_deploy_outside, 50, ["ci-deployer"], 1),
    (S_privesc_export, 45, ["engineer", "finance-analyst"], 1),
    (H_secret_egress, 85, ["engineer", "ops-agent", "procurement-agent"], 2),
    (H_bulk_customer_export, 65, ["export-workflow", "engineer", "finance-analyst"], 0),
    (H_external_identity_grant, 55, ["access-broker", "it-admin"], 1),
    (H_destructive_prod, 70, ["ops-agent", "engineer"], 1),
    (H_payment_unseen, 70, ["ap-workflow"], 0),
    (H_disable_controls, 35, ["ops-agent"], 0),
    (N_confidential_approved_vendor, 120, ["procurement-agent", "finance-analyst"], 0),
    (N_quarter_end_export, 40, ["export-workflow"], 0),
    (N_oncall_deploy, 90, ["ci-deployer"], 0),
    (N_public_new_vendor, 120, ["procurement-agent", "finance-analyst", "engineer"], 0),
    (N_big_refund_ticketed, 70, ["support-lead", "support-copilot"], 0),
    (N_incident_burst, 14, ["ops-agent"], 0),
    (N_oncall_secret, 80, ["engineer"], 0),
    (N_large_partner_release, 50, ["records-exchange"], 0),
    (A_split_exfil, 20, ["procurement-agent", "engineer", "sales-rep"], 0),
    (A_known_dest_new_tool, 40, ["procurement-agent"], 2),
    (A_disguised_class, 35, ["procurement-agent", "engineer", "sales-rep"], 0),
    (A_under_threshold, 25, ["ap-workflow"], 0),
    (A_masked_fields, 60, ["engineer", "ops-agent", "procurement-agent", "support-copilot"], 0),
]

TEST_ONLY_TEMPLATES = {"disguised_classification"}  # measures a known limitation; never trained on


def gradual_ramp(rng: np.random.Generator, actor: Actor, start_ms: int) -> list[tuple[dict, dict]]:
    """Demo B — a support agent's restricted-record pulls double every day for 7 days."""
    out = []
    for d in range(7):
        count = int(20 * 2 ** d)
        label = "safe_normal" if d < 2 else "safe_unusual" if d < 4 else "suspicious_review"
        for k in range(6):
            c = Ctx(rng, actor, start_ms + d * 86_400_000 + (10 + k) * 3_600_000 + int(rng.integers(0, 3_000_000)))
            out.append(ev(c, action="database_query", tool="crm.lookup", cls="restricted", count=count, label=label, family="adversarial" if d >= 4 else "normal", template="gradual_export_ramp", difficulty="adversarial", reasons=("slow_ramp",) if d >= 4 else ()))
    return out


# ------------------------------------------------------------------ world

def build_actors(rng: np.random.Generator) -> list[Actor]:
    actors = []
    for fam, f in FAMILIES.items():
        for i in range(1, f.instances + 1):
            held = f.instances >= 3 and i == f.instances
            aid = f"{fam}-{i}" if f.type != "human" else f"{fam}.{['ari', 'blake', 'cam', 'devon', 'eli', 'frankie', 'gray', 'harper'][i - 1]}"
            vendors = list(rng.choice(APPROVED_VENDORS, size=3, replace=False))
            actors.append(Actor(aid, fam, f.type, f.privilege, f.posture, i, held, vendors, TOOLS[fam]))
    return actors


def _weighted(rng: np.random.Generator, items: list[tuple[float, Template]]) -> Template:
    w = np.array([x[0] for x in items], dtype=float)
    return items[int(rng.choice(len(items), p=w / w.sum()))][1]


def N_vendor_onboarding(c: Ctx):
    """Q4 regime: procurement onboards newly approved vendors and shares confidential terms with them."""
    return [ev(c, action="external_send", tool="email.send", cls="confidential", count=c.between(1, 5), dest=("approved_vendor", "approved"), domain=f"onboarded-vendor-{c.between(1, 400)}.com", ticket=True, label="safe_normal", family="hard_negative", template="q4_vendor_onboarding", difficulty="hard_negative")]


def N_ai_rollout(c: Ctx):
    """Q4 regime: the approved external AI provider becomes routine for internal (non-confidential) drafts."""
    return [ev(c, action="model_provider_send", tool="llm.summarize", cls="internal", count=c.between(1, 4), dest=("external_ai_provider", "approved"), domain=APPROVED_AI[0], label="safe_normal", family="hard_negative", template="q4_approved_ai_internal_drafts", difficulty="hard_negative")]


def S_ticketed_refund_fraud(c: Ctx):
    """Red-team finding on 1.0.0: an agent-asserted ticket flag hides large refunds. Appears in the Q4 window."""
    amt = c.between(20_000, 90_000)
    return [ev(c, action="refund", tool="billing.refund", cls="confidential", amount=amt, dest=INTERNAL, domain="billing.northstar.cloud", ticket=True, label="high_risk" if amt >= 40_000 else "suspicious_review", family="adversarial", template="ticketed_refund_fraud", difficulty="adversarial", reasons=("amount_outlier", "asserted_ticket"))]


REGIMES: dict[str, list[tuple[Callable, float, list[str], int]]] = {
    "q4_shift": [
        (S_ticketed_refund_fraud, 70, ["support-copilot"], 0),
        (N_vendor_onboarding, 420, ["procurement-agent", "finance-analyst"], 0),
        (N_ai_rollout, 300, ["procurement-agent", "engineer", "sales-rep"], 0),
        (A_split_exfil, 12, ["procurement-agent", "engineer"], 0),
        (H_secret_egress, 40, ["engineer", "ops-agent"], 1),
    ],
}


def generate(seed: int = 20261005, label_noise: float = 0.01, start_ts: str = START, days: int | None = None, regime: str | None = None) -> tuple[list[dict], list[dict], dict]:
    """Generate the base world. `regime` adds a production-shift scenario mix on top (drift/retrain demo);
    with a regime the whole window is labelled split='window' (it is new production traffic)."""
    global DAYS
    base_days = DAYS
    if days is not None:
        DAYS = days
    try:
        return _generate(seed, label_noise, start_ts, regime)
    finally:
        DAYS = base_days


def _generate(seed: int, label_noise: float, start_ts: str, regime: str | None) -> tuple[list[dict], list[dict], dict]:
    rng = np.random.Generator(np.random.PCG64(seed))
    start = parse_ts_ms(start_ts)
    actors = build_actors(rng)
    rows: list[tuple[dict, dict]] = []

    # Normal background traffic: inhomogeneous Poisson per actor per local hour.
    for a in actors:
        fam = FAMILIES[a.family]
        for hour_idx in range(DAYS * 24):
            local_h = hour_idx % 24
            wd = (1 + hour_idx // 24) % 7  # day 0 is a Monday
            n = int(rng.poisson(fam.rate(local_h, wd)))
            for _ in range(n):
                t = start + hour_idx * 3_600_000 + int(rng.integers(0, 3_600_000))
                c = Ctx(rng, a, t)
                for e, l in _weighted(rng, NORMAL[a.family])(c):
                    off = not (wd not in (0, 6) and 8 <= local_h < 19)
                    if a.type == "human" and off and l["security_label"] == "safe_normal":
                        l["security_label"], l["expected_policy_decision"] = "safe_unusual", "warn"
                        l["reason_codes"] = ["human_off_hours"]
                    rows.append((e, l))

    # Scenario injections.
    test_start = start + (TRAIN_DAYS + VAL_DAYS) * 86_400_000
    by_family: dict[str, list[Actor]] = {}
    for a in actors:
        by_family.setdefault(a.family, []).append(a)
    for fn, weight, fams, max_variant in INJECTIONS:
        k = int(rng.poisson(weight * DAYS / 28))
        for _ in range(k):
            fam =fams[int(rng.integers(len(fams)))]
            a = by_family[fam][int(rng.integers(len(by_family[fam])))]
            t = start + int(rng.integers(0, DAYS * 86_400_000 - 6 * 3_600_000))
            in_test = t >= test_start
            variants = list(range(max_variant + 1)) if in_test else [v for v in range(max_variant + 1) if v < 2]
            variant = variants[int(rng.integers(len(variants)))]
            produced = fn(Ctx(rng, a, t, variant))
            if any(l["scenario_template"] in TEST_ONLY_TEMPLATES for _, l in produced) and not in_test:
                continue
            rows.extend(produced)

    for fn, weight, fams, max_variant in REGIMES.get(regime or "", []):
        for _ in range(int(rng.poisson(weight))):
            fam = fams[int(rng.integers(len(fams)))]
            a = by_family[fam][int(rng.integers(len(by_family[fam])))]
            t = start + int(rng.integers(0, DAYS * 86_400_000 - 6 * 3_600_000))
            rows.extend(fn(Ctx(rng, a, t, int(rng.integers(max_variant + 1)))))

    # Demo B ramp on one support agent instance, landing in the test window.
    if regime is None:
        ramp_actor = by_family["support-copilot"][1]
        rows.extend(gradual_ramp(rng, ramp_actor, start + 21 * 86_400_000))

    # Weak-label noise on the safe classes only (documented in the dataset card).
    for e, l in rows:
        if l["security_label"] in ("safe_normal", "safe_unusual") and l["difficulty"] == "easy" and rng.random() < label_noise:
            l["security_label"] = "safe_unusual" if l["security_label"] == "safe_normal" else "safe_normal"
            l["expected_policy_decision"] = "warn" if l["security_label"] == "safe_unusual" else "allow"
            l["label_state"], l["label_confidence"] = "weak_label", 0.6

    rows.sort(key=lambda r: (parse_ts_ms(r[0]["timestamp"]), r[0]["event_id"]))
    events = [e for e, _ in rows]
    labels = [l for _, l in rows]
    for e, l in zip(events, labels):
        day = (parse_ts_ms(e["timestamp"]) - start) // 86_400_000
        held = l["held_out_actor"]
        variant2 = l["template_variant"] >= 2 or l["scenario_template"] in TEST_ONLY_TEMPLATES
        if regime is not None:
            split = "window"
        elif day >= TRAIN_DAYS + VAL_DAYS:
            split = "test"
        elif held or variant2:
            split = "excluded"  # still feeds behavioural state, never a training row
        elif day >= TRAIN_DAYS:
            split = "val"
        else:
            split = "train"
        l["split"] = split
        l["day"] = int(day)
    meta = {
        "seed": seed,
        "start": start_ts,
        "days": DAYS,
        "regime": regime,
        "tz_offset_minutes": TZ,
        "actors": [{"id": a.id, "family": a.family, "type": a.type, "privilege": a.privilege, "held_out": a.held_out} for a in actors],
        "label_noise": label_noise,
        "split_rule": {"train_days": [0, TRAIN_DAYS - 1], "val_days": [TRAIN_DAYS, TRAIN_DAYS + VAL_DAYS - 1], "test_days": [TRAIN_DAYS + VAL_DAYS, DAYS - 1], "held_out_actors": [a.id for a in actors if a.held_out], "test_only": ["template_variant>=2", *sorted(TEST_ONLY_TEMPLATES)]},
    }
    return events, labels, meta


def config_hash(seed: int, label_noise: float) -> str:
    import inspect, sys

    src = inspect.getsource(sys.modules[__name__])
    return hashlib.sha256(json.dumps({"seed": seed, "noise": label_noise, "src": hashlib.sha256(src.encode()).hexdigest()}).encode()).hexdigest()

"""Orbis Relay Python SDK — ask before acting.

    from orbis_relay import OrbisClient
    orbis = OrbisClient(api_key=os.environ["ORBIS_API_KEY"])
    d = orbis.preflight(actor={...}, action={...}, resources=[...], destination={...}, intent={...})
    if d.is_allowed:
        execute()
    elif d.requires_approval:
        final = d.wait_for_resolution(timeout=600)
        if final.approved:
            execute(final.approved_parameters)
    orbis.report_outcome(d.action_id, "succeeded")

The SDK never executes your action. It returns authorization state; your code decides.
Standard library only (urllib, hmac, hashlib).
"""
from __future__ import annotations

import hashlib
import hmac
import json
import random
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, Optional

__all__ = ["OrbisClient", "Decision", "Resolution", "OrbisError", "verify_webhook_signature"]
__version__ = "0.1.0"


class OrbisError(Exception):
    def __init__(self, status: int, code: str, message: str, remediation: Optional[str] = None):
        super().__init__(f"{code}: {message}" + (f" — {remediation}" if remediation else ""))
        self.status, self.code, self.message, self.remediation = status, code, message, remediation


@dataclass
class Resolution:
    approved: bool
    status: str
    approved_parameters: Optional[dict] = None
    receipt_id: Optional[str] = None


@dataclass
class Decision:
    raw: dict
    _client: "OrbisClient" = field(repr=False)

    def __getattr__(self, name: str) -> Any:  # decision_id, status, risk, policy, approval, ...
        try:
            return self.raw[name]
        except KeyError as e:
            raise AttributeError(name) from e

    @property
    def is_allowed(self) -> bool:
        return self.raw["status"] in ("allow", "warn") or (self.raw.get("mode") == "observe" and self.raw["status"] != "deny")

    @property
    def is_denied(self) -> bool:
        return self.raw["status"] == "deny"

    @property
    def requires_approval(self) -> bool:
        return self.raw["status"] == "approval_required" and self.raw.get("mode", "enforce") == "enforce"

    def wait_for_resolution(self, timeout: float = 600, poll: float = 1.5) -> Resolution:
        """Poll until a human resolves the approval, it expires, or the timeout elapses."""
        if not self.raw.get("approval"):
            raise RuntimeError("decision does not require approval")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            a = self._client.get_approval(self.raw["approval"]["id"])
            if a["status"] != "pending":
                return Resolution(a["status"] in ("approved", "approved_modified"), a["status"], a.get("approved_parameters"), a.get("receipt_id"))
            time.sleep(poll)
        return Resolution(False, "timeout")


class OrbisClient:
    def __init__(self, api_key: str, base_url: str = "http://localhost:4310", timeout: float = 10.0, max_retries: int = 2):
        if not api_key:
            raise ValueError("api_key is required")
        self._api_key = api_key
        self.base_url = base_url.rstrip("/") + "/api/v1"
        self.timeout = timeout
        self.max_retries = max_retries

    def __repr__(self) -> str:  # never print the key
        return f"OrbisClient(base_url={self.base_url!r})"

    def _request(self, method: str, path: str, body: Optional[dict] = None) -> dict:
        data = None if body is None else json.dumps(body).encode()
        attempt = 0
        while True:
            req = urllib.request.Request(self.base_url + path, data=data, method=method, headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
                "User-Agent": f"orbis-sdk-python/{__version__}",
            })
            try:
                with urllib.request.urlopen(req, timeout=self.timeout) as r:
                    return json.loads(r.read() or b"{}")
            except urllib.error.HTTPError as e:
                payload = json.loads(e.read() or b"{}").get("error", {})
                if e.code >= 500 and attempt < self.max_retries:
                    attempt += 1
                    time.sleep(0.2 * 2 ** attempt + random.random() * 0.1)
                    continue
                raise OrbisError(e.code, payload.get("code", "http_error"), payload.get("message", str(e)), payload.get("remediation")) from None
            except urllib.error.URLError as e:
                if attempt < self.max_retries:
                    attempt += 1
                    time.sleep(0.2 * 2 ** attempt)
                    continue
                raise OrbisError(0, "network_error", str(e.reason), "Check base_url and connectivity.") from None

    def preflight(self, *, actor: dict, action: dict, resources: Optional[list] = None, request_id: Optional[str] = None, **envelope: Any) -> Decision:
        """Ask before acting. Idempotent on request_id — safe to retry."""
        body = {"request_id": request_id or f"req_{uuid.uuid4().hex[:20]}", "actor": actor, "action": action, "resources": resources or [], **envelope}
        return Decision(self._request("POST", "/decisions/preflight", body), self)

    def create_approval(self, *, route: str, actor: dict, action: dict, reason: str = "", **envelope: Any) -> Decision:
        body = {"request_id": envelope.pop("request_id", f"req_{uuid.uuid4().hex[:20]}"), "route": route, "reason": reason, "actor": actor, "action": action, **envelope}
        return Decision(self._request("POST", "/approvals", body), self)

    def get_approval(self, approval_id: str) -> dict:
        return self._request("GET", f"/approvals/{approval_id}")

    def report_outcome(self, action_id: str, status: str, detail: Optional[str] = None) -> dict:
        return self._request("POST", f"/actions/{action_id}/outcome", {"status": status, "detail": detail})

    def get_receipt(self, receipt_id: str) -> dict:
        return self._request("GET", f"/receipts/{receipt_id}")

    def verify_receipt(self, receipt_id: str) -> dict:
        return self._request("POST", f"/receipts/{receipt_id}/verify", {})


def verify_webhook_signature(secret: str, header: str, raw_body: bytes | str, tolerance: int = 300) -> bool:
    """Verify `Orbis-Signature: t=<unix>,v1=<hex>` with a replay window and constant-time compare."""
    try:
        parts = dict(p.split("=", 1) for p in header.split(","))
        t = int(parts["t"])
    except (ValueError, KeyError):
        return False
    if abs(time.time() - t) > tolerance:
        return False
    body = raw_body.decode() if isinstance(raw_body, bytes) else raw_body
    expected = hmac.new(secret.encode(), f"{t}.{body}".encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, parts.get("v1", ""))

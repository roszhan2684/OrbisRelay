"""Unit tests (offline) + integration test against a running local gateway (skipped if unavailable)."""
import hashlib
import hmac
import os
import sys
import time
import unittest
import urllib.request

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from orbis_relay import OrbisClient, OrbisError, verify_webhook_signature  # noqa: E402

BASE = os.environ.get("ORBIS_BASE_URL", "http://localhost:4310")
KEY = os.environ.get("ORBIS_API_KEY", "orb_test_np_sandbox_e5b1c9a3f7d2084b6c3e")


def server_up():
    try:
        urllib.request.urlopen(BASE + "/api/v1/receipts/public-key", timeout=2)
        return True
    except Exception:
        return False


class WebhookTests(unittest.TestCase):
    def test_valid_and_replayed(self):
        t = int(time.time())
        sig = hmac.new(b"whsec", f"{t}.{{}}".encode(), hashlib.sha256).hexdigest()
        self.assertTrue(verify_webhook_signature("whsec", f"t={t},v1={sig}", "{}"))
        self.assertFalse(verify_webhook_signature("whsec", f"t={t - 900},v1={sig}", "{}"))
        self.assertFalse(verify_webhook_signature("other", f"t={t},v1={sig}", "{}"))

    def test_repr_hides_key(self):
        self.assertNotIn("secret", repr(OrbisClient(api_key="secret")))


@unittest.skipUnless(server_up(), "local gateway not running")
class GatewayTests(unittest.TestCase):
    def setUp(self):
        self.orbis = OrbisClient(api_key=KEY, base_url=BASE)

    def test_allow_and_outcome(self):
        d = self.orbis.preflight(actor={"type": "agent", "id": "sandbox-agent"}, action={"type": "refund"}, resources=[{"type": "order"}], business_context={"amount_usd": 40}, intent={"reason": "Duplicate charge refund"})
        self.assertTrue(d.is_allowed)
        self.orbis.report_outcome(d.action_id, "succeeded")
        self.assertTrue(self.orbis.verify_receipt(d.receipt_id)["valid"])

    def test_approval_required(self):
        d = self.orbis.preflight(actor={"type": "agent", "id": "sandbox-agent"}, action={"type": "refund"}, resources=[{"type": "order"}], business_context={"amount_usd": 8500}, intent={"reason": "SLA credit after outage"})
        self.assertTrue(d.requires_approval)
        self.assertEqual(d.approval["route"], "support-manager")

    def test_idempotent_replay(self):
        rid = f"req_py_{int(time.time() * 1000)}"
        a = self.orbis.preflight(request_id=rid, actor={"type": "agent", "id": "sandbox-agent"}, action={"type": "invoke_tool"}, resources=[{"type": "doc", "classification": "internal"}])
        b = self.orbis.preflight(request_id=rid, actor={"type": "agent", "id": "sandbox-agent"}, action={"type": "invoke_tool"}, resources=[{"type": "doc", "classification": "internal"}])
        self.assertEqual(a.action_id, b.action_id)
        self.assertTrue(b.idempotent_replay)

    def test_bad_key(self):
        with self.assertRaises(OrbisError) as e:
            OrbisClient(api_key="orb_live_nope", base_url=BASE).preflight(actor={"type": "agent", "id": "x"}, action={"type": "refund"})
        self.assertEqual(e.exception.status, 401)


if __name__ == "__main__":
    unittest.main()

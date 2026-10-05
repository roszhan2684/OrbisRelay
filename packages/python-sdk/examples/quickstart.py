"""Run: python3 examples/quickstart.py  (with the local Orbis gateway running on :4310)"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from orbis_relay import OrbisClient  # noqa: E402

orbis = OrbisClient(api_key=os.environ.get("ORBIS_API_KEY", "orb_test_np_sandbox_e5b1c9a3f7d2084b6c3e"))
d = orbis.preflight(
    actor={"type": "agent", "id": "sandbox-agent"},
    action={"type": "external_send", "tool": "llm.summarize"},
    resources=[{"type": "document", "classification": "confidential", "count": 4}],
    destination={"type": "external_model", "value": "quickscribe-ai.app"},
    intent={"reason": "Summarize vendor contracts for RFP response"},
)
print(f"{d.status} · risk {d.risk['score']} {d.risk['level']} · {d.policy['name'] if d.policy else 'no rule'}")
if d.requires_approval:
    print(f"Paused for a human — approve it in the console (approval {d.approval['id']}). Waiting up to 60s…")
    final = d.wait_for_resolution(timeout=60)
    print("Resolution:", final)

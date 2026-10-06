# Runbook — model rollback & kill switch

**Symptoms:** canary endpoint latency above 20 ms p95, inference failures, a spike in false escalations reported by approvers, or drift going critical.

1. **Automatic:** a canary endpoint reporting p95 > 20 ms or more than 5 failures triggers an automatic rollback (`endpoint_checkin` op). Confirm it in Console → Intelligence → Overview → *Model lifecycle* (an "automatic" badge) and in Audit (`ml.model_rolled_back`).
2. **Manual rollback:** Console → Intelligence → Models → *Roll back* (passkey step-up), or `POST /api/v1/ml/models/{version}/rollback {reason, step_up}`. The previous production version becomes active, `manifest_seq` increments, and endpoints pick it up on the next sync. They can also roll back locally with no network.
3. **Kill switch (every decision becomes deterministic policy):** Console → Intelligence → *Kill switch*, or `POST /api/v1/ml/settings {kill_switch: true, step_up}`. Responders are allowed. Endpoints receive a signed kill-switch manifest and emit `deterministic_fallback` signals.
4. **Verify:** new decisions show `fusion.rule = model_unavailable_fallback` (kill switch) or the old version in `ml.model`. The endpoints table shows active → assigned versions converging.
5. **Afterwards:** a rolled-back version returns to *candidate*. Re-promotion goes through shadow → canary again.

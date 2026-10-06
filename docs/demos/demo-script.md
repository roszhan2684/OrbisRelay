# 5-minute demo — Orbis Relay v2

1. **(0:00) Hero, endpoint side.** Terminal: `orbis-endpoint sync …` shows signature verified, sha256 matched, compile 26 ms, activated 1.0.0. Then `orbis-endpoint replay fixtures/endpoint-events/hero.jsonl --preflight`: Core ML scores the procurement agent's send of 4 confidential contracts to an unverified AI provider as *high_risk* in about 31 µs, and the gateway returns `approval_required`.
2. **(1:00) iPhone.** The approval card shows the edge-risk signal in plain language ("High risk because sensitive data is going to an unverified destination…"), plus source (endpoint + gateway), model version and behaviour baseline. Face ID, then *Redirect safely*, then a signed receipt whose enrichment records the model, feature schema and fusion rule.
3. **(2:00) Model passport.** Console → Intelligence → Models → 1.0.0 shows 19/19 gates, measured benchmarks and lineage. Verify the signed manifest in the browser, press *Tamper with payload*, and watch the signature fail.
4. **(2:45) Demo C — candidate vs production.** 1.1.0 fixes the red-team finding and cuts Q4-window cost from 0.130 to 0.011, but regresses two golden scenarios, so *Shadow* is disabled. Gates beat enthusiasm.
5. **(3:30) Demo D — rollback.** Roll back 1.0.0 (passkey); 0.9.0 serves. Promote 1.0.0 to shadow, then canary 25%, then *Latency drill*. The health monitor rolls the canary back automatically.
6. **(4:15) Demo B + ground truth.** Drift shows the support copilot's restricted CRM pulls rising. No policy rule covers them, and the model raised them to warn. The review queue labels feed `feedback/export`, which feeds `orbis_ml retrain`.
7. **(4:45) Close.** Deterministic policy decides; the model can only ask for a human.

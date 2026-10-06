# Dataset card — `northstar-actions@1.0.0`

**What:** 33,274 synthetic, metadata-only action events. They cover 28 days of a fictional company, Northstar Cloud, with 49 actors (agents, automations, services, people) in 17 families. There are 73 scenario templates.
**Why synthetic:** labelled security traffic is not publishable, and real agent-action logs don't exist publicly at this granularity. The generator is deterministic and versioned, so every number in this repo is reproducible.

| | |
|---|---|
| Schema | `endpoint-event/1` (`fixtures/endpoint-events/endpoint-event.v1.schema.json`) |
| Features | `edge-features/1`, 85 dims (`fixtures/endpoint-events/feature-spec.json`) |
| Seed / generator | 20261005 · config hash pinned in the manifest |
| Classes | safe_normal 88% · safe_unusual 4.7% · suspicious_review 5.6% · high_risk 1.5%. Imbalanced on purpose |
| Difficulty | 1,012 hard negatives · 848 adversarial |
| Label noise | 1% weak-label flips between the two safe classes (`label_state: weak_label`, confidence 0.6) |
| Gold set | 93 hand-authored scenarios (90 gated, 3 documented limitations), content-hash pinned |

**Splits are never random.**
- Train is days 0–17, validation days 18–22, test days 23–27.
- Every third instance of a multi-instance actor family is held out of train and val.
- Template variant v2 and the `disguised_classification` template only ever appear in test.
- Behavioural features are computed over the full chronological stream, as production would compute them; excluded rows still feed actor baselines.
- Leakage checks (all pass): no event in two splits, no held-out actor rows in train/val, no test-only template rows in train/val, no overlapping days, gold actors namespaced apart.

**Privacy review (automated, in the manifest):**
- Destinations are 16-hex sha256 prefixes and no raw domains are present.
- There is no content, only enums, counts and amounts.
- All people, vendors and amounts are fictional.

**Labels come from the scenario that generated the event, never from its features.** Each label records `security_label`, `expected_policy_decision`, `reason_codes`, `scenario_family`/`template`/`variant`, `difficulty`, `source`, `labeler`, `label_state` and `label_confidence`.

**Known biases.** One was found by error analysis and fixed: tool-registry gaps had appeared only in attacks. One is documented: in the base data, routine refunds always carry a ticket, which the model over-trusts (see the adversarial report). Synthetic data cannot tell us real-tenant performance; shadow mode and reviewed labels are the path to that.

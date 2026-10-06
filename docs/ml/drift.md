# Drift, ground truth and retraining

## Detection (`ml/orbis_ml/drift.py`, `apps/web/src/lib/server/ml.ts`)
- **Input drift:** PSI over the reference window's quantile bins on 10 monitored features. Jensen-Shannon divergence covers the one-hot categorical blocks offline, and two-sample KS is available for continuous scores.
- **Prediction drift:** PSI on the calibrated risk score. It is measured *within one model*, against the first 4 days of the current production version. The first implementation compared 0.9.0 scores with 1.0.0 scores, and that is a model change, not drift.
- **Windows are 7 days.** With 2-day windows, a weekend produced PSI 7.4 on `off_hours`. That was seasonality, not drift.
- **Levels:**
  - info: PSI ≥ 0.10.
  - warn: PSI ≥ 0.25 on a monitored feature or on the risk score.
  - critical: OOD rate ≥ 5%, or a quality regression on labelled outcomes.

## Ground truth
Label states:
- `gold_confirmed`
- `analyst_reviewed` (0.95)
- `human_decision_proxy` (0.5 — "a human approved it" is not "safe")
- `weak_label` (0.3)
- `synthetic`

The **active-review queue** prioritises:
- abstained or out-of-distribution predictions,
- policy↔model disagreements,
- endpoint↔cloud disagreements,
- model-changed outcomes,
- novel tool+destination combinations,
- high-impact escalations.

Analysts label in the console. Labels enter the *next dataset version* through `GET /v1/ml/feedback/export` and are never used online.

## Retraining (`python -m orbis_ml retrain`)
Trigger: sustained warn windows (≥ 2) **and** ≥ 200 labelled outcomes, **or** a known change.
1. A 14-day Q4 production window continues the base stream. It brings vendor onboarding, the approved AI provider used for internal drafts, and red-team ticketed-refund fraud.
2. Production 1.0.0 scores the window and the drift windows are computed.
3. Days 0–9 feed the review queue: 400 analyst reviews out of 3,634 queued items, plus 999 human-decision proxies with 10% simulated human error. Days 10–13 are an untouched holdout. An earlier version picked its holdout as "everything not reviewed", which biased it against everything production had escalated.
4. Dataset 1.1.0 is built from base train plus the confidence-weighted labels. The same architecture is retrained, and calibration and thresholds are set on the unchanged validation split.
5. The candidate is evaluated on the immutable test set, the gold set and the window holdout, then registered as **candidate**.

1.1.0 cuts the window's cost from 0.130 to 0.011 and fixes the ticket evasion. It regresses two golden scenarios and a protected slice, so **the gates block it**. That is the system working: drift ≠ automatic retraining ≠ automatic deployment.

## Known limitation
Slow ramps (+10%/day) are absorbed by per-actor baselines (gold g-k03). The population drift monitor and analyst review are the compensating controls.

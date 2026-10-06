# ADR-003 — Edge model architecture and runtimes

**Status:** accepted · **Date:** 2026-10-06

## Decision
Ship a **dense MLP (85 → 32 → 16 → 4, 3,348 parameters)** as `orbis-edge-risk`. Calibrate it with temperature scaling, versioned separately as the decision policy. Distribute it as a **Core ML FP32 mlprogram**.

## Evidence (all measured, see `ml/models/risk_classifier/`)
| | rule | logreg C=1 | HistGB | **MLP 32×16** | MLP 64×32 |
|---|---|---|---|---|---|
| Validation cost (selection metric) | 0.367 | 0.016 | 0.0107 | **0.0106** | 0.0115 |
| Test cost | 0.513 | 0.083 | 0.067 | **0.073** | 0.075 |
| Test macro-F1 | 0.365 | 0.872 | 0.911 | **0.928** | 0.906 |
| Edge path (Core ML/ONNX/Swift/TS) | — | yes | **no** | **yes** | yes |

- HistGradientBoosting has the best test cost, but it has no supported Core ML/ONNX conversion from sklearn 1.9. It was not selected, and the decision was made on validation cost, not on test.
- Conversion starts from the portable weights (`orbis-portable-mlp/1`) through coremltools' MIL builder and `onnx.helper`, so the path is repeatable from the registry artifact alone.
- **Parity:** Core ML FP32 max |Δp| 4.3e-7, ONNX FP32 4.8e-7, 100% class agreement on the test split.
- **Quantization:** FP16 passes (|Δp| 4.3e-3) but saves only ~6 KB. Weight-only INT8 fails the bounded delta (|Δp| 5.2e-2). We ship FP32.
- **Latency (M4 Pro):** warm p50 38 µs / p95 57 µs for every precision and compute-unit setting. At this size Core ML's per-call dispatch dominates; a hand-written Swift forward pass takes 0.8 µs. We keep Core ML as the shipping path anyway. It gives one signed artifact format, on-device compilation and ANE/GPU readiness for the larger intent model (Model C), and both paths are far inside the 20 ms budget. The portable Swift runtime is retained as the parity reference and as a fallback.
- **MLX** was not built. The blueprint scopes it as an optional experiment, and with the model this small no benchmark could favour it. That is recorded as a non-goal, not a result.

## Behavioural anomaly (Model B)
We ship per-actor robust statistics (median/MAD over 200-sample rings plus novelty terms). It reaches ROC-AUC 0.858 on behavioural attacks, against 0.934 for a global Isolation Forest. The forest has no per-actor context and no portable path. Auto-escalation on the anomaly score added no recall over Model A while raising false escalations, so the anomaly score is evidence for reviewers rather than an escalation trigger.

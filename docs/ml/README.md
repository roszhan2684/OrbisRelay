# Orbis ML lifecycle

Everything below is runnable on a Mac with Python 3.11 and Xcode. Numbers are what the pipeline measured on an Apple M4 Pro.

```bash
python3 -m venv ml/.venv && ml/.venv/bin/pip install -r ml/requirements.lock
ml/pipeline.sh                     # dataset → train → convert → reproduce → adversarial → anomaly → retrain → gates → export
cd apps/macos-endpoint && swift test && swift build -c release
.build/release/orbis-endpoint bench --precision fp32 --compute cpu      # writes ml/benchmarks/results/…
```

| Stage | Command | Output |
|---|---|---|
| Dataset | `python -m orbis_ml dataset` | `ml/datasets/manifests/northstar-actions-1.0.0.json` |
| Reproducibility | `python -m orbis_ml verify-dataset`, `reproduce` | hash-identical regeneration; retrained weights bit-identical |
| Training | `python -m orbis_ml train` | `ml/models/risk_classifier/1.0.0/` + `baselines_report.md` + MLflow runs |
| Conversion + parity | `python -m orbis_ml convert` | Core ML FP32/FP16/INT8, ONNX FP32/INT8, `parity_report.json`, `fixtures/parity/` |
| Cross-language features | `python -m orbis_ml feature-fixtures` | `fixtures/endpoint-events/feature-parity.json` (Swift, TS, C++ test against it) |
| Adversarial | `python -m orbis_ml adversarial` | `adversarial_report.json` |
| Model B | `python -m orbis_ml anomaly` | `anomaly_report.json` |
| Drift → retrain | `python -m orbis_ml retrain [--feedback export.jsonl]` | dataset 1.1.0 + candidate 1.1.0 + `retrain_report.json` |
| Release gates | `python -m orbis_ml gates --version 1.0.0 --baseline 0.9.0` | `release_gate_report.json`, exit 1 on failure |
| Model card | `python -m orbis_ml card` | `MODEL_CARD.md` (every number read from a report) |
| Publish | `python -m orbis_ml export` | registry snapshot + artifacts for the gateway and console |

Further reading: [dataset card](dataset.md) · [evaluation & gates](evaluation.md) · [drift & ground truth](drift.md) · [benchmarks](benchmarks.md) · [deep-dive Q&A](deep-dive.md).

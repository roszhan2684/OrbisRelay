# Edge risk model — baseline comparison

Dataset `northstar-actions@1.0.0`. lowest validation mean security cost among models with a portable (Core ML/ONNX/TS/Swift) export; tie-break fewer parameters. Test and gold were not used for selection.

| Model | Portable | Params | Val cost | Test cost | Test macro-F1 | Test high-risk esc. recall | Test risky recall | Test false-esc. rate | Test ECE | Gold risky recall | Gold hard-neg FPR |
|---|---|---|---|---|---|---|---|---|---|---|---|
| rule | no | — | 0.3669 | 0.5125 | 0.365 | 91.2% | 70.5% | 19.4% | 0.335 | 88.3% | 25.0% |
| logreg-C1 | yes | 344 | 0.0160 | 0.0826 | 0.872 | 91.2% | 98.0% | 0.4% | 0.036 | 100.0% | 0.0% |
| logreg-C10 | yes | 344 | 0.0154 | 0.0884 | 0.874 | 90.2% | 97.7% | 0.4% | 0.042 | 100.0% | 0.0% |
| hgb | no | — | 0.0107 | 0.0665 | 0.911 | 93.1% | 98.4% | 0.2% | 0.008 | 96.7% | 0.0% |
| mlp-32x16 **(selected)** | yes | 3348 | 0.0106 | 0.0732 | 0.928 | 91.2% | 98.0% | 0.2% | 0.015 | 100.0% | 0.0% |
| mlp-64x32 | yes | 7716 | 0.0115 | 0.0751 | 0.906 | 91.2% | 98.0% | 0.4% | 0.007 | 100.0% | 0.0% |

Cost = mean of the security cost matrix in `ml/orbis_ml/metrics.py` (false allow of high-risk = 50, of suspicious = 10; false review of safe work = 1).

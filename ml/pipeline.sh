#!/usr/bin/env bash
# Full Orbis ML lifecycle, in blueprint phase order. Every step writes machine-readable reports.
set -euo pipefail
cd "$(dirname "$0")"
PY=${PY:-.venv/bin/python}
export MLFLOW_DISABLE_AGENT_HINT=1 PYTHONWARNINGS=ignore
step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
step "dataset northstar-actions@1.0.0";        $PY -m orbis_ml dataset --version 1.0.0 >/dev/null
step "feature parity fixtures";                 $PY -m orbis_ml feature-fixtures
step "train baselines + candidates";            $PY -m orbis_ml train --dataset 1.0.0 --version 1.0.0
step "Core ML / ONNX conversion + parity";      $PY -m orbis_ml convert --version 1.0.0 | tail -n +1 >/dev/null
step "reproducibility gate";                    $PY -m orbis_ml reproduce --version 1.0.0 | grep -E '"passed"|weights'
step "adversarial suite";                       $PY -m orbis_ml adversarial --version 1.0.0
step "behavioural anomaly (Model B)";           $PY -m orbis_ml anomaly >/dev/null
step "drift → review queue → retrain candidate"; $PY -m orbis_ml retrain --version 1.1.0 | head -40
step "convert candidate 1.1.0";                 $PY -m orbis_ml convert --version 1.1.0 >/dev/null
step "reproducibility (candidate)";             $PY -m orbis_ml reproduce --version 1.1.0 | grep -E '"passed"' | tail -1
step "adversarial suite (candidate)";           $PY -m orbis_ml adversarial --version 1.1.0
for v in 1.0.0 1.1.0; do step "model card $v"; $PY -m orbis_ml card --version $v; done
step "release gates 1.0.0";                     $PY -m orbis_ml gates --version 1.0.0 --baseline 0.9.0 --allow-pending || true
step "release gates 1.1.0 (baseline 1.0.0)";    $PY -m orbis_ml gates --version 1.1.0 --baseline 1.0.0 --allow-pending || true
step "export registry + artifacts";             $PY -m orbis_ml export

"""Orbis Relay v2 ML systems package.

Reference implementations (Python) for the canonical endpoint event schema, the deterministic
edge feature calculator, the Northstar synthetic dataset, model training/evaluation, release gates,
Core ML / ONNX conversion, drift monitoring and the retraining pipeline.

Everything that runs on an endpoint (Swift), in the gateway (TypeScript) or in the C++ parity module
is a port of the code in this package and is parity-tested against fixtures it generates.
"""

__all__ = ["schema", "features"]

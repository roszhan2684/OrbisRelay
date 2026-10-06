# cxx-risk-core — C++20 port of the Orbis edge feature calculator

A systems-language reimplementation of `ml/orbis_ml/features.py` (`edge-features/1`) and the robust behavioural-anomaly scorer, translated from the versioned Python reference and the shared spec in `fixtures/endpoint-events/feature-spec.json`. No dependencies beyond a C++20 compiler; includes a strict JSON reader.

```bash
make test        # parity against the shared corpus (1,179 vectors + 12 invalid events)
make sanitize    # same, built with -fsanitize=address,undefined
make bench       # features + anomaly throughput
cd ../../ml && .venv/bin/python -c "from orbis_ml import cxx_parity; print(cxx_parity.run())"   # full dataset via the CLI
```

## Measured (Apple M4 Pro, clang 21, -O2)

| Check | Result |
|---|---|
| Shared corpus (20 streams) | 1,179 vectors · 0 mismatches · 1,104 bit-identical · max abs Δ 1.1e-16 |
| Invalid events | 12/12 rejected on the same field as Python |
| Full dataset `northstar-actions@1.0.0` (driven from Python) | 33,274 vectors · 0 over 1e-9 · 31,055 bit-identical · max abs Δ 2.2e-16 (`parity_report.json`) |
| AddressSanitizer + UBSan | clean |
| features + anomaly per event | p50 1.4 µs · p95 5.0 µs · ~520k events/s (single thread) |

For comparison on the same machine: the Swift endpoint port takes p50 ~2 µs for features alone (p50 ~11 µs including validation). The Python reference featurizes the 33k-event dataset in ~0.5 s (~14 µs per event).

## Translation decisions

- **Integer/float fidelity.** The JSON reader keeps whether a number was written as an integer, so `resource.count: 3.0` is rejected exactly as Python's `isinstance(x, int)` rejects it.
- **Missing vs null.** `Value::get` returns `nullptr` for an absent key and a `Null` value for an explicit `null`. The two mean different things in the schema: a missing `environment` defaults to `none`, while an explicit `null` becomes `unknown`.
- **Time.** Timestamps are parsed with a strict regex, then turned into days with Howard Hinnant's integer `days_from_civil`. There is no `timegm` and no locale, so every language agrees to the millisecond. Floor division is explicit for negative offsets.
- **Floating point.** The order of operations follows the reference exactly. That covers the Welford update (`d = x - mean; mean += d/n; m2 += d*(x - mean)`), the anomaly contribution sum, and medians computed by sorting. Remaining differences come from libm `log1p`/`log2` on other platforms. They are within 1 ULP and well inside the documented 1e-9 tolerance.
- **Bounded state.** The containers mirror the Python bounds: 24 h of timestamps with a 10k cap, novelty sets capped at 4,096, and 200-sample rings. Ownership is all RAII (`std::deque`, `std::unordered_set`), with no manual memory management.
- **Unknown is never safe.** Enum values outside the vocabulary map to `unknown`. For the cross features, an unknown classification is sensitive, an unknown destination is external and untrusted, and an unknown privilege is elevated.

## Not ported

This module covers the deterministic feature calculator, the part most likely to drift between runtimes. The model forward pass ships as Core ML on endpoints and as a TypeScript port in the gateway. Both are parity-tested separately.

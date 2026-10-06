# Endpoint benchmarks (measured)

Swift harness `orbis-endpoint bench`, Core ML batch-1, Apple M4 Pro (Mac16,8), macOS 26.6. Raw JSON: `ml/benchmarks/results/`.

| Precision | Compute units | Warm p50 | Warm p95 | Warm p99 | Pipeline p95 | Cold load | Peak footprint | Artifact |
|---|---|---|---|---|---|---|---|---|
| FP32 | CPU | 38.3 µs | 57.3 µs | 101 µs | 63.0 µs | 47.6 ms | 21.0 MB | 16.6 KB |
| FP32 | all | 38.5 µs | 55.8 µs | 98 µs | 64.7 µs | 50.3 ms | 21.7 MB | 16.6 KB |
| FP32 | CPU+ANE | 38.9 µs | 61.5 µs | 103 µs | 68.2 µs | 48.4 ms | 21.0 MB | 16.6 KB |
| FP16 | CPU | 39.0 µs | 60.3 µs | 103 µs | 63.2 µs | 53.8 ms | 21.0 MB | 10.6 KB |
| FP16 | all | 38.8 µs | 55.5 µs | 101 µs | 66.1 µs | 52.7 ms | 21.9 MB | 10.6 KB |
| INT8 (weights) | CPU | 38.6 µs | 55.2 µs | 102 µs | 65.7 µs | 49.2 ms | 20.8 MB | 7.7 KB |

- **Model load** adds +6.6 MB (FP32, CPU). Idle CPU is ≤ 0.002%, and CPU cost is ~53 ms per 1,000 inferences.
- **Pure-Swift forward pass:** p50 0.8–0.9 µs. Core ML dispatch dominates a 3.3k-parameter model.
- **Sustained 10 min at 50 events/s:** 30,000 events, pipeline p95 285 µs, 2.52% of one core, footprint growth 0.23 MB, 0 failures. Paced load runs slower than a hot loop because the scheduler parks the process on efficiency cores between events.
- **Sustained 30 min at 2 events/s:** 0.13% of one core, 0 failures.
- **Optimisation found by profiling:** the first full-pipeline p50 was 235 µs. The daemon re-parsed the manifest expiry on every event, and each parse allocated two `ISO8601DateFormatter`s. Caching it brought p50 to 51 µs (4.6×). Pre-fix results are archived under `results/archive/pre-optimization`.
- **Energy was not measured.** It needs `powermetrics` or Instruments on a physical session, so CPU time is reported as the proxy.

C++20 feature calculator (`packages/cxx-risk-core`): p50 1.4 µs per event, ~520k events/s.

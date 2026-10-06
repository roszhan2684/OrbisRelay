import CoreML
import CryptoKit
import Foundation
import OrbisEndpointCore

// orbis-endpoint — Orbis macOS endpoint runtime CLI.
//
//   orbis-endpoint replay <stream.jsonl> [--model-dir DIR] [--gateway URL --key KEY --preflight]
//   orbis-endpoint bench [--model-dir DIR] [--precision fp32|fp16|int8] [--compute cpu|all|gpu|ane]
//                        [--iterations N] [--sustained-seconds S] [--rate EPS] [--out DIR]
//   orbis-endpoint sync --gateway URL --key KEY [--home DIR] [--endpoint-id ID] [--public-key B64]
//   orbis-endpoint verify-manifest <signed-manifest.json> --public-key B64
//
// The endpoint observes only explicit demo/integration event sources (files, the local agent adapter).

let args = Array(CommandLine.arguments.dropFirst())
func flag(_ name: String) -> String? {
    guard let i = args.firstIndex(of: "--\(name)"), i + 1 < args.count else { return nil }
    return args[i + 1]
}
func has(_ name: String) -> Bool { args.contains("--\(name)") }
func die(_ msg: String) -> Never {
    FileHandle.standardError.write(Data("error: \(msg)\n".utf8))
    exit(1)
}
let repo: URL = {
    var u = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
    for _ in 0..<6 {
        if FileManager.default.fileExists(atPath: u.appendingPathComponent("ml/models/risk_classifier").path) { return u }
        u.deleteLastPathComponent()
    }
    return URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
}()
let modelDir = URL(fileURLWithPath: flag("model-dir") ?? repo.appendingPathComponent("ml/models/risk_classifier/1.0.0").path)

func readStream(_ path: String) -> [[String: Any]] {
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { die("cannot read \(path)") }
    return text.split(separator: "\n").compactMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }
}

func loadLocal(precision: String, compute: MLComputeUnits) throws -> (RiskModel, DecisionPolicy, ModelManifest, compileMs: Double, loadMs: Double) {
    let t0 = DispatchTime.now()
    let compiled = try CoreMLRiskModel.compile(modelDir.appendingPathComponent("coreml/OrbisEdgeRisk-\(precision).mlpackage"))
    let t1 = DispatchTime.now()
    let model = try CoreMLRiskModel(compiledURL: compiled, computeUnits: compute)
    let t2 = DispatchTime.now()
    let policy = try DecisionPolicy.load(Data(contentsOf: modelDir.appendingPathComponent("decision_policy.json")))
    let f = ISO8601DateFormatter()
    let manifest = ModelManifest(manifest_seq: 0, tenant_id: "local", model_name: "orbis-edge-risk", version: model.version, feature_schema: EdgeFeatures.schema, runtime: "coreml", precision: precision,
                                 minimum_app_version: "2.0.0", artifact_url: "local", artifact_sha256: "", policy_sha256: "", policy_json: "", created_at: f.string(from: Date()),
                                 expires_at: f.string(from: Date().addingTimeInterval(86_400)), rollback_to: nil, stage: "local", kill_switch: false)
    let ms = { (a: DispatchTime, b: DispatchTime) in Double(b.uptimeNanoseconds - a.uptimeNanoseconds) / 1e6 }
    return (model, policy, manifest, ms(t0, t1), ms(t1, t2))
}

func pct(_ xs: [Double]) -> [String: Double] {
    ["p50": HealthMonitor.percentile(xs, 50) ?? 0, "p95": HealthMonitor.percentile(xs, 95) ?? 0, "p99": HealthMonitor.percentile(xs, 99) ?? 0,
     "mean": xs.isEmpty ? 0 : xs.reduce(0, +) / Double(xs.count), "max": xs.max() ?? 0]
}

func sysctl(_ name: String) -> String {
    var size = 0
    sysctlbyname(name, nil, &size, nil, 0)
    var buf = [CChar](repeating: 0, count: size)
    sysctlbyname(name, &buf, &size, nil, 0)
    return String(cString: buf)
}

// MARK: - commands

func replay() {
    guard args.count >= 2 else { die("usage: orbis-endpoint replay <stream.jsonl>") }
    let events = readStream(args[1])
    let daemon = EndpointDaemon()
    do {
        let l = try loadLocal(precision: flag("precision") ?? "fp32", compute: .parse(flag("compute") ?? "cpu"))
        daemon.attach((l.0, l.1, l.2))
    } catch {
        print("model unavailable (\(error)) — running in deterministic-fallback mode")
    }
    var last: (NormalizedEvent, [Double], EdgeSignal)?
    for e in events {
        do { last = try daemon.process(e) } catch { print("rejected \(e["event_id"] ?? "?"): \(error)") }
    }
    guard let (ev, _, sig) = last else { die("no valid events") }
    let enc = JSONEncoder()
    enc.outputFormatting = [.prettyPrinted, .sortedKeys]
    print("processed \(events.count) events · \(daemon.state.actorCount) actor baselines · fallbacks \(daemon.health.fallbacks)")
    print("final event \(ev.eventId) (\(ev.actionType) → \(ev.destinationType)/\(ev.destinationTrust)):")
    print(String(data: try! enc.encode(sig), encoding: .utf8)!)
    if has("preflight"), let gw = flag("gateway"), let key = flag("key"), let base = URL(string: gw) {
        let client = GatewayClient(base: base, apiKey: key, endpointId: (events.last?["endpoint_id"] as? String) ?? "ep_local")
        let signal = try! JSONSerialization.jsonObject(with: JSONEncoder().encode(sig))
        let envelope: [String: Any] = [
            "request_id": "ep_\(ev.eventId)_\(Int(Date().timeIntervalSince1970))",
            "actor": ["type": "agent", "id": ev.actorId],
            "action": ["type": "external_send", "tool": ev.tool, "title": "Send \(ev.resourceCount) contracts to external AI", "arguments_summary": "\(ev.resourceCount) \(ev.classification) vendor contracts"],
            "resources": [["type": "document", "classification": ev.classification, "count": ev.resourceCount]],
            "destination": ["type": "external_model", "value": flag("destination") ?? "quickscribe-ai.app"],
            "intent": ["reason": "Summarize vendor contracts for RFP response", "source": "agent"],
            "endpoint_signal": ["endpoint_id": client.endpointId, "event_id": ev.eventId, "signal": signal],
        ]
        do {
            let r = try client.preflight(envelope)
            print("\ngateway decision: \(r["status"] ?? "?") · final \(r["final_status"] ?? "?") · ml \(String(describing: (r["ml"] as? [String: Any])?["fusion"] ?? "-"))")
            print("approval: \(String(describing: (r["approval"] as? [String: Any])?["id"] ?? "none"))")
        } catch { print("preflight failed: \(error)") }
        try? client.events(daemon.telemetry.items.map { ["id": $0.id, "priority": $0.priority, "body": $0.body] })
        try? client.health(daemon.health.snapshot(queueDepth: daemon.telemetry.items.count, model: daemon.model?.version, stale: daemon.stale, killSwitch: false))
    }
}

func bench() {
    let precision = flag("precision") ?? "fp32"
    let compute = MLComputeUnits.parse(flag("compute") ?? "cpu")
    let iterations = Int(flag("iterations") ?? "20000") ?? 20000
    let sustained = Double(flag("sustained-seconds") ?? "60") ?? 60
    let rate = Double(flag("rate") ?? "50") ?? 50
    let fixture = try! JSONSerialization.jsonObject(with: Data(contentsOf: repo.appendingPathComponent("fixtures/parity/edge-risk-1.0.0.json"))) as! [String: Any]
    let vectors = (fixture["cases"] as! [[String: Any]]).map { $0["features"] as! [Double] }
    let parityStreams = (try! JSONSerialization.jsonObject(with: Data(contentsOf: repo.appendingPathComponent("fixtures/endpoint-events/feature-parity.json"))) as! [String: Any])["streams"] as! [[String: Any]]
    let events = parityStreams.flatMap { $0["events"] as! [[String: Any]] }

    let memBaseline = HealthMonitor.footprintBytes()
    var failures = 0
    // 1) cold load: compile + load + first prediction
    let tCold = DispatchTime.now()
    let l: (RiskModel, DecisionPolicy, ModelManifest, compileMs: Double, loadMs: Double)
    do { l = try loadLocal(precision: precision, compute: compute) } catch { die("load failed: \(error)") }
    let tFirst = DispatchTime.now()
    _ = try? l.0.logits(vectors[0])
    let firstMs = Double(DispatchTime.now().uptimeNanoseconds - tFirst.uptimeNanoseconds) / 1e6
    let coldMs = Double(DispatchTime.now().uptimeNanoseconds - tCold.uptimeNanoseconds) / 1e6
    let memAfterLoad = HealthMonitor.footprintBytes()

    // 2) warm batch-1 latency
    for i in 0..<200 { _ = try? l.0.logits(vectors[i % vectors.count]) }
    var warm: [Double] = []
    warm.reserveCapacity(iterations)
    let cpu0 = HealthMonitor.cpuSeconds(), wall0 = DispatchTime.now()
    for i in 0..<iterations {
        let t = DispatchTime.now()
        do { _ = try l.0.logits(vectors[i % vectors.count]) } catch { failures += 1 }
        warm.append(Double(DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1000)
    }
    let warmWall = Double(DispatchTime.now().uptimeNanoseconds - wall0.uptimeNanoseconds) / 1e9
    let warmCpu = HealthMonitor.cpuSeconds() - cpu0

    // 3) burst of 100
    var bursts: [Double] = []
    for b in 0..<100 {
        let t = DispatchTime.now()
        for i in 0..<100 { _ = try? l.0.logits(vectors[(b * 100 + i) % vectors.count]) }
        bursts.append(Double(DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1e6)
    }

    // 4) full event → features → anomaly → inference → decision → telemetry pipeline
    let daemon = EndpointDaemon(telemetry: TelemetryBuffer(capacity: 5000))
    daemon.attach((l.0, l.1, l.2))
    var pipeline: [Double] = []
    var featureOnly: [Double] = []
    let fstate = FeatureState()
    for e in events {
        let t = DispatchTime.now()
        if let ev = try? EventSchema.validate(e) {
            _ = EdgeFeatures.compute(ev, fstate)
            EdgeFeatures.update(ev, fstate)
        }
        featureOnly.append(Double(DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1000)
        let t2 = DispatchTime.now()
        do { _ = try daemon.process(e) } catch { failures += 1 }
        pipeline.append(Double(DispatchTime.now().uptimeNanoseconds - t2.uptimeNanoseconds) / 1000)
    }

    // 5) portable Swift runtime comparison
    let portable = try! PortableMLP(json: Data(contentsOf: modelDir.appendingPathComponent("model.json")))
    var portableLat: [Double] = []
    for i in 0..<min(iterations, 20000) {
        let t = DispatchTime.now()
        _ = try? portable.logits(vectors[i % vectors.count])
        portableLat.append(Double(DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1000)
    }

    // 6) idle CPU (process does nothing for 5 s)
    let idleCpu0 = HealthMonitor.cpuSeconds()
    Thread.sleep(forTimeInterval: 5)
    let idleCpu = (HealthMonitor.cpuSeconds() - idleCpu0) / 5 * 100

    // 7) sustained paced stream through the full pipeline
    var peakFootprint = HealthMonitor.footprintBytes()
    let sus0 = DispatchTime.now(), susCpu0 = HealthMonitor.cpuSeconds(), memSus0 = HealthMonitor.footprintBytes()
    var sustainedEvents = 0
    var susLat: [Double] = []
    let interval = 1.0 / rate
    var next = Date()
    let susDaemon = EndpointDaemon(telemetry: TelemetryBuffer(capacity: 5000))
    susDaemon.attach((l.0, l.1, l.2))
    while Double(DispatchTime.now().uptimeNanoseconds - sus0.uptimeNanoseconds) / 1e9 < sustained {
        var e = events[sustainedEvents % events.count]
        // Shift time forward so windows keep sliding like a live stream.
        if let ts = e["timestamp"] as? String, let ms = try? EventSchema.parseTimestamp(ts) {
            let shifted = ms + Int64(sustainedEvents / events.count) * 7 * 86_400_000
            let d = Date(timeIntervalSince1970: Double(shifted) / 1000)
            let f = ISO8601DateFormatter()
            f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            e["timestamp"] = f.string(from: d)
        }
        let t = DispatchTime.now()
        do { _ = try susDaemon.process(e) } catch { failures += 1 }
        susLat.append(Double(DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1000)
        if susLat.count > 200_000 { susLat.removeFirst(100_000) }
        sustainedEvents += 1
        if sustainedEvents % 500 == 0 { _ = susDaemon.telemetry.flush(batch: 5000) { _ in } }
        peakFootprint = max(peakFootprint, HealthMonitor.footprintBytes())
        next = next.addingTimeInterval(interval)
        let wait = next.timeIntervalSinceNow
        if wait > 0 { Thread.sleep(forTimeInterval: wait) }
    }
    let susWall = Double(DispatchTime.now().uptimeNanoseconds - sus0.uptimeNanoseconds) / 1e9
    let susCpu = (HealthMonitor.cpuSeconds() - susCpu0) / susWall * 100
    let memGrowth = Int64(HealthMonitor.footprintBytes()) - Int64(memSus0)

    let device = "\(sysctl("hw.model"))-\(sysctl("machdep.cpu.brand_string").replacingOccurrences(of: " ", with: "-"))"
    let mb = { (b: UInt64) in Double(b) / 1_048_576 }
    let iso = ISO8601DateFormatter().string(from: Date())
    let report: [String: Any] = [
        "schema": "orbis-benchmark/1",
        "model": "orbis-edge-risk@\(l.0.version)",
        "runtime": l.0.runtime,
        "precision": precision,
        "compute_units": compute.label,
        "device": ["model": sysctl("hw.model"), "cpu": sysctl("machdep.cpu.brand_string"), "os": ProcessInfo.processInfo.operatingSystemVersionString, "cores": ProcessInfo.processInfo.activeProcessorCount],
        "measured_at": iso,
        "cold": ["compile_ms": l.compileMs, "load_ms": l.loadMs, "first_prediction_ms": firstMs, "total_ms": coldMs],
        "warm_batch1_us": pct(warm).merging(["n": Double(iterations), "throughput_per_s": Double(iterations) / warmWall]) { a, _ in a },
        "warm_cpu_percent_of_one_core": warmCpu / warmWall * 100,
        "cpu_ms_per_1k_inferences": warmCpu / Double(iterations) * 1000 * 1000,
        "burst100_ms": pct(bursts),
        "feature_extraction_us": pct(featureOnly).merging(["n": Double(featureOnly.count)]) { a, _ in a },
        "pipeline_event_to_signal_us": pct(pipeline).merging(["n": Double(pipeline.count)]) { a, _ in a },
        "portable_swift_batch1_us": pct(portableLat),
        "idle_cpu_percent": idleCpu,
        "sustained": ["seconds": susWall, "target_rate_eps": rate, "events": sustainedEvents, "pipeline_us": pct(susLat), "cpu_percent": susCpu, "footprint_growth_mb": Double(memGrowth) / 1_048_576],
        "memory_mb": ["process_baseline": mb(memBaseline), "after_model_load": mb(memAfterLoad), "model_load_delta": mb(memAfterLoad) - mb(memBaseline), "peak_footprint": mb(peakFootprint), "peak_rss": mb(HealthMonitor.peakRSSBytes())],
        "failures": failures,
        "artifact_bytes": (try? FileManager.default.subpathsOfDirectory(atPath: modelDir.appendingPathComponent("coreml/OrbisEdgeRisk-\(precision).mlpackage").path))?.reduce(0) { acc, p in
            acc + ((try? FileManager.default.attributesOfItem(atPath: modelDir.appendingPathComponent("coreml/OrbisEdgeRisk-\(precision).mlpackage/\(p)").path)[.size] as? Int) ?? 0)
        } ?? 0,
        "energy": ["measured": false, "note": "Energy needs `sudo powermetrics` or Instruments on a physical session; reported proxy is cpu_ms_per_1k_inferences."],
    ]
    let outDir = URL(fileURLWithPath: flag("out") ?? repo.appendingPathComponent("ml/benchmarks/results/orbis-edge-risk/\(l.0.version)/\(device)").path)
    try? FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
    let file = outDir.appendingPathComponent("\(iso.replacingOccurrences(of: ":", with: "-"))-\(precision)-\(compute.label).json")
    try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: file)
    let w = pct(warm), p = pct(pipeline)
    print(String(format: "%@ %@ %@ · cold %.1f ms · warm p50 %.1f µs p95 %.1f µs p99 %.1f µs · pipeline p95 %.1f µs · peak %.1f MB · sustained %.0f s @ %.0f eps cpu %.2f%% · failures %d",
                 l.0.runtime, precision, compute.label, coldMs, w["p50"]!, w["p95"]!, w["p99"]!, p["p95"]!, mb(peakFootprint), susWall, rate, susCpu, failures))
    print("wrote \(file.path)")
}

/// Stage-by-stage cost of the event pipeline (answers "what limits performance?").
func profile() {
    let streams = (try! JSONSerialization.jsonObject(with: Data(contentsOf: repo.appendingPathComponent("fixtures/endpoint-events/feature-parity.json"))) as! [String: Any])["streams"] as! [[String: Any]]
    let events = streams.flatMap { $0["events"] as! [[String: Any]] }
    let l = try! loadLocal(precision: "fp32", compute: .cpuOnly)
    var stages: [String: [Double]] = [:]
    func time<T>(_ k: String, _ f: () throws -> T) rethrows -> T {
        let t = DispatchTime.now()
        let r = try f()
        stages[k, default: []].append(Double(DispatchTime.now().uptimeNanoseconds - t.uptimeNanoseconds) / 1000)
        return r
    }
    for round in 0..<5 {
        let st = FeatureState()
        let tb = TelemetryBuffer(capacity: 5000)
        for e in events {
            let data = try! JSONSerialization.data(withJSONObject: e)
            let obj = time("json_decode") { try! JSONSerialization.jsonObject(with: data) as! [String: Any] }
            guard let ev = try? time("validate", { try EventSchema.validate(obj) }) else { continue }
            let x = time("features") { EdgeFeatures.compute(ev, st) }
            _ = time("anomaly") { EdgeFeatures.anomaly(ev, st) }
            time("update") { EdgeFeatures.update(ev, st) }
            let z = time("inference_coreml") { try! l.0.logits(x) }
            _ = time("decide") { Decision.decide(logits: z, features: x, policy: l.1) }
            _ = time("reasons") { Decision.reasons(x) }
            time("telemetry_enqueue") { tb.enqueue(.init(id: ev.eventId + "\(round)", priority: 0, at: "", body: ["a": "b"])) }
        }
        let daemon = EndpointDaemon(telemetry: TelemetryBuffer(capacity: 5000))
        daemon.attach((l.0, l.1, l.2))
        for e in events { _ = try? time("daemon_process_total") { try daemon.process(e) } }
        let isoF = ISO8601DateFormatter()
        for _ in events { _ = time("iso8601_format") { isoF.string(from: Date()) } }
        for _ in events { _ = time("health_snapshot_parts") { HealthMonitor.footprintBytes() } }
    }
    for (k, v) in stages.sorted(by: { (pct($0.value)["p50"] ?? 0) > (pct($1.value)["p50"] ?? 0) }) {
        let p = pct(v)
        print(String(format: "%-18@ p50 %8.2f µs  p95 %8.2f µs  mean %8.2f µs", k as NSString, p["p50"]!, p["p95"]!, p["mean"]!))
    }
}

func sync() {
    guard let gw = flag("gateway"), let base = URL(string: gw), let key = flag("key") else { die("usage: orbis-endpoint sync --gateway URL --key KEY") }
    let home = URL(fileURLWithPath: flag("home") ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/OrbisEndpoint").path)
    let client = GatewayClient(base: base, apiKey: key, endpointId: flag("endpoint-id") ?? "ep_\(Host.current().localizedName ?? "mac")".lowercased().replacingOccurrences(of: " ", with: "-"))
    do {
        let pk = try flag("public-key").map { Data(base64Encoded: $0)! } ?? {
            let jwk = try JSONSerialization.jsonObject(with: client.send2("api/v1/endpoint/models/signing-key")) as! [String: Any]
            var s = (jwk["x"] as! String).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
            while s.count % 4 != 0 { s += "=" }
            return Data(base64Encoded: s)!
        }()
        let signed = try client.manifest()
        let mm = try ModelManager(root: home, tenantId: "ten_northstar", trustedKeys: [signed.key_id: pk])
        let m = try mm.verify(signed)
        print("manifest seq \(m.manifest_seq) → \(m.model_name)@\(m.version) (\(m.stage)), artifact \(m.artifact_sha256.prefix(12))…")
        let artifact = try client.artifact(m.artifact_url)
        let r = mm.install(signed, artifact: artifact)
        try? client.activationResult(r)
        print(r.activated ? "activated \(r.version) (compile \(String(format: "%.1f", r.compile_ms ?? 0)) ms, smoke \(String(format: "%.1f", r.smoke_ms ?? 0)) ms); previous \(r.previous ?? "none")" : "NOT activated: \(r.error ?? "?")")
    } catch { die("\(error)") }
}

extension GatewayClient {
    func send2(_ path: String) throws -> Data { try artifact(base.appendingPathComponent(path).absoluteString) }
}

func verifyManifest() {
    guard args.count >= 2, let pkB64 = flag("public-key"), let pk = Data(base64Encoded: pkB64) else { die("usage: verify-manifest <file> --public-key B64") }
    do {
        let signed = try JSONDecoder().decode(SignedManifest.self, from: Data(contentsOf: URL(fileURLWithPath: args[1])))
        let mm = try ModelManager(root: FileManager.default.temporaryDirectory.appendingPathComponent("orbis-verify-\(UUID().uuidString)"), tenantId: flag("tenant") ?? "ten_northstar", trustedKeys: [signed.key_id: pk])
        let m = try mm.verify(signed)
        print("valid: \(m.model_name)@\(m.version) seq \(m.manifest_seq) expires \(m.expires_at)")
    } catch { die("invalid: \(error)") }
}

switch args.first {
case "replay": replay()
case "bench": bench()
case "sync": sync()
case "profile": profile()
case "verify-manifest": verifyManifest()
default:
    print("""
    orbis-endpoint — Orbis Relay macOS endpoint runtime
      replay <stream.jsonl> [--gateway URL --key KEY --preflight]   run a demo stream through the local pipeline
      bench [--precision fp32|fp16|int8] [--compute cpu|all|gpu|ane] [--iterations N] [--sustained-seconds S] [--rate EPS]
      sync --gateway URL --key KEY [--home DIR] [--endpoint-id ID]   fetch, verify and activate the signed model
      verify-manifest <file> --public-key B64
    """)
}

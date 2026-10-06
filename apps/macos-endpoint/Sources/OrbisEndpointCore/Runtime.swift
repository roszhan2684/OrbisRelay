import CoreML
import Darwin
import Foundation

// MARK: - Telemetry buffer

/// Disk-backed, bounded telemetry queue. Under pressure it drops low-priority items first and records
/// every drop, so the cloud can tell "quiet endpoint" from "endpoint shedding load" (blueprint §15.2).
public final class TelemetryBuffer {
    public struct Item: Codable, Sendable {
        public var id: String
        public var priority: Int  // 1 = security-relevant (review/high/abstain), 0 = routine
        public var at: String
        public var body: [String: String]
        public init(id: String, priority: Int, at: String, body: [String: String]) {
            self.id = id; self.priority = priority; self.at = at; self.body = body
        }
    }
    public let capacity: Int
    let url: URL?
    public private(set) var items: [Item] = []
    public private(set) var dropped: [Int: Int] = [0: 0, 1: 0]
    public private(set) var failures = 0
    public private(set) var nextAttempt: Date = .distantPast
    var dirty = 0

    public init(capacity: Int = 5000, url: URL? = nil) {
        self.capacity = capacity
        self.url = url
        if let url, let d = try? Data(contentsOf: url) {
            items = d.split(separator: 10).compactMap { try? JSONDecoder().decode(Item.self, from: Data($0)) }
            if items.count > capacity { items = Array(items.suffix(capacity)) }
        }
    }

    public func enqueue(_ item: Item) {
        if items.count >= capacity {
            if let i = items.firstIndex(where: { $0.priority < item.priority }) ?? (item.priority == 0 ? nil : items.indices.first) {
                dropped[items[i].priority, default: 0] += 1
                items.remove(at: i)
            } else {
                dropped[item.priority, default: 0] += 1  // incoming is the lowest priority: drop it
                return
            }
        }
        items.append(item)
        dirty += 1
        if dirty >= 50 { persist() }
    }

    public func persist() {
        guard let url else { return }
        var d = Data()
        for it in items { if let j = try? JSONEncoder().encode(it) { d.append(j); d.append(10) } }
        let tmp = url.appendingPathExtension("tmp")
        if (try? d.write(to: tmp)) != nil { _ = rename(tmp.path, url.path) }
        dirty = 0
    }

    /// Upload up to `batch` items (high priority first). Failure → exponential backoff (2^n s, max 5 min).
    @discardableResult
    public func flush(batch: Int = 500, now: Date = Date(), upload: ([Item]) throws -> Void) -> Int {
        guard !items.isEmpty, now >= nextAttempt else { return 0 }
        let ordered = items.enumerated().sorted { ($0.element.priority, -$0.offset) > ($1.element.priority, -$1.offset) }.prefix(batch)
        let send = ordered.map(\.element)
        do {
            try upload(send)
            let ids = Set(send.map(\.id))
            items.removeAll { ids.contains($0.id) }
            failures = 0
            nextAttempt = .distantPast
            persist()
            return send.count
        } catch {
            failures += 1
            nextAttempt = now.addingTimeInterval(min(300, pow(2, Double(failures))))
            return 0
        }
    }
}

// MARK: - Health

public final class HealthMonitor {
    var inferenceUs: [Double] = []
    var pipelineUs: [Double] = []
    public private(set) var events = 0
    public private(set) var inferenceFailures = 0
    public private(set) var modelLoadFailures = 0
    public private(set) var fallbacks = 0
    public private(set) var rejectedEvents = 0
    let started = Date()
    let cap = 4096

    public init() {}

    func push(_ arr: inout [Double], _ v: Double) {
        arr.append(v)
        if arr.count > cap { arr.removeFirst(arr.count - cap) }
    }
    public func recordInference(us: Double) { push(&inferenceUs, us) }
    public func recordPipeline(us: Double) { push(&pipelineUs, us); events += 1 }
    public func recordFailure() { inferenceFailures += 1 }
    public func recordLoadFailure() { modelLoadFailures += 1 }
    public func recordFallback() { fallbacks += 1 }
    public func recordRejected() { rejectedEvents += 1 }

    public static func percentile(_ xs: [Double], _ p: Double) -> Double? {
        guard !xs.isEmpty else { return nil }
        let s = xs.sorted()
        let rank = p / 100 * Double(s.count - 1)
        let lo = Int(rank.rounded(.down)), hi = Int(rank.rounded(.up))
        return s[lo] + (s[hi] - s[lo]) * (rank - Double(lo))
    }

    /// Physical memory footprint (what Activity Monitor shows), in bytes.
    public static func footprintBytes() -> UInt64 {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count) } }
        return kr == KERN_SUCCESS ? UInt64(info.phys_footprint) : 0
    }

    /// Peak resident set size since process start, in bytes.
    public static func peakRSSBytes() -> UInt64 {
        var u = rusage()
        getrusage(RUSAGE_SELF, &u)
        return UInt64(u.ru_maxrss)  // bytes on macOS
    }

    public static func cpuSeconds() -> Double {
        var u = rusage()
        getrusage(RUSAGE_SELF, &u)
        return Double(u.ru_utime.tv_sec + u.ru_stime.tv_sec) + Double(u.ru_utime.tv_usec + u.ru_stime.tv_usec) / 1e6
    }

    public func snapshot(queueDepth: Int, model: String?, stale: Bool, killSwitch: Bool) -> [String: Any] {
        let up = Date().timeIntervalSince(started)
        return [
            "events": events,
            "inference_p50_ms": (Self.percentile(inferenceUs, 50) ?? 0) / 1000,
            "inference_p95_ms": (Self.percentile(inferenceUs, 95) ?? 0) / 1000,
            "pipeline_p95_ms": (Self.percentile(pipelineUs, 95) ?? 0) / 1000,
            "inference_failures": inferenceFailures,
            "model_load_failures": modelLoadFailures,
            "fallbacks": fallbacks,
            "rejected_events": rejectedEvents,
            "memory_mb": Double(Self.footprintBytes()) / 1_048_576,
            "cpu_percent": up > 0 ? 100 * Self.cpuSeconds() / up : 0,
            "queue_depth": queueDepth,
            "active_model": model ?? NSNull(),
            "stale_model": stale,
            "kill_switch": killSwitch,
        ]
    }
}

// MARK: - Gateway client

public final class GatewayClient {
    public let base: URL
    let apiKey: String
    public let endpointId: String
    let session: URLSession

    public init(base: URL, apiKey: String, endpointId: String) {
        self.base = base
        self.apiKey = apiKey
        self.endpointId = endpointId
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 15
        session = URLSession(configuration: cfg)
    }

    public struct HTTPError: Error, CustomStringConvertible {
        public let status: Int
        public let body: String
        public var description: String { "HTTP \(status): \(body.prefix(300))" }
    }

    func send(_ method: String, _ path: String, json: Any? = nil) throws -> Data {
        let rel = path.hasPrefix("/") ? String(path.dropFirst()) : path
        let root = base.absoluteString.hasSuffix("/") ? base : URL(string: base.absoluteString + "/")!
        guard let url = path.hasPrefix("http") ? URL(string: path) : URL(string: rel, relativeTo: root)?.absoluteURL else { throw HTTPError(status: 0, body: "bad url \(path)") }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue(endpointId, forHTTPHeaderField: "X-Orbis-Endpoint")
        req.setValue("orbis-endpoint/2.0.0 (macOS)", forHTTPHeaderField: "User-Agent")
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        var out: Result<(Data, URLResponse), Error>!
        let sem = DispatchSemaphore(value: 0)
        session.dataTask(with: req) { d, r, e in
            out = e.map { .failure($0) } ?? .success((d ?? Data(), r!))
            sem.signal()
        }.resume()
        sem.wait()
        let (data, resp) = try out.get()
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw HTTPError(status: status, body: String(data: data, encoding: .utf8) ?? "") }
        return data
    }

    public func manifest() throws -> SignedManifest {
        try JSONDecoder().decode(SignedManifest.self, from: send("GET", "api/v1/endpoint/models/manifest?endpoint_id=\(endpointId)"))
    }
    public func artifact(_ url: String) throws -> Data { try send("GET", url) }
    public func activationResult(_ r: ActivationResult) throws {
        _ = try send("POST", "api/v1/endpoint/models/orbis-edge-risk/\(r.version)/activation-result", json: try JSONSerialization.jsonObject(with: JSONEncoder().encode(r)))
    }
    public func health(_ snapshot: [String: Any]) throws { _ = try send("POST", "api/v1/endpoint/health", json: ["endpoint_id": endpointId, "health": snapshot]) }
    public func events(_ items: [[String: Any]]) throws { _ = try send("POST", "api/v1/endpoint/events/batch", json: ["endpoint_id": endpointId, "events": items]) }
    public func preflight(_ envelope: [String: Any]) throws -> [String: Any] {
        (try JSONSerialization.jsonObject(with: send("POST", "api/v1/decisions/preflight", json: envelope)) as? [String: Any]) ?? [:]
    }
}

// MARK: - Daemon

/// The endpoint pipeline: event → schema → features → (anomaly, model) → advisory signal.
/// Any failure degrades to a deterministic-fallback signal; the gateway's policy still decides.
public final class EndpointDaemon {
    public let state = FeatureState()
    public let health = HealthMonitor()
    public let telemetry: TelemetryBuffer
    public var model: RiskModel?
    public var policy: DecisionPolicy?
    public var manifest: ModelManifest? { didSet { expiry = manifest.flatMap { ModelManager.date($0.expires_at) } } }
    var expiry: Date?
    public var killSwitch = false
    public var now: () -> Date = Date.init

    public init(telemetry: TelemetryBuffer = TelemetryBuffer()) { self.telemetry = telemetry }

    /// Formatter allocation dominated the per-event cost in the first benchmark (≈200 µs/event); share one.
    static let iso = ISO8601DateFormatter()

    public func attach(_ loaded: (RiskModel, DecisionPolicy, ModelManifest)?) {
        model = loaded?.0
        policy = loaded?.1
        manifest = loaded?.2
    }

    /// Expiry is parsed once per manifest: the first benchmark showed ISO-8601 formatter allocation on
    /// every event costing ~175 µs — 3× the model inference itself.
    public var stale: Bool {
        guard manifest != nil else { return false }
        guard let exp = expiry else { return true }
        return exp <= now()
    }

    public func process(_ raw: [String: Any]) throws -> (NormalizedEvent, [Double], EdgeSignal) {
        let t0 = DispatchTime.now()
        let ev: NormalizedEvent
        do { ev = try EventSchema.validate(raw) } catch { health.recordRejected(); throw error }
        let x = EdgeFeatures.compute(ev, state)
        let an = EdgeFeatures.anomaly(ev, state)
        EdgeFeatures.update(ev, state)
        var sig = EdgeSignal(source: .deterministic_fallback, model: nil, modelVersion: nil, runtime: nil, policyVersion: nil, featureSchema: EdgeFeatures.schema, probs: nil, risk: nil, predictedClass: nil,
                             abstain: true, ood: x[EdgeFeatures.index("unknown_fields")] > 0, guarded: false, reasons: Decision.reasons(x),
                             anomalyScore: an.sufficient ? an.score : nil, anomalyTop: an.contributions.prefix(3).map(\.feature), anomalySufficient: an.sufficient, fallbackReason: nil, inferenceMicros: nil)
        if killSwitch {
            sig.fallbackReason = "kill_switch"
        } else if stale {
            sig.fallbackReason = "stale_model"
        } else if let model, let policy {
            do {
                let ti = DispatchTime.now()
                let z = try model.logits(x)
                let us = Double(DispatchTime.now().uptimeNanoseconds - ti.uptimeNanoseconds) / 1000
                health.recordInference(us: us)
                let d = Decision.decide(logits: z, features: x, policy: policy)
                sig.source = .local
                sig.model = model.name
                sig.modelVersion = model.version
                sig.runtime = model.runtime
                sig.policyVersion = policy.version
                sig.probs = d.probs
                sig.risk = d.risk
                sig.predictedClass = Vocab.labels[d.cls]
                sig.abstain = d.abstain
                sig.guarded = d.guarded
                sig.inferenceMicros = Int(us)
            } catch {
                health.recordFailure()
                sig.fallbackReason = "inference_error"
            }
        } else {
            sig.fallbackReason = "model_unavailable"
        }
        if sig.source == .deterministic_fallback { health.recordFallback() }
        health.recordPipeline(us: Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1000)
        let important = sig.abstain || (sig.predictedClass.map { $0 == "suspicious_review" || $0 == "high_risk" } ?? true)
        telemetry.enqueue(.init(id: ev.eventId, priority: important ? 1 : 0, at: Self.iso.string(from: now()), body: [
            "event_id": ev.eventId, "actor_id": ev.actorId, "action_type": ev.actionType, "class": sig.predictedClass ?? "fallback",
            "risk": sig.risk.map { String(($0 * 10_000).rounded() / 10_000) } ?? "", "anomaly": sig.anomalyScore.map { String(($0 * 10_000).rounded() / 10_000) } ?? "",
            "source": sig.source.rawValue, "model_version": sig.modelVersion ?? "", "reasons": sig.reasons.map(\.code).joined(separator: ","),
        ]))
        return (ev, x, sig)
    }
}

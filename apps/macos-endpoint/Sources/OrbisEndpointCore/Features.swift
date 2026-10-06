import Foundation

/// Swift port of the reference feature calculator `edge-features/1` (`ml/orbis_ml/features.py`).
/// Parity with Python is enforced by `fixtures/endpoint-events/feature-parity.json` (exact categorical
/// features, 1e-9 floats). Keep the order of floating-point operations identical to the reference.
public enum EdgeFeatures {
    public static let schema = "edge-features/1"
    static let hourMs: Int64 = 3_600_000
    static let dayMs: Int64 = 86_400_000
    static let window5m: Int64 = 300_000
    static let seenCap = 4096
    static let ringCap = 200
    static let timesCap = 10_000
    static let minBaseline = 5
    static let minAnomalyBaseline = 20

    public static let oneHotBlocks: [(String, [String])] = [
        ("actor_type", Vocab.actorTypes), ("action_type", Vocab.actionTypes), ("classification", Vocab.classifications),
        ("destination_type", Vocab.destinationTypes), ("destination_trust", Vocab.destinationTrust), ("privilege_level", Vocab.privilegeLevels),
        ("device_posture", Vocab.devicePostures), ("tool_risk_class", Vocab.toolRisk), ("environment", Vocab.environments),
    ]
    public static let numeric = [
        "resource_log", "amount_log", "off_hours", "weekend", "production_without_window", "has_ticket", "rate_5m", "rate_1h", "rate_ratio",
        "unique_dest_1h", "first_destination", "first_tool", "first_action", "resource_z", "baseline_insufficient", "unknown_fields", "class_rank",
        "x_sensitive_external", "x_sensitive_untrusted", "x_privileged_new_dest", "x_high_amount_off_hours", "x_destructive_production",
        "x_new_tool_elevated", "x_secret_egress", "x_bulk_sensitive",
    ]
    public static let names: [String] = oneHotBlocks.flatMap { block, vocab in (vocab + ["unknown"]).map { "\(block)=\($0)" } } + numeric
    public static var count: Int { names.count }
    static let nameIndex: [String: Int] = Dictionary(uniqueKeysWithValues: names.enumerated().map { ($1, $0) })
    public static func index(_ name: String) -> Int { nameIndex[name]! }

    static let classRank: [String: Int] = ["public": 0, "internal": 1, "confidential": 2, "restricted": 3, "regulated": 3, "secret": 4, "unknown": 2]
    static let externalDest: Set<String> = ["approved_vendor", "external_domain", "external_ai_provider", "beneficiary", "external_identity", "partner", "unknown"]
    static let untrusted: Set<String> = ["unverified", "blocked", "unknown"]
    static let elevated: Set<String> = ["elevated", "admin", "unknown"]
}

/// Bounded FIFO with O(1) amortised pops from the front.
struct Deque<T> {
    private var items: [T] = []
    private var head = 0
    var count: Int { items.count - head }
    var isEmpty: Bool { count == 0 }
    var first: T? { isEmpty ? nil : items[head] }
    mutating func append(_ x: T) { items.append(x) }
    mutating func popFirst() {
        head += 1
        if head > 1024 && head * 2 > items.count {
            items.removeFirst(head)
            head = 0
        }
    }
    func forEach(_ body: (T) -> Void) { for i in head..<items.count { body(items[i]) } }
    var array: [T] { Array(items[head...]) }
}

/// Fixed-capacity ring that keeps the most recent `cap` values in insertion order.
struct Ring {
    let cap: Int
    private(set) var values: [Double] = []
    init(cap: Int) { self.cap = cap }
    mutating func append(_ x: Double) {
        values.append(x)
        if values.count > cap { values.removeFirst(values.count - cap) }
    }
}

public final class ActorBaseline {
    var times = Deque<(Int64, String)>()
    var seenDest = Set<String>()
    var seenTool = Set<String>()
    var seenAction = Set<String>()
    var n = 0
    var mean = 0.0
    var m2 = 0.0
    var volRing = Ring(cap: EdgeFeatures.ringCap)
    var rateRing = Ring(cap: EdgeFeatures.ringCap)
}

/// Per-actor behavioural state. Bounded: 24h of timestamps (≤10k), capped novelty sets, 200-sample rings.
public final class FeatureState {
    public private(set) var actors: [String: ActorBaseline] = [:]
    public init() {}
    func get(_ id: String) -> ActorBaseline {
        if let a = actors[id] { return a }
        let a = ActorBaseline()
        actors[id] = a
        return a
    }
    public func reset() { actors.removeAll() }
    public var actorCount: Int { actors.count }
}

public struct AnomalyResult: Equatable, Sendable {
    public var score: Double
    public var sufficient: Bool
    public var samples: Int
    public var zVolume: Double?
    public var zRate: Double?
    public var contributions: [(feature: String, weight: Double)]

    public static func == (a: AnomalyResult, b: AnomalyResult) -> Bool {
        a.score == b.score && a.sufficient == b.sufficient && a.samples == b.samples && a.contributions.map(\.feature) == b.contributions.map(\.feature)
    }
}

extension EdgeFeatures {
    struct Window { var n5 = 0, n60 = 0, nBase = 0, uniqueDest1h = 0 }

    static func clamp(_ x: Double, _ lo: Double, _ hi: Double) -> Double { x < lo ? lo : (x > hi ? hi : x) }

    /// Floor division for Int64 (Python `//` semantics).
    static func floorDiv(_ a: Int64, _ b: Int64) -> Int64 {
        let q = a / b
        return (a % b != 0 && ((a < 0) != (b < 0))) ? q - 1 : q
    }

    public static func localTime(_ tsMs: Int64, _ tz: Int) -> (hour: Int, weekday: Int) {
        let local = tsMs + Int64(tz) * 60_000
        let day = floorDiv(local, dayMs)
        let hour = (local - day * dayMs) / hourMs
        var wd = (day + 4) % 7
        if wd < 0 { wd += 7 }
        return (Int(hour), Int(wd))
    }

    static func windowCounts(_ st: ActorBaseline, _ t: Int64) -> Window {
        var w = Window()
        var dests = Set<String>()
        st.times.forEach { ts, dh in
            if ts > t || ts <= t - dayMs { return }
            if ts > t - window5m { w.n5 += 1 }
            if ts > t - hourMs {
                w.n60 += 1
                if !dh.isEmpty { dests.insert(dh) }
            } else {
                w.nBase += 1
            }
        }
        w.uniqueDest1h = dests.count
        return w
    }

    static func unknownCount(_ e: NormalizedEvent) -> Int {
        [e.actorType, e.privilegeLevel, e.actionType, e.classification, e.destinationType, e.destinationTrust, e.devicePosture, e.environment].filter { $0 == "unknown" }.count
    }

    static func onehot(_ value: String, _ vocab: [String], into v: inout [Double]) {
        var block = [Double](repeating: 0, count: vocab.count + 1)
        block[vocab.firstIndex(of: value) ?? vocab.count] = 1
        v.append(contentsOf: block)
    }

    static func blockValue(_ e: NormalizedEvent, _ block: String) -> String {
        switch block {
        case "actor_type": return e.actorType
        case "action_type": return e.actionType
        case "classification": return e.classification
        case "destination_type": return e.destinationType
        case "destination_trust": return e.destinationTrust
        case "privilege_level": return e.privilegeLevel
        case "device_posture": return e.devicePosture
        case "tool_risk_class": return e.toolRiskClass
        default: return e.environment
        }
    }

    /// Feature vector for `e` given prior state. Pure — call `update` afterwards.
    public static func compute(_ e: NormalizedEvent, _ state: FeatureState) -> [Double] {
        let st = state.get(e.actorId)
        let w = windowCounts(st, e.tsMs)
        let (hour, weekday) = localTime(e.tsMs, e.tzOffsetMinutes)
        let weekend = weekday == 0 || weekday == 6
        let offHours = weekend || hour < 8 || hour >= 19

        let hasDest = e.destinationType != "none"
        let firstDest = hasDest && (e.destinationHash.isEmpty || !st.seenDest.contains(e.destinationHash))
        let firstTool = e.tool.isEmpty || !st.seenTool.contains(e.tool)
        let firstAction = !st.seenAction.contains(e.actionType)

        let x = log1p(Double(e.resourceCount))
        let resourceZ: Double
        if st.n >= minBaseline {
            let z = (x - st.mean) / sqrt(st.m2 / Double(st.n) + 0.25)
            resourceZ = clamp(z, -5.0, 5.0) / 5.0
        } else {
            resourceZ = 0.0
        }
        let baseRate = Double(w.nBase) / 23.0
        let rateRatio = clamp(log2((Double(w.n60) + 1.0) / (baseRate + 1.0)), -4.0, 6.0) / 6.0

        let rank = classRank[e.classification] ?? 2
        let sensitive = rank >= 2
        let external = externalDest.contains(e.destinationType)
        let isElevated = elevated.contains(e.privilegeLevel)

        var v: [Double] = []
        v.reserveCapacity(85)
        for (block, vocab) in oneHotBlocks { onehot(blockValue(e, block), vocab, into: &v) }
        let b = { (c: Bool) -> Double in c ? 1.0 : 0.0 }
        v.append(contentsOf: [
            min(x, 16.0) / 16.0,
            min(log10(1.0 + e.amountUSD), 10.0) / 10.0,
            b(offHours),
            b(weekend),
            b(e.environment == "production" && e.changeWindow != true),
            b(e.hasTicket),
            min(log1p(Double(w.n5)), 8.0) / 8.0,
            min(log1p(Double(w.n60)), 8.0) / 8.0,
            rateRatio,
            min(log1p(Double(w.uniqueDest1h)), 6.0) / 6.0,
            b(firstDest),
            b(firstTool),
            b(firstAction),
            resourceZ,
            b(st.n < minBaseline),
            Double(min(unknownCount(e), 4)) / 4.0,
            Double(rank) / 4.0,
            b(sensitive && external),
            b(sensitive && hasDest && untrusted.contains(e.destinationTrust)),
            b(isElevated && firstDest),
            b(e.amountUSD >= 10_000 && offHours),
            b(e.actionType == "destructive_delete" && e.environment == "production"),
            b(firstTool && isElevated),
            b(e.classification == "secret" && e.destinationType != "none" && e.destinationType != "internal"),
            b(e.resourceCount >= 1000 && sensitive),
        ])
        return v
    }

    public static func update(_ e: NormalizedEvent, _ state: FeatureState) {
        let st = state.get(e.actorId)
        let t = e.tsMs
        var w60 = 0
        st.times.forEach { ts, _ in if t - hourMs < ts && ts <= t { w60 += 1 } }
        while let f = st.times.first, f.0 <= t - dayMs { st.times.popFirst() }
        st.times.append((t, e.destinationHash))
        while st.times.count > timesCap { st.times.popFirst() }
        if e.destinationType != "none", !e.destinationHash.isEmpty, st.seenDest.count < seenCap { st.seenDest.insert(e.destinationHash) }
        if !e.tool.isEmpty, st.seenTool.count < seenCap { st.seenTool.insert(e.tool) }
        if st.seenAction.count < seenCap { st.seenAction.insert(e.actionType) }
        let x = log1p(Double(e.resourceCount))
        st.n += 1
        let d = x - st.mean
        st.mean += d / Double(st.n)
        st.m2 += d * (x - st.mean)
        st.volRing.append(x)
        st.rateRing.append(Double(w60))
    }

    static func median(_ xs: [Double]) -> Double {
        let s = xs.sorted()
        let n = s.count, m = n / 2
        return n % 2 == 1 ? s[m] : (s[m - 1] + s[m]) / 2.0
    }

    /// Model B: robust (median/MAD) deviation from the actor's own history. Call before `update`.
    public static func anomaly(_ e: NormalizedEvent, _ state: FeatureState) -> AnomalyResult {
        let st = state.get(e.actorId)
        let n = st.volRing.values.count
        let w = windowCounts(st, e.tsMs)
        guard n >= minAnomalyBaseline else { return AnomalyResult(score: 0, sufficient: false, samples: n, zVolume: nil, zRate: nil, contributions: []) }
        let vols = st.volRing.values, rates = st.rateRing.values
        let mv = median(vols), mr = median(rates)
        let madv = median(vols.map { abs($0 - mv) })
        let madr = median(rates.map { abs($0 - mr) })
        let zVol = (log1p(Double(e.resourceCount)) - mv) / (1.4826 * madv + 0.25)
        let zRate = (Double(w.n60) - mr) / (1.4826 * madr + 1.0)
        let hasDest = e.destinationType != "none"
        let novelty: [(String, Double)] = [
            ("first_destination", (hasDest && (e.destinationHash.isEmpty || !st.seenDest.contains(e.destinationHash))) ? 1.0 : 0.0),
            ("first_tool", (e.tool.isEmpty || !st.seenTool.contains(e.tool)) ? 1.0 : 0.0),
            ("first_action", st.seenAction.contains(e.actionType) ? 0.0 : 1.0),
        ]
        var contributions: [(String, Double)] = [("volume", max(0.0, zVol) / 4.0), ("rate", max(0.0, zRate) / 4.0)] + novelty.map { ($0.0, 0.35 * $0.1) }
        var s = 0.0
        for c in contributions { s += c.1 }
        contributions = contributions.filter { $0.1 > 0 }.sorted { $0.1 != $1.1 ? $0.1 > $1.1 : $0.0 < $1.0 }
        return AnomalyResult(score: 1.0 - exp(-s), sufficient: true, samples: n, zVolume: zVol, zRate: zRate, contributions: contributions.map { (feature: $0.0, weight: $0.1) })
    }
}

import Foundation

/// Calibration + decision policy (`orbis-decision-policy/1`) — Swift port of `ml/orbis_ml/decision.py`.
public struct DecisionPolicy: Codable, Sendable {
    public struct HighImpact: Codable, Sendable {
        public var any_feature_set: [Int]
        public var class_rank_index: Int
        public var class_rank_min: Double
        public var resource_log_index: Int
        public var resource_log_min: Double
    }
    public var schema: String
    public var version: String
    public var model_version: String?
    public var temperature: Double
    public var tau_high: Double
    public var tau_review: Double
    public var abstain_entropy: Double
    public var unknown_fields_index: Int
    public var high_impact: HighImpact

    public static func load(_ data: Data) throws -> DecisionPolicy {
        let p = try JSONDecoder().decode(DecisionPolicy.self, from: data)
        guard p.schema == "orbis-decision-policy/1" else { throw RiskModelError.incompatible("policy schema \(p.schema)") }
        return p
    }
}

public struct Reason: Equatable, Sendable, Codable {
    public var code: String
    public var label: String
}

/// The advisory signal an endpoint attaches to a preflight. It never authorizes anything by itself.
public struct EdgeSignal: Sendable, Codable {
    public enum Source: String, Codable, Sendable { case local, deterministic_fallback }
    public var source: Source
    public var model: String?
    public var modelVersion: String?
    public var runtime: String?
    public var policyVersion: String?
    public var featureSchema: String
    public var probs: [Double]?
    public var risk: Double?
    public var predictedClass: String?
    public var abstain: Bool
    public var ood: Bool
    public var guarded: Bool
    public var reasons: [Reason]
    public var anomalyScore: Double?
    public var anomalyTop: [String]
    public var anomalySufficient: Bool
    public var fallbackReason: String?
    public var inferenceMicros: Int?

    enum CodingKeys: String, CodingKey {
        case source, model, runtime, probs, risk, abstain, ood, guarded, reasons
        case modelVersion = "model_version", policyVersion = "policy_version", featureSchema = "feature_schema", predictedClass = "class"
        case anomalyScore = "anomaly_score", anomalyTop = "anomaly_top", anomalySufficient = "anomaly_sufficient", fallbackReason = "fallback_reason", inferenceMicros = "inference_us"
    }
}

public enum Decision {
    public static func softmax(_ z: [Double], _ T: Double) -> [Double] {
        let s = z.map { $0 / T }
        let m = s.max() ?? 0
        let e = s.map { exp($0 - m) }
        let sum = e.reduce(0, +)
        return e.map { $0 / sum }
    }

    static func normalizedEntropy(_ p: [Double]) -> Double {
        var h = 0.0
        for v in p { h += v * log(min(max(v, 1e-12), 1)) }
        return -h / log(Double(p.count))
    }

    public static func highImpact(_ x: [Double], _ hi: DecisionPolicy.HighImpact) -> Bool {
        hi.any_feature_set.contains { x[$0] > 0.5 } || x[hi.class_rank_index] >= hi.class_rank_min || x[hi.resource_log_index] >= hi.resource_log_min
    }

    public static func decide(logits: [Double], features x: [Double], policy: DecisionPolicy) -> (probs: [Double], risk: Double, cls: Int, abstain: Bool, ood: Bool, guarded: Bool) {
        let p = softmax(logits, policy.temperature)
        let risk = p[2] + p[3]
        var cls = p[1] > p[0] ? 1 : 0
        if risk >= policy.tau_review { cls = 2 }
        if p[3] >= policy.tau_high { cls = 3 }
        let ood = x[policy.unknown_fields_index] > 0
        let abstain = ood || normalizedEntropy(p) >= policy.abstain_entropy
        let guarded = abstain && highImpact(x, policy.high_impact) && cls < 2
        if guarded { cls = 2 }
        return (p, risk, cls, abstain, ood, guarded)
    }

    static let reasonTable: [(String, String)] = [
        ("out_of_distribution", "Unrecognised fields — model confidence reduced"),
        ("secret_egress", "Secret-bearing data leaving the trust boundary"),
        ("sensitive_to_untrusted", "Sensitive data to an unverified destination"),
        ("blocked_destination", "Destination is on the block list"),
        ("external_identity", "Access for an external identity"),
        ("destructive_production", "Destructive change in production"),
        ("bulk_sensitive", "Bulk volume of sensitive records"),
        ("sensitive_external", "Sensitive data leaving the organisation"),
        ("privileged_new_destination", "Privileged actor, never-seen destination"),
        ("first_destination", "Destination never used by this actor"),
        ("rate_spike", "Action rate %@× this actor's baseline"),
        ("volume_outlier", "Volume far above this actor's history"),
        ("high_amount", "High monetary amount"),
        ("outside_change_window", "Production change outside an approved window"),
        ("new_tool", "Tool never used by this actor"),
        ("off_hours", "Outside business hours"),
    ]

    /// Portable, feature-only reason codes (same list, order and thresholds as the Python reference).
    public static func reasons(_ x: [Double], limit: Int = 4) -> [Reason] {
        let f = { (n: String) -> Double in x[EdgeFeatures.index(n)] }
        let established = f("baseline_insufficient") < 0.5
        let rate = pow(2.0, f("rate_ratio") * 6.0)
        let fired: [String: Bool] = [
            "out_of_distribution": f("unknown_fields") > 0,
            "secret_egress": f("x_secret_egress") > 0.5,
            "sensitive_to_untrusted": f("x_sensitive_untrusted") > 0.5,
            "blocked_destination": f("destination_trust=blocked") > 0.5,
            "external_identity": f("destination_type=external_identity") > 0.5,
            "destructive_production": f("x_destructive_production") > 0.5,
            "bulk_sensitive": f("x_bulk_sensitive") > 0.5,
            "sensitive_external": f("x_sensitive_external") > 0.5,
            "privileged_new_destination": f("x_privileged_new_dest") > 0.5 && established,
            "first_destination": f("first_destination") > 0.5 && established,
            "rate_spike": rate >= 3.0 && established,
            "volume_outlier": f("resource_z") >= 0.4,
            "high_amount": f("amount_log") >= 0.4,
            "outside_change_window": f("production_without_window") > 0.5,
            "new_tool": f("first_tool") > 0.5 && established,
            "off_hours": f("off_hours") > 0.5,
        ]
        var out: [Reason] = []
        for (code, label) in reasonTable where fired[code] == true {
            out.append(Reason(code: code, label: label.replacingOccurrences(of: "%@", with: String(format: "%.1f", rate))))
        }
        return Array(out.prefix(limit))
    }
}

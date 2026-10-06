import CryptoKit
import Foundation

/// Canonical endpoint event schema `endpoint-event/1` — Swift port of `ml/orbis_ml/schema.py`.
/// Unknown enum values map to an explicit "unknown" bucket; impossible values are rejected.
public enum Vocab {
    public static let actorTypes = ["human", "agent", "service", "automation"]
    public static let actionTypes = [
        "external_send", "file_upload", "clipboard_export", "tool_invoke", "database_query", "privilege_grant", "payment", "refund",
        "production_deploy", "secrets_access", "model_provider_send", "bulk_download", "destructive_delete", "config_change", "physical_operation",
    ]
    public static let classifications = ["public", "internal", "confidential", "restricted", "regulated", "secret"]
    public static let destinationTypes = ["none", "internal", "internal_model", "approved_vendor", "external_domain", "external_ai_provider", "beneficiary", "external_identity", "partner", "production_env"]
    public static let destinationTrust = ["trusted", "approved", "unverified", "blocked"]
    public static let privilegeLevels = ["standard", "elevated", "admin"]
    public static let devicePostures = ["managed", "unmanaged"]
    public static let toolRisk = ["low", "medium", "high"]
    public static let environments = ["none", "dev", "staging", "production"]
    public static let labels = ["safe_normal", "safe_unusual", "suspicious_review", "high_risk"]
}

public struct SchemaError: Error, CustomStringConvertible, Equatable {
    public let field: String
    public let message: String
    public var description: String { "\(field): \(message)" }
}

public struct NormalizedEvent: Equatable, Sendable {
    public var eventId: String
    public var tsMs: Int64
    public var tzOffsetMinutes: Int
    public var actorId: String
    public var actorType: String
    public var privilegeLevel: String
    public var actionType: String
    public var tool: String
    public var toolRiskClass: String
    public var classification: String
    public var resourceCount: Int
    public var destinationType: String
    public var destinationTrust: String
    public var destinationHash: String
    public var environment: String
    public var devicePosture: String
    public var amountUSD: Double
    public var changeWindow: Bool?
    public var hasTicket: Bool
}

public enum EventSchema {
    public static let id = "endpoint-event/1"
    static let maxCount = 10_000_000
    static let maxAmount = 1e10

    /// First 16 hex chars of sha256(lowercased, trimmed domain). Computed on the endpoint so raw
    /// destinations never leave the machine.
    public static func domainHash(_ domain: String) -> String {
        let d = domain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !d.isEmpty else { return "" }
        return SHA256.hash(data: Data(d.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16).description
    }

    /// Strict `YYYY-MM-DDTHH:MM:SS[.mmm]Z` parser with integer-only civil-date arithmetic.
    public static func parseTimestamp(_ ts: String) throws -> Int64 {
        let b = Array(ts.utf8)
        func digits(_ from: Int, _ n: Int) -> Int? {
            guard from + n <= b.count else { return nil }
            var v = 0
            for i in from..<(from + n) {
                let c = b[i]
                guard c >= 48 && c <= 57 else { return nil }
                v = v * 10 + Int(c - 48)
            }
            return v
        }
        let bad = SchemaError(field: "timestamp", message: "expected YYYY-MM-DDTHH:MM:SS[.mmm]Z, got \(ts)")
        guard b.count >= 20, b[4] == 45, b[7] == 45, b[10] == 84, b[13] == 58, b[16] == 58, b.last == 90,
              let y = digits(0, 4), let mo = digits(5, 2), let d = digits(8, 2), let h = digits(11, 2), let mi = digits(14, 2), let s = digits(17, 2)
        else { throw bad }
        var ms = 0
        if b.count != 20 {
            // ".m", ".mm" or ".mmm" then Z
            let fracLen = b.count - 21
            guard b[19] == 46, (1...3).contains(fracLen), let f = digits(20, fracLen) else { throw bad }
            ms = fracLen == 1 ? f * 100 : fracLen == 2 ? f * 10 : f
        }
        guard (1...12).contains(mo), (1...31).contains(d), h < 24, mi < 60, s < 60 else {
            throw SchemaError(field: "timestamp", message: "timestamp out of range: \(ts)")
        }
        let days = Int64(daysFromCivil(y, mo, d))
        return days * 86_400_000 + Int64(h) * 3_600_000 + Int64(mi) * 60_000 + Int64(s) * 1000 + Int64(ms)
    }

    static func daysFromCivil(_ y0: Int, _ m: Int, _ d: Int) -> Int {
        let y = y0 - (m <= 2 ? 1 : 0)
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    static func isBool(_ v: Any?) -> Bool {
        guard let n = v as? NSNumber else { return false }
        return CFGetTypeID(n) == CFBooleanGetTypeID()
    }

    static func intValue(_ v: Any?) -> Int? {
        guard let n = v as? NSNumber, !isBool(n), !CFNumberIsFloatType(n) else { return nil }
        return n.intValue
    }

    static func numberValue(_ v: Any?) -> Double? {
        guard let n = v as? NSNumber, !isBool(n) else { return nil }
        return n.doubleValue
    }

    static func enumValue(_ v: Any?, _ vocab: [String]) -> String {
        guard let s = v as? String, vocab.contains(s) else { return "unknown" }
        return s
    }

    public static func validate(json data: Data) throws -> NormalizedEvent {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw SchemaError(field: "event", message: "must be a JSON object")
        }
        return try validate(obj)
    }

    public static func validate(_ e: [String: Any]) throws -> NormalizedEvent {
        guard (e["schema"] as? String) == id else { throw SchemaError(field: "schema", message: "expected '\(id)'") }
        guard let eid = e["event_id"] as? String, (1...128).contains(eid.count) else { throw SchemaError(field: "event_id", message: "required string ≤128") }
        guard let ts = e["timestamp"] as? String else { throw SchemaError(field: "timestamp", message: "required string") }
        let tsMs = try parseTimestamp(ts)
        var tz = 0
        if let raw = e["tz_offset_minutes"] {
            guard let t = intValue(raw), (-840...840).contains(t) else { throw SchemaError(field: "tz_offset_minutes", message: "integer in [-840, 840]") }
            tz = t
        }
        guard let actor = e["actor"] as? [String: Any], let actorId = actor["id"] as? String, !actorId.isEmpty else {
            throw SchemaError(field: "actor.id", message: "required")
        }
        guard let action = e["action"] as? [String: Any] else { throw SchemaError(field: "action", message: "required object") }
        let resource: [String: Any]
        if let r = e["resource"], !(r is NSNull) {
            guard let rr = r as? [String: Any] else { throw SchemaError(field: "resource", message: "must be an object") }
            resource = rr
        } else { resource = [:] }
        var count = 1
        if let raw = resource["count"] {
            guard let c = intValue(raw), c >= 0, c <= maxCount else { throw SchemaError(field: "resource.count", message: "integer in [0, 10^7]") }
            count = c
        }
        let dest: [String: Any]
        if let d = e["destination"], !(d is NSNull) {
            guard let dd = d as? [String: Any] else { throw SchemaError(field: "destination", message: "must be an object") }
            dest = dd
        } else { dest = [:] }
        let dh: String
        if let raw = dest["domain_hash"] {
            guard let s = raw as? String else { throw SchemaError(field: "destination.domain_hash", message: "16 lowercase hex chars (never the raw domain)") }
            dh = s
        } else { dh = "" }
        if !dh.isEmpty {
            let ok = dh.utf8.count == 16 && dh.utf8.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
            guard ok else { throw SchemaError(field: "destination.domain_hash", message: "16 lowercase hex chars (never the raw domain)") }
        }
        let bc: [String: Any]
        if let b = e["business_context"], !(b is NSNull) {
            guard let bb = b as? [String: Any] else { throw SchemaError(field: "business_context", message: "must be an object") }
            bc = bb
        } else { bc = [:] }
        var amount = 0.0
        if let raw = bc["amount_usd"] {
            guard let a = numberValue(raw), a >= 0, a <= maxAmount, !a.isNaN else { throw SchemaError(field: "business_context.amount_usd", message: "number in [0, 1e10]") }
            amount = a
        }
        var cw: Bool? = nil
        if let raw = bc["change_window"], !(raw is NSNull) {
            guard isBool(raw), let b = raw as? Bool else { throw SchemaError(field: "business_context.change_window", message: "boolean or null") }
            cw = b
        }
        var tool = ""
        if let raw = action["tool"], !(raw is NSNull) {
            guard let t = raw as? String, t.count <= 120 else { throw SchemaError(field: "action.tool", message: "string ≤120") }
            tool = t
        }
        let destTypeRaw: Any? = dest["type"] ?? "none"
        let destType = enumValue(destTypeRaw, Vocab.destinationTypes)
        let rawIsNone = (destTypeRaw as? String) == "none"
        let ticket: Bool = (bc["ticket"] as? Bool) ?? ((bc["ticket"] as? NSNumber)?.boolValue ?? false)
        return NormalizedEvent(
            eventId: eid,
            tsMs: tsMs,
            tzOffsetMinutes: tz,
            actorId: actorId,
            actorType: enumValue(actor["type"], Vocab.actorTypes),
            privilegeLevel: enumValue(actor["privilege_level"], Vocab.privilegeLevels),
            actionType: enumValue(action["type"], Vocab.actionTypes),
            tool: tool,
            toolRiskClass: enumValue(action["tool_risk_class"], Vocab.toolRisk),
            classification: enumValue(resource["classification"], Vocab.classifications),
            resourceCount: count,
            destinationType: destType,
            destinationTrust: rawIsNone ? "trusted" : enumValue(dest["trust"], Vocab.destinationTrust),
            destinationHash: dh,
            environment: enumValue(e["environment"] ?? "none", Vocab.environments),
            devicePosture: enumValue(e["device_posture"], Vocab.devicePostures),
            amountUSD: amount,
            changeWindow: cw,
            hasTicket: ticket
        )
    }
}

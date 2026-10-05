import Foundation

// Typed mirrors of the Orbis v1 API contract (docs/api/openapi.json).

enum JSONValue: Codable, Hashable, Sendable, CustomStringConvertible {
    case string(String), number(Double), bool(Bool), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else { self = .string(try c.decode(String.self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        }
    }

    var number: Double? { if case .number(let n) = self { return n } else { return nil } }

    var description: String {
        switch self {
        case .string(let s): return s
        case .number(let n): return n.rounded() == n ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        case .null: return "—"
        }
    }
}

enum RiskLevel: String, Codable, Sendable, CaseIterable { case low, medium, high, critical }

struct RiskReason: Codable, Hashable, Sendable { let code: String; let label: String; let weight: Int }
struct Risk: Codable, Hashable, Sendable { let score: Int; let level: RiskLevel; let reasons: [RiskReason] }

enum ApprovalStatus: String, Codable, Sendable {
    case pending, approved, rejected, expired, cancelled
    case approvedModified = "approved_modified"

    var label: String {
        switch self {
        case .pending: return "Awaiting decision"
        case .approved: return "Approved"
        case .approvedModified: return "Approved · modified"
        case .rejected: return "Rejected"
        case .expired: return "Expired"
        case .cancelled: return "Cancelled"
        }
    }
}

enum StepUpRequirement: String, Codable, Sendable { case none, biometric }

struct Evidence: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let label: String
    let value: String
    let source: String
    let freshness: String?
    let confidence: String?
}

struct EditableField: Codable, Hashable, Sendable, Identifiable {
    let key: String
    let label: String
    let type: String
    let min: Double?
    let max: Double?
    var id: String { key }
}

struct SafeAlternative: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let type: String
    let label: String
    let description: String
}

struct PolicyRef: Codable, Hashable, Sendable {
    let id: String
    let name: String
    let version: Int
    let ruleId: String
    let ruleName: String
    let reason: String
}

struct ActorRef: Codable, Hashable, Sendable { let id: String; let type: String; let name: String }
struct IntegrationRef: Codable, Hashable, Sendable { let id: String; let name: String }
struct Quorum: Codable, Hashable, Sendable { let required: Int; let of: Int }
struct QuorumProgress: Codable, Hashable, Sendable { let approvals: Int; let required: Int }

struct ResponseRecord: Codable, Hashable, Sendable {
    let userId: String
    let userName: String
    let decision: String
    let respondedAt: Date
    let channel: String
}

struct Approval: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let title: String
    let summary: String?
    let intent: String?
    let route: String
    var status: ApprovalStatus
    let stepUp: StepUpRequirement
    let quorum: Quorum?
    let createdAt: Date
    let expiresAt: Date
    let escalationLevel: Int
    let editableFields: [EditableField]
    let safeAlternatives: [SafeAlternative]
    let evidence: [Evidence]
    let blastRadius: [String]
    let risk: Risk
    let policy: PolicyRef
    let actor: ActorRef
    let integration: IntegrationRef
    let parameters: [String: JSONValue]
    var quorumProgress: QuorumProgress?
    var canRespond: Bool?
    var receiptId: String?
    var responses: [ResponseRecord]?

    func isExpired(at now: Date = .now) -> Bool { expiresAt <= now }
}

struct Page<T: Decodable & Sendable>: Decodable, Sendable { let data: [T] }

enum Decision: String, Codable, Sendable {
    case approve
    case approveModified = "approve_modified"
    case reject
    case safeAlternative = "safe_alternative"
}

struct StepUpProof: Codable, Hashable, Sendable {
    let method: String // "biometric"
    let verified: Bool
}

struct RespondBody: Encodable, Sendable {
    let decision: Decision
    var alternativeId: String? = nil
    var modifiedParameters: [String: Double]? = nil
    var comment: String? = nil
    var stepUp: StepUpProof? = nil
}

// MARK: - Session / profile

struct UserProfile: Codable, Hashable, Sendable {
    let id: String
    let name: String
    let email: String
    let title: String
    let roles: [String]
    let groups: [String]
    let initials: String
    let color: String
}

struct DeviceInfo: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let name: String
    let model: String
    let os: String
    let trust: String
    let lastSeenAt: Date
}

struct TenantInfo: Codable, Hashable, Sendable { let id: String; let name: String }

struct SignInResponse: Decodable, Sendable { let token: String; let user: UserProfile; let device: DeviceInfo; let tenant: TenantInfo }

struct Permissions: Codable, Hashable, Sendable { let canFreeze: Bool; let canUnfreeze: Bool }

struct Me: Decodable, Sendable {
    let user: UserProfile
    let tenant: TenantInfo
    let device: DeviceInfo?
    let devices: [DeviceInfo]
    let pendingCount: Int
    let permissions: Permissions
}

// MARK: - Activity

struct MyResponse: Codable, Hashable, Sendable { let decision: String; let respondedAt: Date; let channel: String }

struct ActivityDecision: Codable, Hashable, Sendable, Identifiable {
    let approvalId: String
    let title: String
    let status: ApprovalStatus
    let risk: RiskLevel
    let actor: String
    let integration: String
    let resolvedAt: Date
    let myResponse: MyResponse?
    let receiptId: String?
    var id: String { approvalId }
}

struct NamedRef: Codable, Hashable, Sendable { let name: String }
struct ActionSummary: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let title: String
    let actor: NamedRef
    let integration: NamedRef
    let receivedAt: Date
    let finalStatus: String
    let risk: Risk.Brief
}
extension Risk { struct Brief: Codable, Hashable, Sendable { let score: Int; let level: RiskLevel } }

struct ActivityFeed: Decodable, Sendable { let decisions: [ActivityDecision]; let recentActions: [ActionSummary] }

// MARK: - Control

struct FreezeInfo: Codable, Hashable, Sendable { let reason: String; let createdByName: String?; let createdAt: Date; let blockedCount: Int; let channel: String }
struct ActorStats: Codable, Hashable, Sendable { let total: Int; let human: Int; let blocked: Int; let anomalies: Int; let hourly: [Int] }
struct ActorItem: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let type: String
    let name: String
    let description: String
    let ownerTeam: String
    let integrationName: String?
    let trust: String
    var freeze: FreezeInfo?
    let stats: ActorStats?
}
struct ActorList: Decodable, Sendable { let data: [ActorItem]; let canFreeze: Bool; let canUnfreeze: Bool }

// MARK: - Protect

enum ProtectKind: String, Codable, Sendable, CaseIterable { case url, text, qr, screenshot }
enum Verdict: String, Codable, Sendable { case safe, caution, dangerous }
struct ProtectReason: Codable, Hashable, Sendable { let label: String; let detail: String; let weight: String }
struct ModelInfo: Codable, Hashable, Sendable { let name: String; let version: String; let probability: Double }
struct ProtectAnalysis: Codable, Hashable, Sendable, Identifiable {
    let id: String
    let kind: ProtectKind
    let verdict: Verdict
    let score: Int
    let recommendation: String
    let reasons: [ProtectReason]
    let model: [ModelInfo]
    let policyNote: String?
    let inputPreview: String
    let createdAt: Date
}

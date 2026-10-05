import Foundation

/// Everything the app needs from Orbis. UI depends on this protocol, never on URLSession.
protocol ApprovalRepository: Sendable {
    func signIn(email: String, deviceName: String, model: String, os: String) async throws -> SignInResponse
    func me() async throws -> Me
    func inbox() async throws -> [Approval]
    func approval(id: String) async throws -> Approval
    func respond(id: String, body: RespondBody) async throws -> Approval
    func activity() async throws -> ActivityFeed
    func actors() async throws -> ActorList
    func freeze(actorId: String, reason: String) async throws
    func unfreeze(actorId: String, reason: String) async throws
    func analyze(kind: ProtectKind, input: String) async throws -> ProtectAnalysis
}

struct RemoteRepository: ApprovalRepository {
    let api: APIClient

    private func json<E: Encodable>(_ e: E) -> Data? { try? OrbisJSON.encoder.encode(e) }

    func signIn(email: String, deviceName: String, model: String, os: String) async throws -> SignInResponse {
        struct B: Encodable { let email, deviceName, model, os: String }
        return try await api.send(APIRequest(method: "POST", path: "auth/device", body: json(B(email: email, deviceName: deviceName, model: model, os: os))), as: SignInResponse.self)
    }
    func me() async throws -> Me { try await api.send(APIRequest(path: "me"), as: Me.self) }
    func inbox() async throws -> [Approval] { try await api.send(APIRequest(path: "approvals?status=pending&scope=mine"), as: Page<Approval>.self).data }
    func approval(id: String) async throws -> Approval { try await api.send(APIRequest(path: "approvals/\(id)"), as: Approval.self) }
    func respond(id: String, body: RespondBody) async throws -> Approval {
        try await api.send(APIRequest(method: "POST", path: "approvals/\(id)/respond", body: json(body)), as: Approval.self)
    }
    func activity() async throws -> ActivityFeed { try await api.send(APIRequest(path: "me/activity"), as: ActivityFeed.self) }
    func actors() async throws -> ActorList { try await api.send(APIRequest(path: "actors"), as: ActorList.self) }
    func freeze(actorId: String, reason: String) async throws {
        struct B: Encodable { let reason: String }
        struct Ok: Decodable, Sendable {}
        _ = try await api.send(APIRequest(method: "POST", path: "actors/\(actorId)/freeze", body: json(B(reason: reason))), as: Ok.self)
    }
    func unfreeze(actorId: String, reason: String) async throws {
        struct B: Encodable { let reason: String }
        struct Ok: Decodable, Sendable {}
        _ = try await api.send(APIRequest(method: "DELETE", path: "actors/\(actorId)/freeze", body: json(B(reason: reason))), as: Ok.self)
    }
    func analyze(kind: ProtectKind, input: String) async throws -> ProtectAnalysis {
        struct B: Encodable { let kind: ProtectKind; let input: String }
        return try await api.send(APIRequest(method: "POST", path: "protect/analyze", body: json(B(kind: kind, input: input))), as: ProtectAnalysis.self)
    }
}

// MARK: - Environment configuration (MDM-ready)

/// Where the app gets its server and tenant. Managed deployments supply these via
/// ManagedApp / `com.apple.configuration.managed`; otherwise the user's last choice is used.
struct AppConfiguration: Sendable, Equatable {
    var baseURL: URL
    var managed: Bool
    var tenantHint: String?

    static let defaultURL = URL(string: "http://localhost:4310")!

    static func load(defaults: UserDefaults = .standard) -> AppConfiguration {
        if let managed = defaults.dictionary(forKey: "com.apple.configuration.managed"),
           let s = managed["OrbisServerURL"] as? String, let url = URL(string: s), url.scheme == "https" || url.host == "localhost" {
            return AppConfiguration(baseURL: url, managed: true, tenantHint: managed["OrbisTenant"] as? String)
        }
        if let s = defaults.string(forKey: "orbis.serverURL"), let url = URL(string: s) {
            return AppConfiguration(baseURL: url, managed: false, tenantHint: nil)
        }
        return AppConfiguration(baseURL: defaultURL, managed: false, tenantHint: nil)
    }
}

// MARK: - Deep links

enum Route: Equatable, Hashable { case approval(String) }

enum DeepLinkRouter {
    /// Accepts `orbis://approval/<id>` and `https://orbisrelay.dev/a/<id>`. Anything else is ignored;
    /// IDs are strictly validated so a malicious link can't smuggle a payload.
    static func route(for url: URL) -> Route? {
        let comps = url.pathComponents.filter { $0 != "/" }
        let id: String?
        switch url.scheme {
        case "orbis" where url.host == "approval": id = comps.first
        case "https" where url.host == "orbisrelay.dev" && comps.first == "a": id = comps.dropFirst().first
        default: id = nil
        }
        guard let id, id.range(of: #"^apr_[A-Za-z0-9]{6,40}$"#, options: .regularExpression) != nil else { return nil }
        return .approval(id)
    }
}

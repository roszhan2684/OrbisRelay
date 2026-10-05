import Foundation

enum APIError: Error, Equatable, LocalizedError {
    case unauthorized
    case server(status: Int, code: String, message: String, remediation: String?)
    case network(String)
    case decoding(String)

    var errorDescription: String? {
        switch self {
        case .unauthorized: return "Your session ended. Sign in again."
        case .server(_, _, let message, _): return message
        case .network(let m): return "Can't reach Orbis — \(m)"
        case .decoding(let m): return "Unexpected response (\(m))"
        }
    }

    var code: String? { if case .server(_, let c, _, _) = self { return c } else { return nil } }
}

private struct ErrorEnvelope: Decodable {
    struct E: Decodable { let code: String; let message: String; let remediation: String? }
    let error: E
}

struct APIRequest: Sendable {
    var method: String = "GET"
    var path: String
    var body: Data? = nil
    var idempotent: Bool { method == "GET" }
}

protocol APIClient: Sendable {
    func send<T: Decodable & Sendable>(_ request: APIRequest, as: T.Type) async throws -> T
}

enum OrbisJSON {
    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        d.dateDecodingStrategy = .custom { dec in
            let s = try dec.singleValueContainer().decode(String.self)
            if let date = iso.date(from: s) ?? isoNoFraction.date(from: s) { return date }
            throw DecodingError.dataCorrupted(.init(codingPath: dec.codingPath, debugDescription: "Bad date \(s)"))
        }
        return d
    }()
    static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        return e
    }()
    nonisolated(unsafe) static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) static let isoNoFraction = ISO8601DateFormatter()
}

/// URLSession-backed client. Bearer token comes from the Keychain-backed session; GETs retry with backoff.
final class URLSessionAPIClient: APIClient, @unchecked Sendable {
    private let baseURL: URL
    private let session: URLSession
    private let token: @Sendable () -> String?

    init(baseURL: URL, session: URLSession = .shared, token: @escaping @Sendable () -> String?) {
        self.baseURL = baseURL
        self.session = session
        self.token = token
    }

    func send<T: Decodable & Sendable>(_ request: APIRequest, as: T.Type) async throws -> T {
        var attempt = 0
        while true {
            do {
                return try await perform(request)
            } catch let error as APIError {
                if case .network = error, request.idempotent, attempt < 2 {
                    attempt += 1
                    try await Task.sleep(for: .milliseconds(300 * (1 << attempt)))
                    continue
                }
                throw error
            }
        }
    }

    private func perform<T: Decodable>(_ request: APIRequest) async throws -> T {
        var url = baseURL
        url.append(path: "api/v1")
        let parts = request.path.split(separator: "?", maxSplits: 1).map(String.init)
        url.append(path: parts[0])
        var req = URLRequest(url: parts.count > 1 ? URL(string: url.absoluteString + "?" + parts[1])! : url, timeoutInterval: 15)
        req.httpMethod = request.method
        req.httpBody = request.body
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("OrbisRelay-iOS/1.0", forHTTPHeaderField: "User-Agent")
        if let t = token() { req.setValue("Bearer \(t)", forHTTPHeaderField: "Authorization") }

        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: req)
        } catch {
            throw APIError.network(error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else { throw APIError.network("no HTTP response") }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw APIError.unauthorized }
            let e = try? OrbisJSON.decoder.decode(ErrorEnvelope.self, from: data)
            throw APIError.server(status: http.statusCode, code: e?.error.code ?? "http_\(http.statusCode)", message: e?.error.message ?? "Request failed", remediation: e?.error.remediation)
        }
        do {
            return try OrbisJSON.decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decoding(String(describing: error).prefix(160).description)
        }
    }
}

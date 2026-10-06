import CryptoKit
import Foundation
@testable import OrbisEndpointCore

enum Repo {
    static let root: URL = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    static func url(_ rel: String) -> URL { root.appendingPathComponent(rel) }
    static func json(_ rel: String) throws -> Any { try JSONSerialization.jsonObject(with: Data(contentsOf: url(rel))) }
    static let modelVersion = "1.0.0"
    static var modelDir: URL { url("ml/models/risk_classifier/\(modelVersion)") }
}

enum TestSigner {
    static let key = Curve25519.Signing.PrivateKey()
    static let keyId = "test-signing-key"
    static var trusted: [String: Data] { [keyId: key.publicKey.rawRepresentation] }

    static func payload(seq: Int, version: String = Repo.modelVersion, artifact: Data, policyJSON: String, featureSchema: String = EdgeFeatures.schema,
                        expires: Date = Date().addingTimeInterval(86_400), minApp: String = "2.0.0", tenant: String = "ten_northstar", kill: Bool = false) -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let obj: [String: Any] = [
            "manifest_seq": seq, "tenant_id": tenant, "model_name": "orbis-edge-risk", "version": version, "feature_schema": featureSchema, "runtime": "coreml",
            "precision": "fp32", "minimum_app_version": minApp, "artifact_url": "file://artifact", "artifact_sha256": SHA256.hash(data: artifact).hex,
            "policy_sha256": SHA256.hash(data: Data(policyJSON.utf8)).hex, "policy_json": policyJSON, "created_at": f.string(from: Date()),
            "expires_at": f.string(from: expires), "rollback_to": NSNull(), "stage": "production", "kill_switch": kill,
        ]
        return String(data: try! JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]), encoding: .utf8)!
    }

    static func sign(_ payload: String, with k: Curve25519.Signing.PrivateKey = key, keyId: String = keyId) -> SignedManifest {
        SignedManifest(payload: payload, signature: try! k.signature(for: Data(payload.utf8)).base64EncodedString(), key_id: keyId)
    }
}

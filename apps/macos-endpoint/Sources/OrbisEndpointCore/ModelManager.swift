import CoreML
import CryptoKit
import Foundation

/// Signed model distribution manifest (blueprint §13.5, §17). The signature covers the exact UTF-8
/// bytes of `payload`, so no cross-language JSON canonicalisation is needed.
public struct SignedManifest: Codable, Sendable {
    public var payload: String
    public var signature: String
    public var key_id: String
}

public struct ModelManifest: Codable, Sendable, Equatable {
    public var manifest_seq: Int
    public var tenant_id: String
    public var model_name: String
    public var version: String
    public var feature_schema: String
    public var runtime: String
    public var precision: String
    public var minimum_app_version: String
    public var artifact_url: String
    public var artifact_sha256: String
    public var policy_sha256: String
    /// Exact JSON text of the decision policy; covered by the signature and by `policy_sha256`.
    public var policy_json: String
    public var created_at: String
    public var expires_at: String
    public var rollback_to: String?
    public var stage: String
    public var kill_switch: Bool

    public init(manifest_seq: Int, tenant_id: String, model_name: String, version: String, feature_schema: String, runtime: String, precision: String, minimum_app_version: String,
                artifact_url: String, artifact_sha256: String, policy_sha256: String, policy_json: String, created_at: String, expires_at: String, rollback_to: String?, stage: String, kill_switch: Bool) {
        self.manifest_seq = manifest_seq; self.tenant_id = tenant_id; self.model_name = model_name; self.version = version; self.feature_schema = feature_schema
        self.runtime = runtime; self.precision = precision; self.minimum_app_version = minimum_app_version; self.artifact_url = artifact_url; self.artifact_sha256 = artifact_sha256
        self.policy_sha256 = policy_sha256; self.policy_json = policy_json; self.created_at = created_at; self.expires_at = expires_at; self.rollback_to = rollback_to
        self.stage = stage; self.kill_switch = kill_switch
    }
}

public enum ManifestError: Error, Equatable, CustomStringConvertible {
    case malformed(String)
    case badSignature
    case unknownKey(String)
    case incompatibleFeatureSchema(String)
    case unsupportedRuntime(String)
    case appTooOld(required: String)
    case expired(String)
    case replayed(seq: Int, lastAccepted: Int)
    case wrongTenant(String)
    case wrongModel(String)
    case artifactHashMismatch(expected: String, actual: String)
    case policyHashMismatch
    case stagingFailed(String)
    case smokeTestFailed(String)
    case noRollbackTarget

    public var description: String {
        switch self {
        case .malformed(let s): return "malformed manifest: \(s)"
        case .badSignature: return "signature verification failed"
        case .unknownKey(let k): return "unknown signing key \(k)"
        case .incompatibleFeatureSchema(let s): return "feature schema \(s) is not supported by this endpoint"
        case .unsupportedRuntime(let s): return "runtime \(s) is not supported"
        case .appTooOld(let r): return "endpoint app is older than required \(r)"
        case .expired(let s): return "manifest expired at \(s)"
        case .replayed(let s, let l): return "manifest seq \(s) ≤ last accepted \(l) (replay / rollback attack)"
        case .wrongTenant(let t): return "manifest is for tenant \(t)"
        case .wrongModel(let m): return "manifest is for model \(m)"
        case .artifactHashMismatch(let e, let a): return "artifact sha256 \(a.prefix(12))… ≠ manifest \(e.prefix(12))…"
        case .policyHashMismatch: return "decision policy hash mismatch"
        case .stagingFailed(let s): return "staging failed: \(s)"
        case .smokeTestFailed(let s): return "smoke test failed: \(s)"
        case .noRollbackTarget: return "no previous model to roll back to"
        }
    }
}

public struct ActivationResult: Codable, Sendable {
    public var version: String
    public var manifest_seq: Int
    public var activated: Bool
    public var error: String?
    public var compile_ms: Double?
    public var smoke_ms: Double?
    public var previous: String?
}

public struct ManagerState: Codable, Sendable {
    public var active: String?
    public var previous: String?
    public var last_seq: Int = 0
    public var kill_switch: Bool = false
    public var active_manifest: ModelManifest?
    public var history: [String] = []
}

/// Fetches, verifies, stages, smoke-tests, activates and rolls back endpoint models.
/// Activation is atomic: the `current` symlink is replaced with `rename(2)`, so a reader sees either the
/// old or the new model directory, never a half-written one.
public final class ModelManager {
    public let root: URL
    public let tenantId: String
    public let appVersion: String
    let trustedKeys: [String: Curve25519.Signing.PublicKey]
    public private(set) var state: ManagerState
    let fm = FileManager.default
    public var now: () -> Date = Date.init

    public init(root: URL, tenantId: String, appVersion: String = "2.0.0", trustedKeys: [String: Data]) throws {
        self.root = root
        self.tenantId = tenantId
        self.appVersion = appVersion
        self.trustedKeys = try trustedKeys.mapValues { try Curve25519.Signing.PublicKey(rawRepresentation: $0) }
        try fm.createDirectory(at: root.appendingPathComponent("versions"), withIntermediateDirectories: true)
        if let d = try? Data(contentsOf: root.appendingPathComponent("state.json")), let s = try? JSONDecoder().decode(ManagerState.self, from: d) {
            state = s
        } else {
            state = ManagerState()
        }
    }

    // MARK: verification

    public func verify(_ signed: SignedManifest) throws -> ModelManifest {
        guard let key = trustedKeys[signed.key_id] else { throw ManifestError.unknownKey(signed.key_id) }
        guard let sig = Data(base64Encoded: signed.signature), key.isValidSignature(sig, for: Data(signed.payload.utf8)) else { throw ManifestError.badSignature }
        let m: ModelManifest
        do { m = try JSONDecoder().decode(ModelManifest.self, from: Data(signed.payload.utf8)) } catch { throw ManifestError.malformed("\(error)") }
        guard m.tenant_id == tenantId else { throw ManifestError.wrongTenant(m.tenant_id) }
        guard m.model_name == "orbis-edge-risk" else { throw ManifestError.wrongModel(m.model_name) }
        guard m.feature_schema == EdgeFeatures.schema else { throw ManifestError.incompatibleFeatureSchema(m.feature_schema) }
        guard m.runtime == "coreml" else { throw ManifestError.unsupportedRuntime(m.runtime) }
        guard !Self.semver(appVersion).lexicographicallyPrecedes(Self.semver(m.minimum_app_version)) else { throw ManifestError.appTooOld(required: m.minimum_app_version) }
        guard let exp = Self.date(m.expires_at), exp > now() else { throw ManifestError.expired(m.expires_at) }
        let policyHash = SHA256.hash(data: Data(m.policy_json.utf8)).hex
        guard policyHash == m.policy_sha256 else { throw ManifestError.policyHashMismatch }
        // Monotonic sequence: rejects replayed manifests and downgrade (rollback) attacks. A legitimate
        // rollback is a *new* manifest with a higher seq that points at an older version.
        if m.manifest_seq <= state.last_seq && !(m.manifest_seq == state.last_seq && m.version == state.active) {
            throw ManifestError.replayed(seq: m.manifest_seq, lastAccepted: state.last_seq)
        }
        return m
    }

    static func semver(_ s: String) -> [Int] {
        let parts = s.split(separator: ".").map { Int($0) ?? 0 }
        return (parts + [0, 0, 0]).prefix(3).map { $0 }
    }

    static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    static let isoPlain = ISO8601DateFormatter()

    static func date(_ s: String) -> Date? { isoFractional.date(from: s) ?? isoPlain.date(from: s) }

    // MARK: activation

    /// Verify, stage, compile, smoke-test and atomically activate. Nothing changes on any failure.
    @discardableResult
    public func install(_ signed: SignedManifest, artifact: Data, smoke: [(features: [Double], logits: [Double])] = []) -> ActivationResult {
        var result = ActivationResult(version: "?", manifest_seq: 0, activated: false, previous: state.active)
        do {
            let m = try verify(signed)
            result.version = m.version
            result.manifest_seq = m.manifest_seq
            if m.kill_switch {
                state.kill_switch = true
                state.last_seq = m.manifest_seq
                try saveState()
                result.error = "kill switch engaged by manifest — model inference disabled"
                return result
            }
            let actual = SHA256.hash(data: artifact).hex
            guard actual == m.artifact_sha256 else { throw ManifestError.artifactHashMismatch(expected: m.artifact_sha256, actual: actual) }
            if state.active == m.version, fm.fileExists(atPath: currentURL.appendingPathComponent("model.mlmodelc").path) {
                state.last_seq = m.manifest_seq
                state.kill_switch = false
                state.active_manifest = m
                try saveState()
                result.activated = true
                return result
            }
            let staging = root.appendingPathComponent("staging-\(UUID().uuidString)")
            try fm.createDirectory(at: staging, withIntermediateDirectories: true)
            defer { try? fm.removeItem(at: staging) }
            let archive = staging.appendingPathComponent("artifact.zip")
            try artifact.write(to: archive)
            try unzip(archive, to: staging.appendingPathComponent("unzipped"))
            guard let pkg = try fm.contentsOfDirectory(at: staging.appendingPathComponent("unzipped"), includingPropertiesForKeys: nil).first(where: { $0.pathExtension == "mlpackage" || $0.pathExtension == "mlmodel" }) else {
                throw ManifestError.stagingFailed("archive contains no .mlpackage")
            }
            let t0 = DispatchTime.now()
            let compiled = try CoreMLRiskModel.compile(pkg)
            result.compile_ms = Double(DispatchTime.now().uptimeNanoseconds - t0.uptimeNanoseconds) / 1e6
            let modelDir = staging.appendingPathComponent("model.mlmodelc")
            try fm.moveItem(at: compiled, to: modelDir)
            try Data(m.policy_json.utf8).write(to: staging.appendingPathComponent("policy.json"))
            try JSONEncoder().encode(signed).write(to: staging.appendingPathComponent("manifest.json"))
            // Smoke test in staging before anything is visible to the daemon.
            let t1 = DispatchTime.now()
            let model = try CoreMLRiskModel(compiledURL: modelDir)
            let probe = smoke.isEmpty ? [(features: [Double](repeating: 0, count: EdgeFeatures.count), logits: [Double]())] : smoke
            for (x, expected) in probe {
                let z = try model.logits(x)
                guard z.count == 4, z.allSatisfy({ $0.isFinite }) else { throw ManifestError.smokeTestFailed("non-finite or wrong-shaped logits") }
                if !expected.isEmpty {
                    let tol = m.precision == "fp32" ? 1e-3 : 0.5
                    let delta = zip(z, expected).map { abs($0 - $1) }.max() ?? 0
                    guard delta <= tol else { throw ManifestError.smokeTestFailed("logit delta \(delta) > \(tol) on parity probe") }
                }
            }
            result.smoke_ms = Double(DispatchTime.now().uptimeNanoseconds - t1.uptimeNanoseconds) / 1e6
            let dest = root.appendingPathComponent("versions/\(m.version)-\(m.artifact_sha256.prefix(8))")
            if fm.fileExists(atPath: dest.path) { try fm.removeItem(at: dest) }
            try fm.moveItem(at: staging, to: dest)
            try swapCurrent(to: dest)
            state.previous = state.active == m.version ? state.previous : state.active
            state.active = m.version
            state.active_manifest = m
            state.last_seq = m.manifest_seq
            state.kill_switch = false
            state.history.append("\(m.manifest_seq):\(m.version)")
            try saveState()
            result.activated = true
        } catch {
            result.error = (error as? ManifestError)?.description ?? "\(error)"
        }
        return result
    }

    var currentURL: URL { root.appendingPathComponent("current") }

    func swapCurrent(to dir: URL) throws {
        let tmp = root.appendingPathComponent("current.tmp-\(UUID().uuidString)")
        try fm.createSymbolicLink(at: tmp, withDestinationURL: dir)
        guard rename(tmp.path, currentURL.path) == 0 else {
            try? fm.removeItem(at: tmp)
            throw ManifestError.stagingFailed("atomic rename failed: errno \(errno)")
        }
    }

    func unzip(_ zip: URL, to dest: URL) throws {
        try fm.createDirectory(at: dest, withIntermediateDirectories: true)
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ditto")
        p.arguments = ["-x", "-k", zip.path, dest.path]
        try p.run()
        p.waitUntilExit()
        guard p.terminationStatus == 0 else { throw ManifestError.stagingFailed("ditto exited \(p.terminationStatus)") }
    }

    /// Local rollback to the retained previous version (no network needed — used by automatic triggers).
    @discardableResult
    public func rollback(reason: String) throws -> String {
        guard let prev = state.previous,
              let dir = try fm.contentsOfDirectory(at: root.appendingPathComponent("versions"), includingPropertiesForKeys: nil).first(where: { $0.lastPathComponent.hasPrefix("\(prev)-") })
        else { throw ManifestError.noRollbackTarget }
        try swapCurrent(to: dir)
        let manifestData = try Data(contentsOf: dir.appendingPathComponent("manifest.json"))
        let signed = try JSONDecoder().decode(SignedManifest.self, from: manifestData)
        state.active_manifest = try JSONDecoder().decode(ModelManifest.self, from: Data(signed.payload.utf8))
        state.previous = state.active
        state.active = prev
        state.history.append("rollback:\(prev):\(reason)")
        try saveState()
        return prev
    }

    public func setKillSwitch(_ on: Bool) throws {
        state.kill_switch = on
        try saveState()
    }

    /// Load the active model + policy. Returns nil (→ deterministic fallback) if missing or corrupt.
    public func loadActive(computeUnits: MLComputeUnits = .cpuOnly) -> (RiskModel, DecisionPolicy, ModelManifest)? {
        guard !state.kill_switch, let m = state.active_manifest else { return nil }
        do {
            let model = try CoreMLRiskModel(compiledURL: currentURL.appendingPathComponent("model.mlmodelc"), computeUnits: computeUnits)
            let policy = try DecisionPolicy.load(Data(contentsOf: currentURL.appendingPathComponent("policy.json")))
            return (model, policy, m)
        } catch {
            return nil
        }
    }

    func saveState() throws {
        let tmp = root.appendingPathComponent("state.json.tmp")
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        try enc.encode(state).write(to: tmp)
        guard rename(tmp.path, root.appendingPathComponent("state.json").path) == 0 else { throw ManifestError.stagingFailed("state rename failed") }
    }
}

extension Digest {
    var hex: String { map { String(format: "%02x", $0) }.joined() }
}

import Foundation
import LocalAuthentication
import Security

// MARK: - SecureStore (Keychain)

protocol SecureStore: Sendable {
    func set(_ value: String, for key: String) throws
    func get(_ key: String) -> String?
    func remove(_ key: String)
}

/// Keychain storage; items are this-device-only and unavailable while locked.
struct KeychainStore: SecureStore {
    let service = "dev.orbisrelay.ios"

    func set(_ value: String, for key: String) throws {
        remove(key)
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: Data(value.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        ]
        let status = SecItemAdd(q as CFDictionary, nil)
        guard status == errSecSuccess else { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
    }

    func get(_ key: String) -> String? {
        let q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
        return String(data: d, encoding: .utf8)
    }

    func remove(_ key: String) {
        let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
        SecItemDelete(q as CFDictionary)
    }
}

final class MemoryStore: SecureStore, @unchecked Sendable {
    private var values: [String: String] = [:]
    private let lock = NSLock()
    func set(_ value: String, for key: String) throws { lock.withLock { values[key] = value } }
    func get(_ key: String) -> String? { lock.withLock { values[key] } }
    func remove(_ key: String) { lock.withLock { values[key] = nil } }
}

// MARK: - StepUpAuthenticator

enum StepUpError: Error, Equatable, LocalizedError {
    case cancelled, failed, unavailable(String)
    var errorDescription: String? {
        switch self {
        case .cancelled: return "Face ID was cancelled. Nothing was submitted."
        case .failed: return "Face ID didn't match. Nothing was submitted."
        case .unavailable(let m): return m
        }
    }
}

protocol StepUpAuthenticator: Sendable {
    var biometryName: String { get }
    /// Local proof of presence. The server still verifies assignment, state, expiry and device trust.
    func authenticate(reason: String) async throws -> StepUpProof
}

struct LocalAuthStepUp: StepUpAuthenticator {
    var biometryName: String {
        let ctx = LAContext()
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch ctx.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        case .opticID: return "Optic ID"
        default: return "Face ID"
        }
    }

    func authenticate(reason: String) async throws -> StepUpProof {
        let ctx = LAContext()
        ctx.localizedCancelTitle = "Cancel"
        var err: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err) else {
            #if targetEnvironment(simulator)
            // Simulator without enrolled biometrics: allow the demo to continue (Features ▸ Face ID ▸ Enrolled to test the real path).
            try await Task.sleep(for: .milliseconds(600))
            return StepUpProof(method: "biometric", verified: true)
            #else
            throw StepUpError.unavailable("Set up Face ID to approve high-risk actions.")
            #endif
        }
        do {
            let ok = try await ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason)
            guard ok else { throw StepUpError.failed }
            return StepUpProof(method: "biometric", verified: true)
        } catch let e as LAError {
            switch e.code {
            case .userCancel, .appCancel, .systemCancel, .userFallback: throw StepUpError.cancelled
            default: throw StepUpError.failed
            }
        }
    }
}

struct MockStepUp: StepUpAuthenticator {
    var result: Result<StepUpProof, StepUpError> = .success(StepUpProof(method: "biometric", verified: true))
    var biometryName: String { "Face ID" }
    func authenticate(reason: String) async throws -> StepUpProof { try result.get() }
}

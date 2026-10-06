import CryptoKit
import XCTest
@testable import OrbisEndpointCore

/// Model distribution security + lifecycle: signed manifests, tamper/replay/expiry/compatibility
/// rejection, corrupt artifacts, atomic N → N+1 → N, kill switch.
final class ModelManagerTests: XCTestCase {
    var root: URL!
    var artifact: Data!
    var policyJSON: String!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("orbis-mm-\(UUID().uuidString)")
        artifact = try Data(contentsOf: Repo.modelDir.appendingPathComponent("dist/OrbisEdgeRisk-fp32.mlpackage.zip"))
        policyJSON = try String(contentsOf: Repo.modelDir.appendingPathComponent("decision_policy.json"), encoding: .utf8)
    }
    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root) }

    func manager(app: String = "2.0.0") throws -> ModelManager { try ModelManager(root: root, tenantId: "ten_northstar", appVersion: app, trustedKeys: TestSigner.trusted) }

    func testValidManifestInstallsAndLoads() throws {
        let mm = try manager()
        let r = mm.install(TestSigner.sign(TestSigner.payload(seq: 1, artifact: artifact, policyJSON: policyJSON)), artifact: artifact)
        XCTAssertTrue(r.activated, r.error ?? "")
        XCTAssertEqual(mm.state.active, "1.0.0")
        let loaded = try XCTUnwrap(mm.loadActive())
        XCTAssertEqual(try loaded.0.logits([Double](repeating: 0, count: EdgeFeatures.count)).count, 4)
    }

    func testTamperedPayloadIsRejected() throws {
        let mm = try manager()
        var signed = TestSigner.sign(TestSigner.payload(seq: 1, artifact: artifact, policyJSON: policyJSON))
        signed.payload = signed.payload.replacingOccurrences(of: "\"stage\":\"production\"", with: "\"stage\":\"productiom\"")
        XCTAssertThrowsError(try mm.verify(signed)) { XCTAssertEqual($0 as? ManifestError, .badSignature) }
    }

    func testUnknownOrWrongKeyIsRejected() throws {
        let mm = try manager()
        let other = Curve25519.Signing.PrivateKey()
        XCTAssertThrowsError(try mm.verify(TestSigner.sign(TestSigner.payload(seq: 1, artifact: artifact, policyJSON: policyJSON), with: other))) { XCTAssertEqual($0 as? ManifestError, .badSignature) }
        XCTAssertThrowsError(try mm.verify(TestSigner.sign(TestSigner.payload(seq: 1, artifact: artifact, policyJSON: policyJSON), with: other, keyId: "rogue"))) { XCTAssertEqual($0 as? ManifestError, .unknownKey("rogue")) }
    }

    func testExpiredIncompatibleAndTooNewAreRejected() throws {
        let mm = try manager()
        let expired = TestSigner.payload(seq: 1, artifact: artifact, policyJSON: policyJSON, expires: Date().addingTimeInterval(-60))
        XCTAssertThrowsError(try mm.verify(TestSigner.sign(expired))) { if case .expired = $0 as? ManifestError {} else { XCTFail("\($0)") } }
        let schema = TestSigner.payload(seq: 1, artifact: artifact, policyJSON: policyJSON, featureSchema: "edge-features/2")
        XCTAssertThrowsError(try mm.verify(TestSigner.sign(schema))) { XCTAssertEqual($0 as? ManifestError, .incompatibleFeatureSchema("edge-features/2")) }
        let newer = TestSigner.payload(seq: 1, artifact: artifact, policyJSON: policyJSON, minApp: "3.1.0")
        XCTAssertThrowsError(try mm.verify(TestSigner.sign(newer))) { XCTAssertEqual($0 as? ManifestError, .appTooOld(required: "3.1.0")) }
        let tenant = TestSigner.payload(seq: 1, artifact: artifact, policyJSON: policyJSON, tenant: "ten_other")
        XCTAssertThrowsError(try mm.verify(TestSigner.sign(tenant))) { XCTAssertEqual($0 as? ManifestError, .wrongTenant("ten_other")) }
    }

    func testCorruptArtifactIsNeverActivated() throws {
        let mm = try manager()
        var bad = artifact!
        bad[bad.count / 2] ^= 0xFF
        let r = mm.install(TestSigner.sign(TestSigner.payload(seq: 1, artifact: artifact, policyJSON: policyJSON)), artifact: bad)
        XCTAssertFalse(r.activated)
        XCTAssertTrue(r.error?.contains("artifact sha256") == true, r.error ?? "")
        XCTAssertNil(mm.state.active)
        XCTAssertNil(mm.loadActive())
    }

    func testReplayAndDowngradeAreRejected() throws {
        let mm = try manager()
        XCTAssertTrue(mm.install(TestSigner.sign(TestSigner.payload(seq: 5, artifact: artifact, policyJSON: policyJSON)), artifact: artifact).activated)
        let old = TestSigner.sign(TestSigner.payload(seq: 4, version: "0.9.0", artifact: artifact, policyJSON: policyJSON))
        XCTAssertThrowsError(try mm.verify(old)) { XCTAssertEqual($0 as? ManifestError, .replayed(seq: 4, lastAccepted: 5)) }
    }

    func testUpgradeThenRollbackIsAtomic() throws {
        let mm = try manager()
        XCTAssertTrue(mm.install(TestSigner.sign(TestSigner.payload(seq: 1, version: "1.0.0", artifact: artifact, policyJSON: policyJSON)), artifact: artifact).activated)
        let r2 = mm.install(TestSigner.sign(TestSigner.payload(seq: 2, version: "1.0.1", artifact: artifact, policyJSON: policyJSON)), artifact: artifact)
        XCTAssertTrue(r2.activated, r2.error ?? "")
        XCTAssertEqual(r2.previous, "1.0.0")
        XCTAssertEqual(mm.state.active, "1.0.1")
        let current = try FileManager.default.destinationOfSymbolicLink(atPath: root.appendingPathComponent("current").path)
        XCTAssertTrue(current.contains("1.0.1-"))
        XCTAssertEqual(try mm.rollback(reason: "latency_regression"), "1.0.0")
        XCTAssertEqual(mm.state.active, "1.0.0")
        XCTAssertNotNil(mm.loadActive())
        // State survives a restart.
        let reopened = try manager()
        XCTAssertEqual(reopened.state.active, "1.0.0")
        XCTAssertEqual(reopened.state.last_seq, 2)
    }

    func testKillSwitchManifestDisablesInference() throws {
        let mm = try manager()
        XCTAssertTrue(mm.install(TestSigner.sign(TestSigner.payload(seq: 1, artifact: artifact, policyJSON: policyJSON)), artifact: artifact).activated)
        let r = mm.install(TestSigner.sign(TestSigner.payload(seq: 2, artifact: artifact, policyJSON: policyJSON, kill: true)), artifact: artifact)
        XCTAssertFalse(r.activated)
        XCTAssertTrue(mm.state.kill_switch)
        XCTAssertNil(mm.loadActive(), "kill switch → deterministic fallback")
    }

    func testSmokeTestRejectsWrongModel() throws {
        let mm = try manager()
        let probe = (features: [Double](repeating: 0, count: EdgeFeatures.count), logits: [100.0, 100.0, 100.0, 100.0])
        let r = mm.install(TestSigner.sign(TestSigner.payload(seq: 1, artifact: artifact, policyJSON: policyJSON)), artifact: artifact, smoke: [probe])
        XCTAssertFalse(r.activated)
        XCTAssertTrue(r.error?.contains("smoke test") == true, r.error ?? "")
    }
}

final class TelemetryBufferTests: XCTestCase {
    func item(_ i: Int, _ p: Int) -> TelemetryBuffer.Item { .init(id: "e\(i)", priority: p, at: "", body: [:]) }

    func testBoundedAndPreservesSecurityEventsFirst() {
        let b = TelemetryBuffer(capacity: 10)
        for i in 0..<10 { b.enqueue(item(i, i % 2)) }
        for i in 10..<15 { b.enqueue(item(i, 1)) }
        XCTAssertEqual(b.items.count, 10)
        XCTAssertEqual(b.items.filter { $0.priority == 1 }.count, 10, "routine items are dropped before security items")
        XCTAssertEqual(b.dropped[0], 5)
        b.enqueue(item(99, 0))
        XCTAssertEqual(b.dropped[0], 6, "routine item dropped when the queue is all security events")
    }

    func testBackoffOnUploadFailure() {
        let b = TelemetryBuffer(capacity: 10)
        b.enqueue(item(1, 1))
        struct Down: Error {}
        let t = Date()
        XCTAssertEqual(b.flush(now: t) { _ in throw Down() }, 0)
        XCTAssertEqual(b.flush(now: t.addingTimeInterval(1)) { _ in }, 0, "still backing off")
        XCTAssertEqual(b.flush(now: t.addingTimeInterval(3)) { _ in }, 1)
        XCTAssertTrue(b.items.isEmpty)
    }

    func testPersistsAcrossRestart() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("tb-\(UUID().uuidString).jsonl")
        defer { try? FileManager.default.removeItem(at: url) }
        let b = TelemetryBuffer(capacity: 10, url: url)
        b.enqueue(item(1, 1))
        b.persist()
        XCTAssertEqual(TelemetryBuffer(capacity: 10, url: url).items.map(\.id), ["e1"])
    }
}

final class DaemonTests: XCTestCase {
    func stream(_ name: String) throws -> [[String: Any]] {
        try String(contentsOf: Repo.url("fixtures/endpoint-events/\(name).jsonl"), encoding: .utf8).split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
    }

    func loaded() throws -> (RiskModel, DecisionPolicy, ModelManifest) {
        let m = try PortableMLP(json: Data(contentsOf: Repo.modelDir.appendingPathComponent("model.json")))
        let p = try DecisionPolicy.load(Data(contentsOf: Repo.modelDir.appendingPathComponent("decision_policy.json")))
        let f = ISO8601DateFormatter()
        let manifest = ModelManifest(manifest_seq: 1, tenant_id: "ten_northstar", model_name: "orbis-edge-risk", version: "1.0.0", feature_schema: EdgeFeatures.schema, runtime: "coreml", precision: "fp32",
                                     minimum_app_version: "2.0.0", artifact_url: "", artifact_sha256: "", policy_sha256: "", policy_json: "", created_at: f.string(from: Date()),
                                     expires_at: f.string(from: Date().addingTimeInterval(3600)), rollback_to: nil, stage: "production", kill_switch: false)
        return (m, p, manifest)
    }

    func testHeroStreamEscalatesLocally() throws {
        let d = EndpointDaemon()
        d.attach(try loaded())
        var last: EdgeSignal?
        for e in try stream("hero") { last = try d.process(e).2 }
        let s = try XCTUnwrap(last)
        XCTAssertEqual(s.source, .local)
        XCTAssertEqual(s.predictedClass, "high_risk")
        XCTAssertGreaterThan(s.risk ?? 0, 0.9)
        XCTAssertTrue(s.reasons.map(\.code).contains("sensitive_to_untrusted"))
    }

    func testSafeRedirectStreamStaysSafe() throws {
        let d = EndpointDaemon()
        d.attach(try loaded())
        var last: EdgeSignal?
        for e in try stream("hero-redirected") { last = try d.process(e).2 }
        XCTAssertEqual(last?.predictedClass, "safe_normal")
    }

    func testMissingModelDegradesToDeterministicFallback() throws {
        let d = EndpointDaemon()
        let s = try d.process(try stream("hero").last!).2
        XCTAssertEqual(s.source, .deterministic_fallback)
        XCTAssertEqual(s.fallbackReason, "model_unavailable")
        XCTAssertNil(s.risk, "fallback never fabricates a score")
        XCTAssertEqual(d.health.fallbacks, 1)
    }

    func testKillSwitchAndStaleModelFallBack() throws {
        let d = EndpointDaemon()
        d.attach(try loaded())
        d.killSwitch = true
        XCTAssertEqual(try d.process(try stream("hero").last!).2.fallbackReason, "kill_switch")
        d.killSwitch = false
        d.now = { Date().addingTimeInterval(7200) }
        XCTAssertEqual(try d.process(try stream("hero").last!).2.fallbackReason, "stale_model")
    }

    func testUnknownEnumsAbstainAndEscalateHighImpact() throws {
        let d = EndpointDaemon()
        d.attach(try loaded())
        var e = try stream("hero").last!
        e["action"] = ["type": "exfil_v2", "tool": "unknown.tool"]
        e["resource"] = ["classification": "top_secret", "count": 4000]
        let s = try d.process(e).2
        XCTAssertTrue(s.ood)
        XCTAssertTrue(s.abstain)
        XCTAssertTrue(["suspicious_review", "high_risk"].contains(s.predictedClass ?? ""), "unknown never defaults to safe")
    }

    func testMalformedEventIsRejectedAndCounted() throws {
        let d = EndpointDaemon()
        var e = try stream("hero").last!
        e["resource"] = ["count": -3]
        XCTAssertThrowsError(try d.process(e))
        XCTAssertEqual(d.health.rejectedEvents, 1)
    }
}

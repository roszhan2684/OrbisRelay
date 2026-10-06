import XCTest
@testable import OrbisRelay

/// The gateway's `ml` block decodes into the approval card model (snake_case → camelCase).
final class ApprovalMLDecodingTests: XCTestCase {
    func testDecodesEdgeRiskEvidence() throws {
        let json = """
        {"source":"local+cloud","model_version":"1.0.0","runtime":"coreml-fp32","class":"high_risk","risk":0.97,"abstain":false,
         "reasons":[{"code":"sensitive_to_untrusted","label":"Sensitive data to an unverified destination"}],
         "explanation":"High risk because sensitive data is going to an unverified destination.","anomaly":null,"anomaly_top":[],
         "baseline":"Not enough history for a behavioural baseline yet","fusion_rule":"model_escalated_to_approval","model_health":"ok"}
        """
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        let ml = try d.decode(ApprovalML.self, from: Data(json.utf8))
        XCTAssertEqual(ml.classLabel, "High risk")
        XCTAssertTrue(ml.escalatedByModel)
        XCTAssertEqual(ml.sourceLabel, "Endpoint (coreml-fp32) + gateway")
        XCTAssertNil(ml.anomaly)
    }

    func testHeroFixtureCarriesModelSignal() {
        XCTAssertEqual(Fixtures.approval().ml?.modelVersion, "1.0.0")
        XCTAssertFalse(Fixtures.refund.ml != nil)
    }
}

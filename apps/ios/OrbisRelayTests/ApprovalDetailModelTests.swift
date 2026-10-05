import XCTest
@testable import OrbisRelay

/// Scriptable repository: each test decides how the "server" answers.
actor StubRepo: ApprovalRepository {
    var approvalResult: Result<Approval, APIError>
    var respondResult: Result<Approval, APIError>
    private(set) var respondCalls = 0
    private(set) var lastBody: RespondBody?

    init(approval: Result<Approval, APIError>, respond: Result<Approval, APIError>) {
        approvalResult = approval
        respondResult = respond
    }

    func signIn(email: String, deviceName: String, model: String, os: String) async throws -> SignInResponse { fatalError() }
    func me() async throws -> Me { fatalError() }
    func inbox() async throws -> [Approval] { [] }
    func approval(id: String) async throws -> Approval { try approvalResult.get() }
    func respond(id: String, body: RespondBody) async throws -> Approval {
        respondCalls += 1
        lastBody = body
        try await Task.sleep(for: .milliseconds(20))
        return try respondResult.get()
    }
    func activity() async throws -> ActivityFeed { fatalError() }
    func actors() async throws -> ActorList { fatalError() }
    func freeze(actorId: String, reason: String) async throws {}
    func unfreeze(actorId: String, reason: String) async throws {}
    func analyze(kind: ProtectKind, input: String) async throws -> ProtectAnalysis { fatalError() }
}

@MainActor
final class ApprovalDetailModelTests: XCTestCase {
    private func resolved(_ a: Approval, _ s: ApprovalStatus) -> Approval {
        var x = a
        x.status = s
        x.receiptId = "rcp_test0001"
        return x
    }

    func testHappyPathRequiresStepUpAndResolves() async {
        let a = Fixtures.approval()
        let repo = StubRepo(approval: .success(a), respond: .success(resolved(a, .approvedModified)))
        let m = ApprovalDetailModel(id: a.id, repo: repo, stepUp: MockStepUp())
        await m.load()
        await m.chooseAlternative(a.safeAlternatives[0])
        XCTAssertEqual(m.state, .resolved(status: .approvedModified, receiptId: "rcp_test0001", message: "Redirected safely"))
        let body = await repo.lastBody
        XCTAssertEqual(body?.stepUp?.verified, true)
        XCTAssertEqual(body?.alternativeId, "redirect_internal_model")
    }

    func testFaceIDCancellationSubmitsNothing() async {
        let a = Fixtures.approval()
        let repo = StubRepo(approval: .success(a), respond: .success(resolved(a, .approved)))
        let m = ApprovalDetailModel(id: a.id, repo: repo, stepUp: MockStepUp(result: .failure(.cancelled)))
        await m.load()
        await m.approve()
        XCTAssertEqual(m.state, .ready)
        XCTAssertNotNil(m.notice)
        let calls = await repo.respondCalls
        XCTAssertEqual(calls, 0)
    }

    func testFaceIDFailureSubmitsNothing() async {
        let a = Fixtures.approval()
        let repo = StubRepo(approval: .success(a), respond: .success(resolved(a, .approved)))
        let m = ApprovalDetailModel(id: a.id, repo: repo, stepUp: MockStepUp(result: .failure(.failed)))
        await m.load()
        await m.approve()
        let calls = await repo.respondCalls
        XCTAssertEqual(calls, 0)
    }

    func testRejectNeverNeedsStepUp() async {
        let a = Fixtures.approval()
        let repo = StubRepo(approval: .success(a), respond: .success(resolved(a, .rejected)))
        let m = ApprovalDetailModel(id: a.id, repo: repo, stepUp: MockStepUp(result: .failure(.unavailable("no biometrics"))))
        await m.load()
        await m.reject()
        if case .resolved(let s, _, _) = m.state { XCTAssertEqual(s, .rejected) } else { XCTFail("expected resolved, got \(m.state)") }
    }

    func testExpiredLocallyBlocksSubmit() async {
        let a = Fixtures.approval(expiresIn: -5)
        let repo = StubRepo(approval: .success(a), respond: .success(resolved(a, .approved)))
        let m = ApprovalDetailModel(id: a.id, repo: repo, stepUp: MockStepUp())
        await m.load()
        XCTAssertEqual(m.state, .expired)
        await m.approve()
        let calls = await repo.respondCalls
        XCTAssertEqual(calls, 0)
    }

    func testServerSaysExpired() async {
        let a = Fixtures.approval()
        let repo = StubRepo(approval: .success(a), respond: .failure(.server(status: 410, code: "expired", message: "Expired", remediation: nil)))
        let m = ApprovalDetailModel(id: a.id, repo: repo, stepUp: MockStepUp())
        await m.load()
        await m.approve()
        XCTAssertEqual(m.state, .expired)
    }

    func testAlreadyResolvedByAnotherApprover() async {
        let a = Fixtures.approval()
        let repo = StubRepo(approval: .success(a), respond: .failure(.server(status: 409, code: "already_resolved", message: "This approval is already approved.", remediation: nil)))
        let m = ApprovalDetailModel(id: a.id, repo: repo, stepUp: MockStepUp())
        await m.load()
        await m.approve()
        XCTAssertEqual(m.state, .alreadyResolved("This approval is already approved."))
    }

    func testOpeningResolvedApprovalShowsResolved() async {
        let a = resolved(Fixtures.approval(), .approved)
        let m = ApprovalDetailModel(id: a.id, repo: StubRepo(approval: .success(a), respond: .success(a)), stepUp: MockStepUp())
        await m.load()
        XCTAssertEqual(m.state, .alreadyResolved("Approved"))
    }

    func testDeepLinkToUnauthorizedApproval() async {
        let repo = StubRepo(approval: .failure(.server(status: 403, code: "not_assigned", message: "Not assigned", remediation: nil)), respond: .failure(.unauthorized))
        let m = ApprovalDetailModel(id: "apr_other000001", repo: repo, stepUp: MockStepUp())
        await m.load()
        XCTAssertEqual(m.state, .notAssigned)
    }

    func testTenantMismatchIsNotFound() async {
        let repo = StubRepo(approval: .failure(.server(status: 404, code: "not_found", message: "Approval not found.", remediation: nil)), respond: .failure(.unauthorized))
        let m = ApprovalDetailModel(id: "apr_tenant00002", repo: repo, stepUp: MockStepUp())
        await m.load()
        XCTAssertEqual(m.state, .notAssigned)
    }

    func testDoubleSubmitIsIgnored() async {
        let a = Fixtures.refund
        let repo = StubRepo(approval: .success(a), respond: .success(resolved(a, .approved)))
        let m = ApprovalDetailModel(id: a.id, repo: repo, stepUp: MockStepUp())
        await m.load()
        async let first: Void = m.approve()
        async let second: Void = m.approve()
        _ = await (first, second)
        let calls = await repo.respondCalls
        XCTAssertEqual(calls, 1)
    }

    func testEditValidationRespectsServerConstraints() async {
        let a = Fixtures.refund
        let repo = StubRepo(approval: .success(a), respond: .success(resolved(a, .approvedModified)))
        let m = ApprovalDetailModel(id: a.id, repo: repo, stepUp: MockStepUp())
        await m.load()
        XCTAssertEqual(m.edits["amount_usd"], 8500)
        m.edits["amount_usd"] = -1
        XCTAssertNotNil(m.validationError())
        await m.approveEdited()
        var calls = await repo.respondCalls
        XCTAssertEqual(calls, 0)
        m.edits["amount_usd"] = 60_000
        XCTAssertNotNil(m.validationError())
        m.edits["amount_usd"] = 8160
        XCTAssertNil(m.validationError())
        await m.approveEdited()
        calls = await repo.respondCalls
        XCTAssertEqual(calls, 1)
        let body = await repo.lastBody
        XCTAssertEqual(body?.modifiedParameters?["amount_usd"], 8160)
    }

    func testNetworkErrorKeepsRequestActionable() async {
        let a = Fixtures.refund
        let repo = StubRepo(approval: .success(a), respond: .failure(.network("offline")))
        let m = ApprovalDetailModel(id: a.id, repo: repo, stepUp: MockStepUp())
        await m.load()
        await m.approve()
        XCTAssertEqual(m.state, .ready)
        XCTAssertNotNil(m.notice)
    }
}

final class DeepLinkTests: XCTestCase {
    func testValidLinks() {
        XCTAssertEqual(DeepLinkRouter.route(for: URL(string: "orbis://approval/apr_RRH1GZzpxjQ3")!), .approval("apr_RRH1GZzpxjQ3"))
        XCTAssertEqual(DeepLinkRouter.route(for: URL(string: "https://orbisrelay.dev/a/apr_RRH1GZzpxjQ3")!), .approval("apr_RRH1GZzpxjQ3"))
    }

    func testMaliciousLinksAreRejected() {
        XCTAssertNil(DeepLinkRouter.route(for: URL(string: "orbis://approval/apr_x%22%3E%3Cscript")!))
        XCTAssertNil(DeepLinkRouter.route(for: URL(string: "orbis://approval/../../etc/passwd")!))
        XCTAssertNil(DeepLinkRouter.route(for: URL(string: "https://evil.example/a/apr_RRH1GZzpxjQ3")!))
        XCTAssertNil(DeepLinkRouter.route(for: URL(string: "orbis://respond/apr_RRH1GZzpxjQ3?decision=approve")!))
    }
}

final class DecodingTests: XCTestCase {
    func testDecodesServerApprovalShape() throws {
        let json = """
        {"id":"apr_abc123def","title":"Refund $8,500","summary":"x","intent":"y","route":"support-manager","status":"pending","step_up":"none","quorum":null,
         "created_at":"2026-10-04T18:00:00.123Z","expires_at":"2026-10-04T19:00:00.000Z","escalation_level":0,
         "editable_fields":[{"key":"amount_usd","label":"Refund amount (USD)","type":"number","min":0,"max":50000}],
         "safe_alternatives":[],"evidence":[{"id":"e1","label":"L","value":"V","source":"S"}],"blast_radius":[],
         "risk":{"score":30,"level":"medium","reasons":[{"code":"c","label":"l","weight":10}]},
         "policy":{"id":"p","name":"n","version":5,"rule_id":"r","rule_name":"rn","reason":"why"},
         "actor":{"id":"support-copilot","type":"agent","name":"Support Copilot"},"integration":{"id":"i","name":"Support"},
         "parameters":{"amount_usd":8500,"customer":"Meridian"},"can_respond":true,"receipt_id":null,"quorum_progress":null,"responses":[]}
        """
        let a = try OrbisJSON.decoder.decode(Approval.self, from: Data(json.utf8))
        XCTAssertEqual(a.parameters["amount_usd"]?.number, 8500)
        XCTAssertEqual(a.risk.level, .medium)
        XCTAssertEqual(a.stepUp, .none)
    }
}

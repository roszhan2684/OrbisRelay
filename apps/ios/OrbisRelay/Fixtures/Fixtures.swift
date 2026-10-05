import Foundation

/// Deterministic fixtures for previews, tests and the offline demo mode.
enum Fixtures {
    static let now = Date()

    static func approval(
        id: String = "apr_hero000001",
        title: String = "Send 4 contracts to external AI",
        status: ApprovalStatus = .pending,
        expiresIn: TimeInterval = 14 * 60,
        stepUp: StepUpRequirement = .biometric,
        editable: [EditableField] = [],
        risk: Risk = Risk(score: 65, level: .high, reasons: [
            RiskReason(code: "sensitive_external", label: "Sensitive data leaving the trust boundary", weight: 30),
            RiskReason(code: "new_destination", label: "New or untrusted destination", weight: 15),
            RiskReason(code: "irreversible", label: "Hard to reverse once executed", weight: 10),
        ]),
        canRespond: Bool = true,
        parameters: [String: JSONValue] = ["destination": .string("quickscribe-ai.app"), "documents": .number(4)]
    ) -> Approval {
        Approval(
            id: id, title: title, summary: "4 confidential vendor contracts", intent: "Summarize four vendor contracts for the Q4 RFP response",
            route: "ai-governance", status: status, stepUp: stepUp, quorum: nil,
            createdAt: now.addingTimeInterval(-60), expiresAt: now.addingTimeInterval(expiresIn), escalationLevel: 0,
            editableFields: editable,
            safeAlternatives: [SafeAlternative(id: "redirect_internal_model", type: "redirect", label: "Redirect to Approved Internal Model", description: "Run the same task on Northstar Private LLM (zero retention).")],
            evidence: [
                Evidence(id: "e1", label: "Documents", value: "MSA + 3 SOWs · pricing & liability terms", source: "Procurement Agent", freshness: "now", confidence: "high"),
                Evidence(id: "e2", label: "Destination", value: "quickscribe-ai.app — not on AI allowlist", source: "Orbis registry", freshness: "today", confidence: "high"),
                Evidence(id: "e3", label: "Agent history", value: "212 tool calls · 0 prior external sends", source: "Orbis baseline", freshness: "live", confidence: "medium"),
            ],
            blastRadius: ["4 confidential contracts leave the trust boundary", "Deal D-82 negotiating position exposed"],
            risk: risk,
            policy: PolicyRef(id: "pol_conf_external", name: "Confidential data egress", version: 17, ruleId: "ext_model_confidential", ruleName: "Confidential data → unapproved AI provider", reason: "Confidential data would leave the approved AI trust boundary."),
            actor: ActorRef(id: "procurement-agent", type: "agent", name: "Procurement Agent"),
            integration: IntegrationRef(id: "int_procurement", name: "Procurement Agent"),
            parameters: parameters, quorumProgress: nil, canRespond: canRespond, receiptId: nil, responses: []
        )
    }

    static let refund = approval(
        id: "apr_refund00001", title: "Refund $8,500", expiresIn: 7 * 3600, stepUp: .none,
        editable: [EditableField(key: "amount_usd", label: "Refund amount (USD)", type: "number", min: 0, max: 50_000)],
        risk: Risk(score: 30, level: .medium, reasons: [RiskReason(code: "elevated_impact", label: "Elevated monetary impact", weight: 10), RiskReason(code: "irreversible", label: "Hard to reverse once executed", weight: 10)]),
        parameters: ["amount_usd": .number(8500)]
    )

    static let inbox: [Approval] = [
        approval(),
        approval(id: "apr_vendor00001", title: "Pay new vendor $84,000", expiresIn: 9 * 3600, risk: Risk(score: 70, level: .high, reasons: [RiskReason(code: "high_impact", label: "High monetary impact ($84,000)", weight: 20), RiskReason(code: "fraud_signal", label: "Bank change + first payment", weight: 15)])),
        approval(id: "apr_deploy00001", title: "Deploy api-gateway v2.41.0 to Production", expiresIn: 110 * 60, risk: Risk(score: 30, level: .medium, reasons: [RiskReason(code: "privileged_env", label: "Privileged environment", weight: 15)])),
        refund,
    ]

    static let user = UserProfile(id: "usr_alex_chen", name: "Alex Chen", email: "alex.chen@northstar.cloud", title: "Head of Platform Trust", roles: ["owner", "admin", "approver", "responder"], groups: ["security"], initials: "AC", color: "#2747E8")

    static let actors: [ActorItem] = [
        ActorItem(id: "growth-agent", type: "agent", name: "Growth Outreach Agent", description: "Autonomous outbound email to marketing leads.", ownerTeam: "Growth", integrationName: "Ops Agent", trust: "watch", freeze: FreezeInfo(reason: "Outbound volume 14× baseline", createdByName: "Avery Kim", createdAt: now.addingTimeInterval(-2 * 86400), blockedCount: 14, channel: "ios"), stats: ActorStats(total: 77, human: 0, blocked: 14, anomalies: 65, hourly: Array(repeating: 0, count: 48))),
        ActorItem(id: "ops-agent", type: "agent", name: "Ops Agent", description: "Triages alerts, rotates configs, runs runbooks.", ownerTeam: "SRE", integrationName: "Ops Agent", trust: "trusted", freeze: nil, stats: ActorStats(total: 45, human: 0, blocked: 1, anomalies: 1, hourly: [0, 1, 0, 2, 1, 0, 3, 1, 0, 2, 4, 1])),
        ActorItem(id: "procurement-agent", type: "agent", name: "Procurement Agent", description: "Summarizes vendor contracts and drafts RFP responses.", ownerTeam: "Finance Ops", integrationName: "Procurement Agent", trust: "trusted", freeze: nil, stats: ActorStats(total: 63, human: 8, blocked: 0, anomalies: 0, hourly: [1, 0, 2, 1, 0, 0, 1, 2, 1, 0, 1, 1])),
    ]
}

/// Offline demo repository: a stateful in-memory version of the gateway behaviour.
actor FixtureRepository: ApprovalRepository {
    private var items = Fixtures.inbox
    private var actorItems = Fixtures.actors

    func signIn(email: String, deviceName: String, model: String, os: String) async throws -> SignInResponse {
        SignInResponse(token: "orbu_offline", user: Fixtures.user, device: DeviceInfo(id: "dev_offline", name: deviceName, model: model, os: os, trust: "registered", lastSeenAt: .now), tenant: TenantInfo(id: "ten_northstar", name: "Northstar Cloud"))
    }
    func me() async throws -> Me {
        Me(user: Fixtures.user, tenant: TenantInfo(id: "ten_northstar", name: "Northstar Cloud (offline)"), device: nil, devices: [], pendingCount: items.filter { $0.status == .pending }.count, permissions: Permissions(canFreeze: true, canUnfreeze: true))
    }
    func inbox() async throws -> [Approval] { items.filter { $0.status == .pending } }
    func approval(id: String) async throws -> Approval {
        guard let a = items.first(where: { $0.id == id }) else { throw APIError.server(status: 404, code: "not_found", message: "Approval not found.", remediation: nil) }
        return a
    }
    func respond(id: String, body: RespondBody) async throws -> Approval {
        guard let i = items.firstIndex(where: { $0.id == id }) else { throw APIError.server(status: 404, code: "not_found", message: "Approval not found.", remediation: nil) }
        guard items[i].status == .pending else { throw APIError.server(status: 409, code: "already_resolved", message: "This approval is already resolved.", remediation: nil) }
        if items[i].isExpired() { throw APIError.server(status: 410, code: "expired", message: "This approval expired.", remediation: nil) }
        if body.decision != .reject, items[i].stepUp == .biometric, body.stepUp?.verified != true {
            throw APIError.server(status: 428, code: "step_up_required", message: "Biometric step-up required.", remediation: nil)
        }
        switch body.decision {
        case .reject: items[i].status = .rejected
        case .approve: items[i].status = .approved
        case .approveModified, .safeAlternative: items[i].status = .approvedModified
        }
        items[i].receiptId = "rcp_offline_\(Int.random(in: 1000...9999))"
        return items[i]
    }
    func activity() async throws -> ActivityFeed {
        ActivityFeed(decisions: items.filter { $0.status != .pending }.map { ActivityDecision(approvalId: $0.id, title: $0.title, status: $0.status, risk: $0.risk.level, actor: $0.actor.name, integration: $0.integration.name, resolvedAt: .now, myResponse: nil, receiptId: $0.receiptId) }, recentActions: [])
    }
    func actors() async throws -> ActorList { ActorList(data: actorItems, canFreeze: true, canUnfreeze: true) }
    func freeze(actorId: String, reason: String) async throws {
        if let i = actorItems.firstIndex(where: { $0.id == actorId }) { actorItems[i].freeze = FreezeInfo(reason: reason, createdByName: "You", createdAt: .now, blockedCount: 0, channel: "ios") }
    }
    func unfreeze(actorId: String, reason: String) async throws {
        if let i = actorItems.firstIndex(where: { $0.id == actorId }) { actorItems[i].freeze = nil }
    }
    func analyze(kind: ProtectKind, input: String) async throws -> ProtectAnalysis {
        let risky = input.lowercased().contains("verify") || input.lowercased().contains("gift") || input.lowercased().contains("login")
        return ProtectAnalysis(id: "pa_offline", kind: kind, verdict: risky ? .dangerous : .safe, score: risky ? 88 : 12, recommendation: risky ? "Don't open it. Report it to security." : "No strong risk signals.", reasons: [ProtectReason(label: risky ? "Credential bait" : "Looks routine", detail: "Offline heuristic — connect to Orbis for the full model.", weight: risky ? "high" : "positive")], model: [], policyNote: nil, inputPreview: String(input.prefix(160)), createdAt: .now)
    }
}

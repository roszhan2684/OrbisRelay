import Foundation
import Observation

/// Explicit approval state — no Boolean soup. All domain rules live here, not in SwiftUI views.
@MainActor
@Observable
final class ApprovalDetailModel {
    enum State: Equatable {
        case loading
        case ready
        case verifying
        case submitting
        case resolved(status: ApprovalStatus, receiptId: String?, message: String)
        case waitingForQuorum
        case expired
        case alreadyResolved(String)
        case notAssigned
        case failed(String)

        var isBusy: Bool { self == .verifying || self == .submitting }
        var isTerminal: Bool {
            switch self {
            case .resolved, .expired, .alreadyResolved, .notAssigned, .waitingForQuorum: return true
            default: return false
            }
        }
    }

    private(set) var approval: Approval?
    private(set) var state: State = .loading
    var notice: String?
    var edits: [String: Double] = [:]

    private let id: String
    private let repo: ApprovalRepository
    private let stepUp: StepUpAuthenticator
    private let clock: () -> Date

    init(id: String, initial: Approval? = nil, repo: ApprovalRepository, stepUp: StepUpAuthenticator, clock: @escaping () -> Date = { .now }) {
        self.id = id
        self.repo = repo
        self.stepUp = stepUp
        self.clock = clock
        if let initial { apply(initial) }
    }

    func load() async {
        do {
            apply(try await repo.approval(id: id))
        } catch let e as APIError {
            handle(e)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private func apply(_ a: Approval) {
        approval = a
        for f in a.editableFields where edits[f.key] == nil { edits[f.key] = a.parameters[f.key]?.number ?? f.max ?? 0 }
        if a.status != .pending { state = .alreadyResolved(a.status.label) }
        else if a.isExpired(at: clock()) { state = .expired }
        else if a.canRespond == false { state = .notAssigned }
        else { state = .ready }
    }

    /// Validates Edit & Approve values against server-declared constraints (re-checked server-side).
    func validationError() -> String? {
        guard let a = approval else { return nil }
        for f in a.editableFields {
            guard let v = edits[f.key], v.isFinite else { return "\(f.label) must be a number." }
            if let min = f.min, v < min { return "\(f.label) must be at least \(Int(min))." }
            let max = f.max ?? a.parameters[f.key]?.number
            if let max, v > max { return "\(f.label) can't exceed \(Int(max))." }
        }
        return nil
    }

    func approve() async { await submit(RespondBody(decision: .approve)) }
    func reject(comment: String? = nil) async { await submit(RespondBody(decision: .reject, comment: comment)) }
    func chooseAlternative(_ alt: SafeAlternative) async { await submit(RespondBody(decision: .safeAlternative, alternativeId: alt.id)) }
    func approveEdited() async {
        if let err = validationError() {
            notice = err
            return
        }
        await submit(RespondBody(decision: .approveModified, modifiedParameters: edits))
    }

    private func submit(_ body: RespondBody) async {
        guard let a = approval, state == .ready else { return } // prevents stale double-submit
        if a.isExpired(at: clock()) {
            state = .expired
            return
        }
        var body = body
        notice = nil
        if body.decision != .reject && a.stepUp == .biometric {
            state = .verifying
            do {
                body.stepUp = try await stepUp.authenticate(reason: "Approve “\(a.title)”")
            } catch let e as StepUpError {
                state = .ready
                notice = e.errorDescription
                return
            } catch {
                state = .ready
                notice = error.localizedDescription
                return
            }
        }
        state = .submitting
        do {
            let updated = try await repo.respond(id: a.id, body: body)
            approval = updated
            if updated.status == .pending {
                state = .waitingForQuorum
            } else {
                let msg: String = switch (body.decision, updated.status) {
                case (.safeAlternative, _): "Redirected safely"
                case (_, .approvedModified): "Approved with edits"
                case (_, .approved): "Approved"
                case (_, .rejected): "Rejected — nothing will execute"
                default: updated.status.label
                }
                state = .resolved(status: updated.status, receiptId: updated.receiptId, message: msg)
            }
        } catch let e as APIError {
            handle(e)
        } catch {
            state = .failed(error.localizedDescription)
        }
    }

    private func handle(_ e: APIError) {
        switch e {
        case .server(410, _, _, _): state = .expired
        case .server(409, "already_responded", _, _): state = .waitingForQuorum
        case .server(409, _, let m, _): state = .alreadyResolved(m)
        case .server(403, _, _, _), .server(404, _, _, _): state = .notAssigned
        case .server(422, _, let m, _): state = .ready; notice = m
        case .server(428, _, let m, _): state = .ready; notice = m
        default: state = approval == nil ? .failed(e.localizedDescription) : .ready; notice = e.localizedDescription
        }
    }
}

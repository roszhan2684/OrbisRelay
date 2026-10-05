import SwiftUI

/// WHAT / WHO / WHY / RISK first; policy, evidence and blast radius progressively disclosed.
struct ApprovalDetailView: View {
    @State var model: ApprovalDetailModel
    @State private var editing = false
    @State private var confirmReject = false
    @State private var showEvidence = true
    @Environment(\.dismiss) private var dismiss
    var onFinished: () -> Void = {}

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { ctx in
            ScrollView {
                if let a = model.approval {
                    VStack(alignment: .leading, spacing: 14) {
                        header(a, now: ctx.date)
                        policyCard(a)
                        if !a.evidence.isEmpty { evidenceCard(a) }
                        if !a.blastRadius.isEmpty { blastCard(a) }
                        if editing { editCard(a) }
                        Color.clear.frame(height: 190)
                    }
                    .padding(.horizontal)
                } else if case .failed(let m) = model.state {
                    ContentUnavailableView("Couldn't load", systemImage: "wifi.exclamationmark", description: Text(m))
                } else {
                    ProgressView().padding(.top, 80)
                }
            }
            .background(Color(.systemGroupedBackground))
            .safeAreaInset(edge: .bottom) { actionBar }
        }
        .navigationTitle("Action paused")
        .navigationBarTitleDisplayMode(.inline)
        .task { await model.load() }
        .confirmationDialog("Reject this action?", isPresented: $confirmReject, titleVisibility: .visible) {
            Button("Reject — nothing executes", role: .destructive) { Task { await model.reject() } }
        }
        .sensoryFeedback(.success, trigger: model.state.isTerminal)
    }

    private func header(_ a: Approval, now: Date) -> some View {
        Card {
            HStack(spacing: 8) {
                Image(systemName: a.actor.type == "agent" ? "cpu" : a.actor.type == "human" ? "person.fill" : "gearshape.2.fill")
                    .foregroundStyle(Theme.cobalt)
                Text("\(a.actor.name) · \(a.actor.type.capitalized) via \(a.integration.name)")
                    .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
            Text(a.title)
                .font(.title2.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let intent = a.intent { Text("“\(intent)”").font(.callout).foregroundStyle(.secondary) }
            HStack(spacing: 8) {
                RiskBadge(level: a.risk.level, score: a.risk.score)
                if a.stepUp == .biometric { Label("Face ID", systemImage: "faceid").font(.caption.weight(.medium)).padding(.horizontal, 8).padding(.vertical, 4).background(Color(.tertiarySystemFill), in: Capsule()) }
                Spacer()
                Label(a.expiresAt.countdown(from: now), systemImage: "timer")
                    .font(.caption.monospacedDigit().weight(.medium))
                    .foregroundStyle(a.expiresAt.timeIntervalSince(now) < 900 ? Theme.critical : .secondary)
            }
            if let q = a.quorum {
                Label("\(a.quorumProgress?.approvals ?? 0) of \(q.required) approvals", systemImage: "person.2.fill").font(.caption).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 6) {
                ForEach(a.risk.reasons.filter { $0.weight > 0 }.prefix(3), id: \.code) { r in
                    Label(r.label, systemImage: "circle.fill").labelStyle(BulletLabel())
                }
            }
        }
    }

    private func policyCard(_ a: Approval) -> some View {
        Card {
            SectionTitle(text: "Why Orbis paused this", icon: "shield.lefthalf.filled")
            Text(a.policy.reason).font(.body)
            Text("\(a.policy.name) · v\(a.policy.version) · \(a.policy.ruleId)").font(.caption.monospaced()).foregroundStyle(.secondary)
            Text("Routed to \(a.route.routeLabel)").font(.caption).foregroundStyle(.secondary)
        }
    }

    private func evidenceCard(_ a: Approval) -> some View {
        Card {
            Button { withAnimation(.snappy) { showEvidence.toggle() } } label: {
                HStack { SectionTitle(text: "Evidence · \(a.evidence.count)", icon: "doc.text.magnifyingglass"); Spacer(); Image(systemName: "chevron.right").rotationEffect(.degrees(showEvidence ? 90 : 0)).foregroundStyle(.secondary) }
            }
            .buttonStyle(.plain)
            .accessibilityHint(showEvidence ? "Collapse evidence" : "Expand evidence")
            if showEvidence {
                ForEach(a.evidence) { e in
                    VStack(alignment: .leading, spacing: 2) {
                        HStack { Text(e.label).font(.subheadline.weight(.semibold)); Spacer(); Text(e.source).font(.caption2).foregroundStyle(.secondary) }
                        Text(e.value).font(.subheadline).foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
    }

    private func blastCard(_ a: Approval) -> some View {
        Card {
            SectionTitle(text: "If approved", icon: "scope")
            ForEach(a.blastRadius, id: \.self) { b in
                Label(b, systemImage: "arrow.right").font(.subheadline).foregroundStyle(.primary)
            }
        }
    }

    private func editCard(_ a: Approval) -> some View {
        Card {
            SectionTitle(text: "Edit & approve", icon: "pencil")
            ForEach(a.editableFields) { f in
                VStack(alignment: .leading, spacing: 4) {
                    Text(f.label).font(.subheadline)
                    TextField(f.label, value: Binding(get: { model.edits[f.key] ?? 0 }, set: { model.edits[f.key] = $0 }), format: .number)
                        .keyboardType(.decimalPad)
                        .font(.title3.monospacedDigit().weight(.semibold))
                        .padding(10)
                        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
                    if let max = f.max ?? a.parameters[f.key]?.number { Text("Maximum \(Int(max).formatted())").font(.caption).foregroundStyle(.secondary) }
                }
            }
            if let err = model.validationError() { Text(err).font(.caption).foregroundStyle(Theme.critical) }
        }
    }

    @ViewBuilder private var actionBar: some View {
        VStack(spacing: 10) {
            if let n = model.notice { Text(n).font(.footnote).foregroundStyle(Theme.critical).multilineTextAlignment(.center) }
            switch model.state {
            case .resolved(_, let receipt, let message):
                outcome(icon: "checkmark.seal.fill", color: Theme.low, title: message, detail: receipt.map { "Receipt \($0) · Ed25519 signed" })
                Button("Done") { onFinished(); dismiss() }.buttonStyle(.bordered)
            case .waitingForQuorum:
                outcome(icon: "person.2.badge.gearshape.fill", color: Theme.cobalt, title: "Signed — waiting for quorum", detail: "The action stays paused until enough approvers sign.")
            case .expired:
                outcome(icon: "clock.badge.xmark", color: .secondary, title: "This request expired", detail: "Nothing was executed. The caller was notified.")
            case .alreadyResolved(let m):
                outcome(icon: "checkmark.circle", color: .secondary, title: m, detail: "Another approver already decided.")
            case .notAssigned:
                outcome(icon: "lock.fill", color: .secondary, title: "Not assigned to you", detail: "This approval belongs to another team or tenant.")
            case .verifying, .submitting:
                ProgressView(model.state == .verifying ? "Verifying with Face ID…" : "Submitting…").padding(.vertical, 14)
            default:
                if let a = model.approval { buttons(a) }
            }
        }
        .padding(.horizontal).padding(.top, 12).padding(.bottom, 8)
        .background(.bar)
    }

    @ViewBuilder private func buttons(_ a: Approval) -> some View {
        if editing {
            HStack {
                Button("Cancel") { editing = false }.buttonStyle(BigButton(kind: .secondary))
                Button("Approve edited") { Task { await model.approveEdited() } }.buttonStyle(BigButton(kind: .primary))
                    .disabled(model.validationError() != nil)
            }
        } else {
            if let alt = a.safeAlternatives.first {
                Button { Task { await model.chooseAlternative(alt) } } label: {
                    Label(alt.label, systemImage: "sparkles").lineLimit(1).minimumScaleFactor(0.8)
                }
                .buttonStyle(BigButton(kind: .safe))
                .accessibilityHint(alt.description)
            }
            HStack {
                Button { confirmReject = true } label: { Label("Reject", systemImage: "xmark") }.buttonStyle(BigButton(kind: .secondary))
                if !a.editableFields.isEmpty { Button { editing = true } label: { Label("Edit", systemImage: "pencil") }.buttonStyle(BigButton(kind: .secondary)) }
                Button { Task { await model.approve() } } label: { Text("Approve") }.buttonStyle(BigButton(kind: a.safeAlternatives.isEmpty ? .primary : .secondary))
            }
        }
    }

    private func outcome(icon: String, color: Color, title: String, detail: String?) -> some View {
        VStack(spacing: 4) {
            Image(systemName: icon).font(.system(size: 30)).foregroundStyle(color)
            Text(title).font(.headline)
            if let detail { Text(detail).font(.caption.monospaced()).foregroundStyle(.secondary).multilineTextAlignment(.center) }
        }
        .frame(maxWidth: .infinity).padding(.vertical, 8)
        .accessibilityElement(children: .combine)
    }
}

struct BigButton: ButtonStyle {
    enum Kind { case primary, secondary, safe }
    let kind: Kind
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.headline)
            .frame(maxWidth: .infinity, minHeight: 50)
            .foregroundStyle(kind == .secondary ? Color.primary : .white)
            .background(kind == .primary ? Theme.cobalt : kind == .safe ? Theme.low : Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(kind == .secondary ? Color(.separator) : .clear))
            .opacity(configuration.isPressed ? 0.85 : 1)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
    }
}

struct BulletLabel: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            configuration.icon.font(.system(size: 6)).foregroundStyle(Theme.high)
            configuration.title.font(.subheadline)
        }
    }
}

#Preview {
    NavigationStack { ApprovalDetailView(model: ApprovalDetailModel(id: "apr_hero000001", initial: Fixtures.approval(), repo: FixtureRepository(), stepUp: MockStepUp())) }
}

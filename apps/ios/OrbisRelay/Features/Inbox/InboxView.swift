import SwiftUI

@MainActor
@Observable
final class InboxModel {
    var items: [Approval] = []
    var loading = true
    var error: String?
    var offline = false

    func refresh(_ app: AppState) async {
        do {
            let list = try await app.repo.inbox()
            items = list.sorted { ($0.risk.score, $1.expiresAt) > ($1.risk.score, $0.expiresAt) }
            app.pendingCount = items.count
            error = nil
            offline = false
            NotificationService.shared.announceNew(items)
        } catch APIError.unauthorized {
            app.signOut()
        } catch {
            // Offline: keep showing cached items read-only; never resolve high-risk actions offline.
            offline = true
            self.error = error.localizedDescription
        }
        loading = false
    }
}

struct InboxView: View {
    @Environment(AppState.self) private var app
    @State private var model = InboxModel()
    @State private var path: [Route] = []

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if model.offline {
                    Label("Offline — showing cached requests. Decisions resume when you reconnect.", systemImage: "wifi.slash")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                if !model.loading && model.items.isEmpty {
                    ContentUnavailableView("All clear", systemImage: "tray", description: Text("Safe work keeps running on its own. Paused actions that need you will appear here."))
                        .listRowBackground(Color.clear)
                }
                Section {
                    ForEach(model.items) { a in
                        NavigationLink(value: Route.approval(a.id)) { InboxRow(a: a) }
                    }
                } header: {
                    Text(model.items.isEmpty ? app.tenantName : "\(app.tenantName) · \(model.items.count) paused · highest risk first")
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle("Inbox")
            .overlay { if model.loading { ProgressView() } }
            .refreshable { await model.refresh(app) }
            .navigationDestination(for: Route.self) { route in
                switch route {
                case .approval(let id):
                    ApprovalDetailView(model: ApprovalDetailModel(id: id, initial: model.items.first { $0.id == id }, repo: app.repo, stepUp: app.stepUp)) {
                        Task { await model.refresh(app) }
                    }
                }
            }
            .task {
                // Poll while visible (APNs replaces this in production builds).
                while !Task.isCancelled {
                    await model.refresh(app)
                    try? await Task.sleep(for: .seconds(4))
                }
            }
            .onChange(of: app.pendingRoute, initial: true) { _, route in
                if let route { path = [route]; app.pendingRoute = nil }
            }
        }
    }
}

struct InboxRow: View {
    let a: Approval
    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: a.actor.type == "agent" ? "cpu" : a.actor.type == "human" ? "person.fill" : "gearshape.2.fill")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.cobalt)
                    .frame(width: 36, height: 36)
                    .background(Theme.cobalt.opacity(0.1), in: RoundedRectangle(cornerRadius: 10))
                VStack(alignment: .leading, spacing: 4) {
                    Text(a.title).font(.headline).lineLimit(2)
                    Text("\(a.actor.name) · \(a.integration.name)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                    HStack(spacing: 8) {
                        RiskBadge(level: a.risk.level)
                        Text(a.expiresAt.countdown(from: ctx.date)).font(.caption.monospacedDigit()).foregroundStyle(a.expiresAt.timeIntervalSince(ctx.date) < 900 ? Theme.critical : .secondary)
                        if a.escalationLevel > 0 { Text("Escalated").font(.caption.weight(.semibold)).foregroundStyle(Theme.high) }
                    }
                }
            }
            .padding(.vertical, 4)
            .accessibilityElement(children: .combine)
        }
    }
}

// MARK: - Activity

struct ActivityView: View {
    @Environment(AppState.self) private var app
    @State private var feed: ActivityFeed?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if let feed {
                    Section("Your decisions") {
                        if feed.decisions.isEmpty { Text("No decisions yet.").foregroundStyle(.secondary) }
                        ForEach(feed.decisions.prefix(30)) { d in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack { Text(d.title).font(.subheadline.weight(.semibold)).lineLimit(1); Spacer(); StatusPill(status: d.status) }
                                Text("\(d.actor) · \(d.resolvedAt.formatted(.relative(presentation: .named)))\(d.myResponse != nil ? " · you decided" : "")").font(.caption).foregroundStyle(.secondary)
                                if let r = d.receiptId { Text("Receipt \(r)").font(.caption2.monospaced()).foregroundStyle(.tertiary) }
                            }
                        }
                    }
                    if !feed.recentActions.isEmpty {
                        Section("Protected actions") {
                            ForEach(feed.recentActions.prefix(25)) { a in
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(a.title).font(.subheadline).lineLimit(1)
                                        Text("\(a.actor.name) · \(a.receivedAt.formatted(.relative(presentation: .named)))").font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Text(a.finalStatus.replacingOccurrences(of: "_", with: " ").capitalized).font(.caption.weight(.semibold)).foregroundStyle(a.finalStatus == "deny" || a.finalStatus == "rejected" ? Theme.critical : a.finalStatus == "pending" ? Theme.cobalt : Theme.low)
                                }
                            }
                        }
                    }
                } else if let error {
                    ContentUnavailableView("Can't load activity", systemImage: "wifi.slash", description: Text(error))
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Activity")
            .refreshable { await load() }
            .task { await load() }
        }
    }

    private func load() async {
        do { feed = try await app.repo.activity(); error = nil } catch { self.error = error.localizedDescription }
    }
}

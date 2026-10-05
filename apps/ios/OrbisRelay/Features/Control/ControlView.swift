import Charts
import SwiftUI

/// Emergency controls. Buttons render only for roles the backend authorizes; the server re-checks anyway.
struct ControlView: View {
    @Environment(AppState.self) private var app
    @State private var list: ActorList?
    @State private var target: ActorItem?
    @State private var reason = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            List {
                if let list {
                    let frozen = list.data.filter { $0.freeze != nil }
                    if !frozen.isEmpty {
                        Section {
                            ForEach(frozen) { a in row(a, list: list) }
                        } header: { Label("Frozen", systemImage: "snowflake") }
                    }
                    Section {
                        ForEach(list.data.filter { $0.freeze == nil && $0.id != "sandbox-agent" }) { a in row(a, list: list) }
                    } header: { Text("Agents & automations") } footer: {
                        Text("Freezing denies every new gateway request from that actor immediately and cancels its pending approvals. Restoring requires an admin and a reason.")
                    }
                } else if let error {
                    ContentUnavailableView("Can't load actors", systemImage: "wifi.slash", description: Text(error))
                } else {
                    ProgressView()
                }
            }
            .navigationTitle("Control")
            .refreshable { await load() }
            .task { await load() }
            .sheet(item: $target) { a in sheet(a) }
        }
    }

    private func row(_ a: ActorItem, list: ActorList) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(a.name).font(.headline)
                    if a.trust == "watch" { Text("On watch").font(.caption2.weight(.semibold)).foregroundStyle(Theme.high) }
                }
                Text(a.freeze.map { "Frozen by \($0.createdByName ?? "admin") · \($0.blockedCount) blocked" } ?? "\(a.ownerTeam) · \(a.stats?.total ?? 0) actions this week")
                    .font(.caption).foregroundStyle(a.freeze == nil ? .secondary : Theme.critical)
            }
            Spacer()
            if let hourly = a.stats?.hourly, hourly.contains(where: { $0 > 0 }) {
                Chart(Array(hourly.suffix(24).enumerated()), id: \.offset) { p in
                    LineMark(x: .value("h", p.offset), y: .value("n", p.element)).interpolationMethod(.monotone)
                }
                .chartXAxis(.hidden).chartYAxis(.hidden)
                .foregroundStyle(a.freeze == nil ? Theme.cobalt : Theme.critical)
                .frame(width: 64, height: 26)
                .accessibilityLabel("24-hour activity trend")
            }
            if a.freeze != nil ? list.canUnfreeze : list.canFreeze {
                Button(a.freeze == nil ? "Freeze" : "Restore") { reason = ""; target = a }
                    .buttonStyle(.bordered)
                    .tint(a.freeze == nil ? Theme.critical : Theme.low)
            }
        }
    }

    private func sheet(_ a: ActorItem) -> some View {
        NavigationStack {
            Form {
                Section {
                    Label(a.freeze == nil ? "Every new request from \(a.name) will be denied until an admin restores it." : "\(a.name) will be evaluated by policy again.", systemImage: a.freeze == nil ? "snowflake" : "sun.max")
                }
                Section(a.freeze == nil ? "Why are you freezing it?" : "What was fixed?") {
                    TextField("Reason (required, audited)", text: $reason, axis: .vertical).lineLimit(2...4)
                }
                if let error { Text(error).foregroundStyle(Theme.critical) }
            }
            .navigationTitle(a.freeze == nil ? "Freeze \(a.name)" : "Restore \(a.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { target = nil } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(a.freeze == nil ? "Freeze" : "Restore", role: a.freeze == nil ? .destructive : nil) {
                        Task { await apply(a) }
                    }
                    .disabled(busy || reason.trimmingCharacters(in: .whitespaces).count < 4)
                }
            }
        }
        .presentationDetents([.medium])
    }

    private func apply(_ a: ActorItem) async {
        busy = true
        defer { busy = false }
        do {
            if a.freeze == nil { try await app.repo.freeze(actorId: a.id, reason: reason) } else { try await app.repo.unfreeze(actorId: a.id, reason: reason) }
            target = nil
            await load()
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func load() async {
        do { list = try await app.repo.actors(); error = nil } catch { self.error = error.localizedDescription }
    }
}

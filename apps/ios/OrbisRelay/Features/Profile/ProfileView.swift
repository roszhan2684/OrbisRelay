import SwiftUI
import UserNotifications

struct ProfileView: View {
    @Environment(AppState.self) private var app
    @State private var me: Me?
    @State private var notifications = "Unknown"

    var body: some View {
        NavigationStack {
            List {
                if let u = app.user {
                    Section {
                        HStack(spacing: 14) {
                            Text(u.initials).font(.headline).foregroundStyle(.white).frame(width: 48, height: 48).background(Theme.cobalt, in: Circle())
                            VStack(alignment: .leading) {
                                Text(u.name).font(.headline)
                                Text(u.title).font(.subheadline).foregroundStyle(.secondary)
                                Text(u.email).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                        LabeledContent("Organization", value: app.tenantName)
                        LabeledContent("Roles", value: u.roles.map { $0.replacingOccurrences(of: "_", with: " ") }.joined(separator: ", "))
                    }
                }
                Section("Security") {
                    LabeledContent("Sign-in", value: "Okta SSO (OIDC)")
                    LabeledContent("Step-up", value: app.stepUp.biometryName)
                    LabeledContent("Session storage", value: "Keychain · this device only")
                    if let d = me?.device { LabeledContent("This device", value: "\(d.name) · \(d.trust)") }
                    LabeledContent("Notifications", value: notifications)
                }
                if let devices = me?.devices, !devices.isEmpty {
                    Section("Registered devices") {
                        ForEach(devices) { d in
                            LabeledContent(d.name, value: d.trust == "revoked" ? "Revoked" : d.lastSeenAt.formatted(.relative(presentation: .named)))
                        }
                    }
                }
                Section("Deployment") {
                    LabeledContent("Server", value: app.config.baseURL.absoluteString)
                    LabeledContent("Configuration", value: app.config.managed ? "Managed by your organization (MDM)" : "User configured")
                    if app.phase == .offlineDemo { Label("Offline demo mode — fixture data", systemImage: "airplane") }
                }
                Section {
                    Button("Sign out", role: .destructive) { app.signOut() }
                } footer: {
                    Text("Orbis never receives biometric data. Face ID is evaluated by iOS; Orbis only learns that verification succeeded on this registered device.")
                }
            }
            .navigationTitle("Profile")
            .task {
                me = try? await app.repo.me()
                let s = await UNUserNotificationCenter.current().notificationSettings()
                notifications = s.authorizationStatus == .authorized ? "On · title + risk only" : "Off"
            }
        }
    }
}

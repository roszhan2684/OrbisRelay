import SwiftUI

@main
struct OrbisRelayApp: App {
    @State private var app = AppState()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                .tint(Theme.cobalt)
                .overlay { if scenePhase != .active && app.phase != .signedOut { PrivacyShield() } }
                .onOpenURL { app.open($0) }
                .task {
                    NotificationService.shared.onOpen = { url in app.open(url) }
                    #if DEBUG
                    // Demo/screenshot automation: -OrbisAutoSignIn <email>
                    let d = UserDefaults.standard
                    if let email = d.string(forKey: "OrbisAutoSignIn"), app.phase == .signedOut {
                        try? await app.signIn(email: email)
                    }
                    if let tab = d.string(forKey: "OrbisTab") {
                        app.selectedTab = ["activity": .activity, "protect": .protect, "control": .control, "profile": .profile][tab] ?? .inbox
                    }
                    if let link = d.string(forKey: "OrbisOpen"), let url = URL(string: link) { app.open(url) }
                    if d.bool(forKey: "OrbisNoPrompts") { return }
                    #endif
                    if app.phase == .signedIn {
                        await NotificationService.shared.requestAuthorization()
                        await app.refreshProfile()
                    }
                }
        }
    }
}

struct RootView: View {
    @Environment(AppState.self) private var app

    var body: some View {
        @Bindable var app = app
        if app.phase == .signedOut {
            SignInView()
        } else {
            TabView(selection: $app.selectedTab) {
                Tab("Inbox", systemImage: "tray.full.fill", value: AppState.Tab.inbox) { InboxView() }
                    .badge(app.pendingCount)
                Tab("Activity", systemImage: "clock.arrow.circlepath", value: AppState.Tab.activity) { ActivityView() }
                Tab("Protect", systemImage: "checkmark.shield", value: AppState.Tab.protect) { ProtectView() }
                Tab("Control", systemImage: "octagon", value: AppState.Tab.control) { ControlView() }
                Tab("Profile", systemImage: "person.crop.circle", value: AppState.Tab.profile) { ProfileView() }
            }
        }
    }
}

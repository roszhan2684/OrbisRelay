import Foundation
import Observation
import UIKit
import UserNotifications

/// Session + dependency container. Views read it from the environment; all I/O goes through `repo`.
@MainActor
@Observable
final class AppState {
    enum Phase: Equatable { case signedOut, signedIn, offlineDemo }

    var phase: Phase = .signedOut
    var user: UserProfile?
    var tenantName = "Northstar Cloud"
    var deviceId: String?
    var permissions = Permissions(canFreeze: false, canUnfreeze: false)
    var pendingCount = 0
    var pendingRoute: Route?
    var selectedTab: Tab = .inbox
    var config: AppConfiguration

    enum Tab: Hashable { case inbox, activity, protect, control, profile }

    private(set) var repo: ApprovalRepository
    let stepUp: StepUpAuthenticator
    private let store: SecureStore
    nonisolated private static let tokenKey = "orbis.session"

    init(store: SecureStore = KeychainStore(), stepUp: StepUpAuthenticator = LocalAuthStepUp(), config: AppConfiguration = .load()) {
        self.store = store
        self.stepUp = stepUp
        self.config = config
        self.repo = RemoteRepository(api: URLSessionAPIClient(baseURL: config.baseURL, token: { [store] in store.get(AppState.tokenKey) }))
        if store.get(Self.tokenKey) != nil { phase = .signedIn }
    }

    func updateServer(_ url: URL) {
        config.baseURL = url
        UserDefaults.standard.set(url.absoluteString, forKey: "orbis.serverURL")
        repo = RemoteRepository(api: URLSessionAPIClient(baseURL: url, token: { [store] in store.get(AppState.tokenKey) }))
    }

    func signIn(email: String) async throws {
        let res = try await repo.signIn(email: email, deviceName: UIDevice.current.name, model: UIDevice.current.model, os: "iOS \(UIDevice.current.systemVersion)")
        try store.set(res.token, for: Self.tokenKey)
        user = res.user
        deviceId = res.device.id
        tenantName = res.tenant.name
        phase = .signedIn
        await refreshProfile()
        #if DEBUG
        if UserDefaults.standard.bool(forKey: "OrbisNoPrompts") { return }
        #endif
        await NotificationService.shared.requestAuthorization()
    }

    func startOfflineDemo() {
        repo = FixtureRepository()
        user = Fixtures.user
        tenantName = "Northstar Cloud (offline)"
        permissions = Permissions(canFreeze: true, canUnfreeze: true)
        phase = .offlineDemo
    }

    func refreshProfile() async {
        do {
            let me = try await repo.me()
            user = me.user
            tenantName = me.tenant.name
            permissions = me.permissions
            pendingCount = me.pendingCount
            deviceId = me.device?.id ?? deviceId
        } catch APIError.unauthorized {
            signOut()
        } catch {}
    }

    func signOut() {
        store.remove(Self.tokenKey)
        user = nil
        phase = .signedOut
        updateServer(config.baseURL)
    }

    func open(_ url: URL) {
        guard let route = DeepLinkRouter.route(for: url) else { return }
        selectedTab = .inbox
        pendingRoute = route
    }
}

/// Local notifications stand in for APNs in the demo. Bodies carry only a title and risk level —
/// never sensitive payloads — plus a deep link. High-risk approvals cannot complete from the notification.
@MainActor
final class NotificationService: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationService()
    var onOpen: ((URL) -> Void)?
    private var announced = Set<String>()

    func requestAuthorization() async {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-OrbisNoPrompts") { return }
        #endif
        _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
    }

    func announceNew(_ approvals: [Approval]) {
        let fresh = approvals.filter { !announced.contains($0.id) }
        let firstRun = announced.isEmpty
        approvals.forEach { announced.insert($0.id) }
        guard !firstRun, !fresh.isEmpty else { return }
        Task {
            let settings = await UNUserNotificationCenter.current().notificationSettings()
            guard settings.authorizationStatus == .authorized else { return }
            for a in fresh { Self.schedule(a) }
        }
    }

    private static func schedule(_ a: Approval) {
        let content = UNMutableNotificationContent()
        content.title = "Action paused — needs approval"
        content.body = "\(a.title) · \(a.risk.level.rawValue) risk"
        content.sound = .default
        content.userInfo = ["link": "orbis://approval/\(a.id)"]
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: a.id, content: content, trigger: nil))
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound, .list]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        guard let s = response.notification.request.content.userInfo["link"] as? String, let url = URL(string: s) else { return }
        await MainActor.run { onOpen?(url) }
    }
}

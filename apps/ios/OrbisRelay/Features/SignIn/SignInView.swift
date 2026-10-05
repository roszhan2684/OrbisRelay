import SwiftUI

struct SignInView: View {
    @Environment(AppState.self) private var app
    @State private var email = "alex.chen@northstar.cloud"
    @State private var server = AppConfiguration.load().baseURL.absoluteString
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        ZStack {
            LinearGradient(colors: [Color(red: 0.03, green: 0.05, blue: 0.10), Color(red: 0.06, green: 0.09, blue: 0.20)], startPoint: .top, endPoint: .bottom).ignoresSafeArea()
            VStack(alignment: .leading, spacing: 22) {
                Spacer()
                Image(systemName: "circle.circle")
                    .font(.system(size: 44, weight: .light))
                    .foregroundStyle(.white, Theme.cobalt)
                Text("Orbis").font(.system(size: 44, weight: .semibold)).foregroundStyle(.white)
                Text("The trusted decision terminal for software that acts on your behalf.")
                    .font(.title3).foregroundStyle(.white.opacity(0.7))
                Spacer()
                VStack(spacing: 12) {
                    TextField("Work email", text: $email)
                        .textContentType(.username).keyboardType(.emailAddress).textInputAutocapitalization(.never).autocorrectionDisabled()
                        .padding(14).background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 14)).foregroundStyle(.white)
                    if !app.config.managed {
                        TextField("Server", text: $server)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().font(.footnote.monospaced())
                            .padding(12).background(.white.opacity(0.05), in: RoundedRectangle(cornerRadius: 12)).foregroundStyle(.white.opacity(0.8))
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(Color(red: 1, green: 0.45, blue: 0.45)) }
                    Button {
                        Task { await signIn() }
                    } label: {
                        HStack { if busy { ProgressView().tint(.white) }; Text("Continue with SSO") }
                    }
                    .buttonStyle(BigButton(kind: .primary))
                    .disabled(busy)
                    Button("Explore offline demo") { app.startOfflineDemo() }
                        .font(.subheadline).foregroundStyle(.white.opacity(0.7)).padding(.top, 4)
                }
                Text("Northstar Cloud demo tenant · Face ID protects high-risk approvals").font(.caption).foregroundStyle(.white.opacity(0.4)).frame(maxWidth: .infinity)
            }
            .padding(28)
        }
    }

    private func signIn() async {
        busy = true
        defer { busy = false }
        if let url = URL(string: server.trimmingCharacters(in: .whitespaces)), url.scheme != nil { app.updateServer(url) }
        do {
            try await app.signIn(email: email.trimmingCharacters(in: .whitespaces))
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }
}

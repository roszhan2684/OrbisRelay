import SwiftUI

enum Theme {
    static let cobalt = Color(red: 0.153, green: 0.278, blue: 0.910)
    static let ink = Color(red: 0.043, green: 0.071, blue: 0.125)
    static let low = Color(red: 0.055, green: 0.486, blue: 0.290)
    static let medium = Color(red: 0.70, green: 0.46, blue: 0.0)
    static let high = Color(red: 0.761, green: 0.255, blue: 0.047)
    static let critical = Color(red: 0.706, green: 0.137, blue: 0.094)

    static func color(_ level: RiskLevel) -> Color {
        switch level {
        case .low: return low
        case .medium: return medium
        case .high: return high
        case .critical: return critical
        }
    }

    static func icon(_ level: RiskLevel) -> String {
        switch level {
        case .low: return "checkmark.shield.fill"
        case .medium: return "exclamationmark.triangle.fill"
        case .high: return "exclamationmark.shield.fill"
        case .critical: return "xmark.octagon.fill"
        }
    }
}

/// Risk is always icon + label (+ score) — never color alone.
struct RiskBadge: View {
    let level: RiskLevel
    var score: Int? = nil
    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: Theme.icon(level))
            Text(score.map { "\(level.rawValue.capitalized) risk · \($0)" } ?? "\(level.rawValue.capitalized) risk")
                .lineLimit(1)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(Theme.color(level))
        .padding(.horizontal, 8).padding(.vertical, 4)
        .background(Theme.color(level).opacity(0.12), in: Capsule())
        .fixedSize()
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(level.rawValue) risk\(score.map { ", score \($0)" } ?? "")")
    }
}

struct StatusPill: View {
    let status: ApprovalStatus
    var body: some View {
        let (icon, color): (String, Color) = switch status {
        case .pending: ("hourglass", Theme.cobalt)
        case .approved: ("checkmark.circle.fill", Theme.low)
        case .approvedModified: ("pencil.circle.fill", Theme.low)
        case .rejected: ("xmark.circle.fill", Theme.critical)
        case .expired: ("clock.fill", .secondary)
        case .cancelled: ("minus.circle.fill", .secondary)
        }
        Label(status.label, systemImage: icon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
    }
}

struct Card<Content: View>: View {
    @ViewBuilder var content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(16)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }
}

struct SectionTitle: View {
    let text: String
    var icon: String? = nil
    var body: some View {
        Label { Text(text.uppercased()) } icon: { if let icon { Image(systemName: icon) } }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
    }
}

extension Date {
    func countdown(from now: Date = .now) -> String {
        let s = Int(timeIntervalSince(now))
        if s <= 0 { return "expired" }
        if s < 3600 { return String(format: "%dm %02ds", s / 60, s % 60) }
        return "\(s / 3600)h \((s % 3600) / 60)m"
    }
}

extension String {
    var routeLabel: String {
        [
            "security": "Security", "ai-governance": "AI governance", "finance-controller": "Finance controllers",
            "support-manager": "Support managers", "eng-oncall": "Engineering on-call", "eng-manager": "Engineering managers",
            "data-owner": "Data owner + Security", "sales-leader": "Sales leadership", "privacy": "Privacy office", "facility-ops": "Facility operations",
        ][self] ?? self
    }
}

/// Hides sensitive content in the app switcher.
struct PrivacyShield: View {
    var body: some View {
        ZStack {
            Rectangle().fill(.ultraThinMaterial)
            VStack(spacing: 10) {
                Image(systemName: "lock.shield.fill").font(.system(size: 44)).foregroundStyle(Theme.cobalt)
                Text("Orbis").font(.title3.weight(.semibold))
            }
        }
        .ignoresSafeArea()
    }
}

import PhotosUI
import SwiftUI
import Vision
import VisionKit

/// User-initiated checks only: Orbis never reads other apps. It analyzes exactly what you share.
struct ProtectView: View {
    @Environment(AppState.self) private var app
    @State private var kind: ProtectKind = .url
    @State private var input = "https://northstar-payroll-update.com/login"
    @State private var result: ProtectAnalysis?
    @State private var busy = false
    @State private var error: String?
    @State private var scanning = false
    @State private var photo: PhotosPickerItem?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Card {
                        Picker("Type", selection: $kind) {
                            Text("Link").tag(ProtectKind.url)
                            Text("Message").tag(ProtectKind.text)
                            Text("QR").tag(ProtectKind.qr)
                            Text("Screenshot").tag(ProtectKind.screenshot)
                        }
                        .pickerStyle(.segmented)
                        TextField(kind == .url || kind == .qr ? "Paste a link" : "Paste a message", text: $input, axis: .vertical)
                            .lineLimit(kind == .url || kind == .qr ? 1...2 : 3...8)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .font(kind == .url || kind == .qr ? .callout.monospaced() : .callout)
                            .padding(12)
                            .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
                        HStack {
                            if kind == .qr {
                                Button { scanning = true } label: { Label("Scan QR", systemImage: "qrcode.viewfinder") }
                                    .buttonStyle(.bordered)
                                    .disabled(!(DataScannerViewController.isSupported && DataScannerViewController.isAvailable))
                            }
                            if kind == .screenshot {
                                PhotosPicker(selection: $photo, matching: .screenshots) { Label("Choose screenshot", systemImage: "photo") }
                                    .buttonStyle(.bordered)
                            }
                            Spacer()
                            Button {
                                Task { await analyze() }
                            } label: {
                                if busy { ProgressView() } else { Label("Is this safe?", systemImage: "checkmark.shield") }
                            }
                            .buttonStyle(.borderedProminent)
                            .disabled(busy || input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        }
                        if kind == .screenshot { Text("Text is extracted on this iPhone with Vision. Only the text you choose to check is sent.").font(.caption).foregroundStyle(.secondary) }
                    }
                    if let error { Text(error).font(.footnote).foregroundStyle(Theme.critical) }
                    if let r = result { ResultCard(r: r) }
                }
                .padding()
            }
            .background(Color(.systemGroupedBackground))
            .navigationTitle("Protect")
            .onChange(of: kind) { _, k in
                result = nil
                input = switch k {
                case .url: "https://northstar-payroll-update.com/login"
                case .text: "Hi, it's Priya. I'm in a meeting — please buy 5 Apple gift cards for a client today and keep this between us."
                case .qr: "https://bit.ly/ns-parking-pay"
                case .screenshot: ""
                }
            }
            .onChange(of: photo) { _, item in Task { await ocr(item) } }
            .sheet(isPresented: $scanning) {
                QRScanner { code in
                    input = code
                    scanning = false
                    Task { await analyze() }
                }
                .ignoresSafeArea()
            }
        }
    }

    private func analyze() async {
        busy = true
        defer { busy = false }
        do {
            result = try await app.repo.analyze(kind: kind, input: input.trimmingCharacters(in: .whitespacesAndNewlines))
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func ocr(_ item: PhotosPickerItem?) async {
        guard let item, let data = try? await item.loadTransferable(type: Data.self), let image = UIImage(data: data)?.cgImage else { return }
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        try? VNImageRequestHandler(cgImage: image).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
        input = String(text.prefix(2000))
        if !input.isEmpty { await analyze() }
    }
}

private struct ResultCard: View {
    let r: ProtectAnalysis
    var body: some View {
        let (title, icon, color): (String, String, Color) = switch r.verdict {
        case .dangerous: ("Dangerous", "xmark.octagon.fill", Theme.critical)
        case .caution: ("Be careful", "exclamationmark.shield.fill", Theme.medium)
        case .safe: ("Looks safe", "checkmark.shield.fill", Theme.low)
        }
        Card {
            HStack {
                Label(title, systemImage: icon).font(.title3.weight(.semibold)).foregroundStyle(color)
                Spacer()
                Text("\(r.score)/100").font(.headline.monospacedDigit()).foregroundStyle(color)
            }
            ProgressView(value: Double(r.score), total: 100).tint(color)
            Text(r.recommendation).font(.body.weight(.medium))
            if let note = r.policyNote { Text(note).font(.footnote).padding(10).frame(maxWidth: .infinity, alignment: .leading).background(Theme.cobalt.opacity(0.08), in: RoundedRectangle(cornerRadius: 10)) }
            ForEach(r.reasons, id: \.label) { reason in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: reason.weight == "positive" ? "hand.thumbsup.fill" : "circle.fill")
                        .font(.system(size: reason.weight == "positive" ? 12 : 7))
                        .foregroundStyle(reason.weight == "positive" ? Theme.low : reason.weight == "high" ? Theme.critical : Theme.high)
                        .padding(.top, 5)
                    Text("**\(reason.label).** \(reason.detail)").font(.subheadline)
                }
            }
            ForEach(r.model, id: \.name) { m in
                Text("\(m.name)@\(m.version) · p=\(m.probability.formatted(.number.precision(.fractionLength(3))))").font(.caption2.monospaced()).foregroundStyle(.secondary)
            }
        }
    }
}

/// VisionKit live QR scanner (real devices; unavailable in Simulator).
struct QRScanner: UIViewControllerRepresentable {
    var onCode: (String) -> Void

    func makeUIViewController(context: Context) -> DataScannerViewController {
        let vc = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, isHighlightingEnabled: true)
        vc.delegate = context.coordinator
        try? vc.startScanning()
        return vc
    }

    func updateUIViewController(_ vc: DataScannerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onCode: (String) -> Void
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }
        func dataScanner(_ scanner: DataScannerViewController, didAdd items: [RecognizedItem], allItems: [RecognizedItem]) {
            for case .barcode(let b) in items { if let s = b.payloadStringValue { scanner.stopScanning(); onCode(s); return } }
        }
    }
}

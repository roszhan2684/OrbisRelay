// swift-tools-version: 6.0
// Orbis Endpoint — macOS endpoint runtime for Orbis Relay v2 (blueprint §15).
import PackageDescription

let package = Package(
    name: "OrbisEndpoint",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "OrbisEndpointCore", targets: ["OrbisEndpointCore"]),
        .executable(name: "orbis-endpoint", targets: ["orbis-endpoint"]),
    ],
    targets: [
        .target(name: "OrbisEndpointCore", swiftSettings: [.swiftLanguageMode(.v5)]),
        .executableTarget(name: "orbis-endpoint", dependencies: ["OrbisEndpointCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
        .testTarget(name: "OrbisEndpointCoreTests", dependencies: ["OrbisEndpointCore"], swiftSettings: [.swiftLanguageMode(.v5)]),
    ]
)

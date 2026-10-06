import CoreML
import Foundation

/// A runtime that turns an `edge-features/1` vector into 4 class logits.
public protocol RiskModel: AnyObject {
    var name: String { get }
    var version: String { get }
    var runtime: String { get }
    func logits(_ features: [Double]) throws -> [Double]
}

public enum RiskModelError: Error, CustomStringConvertible {
    case badInput(Int)
    case missingOutput
    case incompatible(String)
    public var description: String {
        switch self {
        case .badInput(let n): return "expected \(EdgeFeatures.count) features, got \(n)"
        case .missingOutput: return "model produced no 'logits' output"
        case .incompatible(let s): return "incompatible model: \(s)"
        }
    }
}

/// Pure-Swift float64 forward pass over `orbis-portable-mlp/1` weights. Used as the parity reference on
/// device and as a fallback runtime when Core ML is unavailable.
public final class PortableMLP: RiskModel {
    struct Layer { let W: [[Double]]; let b: [Double]; let relu: Bool }
    let layers: [Layer]
    public let name: String
    public let version: String
    public let runtime = "portable-swift"
    public let featureSchema: String

    public init(json data: Data) throws {
        guard let o = try JSONSerialization.jsonObject(with: data) as? [String: Any], (o["format"] as? String) == "orbis-portable-mlp/1",
              let ls = o["layers"] as? [[String: Any]] else { throw RiskModelError.incompatible("not orbis-portable-mlp/1") }
        layers = try ls.map { l in
            guard let W = l["W"] as? [[Double]], let b = l["b"] as? [Double] else { throw RiskModelError.incompatible("bad layer") }
            return Layer(W: W, b: b, relu: (l["activation"] as? String) == "relu")
        }
        name = o["model_name"] as? String ?? "orbis-edge-risk"
        version = o["version"] as? String ?? "?"
        featureSchema = o["feature_schema"] as? String ?? "?"
        guard featureSchema == EdgeFeatures.schema else { throw RiskModelError.incompatible("feature schema \(featureSchema) ≠ \(EdgeFeatures.schema)") }
    }

    public func logits(_ x: [Double]) throws -> [Double] {
        guard x.count == EdgeFeatures.count else { throw RiskModelError.badInput(x.count) }
        var h = x
        for l in layers {
            var out = [Double](repeating: 0, count: l.b.count)
            for (i, row) in l.W.enumerated() {
                var acc = 0.0
                for j in 0..<row.count { acc += h[j] * row[j] }
                acc += l.b[i]
                out[i] = l.relu ? max(acc, 0) : acc
            }
            h = out
        }
        return h
    }
}

/// Core ML runtime: loads a compiled `.mlmodelc` and runs single-row predictions.
public final class CoreMLRiskModel: RiskModel {
    public let name: String
    public let version: String
    public let runtime: String
    let model: MLModel
    let input: MLMultiArray

    public init(compiledURL: URL, computeUnits: MLComputeUnits = .cpuOnly) throws {
        let cfg = MLModelConfiguration()
        cfg.computeUnits = computeUnits
        model = try MLModel(contentsOf: compiledURL, configuration: cfg)
        let meta = model.modelDescription.metadata[.creatorDefinedKey] as? [String: String] ?? [:]
        guard meta["feature_schema"] == EdgeFeatures.schema else { throw RiskModelError.incompatible("feature schema \(meta["feature_schema"] ?? "missing")") }
        name = "orbis-edge-risk"
        version = model.modelDescription.metadata[.versionString] as? String ?? "?"
        runtime = "coreml-\(meta["precision"] ?? "fp32")"
        input = try MLMultiArray(shape: [1, NSNumber(value: EdgeFeatures.count)], dataType: .float32)
    }

    /// Compile an `.mlpackage` (or `.mlmodel`) into a temporary `.mlmodelc`.
    public static func compile(_ packageURL: URL) throws -> URL {
        try MLModel.compileModel(at: packageURL)
    }

    public func logits(_ x: [Double]) throws -> [Double] {
        guard x.count == EdgeFeatures.count else { throw RiskModelError.badInput(x.count) }
        let p = input.dataPointer.bindMemory(to: Float.self, capacity: x.count)
        for i in 0..<x.count { p[i] = Float(x[i]) }
        let provider = try MLDictionaryFeatureProvider(dictionary: ["features": MLFeatureValue(multiArray: input)])
        let out = try model.prediction(from: provider)
        guard let arr = out.featureValue(for: "logits")?.multiArrayValue else { throw RiskModelError.missingOutput }
        return (0..<arr.count).map { arr[$0].doubleValue }
    }
}

public extension MLComputeUnits {
    static func parse(_ s: String) -> MLComputeUnits {
        switch s.lowercased() {
        case "all": return .all
        case "gpu", "cpu_gpu", "cpuandgpu": return .cpuAndGPU
        case "ane", "cpu_ne", "neural", "cpuandneuralengine": return .cpuAndNeuralEngine
        default: return .cpuOnly
        }
    }
    var label: String {
        switch self {
        case .all: return "all"
        case .cpuAndGPU: return "cpu_gpu"
        case .cpuAndNeuralEngine: return "cpu_ane"
        default: return "cpu_only"
        }
    }
}

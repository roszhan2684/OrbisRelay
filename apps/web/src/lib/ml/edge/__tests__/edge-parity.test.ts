import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { anomaly, compute, FEATURE_NAMES, FeatureState, SchemaError, update, validate } from "../features";
import { decide, logits, reasons, type DecisionPolicy, type PortableModel } from "../model";
import { domainHash } from "../adapter";

const ROOT = path.resolve(__dirname, "../../../../../../..");
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8"));
const featureDoc = read("fixtures/endpoint-events/feature-parity.json");
const spec = read("fixtures/endpoint-events/feature-spec.json");

describe("edge features: python ↔ typescript parity", () => {
  it("feature names and order match the spec", () => {
    expect(FEATURE_NAMES).toEqual(spec.names);
  });

  type Stream = { name: string; events: unknown[]; expected: Array<{ event_id: string; features: number[]; anomaly: { score: number; sufficient: boolean; contributions: Array<{ feature: string }> } }> };
  it.each((featureDoc.streams as Stream[]).map((s) => [s.name, s] as [string, Stream]))("stream %s", (_name, s) => {
    const st = new FeatureState();
    s.events.forEach((e, k) => {
      const ev = validate(e);
      const x = compute(ev, st);
      const an = anomaly(ev, st);
      update(ev, st);
      const ref = s.expected[k];
      for (let i = 0; i < x.length; i++) {
        if (Math.abs(x[i] - ref.features[i]) > 1e-9) throw new Error(`${ref.event_id} ${FEATURE_NAMES[i]}: ts ${x[i]} py ${ref.features[i]}`);
      }
      expect(an.sufficient).toBe(ref.anomaly.sufficient);
      expect(Math.abs(an.score - ref.anomaly.score)).toBeLessThan(1e-9);
      expect(an.contributions.map((c) => c.feature)).toEqual(ref.anomaly.contributions.map((c) => c.feature));
    });
  });

  type Invalid = { name: string; event: unknown; field: string };
  it.each((featureDoc.invalid as Invalid[]).map((c) => [c.name, c] as [string, Invalid]))("rejects %s on the same field", (_n, c) => {
    try {
      validate(c.event);
      throw new Error("accepted");
    } catch (e) {
      expect(e).toBeInstanceOf(SchemaError);
      expect((e as SchemaError).field).toBe(c.field);
    }
  });

  it("destination hashing matches the endpoint", () => {
    expect(domainHash(" QuickScribe-AI.app ")).toBe("e00fd622626850a6");
    expect(domainHash("example.org")).toBe("bfabc37432958b06");
  });
});

describe.each(["1.0.0", "1.1.0"])("edge model %s: python ↔ typescript parity", (version) => {
  const file = path.join(ROOT, `fixtures/parity/edge-risk-${version}.json`);
  const exists = fs.existsSync(file);
  it.skipIf(!exists)("logits, calibrated probabilities, class and reasons", () => {
    const fx = JSON.parse(fs.readFileSync(file, "utf8"));
    const art = JSON.parse(fs.readFileSync(path.join(ROOT, `apps/web/src/lib/ml/edge/models/${version}.json`), "utf8")) as { model: PortableModel; policy: DecisionPolicy };
    for (const c of fx.cases as Array<{ event_id: string; features: number[]; logits: number[]; probs: number[]; class: number; abstain: boolean; reasons: string[] }>) {
      const z = logits(art.model, c.features);
      z.forEach((v, i) => expect(Math.abs(v - c.logits[i])).toBeLessThan(1e-9));
      const d = decide(z, c.features, art.policy);
      expect(d.cls, c.event_id).toBe(c.class);
      expect(d.abstain).toBe(c.abstain);
      d.probs.forEach((v, i) => expect(Math.abs(v - c.probs[i])).toBeLessThan(1e-9));
      expect(reasons(c.features).map((r) => r.code), c.event_id).toEqual(c.reasons);
    }
  });
});

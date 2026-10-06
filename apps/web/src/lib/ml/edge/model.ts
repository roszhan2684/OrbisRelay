// Portable model runtime + calibrated decision policy — TypeScript port of ml/orbis_ml/{models,decision}.py.
// Used by the gateway for cloud-side scoring (and as the shadow/canary scorer). Parity-tested against
// fixtures/parity/edge-risk-<version>.json.
import { fi, N_FEATURES } from "./features";

export const LABELS = ["safe_normal", "safe_unusual", "suspicious_review", "high_risk"] as const;
export type Label = (typeof LABELS)[number];

export interface PortableModel {
  format: "orbis-portable-mlp/1";
  input_dim: number;
  layers: Array<{ W: number[][]; b: number[]; activation: "relu" | "none" }>;
  model_name: string;
  version: string;
  feature_schema: string;
  classes: string[];
  architecture: string;
}

export interface DecisionPolicy {
  schema: "orbis-decision-policy/1";
  version: string;
  temperature: number;
  tau_high: number;
  tau_review: number;
  abstain_entropy: number;
  unknown_fields_index: number;
  high_impact: { any_feature_set: number[]; class_rank_index: number; class_rank_min: number; resource_log_index: number; resource_log_min: number };
}

export function logits(model: PortableModel, x: number[]): number[] {
  if (x.length !== N_FEATURES || model.input_dim !== N_FEATURES) throw new Error(`feature length ${x.length} ≠ ${N_FEATURES}`);
  let h = x;
  for (const layer of model.layers) {
    const out = new Array<number>(layer.b.length);
    for (let i = 0; i < layer.W.length; i++) {
      const row = layer.W[i];
      let acc = 0;
      for (let j = 0; j < row.length; j++) acc += h[j] * row[j];
      acc += layer.b[i];
      out[i] = layer.activation === "relu" ? Math.max(acc, 0) : acc;
    }
    h = out;
  }
  return h;
}

export function softmax(z: number[], T = 1): number[] {
  const s = z.map((v) => v / T);
  const m = Math.max(...s);
  const e = s.map((v) => Math.exp(v - m));
  const sum = e.reduce((a, b) => a + b, 0);
  return e.map((v) => v / sum);
}

function normalizedEntropy(p: number[]) {
  let h = 0;
  for (const v of p) h += v * Math.log(Math.min(Math.max(v, 1e-12), 1));
  return -h / Math.log(p.length);
}

export function highImpact(x: number[], hi: DecisionPolicy["high_impact"]) {
  return hi.any_feature_set.some((i) => x[i] > 0.5) || x[hi.class_rank_index] >= hi.class_rank_min || x[hi.resource_log_index] >= hi.resource_log_min;
}

export interface Decided {
  probs: number[];
  risk: number;
  cls: number;
  label: Label;
  abstain: boolean;
  ood: boolean;
  guarded: boolean;
  high_impact: boolean;
}

export function decide(z: number[], x: number[], p: DecisionPolicy): Decided {
  const probs = softmax(z, p.temperature);
  const risk = probs[2] + probs[3];
  let cls = probs[1] > probs[0] ? 1 : 0;
  if (risk >= p.tau_review) cls = 2;
  if (probs[3] >= p.tau_high) cls = 3;
  const ood = x[p.unknown_fields_index] > 0;
  const abstain = ood || normalizedEntropy(probs) >= p.abstain_entropy;
  const hi = highImpact(x, p.high_impact);
  const guarded = abstain && hi && cls < 2;
  if (guarded) cls = 2;
  return { probs, risk, cls, label: LABELS[cls], abstain, ood, guarded, high_impact: hi };
}

const REASONS: Array<[string, string]> = [
  ["out_of_distribution", "Unrecognised fields — model confidence reduced"],
  ["secret_egress", "Secret-bearing data leaving the trust boundary"],
  ["sensitive_to_untrusted", "Sensitive data to an unverified destination"],
  ["blocked_destination", "Destination is on the block list"],
  ["external_identity", "Access for an external identity"],
  ["destructive_production", "Destructive change in production"],
  ["bulk_sensitive", "Bulk volume of sensitive records"],
  ["sensitive_external", "Sensitive data leaving the organisation"],
  ["privileged_new_destination", "Privileged actor, never-seen destination"],
  ["first_destination", "Destination never used by this actor"],
  ["rate_spike", "Action rate {rate}× this actor's baseline"],
  ["volume_outlier", "Volume far above this actor's history"],
  ["high_amount", "High monetary amount"],
  ["outside_change_window", "Production change outside an approved window"],
  ["new_tool", "Tool never used by this actor"],
  ["off_hours", "Outside business hours"],
];

export function reasons(x: number[], limit = 4): Array<{ code: string; label: string }> {
  const f = (n: string) => x[fi(n)];
  const established = f("baseline_insufficient") < 0.5;
  const rate = 2 ** (f("rate_ratio") * 6);
  const fired: Record<string, boolean> = {
    out_of_distribution: f("unknown_fields") > 0,
    secret_egress: f("x_secret_egress") > 0.5,
    sensitive_to_untrusted: f("x_sensitive_untrusted") > 0.5,
    blocked_destination: f("destination_trust=blocked") > 0.5,
    external_identity: f("destination_type=external_identity") > 0.5,
    destructive_production: f("x_destructive_production") > 0.5,
    bulk_sensitive: f("x_bulk_sensitive") > 0.5,
    sensitive_external: f("x_sensitive_external") > 0.5,
    privileged_new_destination: f("x_privileged_new_dest") > 0.5 && established,
    first_destination: f("first_destination") > 0.5 && established,
    rate_spike: rate >= 3 && established,
    volume_outlier: f("resource_z") >= 0.4,
    high_amount: f("amount_log") >= 0.4,
    outside_change_window: f("production_without_window") > 0.5,
    new_tool: f("first_tool") > 0.5 && established,
    off_hours: f("off_hours") > 0.5,
  };
  return REASONS.filter(([code]) => fired[code])
    .map(([code, label]) => ({ code, label: label.replace("{rate}", rate.toFixed(1)) }))
    .slice(0, limit);
}

/** One plain-language sentence for the approval card (blueprint §16 "human-friendly example"). */
export function explain(label: Label, rs: Array<{ code: string; label: string }>, actorKind: string, abstain: boolean): string {
  if (abstain && rs.some((r) => r.code === "out_of_distribution")) return "The model saw fields it does not recognise, so it is not guessing — a human should decide.";
  const lead = label === "high_risk" ? "High risk" : label === "suspicious_review" ? "Worth a review" : label === "safe_unusual" ? "Unusual but likely fine" : "Looks routine";
  const map: Record<string, string> = {
    secret_egress: "secret-bearing data is leaving the trust boundary",
    sensitive_to_untrusted: "sensitive data is going to an unverified destination",
    blocked_destination: "the destination is on the block list",
    external_identity: "access is being granted to an external identity",
    destructive_production: "this is a destructive change in production",
    bulk_sensitive: "a bulk volume of sensitive records is involved",
    sensitive_external: "sensitive data is leaving the organisation",
    privileged_new_destination: "a privileged actor is using a destination it has never used",
    first_destination: `this ${actorKind} has never used this destination before`,
    volume_outlier: `the volume is far above this ${actorKind}'s history`,
    high_amount: "the amount is high",
    outside_change_window: "it is a production change outside an approved window",
    new_tool: `this ${actorKind} has never used this tool`,
    off_hours: "it is outside business hours",
  };
  const codes = new Set(rs.map((r) => r.code));
  const parts = rs
    .filter((r) => !(r.code === "sensitive_external" && (codes.has("sensitive_to_untrusted") || codes.has("secret_egress"))))
    .map((r) => (r.code === "rate_spike" ? `its action rate is ${r.label.match(/[\d.]+×/)?.[0] ?? "well above"} its normal baseline` : map[r.code]))
    .filter(Boolean)
    .slice(0, 2);
  if (!parts.length) return `${lead}: nothing in this ${actorKind}'s behaviour stands out.`;
  return `${lead} because ${parts.join(", and ")}.`;
}

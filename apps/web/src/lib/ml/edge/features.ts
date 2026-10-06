// TypeScript port of the Orbis edge feature calculator (edge-features/1) and the canonical event schema
// (endpoint-event/1). Reference: ml/orbis_ml/{schema,features}.py. Parity is enforced against
// fixtures/endpoint-events/feature-parity.json (exact categorical features, 1e-9 floats).

export const FEATURE_SCHEMA = "edge-features/1";
export const EVENT_SCHEMA = "endpoint-event/1";

export const VOCAB = {
  actor_type: ["human", "agent", "service", "automation"],
  action_type: [
    "external_send", "file_upload", "clipboard_export", "tool_invoke", "database_query", "privilege_grant", "payment", "refund",
    "production_deploy", "secrets_access", "model_provider_send", "bulk_download", "destructive_delete", "config_change", "physical_operation",
  ],
  classification: ["public", "internal", "confidential", "restricted", "regulated", "secret"],
  destination_type: ["none", "internal", "internal_model", "approved_vendor", "external_domain", "external_ai_provider", "beneficiary", "external_identity", "partner", "production_env"],
  destination_trust: ["trusted", "approved", "unverified", "blocked"],
  privilege_level: ["standard", "elevated", "admin"],
  device_posture: ["managed", "unmanaged"],
  tool_risk_class: ["low", "medium", "high"],
  environment: ["none", "dev", "staging", "production"],
} as const;

type Block = keyof typeof VOCAB;
const BLOCKS: Block[] = ["actor_type", "action_type", "classification", "destination_type", "destination_trust", "privilege_level", "device_posture", "tool_risk_class", "environment"];
export const NUMERIC = [
  "resource_log", "amount_log", "off_hours", "weekend", "production_without_window", "has_ticket", "rate_5m", "rate_1h", "rate_ratio", "unique_dest_1h",
  "first_destination", "first_tool", "first_action", "resource_z", "baseline_insufficient", "unknown_fields", "class_rank",
  "x_sensitive_external", "x_sensitive_untrusted", "x_privileged_new_dest", "x_high_amount_off_hours", "x_destructive_production", "x_new_tool_elevated", "x_secret_egress", "x_bulk_sensitive",
] as const;
export const FEATURE_NAMES: string[] = [...BLOCKS.flatMap((b) => [...VOCAB[b], "unknown"].map((v) => `${b}=${v}`)), ...NUMERIC];
const INDEX = new Map(FEATURE_NAMES.map((n, i) => [n, i]));
export const fi = (name: string) => INDEX.get(name)!;
export const N_FEATURES = FEATURE_NAMES.length;

const HOUR = 3_600_000, DAY = 86_400_000, W5 = 300_000;
const SEEN_CAP = 4096, RING_CAP = 200, TIMES_CAP = 10_000, MIN_BASELINE = 5, MIN_ANOMALY = 20;
const CLASS_RANK: Record<string, number> = { public: 0, internal: 1, confidential: 2, restricted: 3, regulated: 3, secret: 4, unknown: 2 };
const EXTERNAL = new Set(["approved_vendor", "external_domain", "external_ai_provider", "beneficiary", "external_identity", "partner", "unknown"]);
const UNTRUSTED = new Set(["unverified", "blocked", "unknown"]);
const ELEVATED = new Set(["elevated", "admin", "unknown"]);

export class SchemaError extends Error {
  constructor(public field: string, message: string) {
    super(`${field}: ${message}`);
  }
}

export interface NormalizedEvent {
  event_id: string;
  ts_ms: number;
  tz_offset_minutes: number;
  actor_id: string;
  actor_type: string;
  privilege_level: string;
  action_type: string;
  tool: string;
  tool_risk_class: string;
  classification: string;
  resource_count: number;
  destination_type: string;
  destination_trust: string;
  destination_hash: string;
  environment: string;
  device_posture: string;
  amount_usd: number;
  change_window: boolean | null;
  has_ticket: boolean;
}

function daysFromCivil(y0: number, m: number, d: number) {
  const y = y0 - (m <= 2 ? 1 : 0);
  const era = Math.floor((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const TS_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
export function parseTs(ts: string): number {
  const m = TS_RE.exec(ts);
  if (!m) throw new SchemaError("timestamp", `expected YYYY-MM-DDTHH:MM:SS[.mmm]Z, got ${JSON.stringify(ts)}`);
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map((i) => Number(m[i]));
  const ms = Number((m[7] ?? "0").padEnd(3, "0"));
  if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h < 24 && mi < 60 && s < 60)) throw new SchemaError("timestamp", `timestamp out of range: ${ts}`);
  return daysFromCivil(y, mo, d) * DAY + h * HOUR + mi * 60_000 + s * 1000 + ms;
}

export function formatTs(ms: number) {
  return new Date(ms).toISOString();
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const enumOf = (v: unknown, vocab: readonly string[]) => (typeof v === "string" && vocab.includes(v) ? v : "unknown");
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Strict validation; mirrors the Python reference error fields exactly. */
export function validate(e: unknown): NormalizedEvent {
  if (!isObj(e)) throw new SchemaError("event", "must be an object");
  if (e.schema !== EVENT_SCHEMA) throw new SchemaError("schema", `expected '${EVENT_SCHEMA}'`);
  const eid = e.event_id;
  if (typeof eid !== "string" || eid.length < 1 || eid.length > 128) throw new SchemaError("event_id", "required string ≤128");
  if (typeof e.timestamp !== "string") throw new SchemaError("timestamp", "required string");
  const ts = parseTs(e.timestamp);
  const tz = e.tz_offset_minutes === undefined ? 0 : e.tz_offset_minutes;
  if (!isInt(tz) || tz < -840 || tz > 840) throw new SchemaError("tz_offset_minutes", "integer in [-840, 840]");
  const actor = e.actor;
  if (!isObj(actor) || typeof actor.id !== "string" || !actor.id) throw new SchemaError("actor.id", "required");
  const action = e.action;
  if (!isObj(action)) throw new SchemaError("action", "required object");
  const resource = e.resource === undefined || e.resource === null ? {} : e.resource;
  if (!isObj(resource)) throw new SchemaError("resource", "must be an object");
  const count = resource.count === undefined ? 1 : resource.count;
  if (!isInt(count) || count < 0 || count > 10_000_000) throw new SchemaError("resource.count", "integer in [0, 10^7]");
  const dest = e.destination === undefined || e.destination === null ? {} : e.destination;
  if (!isObj(dest)) throw new SchemaError("destination", "must be an object");
  const dh = dest.domain_hash === undefined ? "" : dest.domain_hash;
  if (typeof dh !== "string" || (dh && !/^[0-9a-f]{16}$/.test(dh))) throw new SchemaError("destination.domain_hash", "16 lowercase hex chars (never the raw domain)");
  const bc = e.business_context === undefined || e.business_context === null ? {} : e.business_context;
  if (!isObj(bc)) throw new SchemaError("business_context", "must be an object");
  const amount = bc.amount_usd === undefined ? 0 : bc.amount_usd;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0 || amount > 1e10) throw new SchemaError("business_context.amount_usd", "number in [0, 1e10]");
  const cw = bc.change_window;
  if (cw !== undefined && cw !== null && typeof cw !== "boolean") throw new SchemaError("business_context.change_window", "boolean or null");
  const tool = action.tool === undefined || action.tool === null ? "" : action.tool;
  if (typeof tool !== "string" || tool.length > 120) throw new SchemaError("action.tool", "string ≤120");
  const destTypeRaw = dest.type === undefined ? "none" : dest.type;
  return {
    event_id: eid,
    ts_ms: ts,
    tz_offset_minutes: tz,
    actor_id: actor.id,
    actor_type: enumOf(actor.type, VOCAB.actor_type),
    privilege_level: enumOf(actor.privilege_level, VOCAB.privilege_level),
    action_type: enumOf(action.type, VOCAB.action_type),
    tool,
    tool_risk_class: enumOf(action.tool_risk_class, VOCAB.tool_risk_class),
    classification: enumOf(resource.classification, VOCAB.classification),
    resource_count: count,
    destination_type: enumOf(destTypeRaw, VOCAB.destination_type),
    destination_trust: destTypeRaw !== "none" ? enumOf(dest.trust, VOCAB.destination_trust) : "trusted",
    destination_hash: dh,
    environment: enumOf(e.environment === undefined ? "none" : e.environment, VOCAB.environment),
    device_posture: enumOf(e.device_posture, VOCAB.device_posture),
    amount_usd: amount,
    change_window: cw === undefined ? null : (cw as boolean | null),
    has_ticket: Boolean(bc.ticket),
  };
}

// ---------------------------------------------------------------- state

/** JSON-serialisable per-actor baseline (stored in the gateway DB so every replica agrees). */
export interface ActorState {
  times: Array<[number, string]>;
  seen_dest: string[];
  seen_tool: string[];
  seen_action: string[];
  n: number;
  mean: number;
  m2: number;
  vol: number[];
  rate: number[];
}

export const newActorState = (): ActorState => ({ times: [], seen_dest: [], seen_tool: [], seen_action: [], n: 0, mean: 0, m2: 0, vol: [], rate: [] });

export class FeatureState {
  constructor(public actors: Record<string, ActorState> = {}) {}
  get(id: string): ActorState {
    return (this.actors[id] ??= newActorState());
  }
}

interface Window {
  n5: number;
  n60: number;
  nBase: number;
  uniqueDest1h: number;
}

function windowCounts(st: ActorState, t: number): Window {
  let n5 = 0, n60 = 0, nBase = 0;
  const dests = new Set<string>();
  for (const [ts, dh] of st.times) {
    if (ts > t || ts <= t - DAY) continue;
    if (ts > t - W5) n5++;
    if (ts > t - HOUR) {
      n60++;
      if (dh) dests.add(dh);
    } else nBase++;
  }
  return { n5, n60, nBase, uniqueDest1h: dests.size };
}

export function localTime(tsMs: number, tz: number) {
  const local = tsMs + tz * 60_000;
  const day = Math.floor(local / DAY);
  const hour = Math.floor((local - day * DAY) / HOUR);
  const weekday = (((day + 4) % 7) + 7) % 7;
  return { hour, weekday };
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const unknownCount = (e: NormalizedEvent) =>
  [e.actor_type, e.privilege_level, e.action_type, e.classification, e.destination_type, e.destination_trust, e.device_posture, e.environment].filter((v) => v === "unknown").length;

export function compute(e: NormalizedEvent, state: FeatureState): number[] {
  const st = state.get(e.actor_id);
  const w = windowCounts(st, e.ts_ms);
  const { hour, weekday } = localTime(e.ts_ms, e.tz_offset_minutes);
  const weekend = weekday === 0 || weekday === 6;
  const offHours = weekend || hour < 8 || hour >= 19;
  const hasDest = e.destination_type !== "none";
  const firstDest = hasDest && (!e.destination_hash || !st.seen_dest.includes(e.destination_hash));
  const firstTool = !e.tool || !st.seen_tool.includes(e.tool);
  const firstAction = !st.seen_action.includes(e.action_type);
  const x = Math.log1p(e.resource_count);
  let resourceZ = 0;
  if (st.n >= MIN_BASELINE) {
    const z = (x - st.mean) / Math.sqrt(st.m2 / st.n + 0.25);
    resourceZ = clamp(z, -5, 5) / 5;
  }
  const baseRate = w.nBase / 23.0;
  const rateRatio = clamp(Math.log2((w.n60 + 1.0) / (baseRate + 1.0)), -4, 6) / 6;
  const rank = CLASS_RANK[e.classification] ?? 2;
  const sensitive = rank >= 2;
  const external = EXTERNAL.has(e.destination_type);
  const elevated = ELEVATED.has(e.privilege_level);
  const b = (c: boolean) => (c ? 1 : 0);
  const v: number[] = [];
  for (const block of BLOCKS) {
    const vocab = VOCAB[block] as readonly string[];
    const value = e[block as keyof NormalizedEvent] as string;
    const onehot = new Array(vocab.length + 1).fill(0);
    const i = vocab.indexOf(value);
    onehot[i === -1 ? vocab.length : i] = 1;
    v.push(...onehot);
  }
  v.push(
    Math.min(x, 16) / 16,
    Math.min(Math.log10(1 + e.amount_usd), 10) / 10,
    b(offHours),
    b(weekend),
    b(e.environment === "production" && e.change_window !== true),
    b(e.has_ticket),
    Math.min(Math.log1p(w.n5), 8) / 8,
    Math.min(Math.log1p(w.n60), 8) / 8,
    rateRatio,
    Math.min(Math.log1p(w.uniqueDest1h), 6) / 6,
    b(firstDest),
    b(firstTool),
    b(firstAction),
    resourceZ,
    b(st.n < MIN_BASELINE),
    Math.min(unknownCount(e), 4) / 4,
    rank / 4,
    b(sensitive && external),
    b(sensitive && hasDest && UNTRUSTED.has(e.destination_trust)),
    b(elevated && firstDest),
    b(e.amount_usd >= 10_000 && offHours),
    b(e.action_type === "destructive_delete" && e.environment === "production"),
    b(firstTool && elevated),
    b(e.classification === "secret" && e.destination_type !== "none" && e.destination_type !== "internal"),
    b(e.resource_count >= 1000 && sensitive),
  );
  return v;
}

export function update(e: NormalizedEvent, state: FeatureState) {
  const st = state.get(e.actor_id);
  const t = e.ts_ms;
  let w60 = 0;
  for (const [ts] of st.times) if (t - HOUR < ts && ts <= t) w60++;
  let drop = 0;
  while (drop < st.times.length && st.times[drop][0] <= t - DAY) drop++;
  if (drop) st.times.splice(0, drop);
  st.times.push([t, e.destination_hash]);
  if (st.times.length > TIMES_CAP) st.times.splice(0, st.times.length - TIMES_CAP);
  if (e.destination_type !== "none" && e.destination_hash && st.seen_dest.length < SEEN_CAP && !st.seen_dest.includes(e.destination_hash)) st.seen_dest.push(e.destination_hash);
  if (e.tool && st.seen_tool.length < SEEN_CAP && !st.seen_tool.includes(e.tool)) st.seen_tool.push(e.tool);
  if (st.seen_action.length < SEEN_CAP && !st.seen_action.includes(e.action_type)) st.seen_action.push(e.action_type);
  const x = Math.log1p(e.resource_count);
  st.n += 1;
  const d = x - st.mean;
  st.mean += d / st.n;
  st.m2 += d * (x - st.mean);
  st.vol.push(x);
  if (st.vol.length > RING_CAP) st.vol.splice(0, st.vol.length - RING_CAP);
  st.rate.push(w60);
  if (st.rate.length > RING_CAP) st.rate.splice(0, st.rate.length - RING_CAP);
}

// ---------------------------------------------------------------- Model B — behavioural anomaly

export interface AnomalyResult {
  score: number;
  sufficient: boolean;
  samples: number;
  contributions: Array<{ feature: string; weight: number }>;
}

function median(xs: number[]) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length, m = Math.floor(n / 2);
  return n % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function anomaly(e: NormalizedEvent, state: FeatureState): AnomalyResult {
  const st = state.get(e.actor_id);
  const n = st.vol.length;
  const w = windowCounts(st, e.ts_ms);
  if (n < MIN_ANOMALY) return { score: 0, sufficient: false, samples: n, contributions: [] };
  const mv = median(st.vol), mr = median(st.rate);
  const madv = median(st.vol.map((v) => Math.abs(v - mv)));
  const madr = median(st.rate.map((r) => Math.abs(r - mr)));
  const zVol = (Math.log1p(e.resource_count) - mv) / (1.4826 * madv + 0.25);
  const zRate = (w.n60 - mr) / (1.4826 * madr + 1.0);
  const hasDest = e.destination_type !== "none";
  const contributions: Array<[string, number]> = [
    ["volume", Math.max(0, zVol) / 4],
    ["rate", Math.max(0, zRate) / 4],
    ["first_destination", 0.35 * (hasDest && (!e.destination_hash || !st.seen_dest.includes(e.destination_hash)) ? 1 : 0)],
    ["first_tool", 0.35 * (!e.tool || !st.seen_tool.includes(e.tool) ? 1 : 0)],
    ["first_action", 0.35 * (st.seen_action.includes(e.action_type) ? 0 : 1)],
  ];
  let s = 0;
  for (const [, c] of contributions) s += c;
  const sorted = contributions.filter((c) => c[1] > 0).sort((a, b) => (a[1] !== b[1] ? b[1] - a[1] : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return { score: 1 - Math.exp(-s), sufficient: true, samples: n, contributions: sorted.map(([feature, weight]) => ({ feature, weight })) };
}

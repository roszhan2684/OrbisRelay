import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import type { AuditEvent, DB } from "../domain";
import { hashJson, id } from "./crypto";

// Demo persistence: a single JSON document, loaded once per process and flushed on change.
// This stands in for PostgreSQL in the real architecture; every mutation goes through the
// gateway services so swapping the storage layer does not touch domain logic.

// Serverless filesystems are read-only except the temp dir.
const DATA_DIR = process.env.ORBIS_DATA_DIR ?? (process.env.VERCEL ? path.join(os.tmpdir(), "orbis") : path.join(process.cwd(), ".data"));

/** Seed time anchored to the hour, so concurrently started serverless instances build the same tenant. */
export const seedAnchor = () => new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000);
const FILE = path.join(DATA_DIR, "store.json");
export const STORE_VERSION = 6;

export type LiveEvent =
  | { type: "action.created"; action_id: string; status: string; title: string }
  | { type: "approval.created"; approval_id: string; title: string; risk: string }
  | { type: "approval.resolved"; approval_id: string; status: string }
  | { type: "approval.escalated"; approval_id: string }
  | { type: "freeze.changed"; actor_id: string; frozen: boolean }
  | { type: "policy.published"; policy_id: string; version: number }
  | { type: "outcome.reported"; action_id: string; status: string }
  | { type: "protect.analyzed"; analysis_id: string; verdict: string }
  | { type: "ml.changed"; kind: string; version?: string }
  | { type: "demo.reset" };

interface Runtime {
  lastTick: number;
  gateway: typeof import("./gateway") | null;
  db: DB | null;
  bus: EventEmitter;
  flushTimer: NodeJS.Timeout | null;
  ticker: NodeJS.Timeout | null;
  seeding: Promise<DB> | null;
}

const g = globalThis as unknown as { __orbis?: Runtime };
const rt: Runtime = (g.__orbis ??= { db: null, bus: new EventEmitter(), flushTimer: null, ticker: null, seeding: null, lastTick: 0, gateway: null });
rt.bus.setMaxListeners(200);

async function syncedDb(): Promise<DB> {
  const sync = await import("./sync");
  const { applyOp } = await import("./ops");
  const { buildSeed } = await import("./seed");
  const rebuild = async (forceNew = false) => {
    const epoch = forceNew ? await sync.createEpoch(seedAnchor()) : await sync.resolveEpoch(seedAnchor);
    sync.resetApplied();
    const db = buildSeed(new Date(epoch.anchor));
    db.epoch_id = epoch.id;
    rt.db = db;
    await sync.pull(db, (env) => applyOp(db, env), true);
    return db;
  };
  if (!rt.db || !rt.db.epoch_id) {
    rt.seeding ??= rebuild().finally(() => (rt.seeding = null));
    await rt.seeding;
    startTicker();
  }
  const db = rt.db!;
  if ((await sync.pull(db, (env) => applyOp(db, env))) === "rebuild") {
    rt.seeding ??= rebuild().finally(() => (rt.seeding = null));
    await rt.seeding;
    emit({ type: "demo.reset" });
  }
  if (rt.gateway && Date.now() - rt.lastTick > 5000) {
    rt.lastTick = Date.now();
    rt.gateway.tick(rt.db!);
  }
  return rt.db!;
}

export async function getDb(): Promise<DB> {
  const sync = await import("./sync");
  if (sync.syncEnabled()) {
    try {
      return await syncedDb();
    } catch (e) {
      sync.tripBreaker(e);
    }
  }
  if (rt.db) {
    // Request-driven lifecycle tick: serverless instances may be frozen between requests.
    if (rt.gateway && Date.now() - rt.lastTick > 5000) {
      rt.lastTick = Date.now();
      rt.gateway.tick(rt.db);
    }
    return rt.db;
  }
  if (!rt.seeding) {
    rt.seeding = (async () => {
      let db: DB | null = null;
      try {
        const raw = JSON.parse(fs.readFileSync(FILE, "utf8")) as DB;
        // Re-seed stale demo data so pending approvals and "today" metrics stay current.
        const fresh = Date.now() - new Date(raw.seeded_at).getTime() < 20 * 3_600_000;
        if (raw.version === STORE_VERSION && (fresh || process.env.ORBIS_KEEP_DATA === "1")) db = raw;
      } catch {
        /* first run */
      }
      if (!db) {
        const { buildSeed } = await import("./seed");
        db = buildSeed(seedAnchor());
        rt.db = db;
        flushNow();
      }
      rt.db = db;
      startTicker();
      return db;
    })();
  }
  return rt.seeding;
}

export async function resetDb() {
  const sync = await import("./sync");
  if (sync.syncEnabled()) {
    try {
      const { buildSeed } = await import("./seed");
      const epoch = await sync.createEpoch(seedAnchor());
      sync.resetApplied();
      rt.db = buildSeed(new Date(epoch.anchor));
      rt.db.epoch_id = epoch.id;
      emit({ type: "demo.reset" });
      return rt.db;
    } catch (e) {
      sync.tripBreaker(e);
    }
  }
  const { buildSeed } = await import("./seed");
  rt.db = buildSeed(seedAnchor());
  flushNow();
  emit({ type: "demo.reset" });
  return rt.db;
}

function flushNow() {
  if (!rt.db) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rt.db));
  fs.renameSync(tmp, FILE);
}

export function persist() {
  if (rt.flushTimer) return;
  rt.flushTimer = setTimeout(() => {
    rt.flushTimer = null;
    try {
      flushNow();
    } catch (e) {
      console.error("[orbis] persist failed", (e as Error).message);
    }
  }, 250);
}

export function emit(e: LiveEvent) {
  rt.bus.emit("event", { ...e, at: new Date().toISOString() });
}

export function subscribe(fn: (e: LiveEvent & { at: string }) => void) {
  rt.bus.on("event", fn);
  return () => rt.bus.off("event", fn);
}

/** Append to the tamper-evident audit chain: each event commits to the previous event's hash. */
export function audit(db: DB, e: Omit<AuditEvent, "id" | "seq" | "prev_hash" | "hash" | "tenant_id"> & { tenant_id?: string }) {
  const prev = db.audit[db.audit.length - 1];
  const base = {
    id: id("evt"),
    seq: (prev?.seq ?? 0) + 1,
    tenant_id: e.tenant_id ?? db.tenant.id,
    at: e.at,
    type: e.type,
    actor: e.actor,
    target: e.target,
    summary: e.summary,
    data: e.data,
    prev_hash: prev?.hash ?? "0".repeat(64),
  };
  const ev: AuditEvent = { ...base, hash: hashJson(base) };
  db.audit.push(ev);
  return ev;
}

export function verifyAuditChain(db: DB) {
  let prev = "0".repeat(64);
  for (const ev of db.audit) {
    const { hash, ...rest } = ev;
    if (ev.prev_hash !== prev || hashJson(rest) !== hash) return { ok: false, broken_at: ev.seq, checked: db.audit.length };
    prev = hash;
  }
  return { ok: true, checked: db.audit.length, head: prev };
}

function startTicker() {
  if (rt.ticker) return;
  void import("./gateway").then((m) => (rt.gateway = m));
  rt.ticker = setInterval(async () => {
    try {
      rt.gateway ??= await import("./gateway");
      rt.lastTick = Date.now();
      if (rt.db) rt.gateway.tick(rt.db);
    } catch (e) {
      console.error("[orbis] tick failed", (e as Error).message);
    }
  }, 5000);
  rt.ticker.unref?.();
}

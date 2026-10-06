import "server-only";
import { randomBytes } from "node:crypto";
import { get, list, put } from "@vercel/blob";
import type { DB } from "../domain";
import type { OpEnvelope } from "./ops";

/**
 * Cross-instance consistency for serverless deployments (enabled when BLOB_READ_WRITE_TOKEN is set).
 *
 * - An *epoch* pins the seed anchor, so every instance builds the identical deterministic tenant.
 * - Every mutation is appended to a private, append-only op log in Vercel Blob.
 * - Before serving, an instance replays ops it hasn't applied yet (same ids, same timestamps).
 *
 * Locally (no token) this is a no-op and the single process is the source of truth.
 */
export const syncEnabled = () => !!process.env.BLOB_READ_WRITE_TOKEN;

// Namespaced per environment so local and preview runs never touch the production demo log.
const ROOT = `orbis-relay/${process.env.VERCEL_ENV ?? "local"}/v2`;
const EPOCH_TTL_MS = 20 * 3_600_000;
const PULL_INTERVAL_MS = 350;
const EPOCH_CHECK_MS = 10_000;

export interface Epoch {
  id: string;
  anchor: string;
  created_at: string;
}

interface SyncState {
  applied: Set<string>;
  lastPull: number;
  lastEpochCheck: number;
  pulling: Promise<void> | null;
}
const g = globalThis as unknown as { __orbisSync?: SyncState };
const st: SyncState = (g.__orbisSync ??= { applied: new Set(), lastPull: 0, lastEpochCheck: 0, pulling: null });

const pad = (n: number) => String(n).padStart(15, "0");
const opts = { access: "private" as const, addRandomSuffix: false, contentType: "application/json" };

async function readJson<T>(pathname: string): Promise<T | null> {
  const r = await get(pathname, { access: "private", useCache: false });
  if (!r) return null;
  return JSON.parse(await new Response(r.stream).text()) as T;
}

async function listAll(prefix: string) {
  const out: Array<{ pathname: string }> = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    out.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out.sort((a, b) => a.pathname.localeCompare(b.pathname));
}

export async function latestEpoch(): Promise<Epoch | null> {
  const blobs = await listAll(`${ROOT}/epochs/`);
  const last = blobs[blobs.length - 1];
  return last ? readJson<Epoch>(last.pathname) : null;
}

export async function createEpoch(anchor: Date): Promise<Epoch> {
  const e: Epoch = { id: randomBytes(6).toString("hex"), anchor: anchor.toISOString(), created_at: new Date().toISOString() };
  await put(`${ROOT}/epochs/${pad(Date.now())}-${e.id}.json`, JSON.stringify(e), opts);
  st.applied = new Set();
  return e;
}

/** The epoch this instance should be on: latest shared one, or a fresh one if none/expired. */
export async function resolveEpoch(anchor: () => Date): Promise<Epoch> {
  const e = await latestEpoch();
  if (e && Date.now() - Date.parse(e.created_at) < EPOCH_TTL_MS) return e;
  return createEpoch(anchor());
}

export function markApplied(opId: string) {
  st.applied.add(opId);
}

export async function recordOp(db: DB, env: OpEnvelope) {
  if (!syncEnabled() || !db.epoch_id) return;
  await put(`${ROOT}/ops/${db.epoch_id}/${pad(Date.parse(env.at))}-${env.id}.json`, JSON.stringify(env), opts);
}

/**
 * Replay unseen ops. Returns "rebuild" when another instance started a new epoch (demo reset or expiry).
 */
export async function pull(db: DB, apply: (env: OpEnvelope) => void, force = false): Promise<"ok" | "rebuild"> {
  if (!syncEnabled() || !db.epoch_id) return "ok";
  if (!force && Date.now() - st.lastPull < PULL_INTERVAL_MS) {
    if (st.pulling) await st.pulling;
    return "ok";
  }
  if (Date.now() - st.lastEpochCheck > EPOCH_CHECK_MS) {
    st.lastEpochCheck = Date.now();
    const e = await latestEpoch();
    if (e && e.id !== db.epoch_id) return "rebuild";
  }
  if (st.pulling) {
    await st.pulling;
    return "ok";
  }
  st.pulling = (async () => {
    st.lastPull = Date.now();
    const blobs = await listAll(`${ROOT}/ops/${db.epoch_id}/`);
    const pending = blobs.filter((b) => !st.applied.has(b.pathname.slice(b.pathname.lastIndexOf("-") + 1, -".json".length)));
    const envs = await Promise.all(pending.map((b) => readJson<OpEnvelope>(b.pathname)));
    for (const env of envs) {
      if (!env || st.applied.has(env.id)) continue;
      st.applied.add(env.id);
      try {
        apply(env);
      } catch {
        // Conflicting replay (e.g. two instances answered the same approval) — first writer wins.
      }
    }
  })().finally(() => {
    st.pulling = null;
  });
  await st.pulling;
  return "ok";
}

export function resetApplied() {
  st.applied = new Set();
  st.lastPull = 0;
  st.lastEpochCheck = Date.now();
}

/**
 * @orbis/sdk — the safe path to "may I do this?".
 *
 *   const orbis = new OrbisClient({ apiKey: process.env.ORBIS_API_KEY! });
 *   const decision = await orbis.preflight({ actor, action, resources, destination, intent });
 *   if (decision.isAllowed()) await execute();
 *   else if (decision.requiresApproval()) {
 *     const final = await decision.waitForResolution({ timeoutMs: 600_000 });
 *     if (final.approved) await execute(final.approvedParameters);
 *   }
 *   await orbis.reportOutcome(decision.actionId, "succeeded");
 *
 * The SDK never executes your action. It returns authorization state; your code decides.
 */
import type { ActionEnvelope } from "@orbis/policy-core";

export type PreflightInput = Omit<ActionEnvelope, "request_id"> & { request_id?: string };
export type OutcomeStatus = "succeeded" | "failed" | "not_executed" | "unknown";

export interface DecisionPayload {
  decision_id: string;
  action_id: string;
  request_id: string;
  status: "allow" | "warn" | "deny" | "approval_required";
  final_status: string;
  effect: string;
  frozen: boolean;
  mode: "enforce" | "observe";
  risk: { score: number; level: "low" | "medium" | "high" | "critical"; reasons: string[] };
  policy: { id: string; name: string; version: number; rule_id: string; reason: string } | null;
  approval: { id: string; status: string; route: string; expires_at: string; step_up: string; quorum: { required: number; of: number } | null; status_url: string } | null;
  safe_alternatives: Array<{ id: string; type: string; label: string; description: string }>;
  approved_parameters: Record<string, string | number | boolean> | null;
  receipt_id: string | null;
  latency_ms: number;
  idempotent_replay: boolean;
}

export interface Resolution {
  approved: boolean;
  status: "approved" | "approved_modified" | "rejected" | "expired" | "cancelled" | "timeout";
  approvedParameters: Record<string, string | number | boolean> | null;
  receiptId: string | null;
}

export class OrbisError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public remediation?: string,
  ) {
    super(`${code}: ${message}${remediation ? ` — ${remediation}` : ""}`);
    this.name = "OrbisError";
  }
}

export interface OrbisClientOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  /** Retries for network errors and 5xx on idempotent calls (preflight uses request_id for idempotency). */
  maxRetries?: number;
  fetch?: typeof fetch;
}

export class OrbisClient {
  private baseUrl: string;
  readonly #apiKey: string;
  private timeoutMs: number;
  private maxRetries: number;
  private fetchImpl: typeof fetch;

  constructor(opts: OrbisClientOptions) {
    if (!opts.apiKey) throw new Error("OrbisClient: apiKey is required");
    this.#apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? "http://localhost:4310").replace(/\/$/, "") + "/api/v1";
    this.timeoutMs = opts.timeoutMs ?? 10_000;
    this.maxRetries = opts.maxRetries ?? 2;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /** @internal */
  async request<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
    let attempt = 0;
    for (;;) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
      try {
        const res = await this.fetchImpl(this.baseUrl + path, {
          method,
          headers: { authorization: `Bearer ${this.#apiKey}`, "content-type": "application/json", "user-agent": "orbis-sdk-ts/0.1.0", ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctl.signal,
        });
        const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; remediation?: string } };
        if (res.ok) return data as T;
        if (res.status >= 500 && attempt < this.maxRetries) throw new OrbisError(res.status, "server_error", "retryable");
        throw new OrbisError(res.status, data.error?.code ?? "http_error", data.error?.message ?? res.statusText, data.error?.remediation);
      } catch (e) {
        const retryable = !(e instanceof OrbisError) || e.status >= 500;
        if (retryable && attempt < this.maxRetries) {
          attempt += 1;
          await sleep(200 * 2 ** attempt + Math.random() * 100);
          continue;
        }
        throw e instanceof OrbisError ? e : new OrbisError(0, "network_error", (e as Error).message, "Check baseUrl and network connectivity.");
      } finally {
        clearTimeout(timer);
      }
    }
  }

  /** Ask before acting. Safe to retry: the request_id makes it idempotent. */
  async preflight(input: PreflightInput): Promise<Decision> {
    const request_id = input.request_id ?? `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const data = await this.request<DecisionPayload>("POST", "/decisions/preflight", { ...input, request_id });
    return new Decision(this, data);
  }

  /** The workflow already knows a human must decide. */
  async createApproval(input: PreflightInput & { route: string; reason?: string }): Promise<Decision> {
    const request_id = input.request_id ?? `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    return new Decision(this, await this.request<DecisionPayload>("POST", "/approvals", { ...input, request_id }));
  }

  getApproval(id: string) {
    return this.request<{ id: string; status: string; final_status: string; approved_parameters: Record<string, string | number | boolean> | null; receipt_id: string | null; expires_at: string }>("GET", `/approvals/${id}`);
  }

  cancelApproval(id: string) {
    return this.request<{ id: string; status: string }>("POST", `/approvals/${id}/cancel`, {});
  }

  /** Report what actually happened downstream. Idempotent for the same status. */
  reportOutcome(actionId: string, status: OutcomeStatus, detail?: string) {
    return this.request<{ action_id: string; receipt_id: string }>("POST", `/actions/${actionId}/outcome`, { status, detail });
  }

  getReceipt(id: string) {
    return this.request<{ id: string; body: Record<string, unknown>; body_hash: string; signature: string; key_id: string; alg: string }>("GET", `/receipts/${id}`);
  }

  verifyReceipt(id: string) {
    return this.request<{ valid: boolean; signature_valid: boolean; hash_valid: boolean }>("POST", `/receipts/${id}/verify`, {});
  }
}

export class Decision implements DecisionPayload {
  decision_id!: string;
  action_id!: string;
  request_id!: string;
  status!: DecisionPayload["status"];
  final_status!: string;
  effect!: string;
  frozen!: boolean;
  mode!: DecisionPayload["mode"];
  risk!: DecisionPayload["risk"];
  policy!: DecisionPayload["policy"];
  approval!: DecisionPayload["approval"];
  safe_alternatives!: DecisionPayload["safe_alternatives"];
  approved_parameters!: DecisionPayload["approved_parameters"];
  receipt_id!: string | null;
  latency_ms!: number;
  idempotent_replay!: boolean;

  // ES private field: never enumerable, so serializing a Decision can't leak the client or its API key.
  readonly #client: OrbisClient;

  constructor(client: OrbisClient, data: DecisionPayload) {
    Object.assign(this, data);
    this.#client = client;
  }

  get actionId() {
    return this.action_id;
  }
  /** allow or warn (warn = allowed, someone was notified). Observe-mode integrations are always allowed. */
  isAllowed() {
    return this.status === "allow" || this.status === "warn" || (this.mode === "observe" && this.status !== "deny");
  }
  isDenied() {
    return this.status === "deny";
  }
  requiresApproval() {
    return this.status === "approval_required" && this.mode === "enforce";
  }

  /** Poll until a human resolves the approval, it expires, or the timeout elapses. Never executes anything. */
  async waitForResolution(opts: { timeoutMs?: number; pollMs?: number; signal?: AbortSignal; onUpdate?: (status: string) => void } = {}): Promise<Resolution> {
    if (!this.approval) throw new Error("waitForResolution: this decision does not require approval");
    const deadline = Date.now() + (opts.timeoutMs ?? 600_000);
    const poll = opts.pollMs ?? 1500;
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) break;
      const a = await this.#client.getApproval(this.approval.id);
      opts.onUpdate?.(a.status);
      if (a.status !== "pending") {
        const approved = a.status === "approved" || a.status === "approved_modified";
        return { approved, status: a.status as Resolution["status"], approvedParameters: a.approved_parameters, receiptId: a.receipt_id };
      }
      await sleep(poll);
    }
    return { approved: false, status: "timeout", approvedParameters: null, receiptId: null };
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ webhooks

/**
 * Verify an `Orbis-Signature: t=<unix>,v1=<hex>` header. Constant-time compare, replay window.
 * Works in Node 18+, Deno, Bun, edge runtimes (WebCrypto).
 */
export async function verifyWebhookSignature(secret: string, header: string, rawBody: string, toleranceSeconds = 300): Promise<boolean> {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=") as [string, string]));
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`)));
  const expected = [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (expected.length !== parts.v1.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ parts.v1.charCodeAt(i);
  return diff === 0;
}

export { createAgentAdapter, ToolBlockedError } from "./agent";

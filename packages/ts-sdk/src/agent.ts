/**
 * Orbis Agent Adapter — explicit opt-in middleware for agent tool calls (blueprint §4.5).
 *
 * You register each tool with a classifier that turns its arguments into a redacted action
 * envelope. The adapter asks Orbis first; only when authorized does it call YOUR tool function,
 * with server-approved parameters merged in (e.g. a safe redirect). Denials surface to the agent
 * as a ToolBlockedError it can reason about.
 */
import type { ActionEnvelope } from "@orbis/policy-core";
import type { OrbisClient, Resolution } from "./index";

export class ToolBlockedError extends Error {
  constructor(
    public tool: string,
    public reason: string,
    public status: string,
    public receiptId: string | null,
  ) {
    super(`Tool "${tool}" blocked by Orbis (${status}): ${reason}`);
    this.name = "ToolBlockedError";
  }
}

export interface ToolSpec<A extends Record<string, unknown>, R> {
  name: string;
  run: (args: A) => Promise<R>;
  /** Map tool args → redacted envelope fields. Never put raw secrets or full documents here. */
  classify: (args: A) => Omit<ActionEnvelope, "request_id" | "actor">;
  /** How server-approved parameters (edits / safe alternatives) map back onto tool args. */
  applyApproved?: (args: A, approved: Record<string, string | number | boolean>) => A;
}

export interface AdapterEvents {
  onDecision?: (tool: string, status: string, risk: number) => void;
  onWaiting?: (tool: string, approvalId: string) => void;
  onResolved?: (tool: string, r: Resolution) => void;
}

export function createAgentAdapter(client: OrbisClient, actor: ActionEnvelope["actor"], events: AdapterEvents = {}) {
  return {
    wrap<A extends Record<string, unknown>, R>(spec: ToolSpec<A, R>) {
      return async (args: A): Promise<R> => {
        const decision = await client.preflight({ ...spec.classify(args), actor, action: { ...spec.classify(args).action, tool: spec.name } });
        events.onDecision?.(spec.name, decision.status, decision.risk.score);
        let effectiveArgs = args;
        if (decision.isDenied()) throw new ToolBlockedError(spec.name, decision.policy?.reason ?? "Denied by policy", decision.frozen ? "frozen" : "deny", decision.receipt_id);
        if (decision.requiresApproval()) {
          events.onWaiting?.(spec.name, decision.approval!.id);
          const r = await decision.waitForResolution({ timeoutMs: 15 * 60_000 });
          events.onResolved?.(spec.name, r);
          if (!r.approved) throw new ToolBlockedError(spec.name, `Human decision: ${r.status}`, r.status, r.receiptId);
          if (r.approvedParameters && spec.applyApproved) effectiveArgs = spec.applyApproved(args, r.approvedParameters);
        }
        try {
          const out = await spec.run(effectiveArgs);
          await client.reportOutcome(decision.actionId, "succeeded").catch(() => undefined);
          return out;
        } catch (e) {
          await client.reportOutcome(decision.actionId, "failed", (e as Error).message).catch(() => undefined);
          throw e;
        }
      };
    },
  };
}

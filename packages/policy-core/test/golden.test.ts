import { describe, expect, it } from "vitest";
import golden from "../../../fixtures/decisions/golden.json";
import { APPROVED_DESTINATIONS, DEFAULT_POLICIES, evaluate, publishedVersion, type ActionEnvelope } from "../src";

// Policy regression: these decisions must never change silently after a refactor.
const live = DEFAULT_POLICIES.map((p) => ({ policy: p, version: publishedVersion(p)! }));

describe("golden decision fixtures", () => {
  it.each(golden as Array<{ name: string; frozen?: string[]; expect: { status: string; effect?: string; rule?: string; step_up?: string }; envelope: ActionEnvelope }>)("$name", (g) => {
    const e = evaluate(g.envelope, live, {
      now: new Date("2026-10-06T15:00:00Z"),
      frozenActors: new Set(g.frozen ?? []),
      approvedDestinations: new Set(APPROVED_DESTINATIONS),
      knownDestinations: new Set(APPROVED_DESTINATIONS),
    });
    expect(e.status).toBe(g.expect.status);
    if (g.expect.effect) expect(e.effect).toBe(g.expect.effect);
    if (g.expect.rule) expect(e.deciding?.rule_id).toBe(g.expect.rule);
    if (g.expect.step_up) expect(e.approval?.step_up).toBe(g.expect.step_up);
  });
});

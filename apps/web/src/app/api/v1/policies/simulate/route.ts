import { simulate, publishedVersion, type PolicyRule, type PolicyVersion } from "@orbis/policy-core";
import { requireUser } from "@/lib/server/auth";
import { ApiError, contextFor, liveVersions } from "@/lib/server/gateway";
import { handle, json, readJson } from "@/lib/server/http";

/**
 * POST /v1/policies/simulate — replay a candidate policy version (or ad-hoc rules) against
 * recent real action envelopes and diff the decisions against what is live today.
 */
export const POST = handle(async (req: Request) => {
  const { db } = await requireUser(req);
  const body = await readJson<{ policy_id?: string; version?: number; rules?: PolicyRule[]; limit?: number }>(req);
  const policy = db.policies.find((p) => p.id === body.policy_id);
  if (!policy) throw new ApiError(404, "not_found", "Policy not found.");
  let candidate: PolicyVersion | undefined;
  if (Array.isArray(body.rules)) {
    candidate = { policy_id: policy.id, version: -1, status: "draft", rules: body.rules, change_note: "ad-hoc", created_at: new Date().toISOString(), created_by: "simulator" };
  } else {
    candidate = policy.versions.find((v) => v.version === (body.version ?? Math.max(...policy.versions.map((x) => x.version))));
  }
  if (!candidate) throw new ApiError(404, "version_not_found", "Candidate version not found.");
  const live = liveVersions(db);
  const cand = live.map((v) => (v.policy.id === policy.id ? { policy: v.policy, version: candidate! } : v));
  if (!live.some((v) => v.policy.id === policy.id)) cand.push({ policy, version: candidate });
  const limit = Math.min(1500, body.limit ?? 1500);
  const sample = db.actions.slice(-limit).map((a) => ({ id: a.id, envelope: a.envelope, at: new Date(a.received_at) }));
  const result = simulate(sample, live, cand, (at) => ({ ...contextFor(db, at), frozenActors: new Set() }));
  return json({
    policy_id: policy.id,
    live_version: publishedVersion(policy)?.version ?? null,
    candidate_version: candidate.version,
    ...result,
    rows: result.rows.filter((r) => r.changed).sort((a, b) => Number(b.current.status !== b.candidate.status) - Number(a.current.status !== a.candidate.status)).slice(0, 200),
    sample_rows: result.rows.slice(-12),
  });
});

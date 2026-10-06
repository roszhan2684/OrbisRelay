import "server-only";
import type { DB, MlModelRecord, User } from "../domain";
import { ApiError } from "./gateway";
import { lifecycleAt, REGISTRY, registryEntry, roleVersions } from "./ml";

/** Strong authorization for model mutations: admin role + fresh step-up (passkey on web, Face ID on iOS). */
export function requireMlAdmin(user: User, body: { step_up?: { verified?: boolean; method?: string } }, roles = ["owner", "admin", "policy_admin"]) {
  if (!user.roles.some((r) => roles.includes(r))) throw new ApiError(403, "forbidden", "This model operation requires an admin or policy admin.");
  if (!body.step_up?.verified) throw new ApiError(428, "step_up_required", "Model lifecycle changes require step-up verification.", "Confirm with your passkey (web) or Face ID (iOS) and resubmit.");
}

export function modelView(db: DB, m: MlModelRecord) {
  const e = registryEntry(m.version);
  const roles = roleVersions(db);
  return {
    version: m.version,
    status: m.status,
    rollout_percent: m.rollout_percent,
    created_at: m.created_at,
    history: m.history,
    role: roles.production === m.version ? "production" : roles.canary?.version === m.version ? "canary" : roles.shadow === m.version ? "shadow" : null,
    endpoints: db.ml.endpoints.filter((ep) => ep.model_version === m.version).length,
    architecture: e?.architecture ?? null,
    n_params: e?.n_params ?? null,
    dataset: e?.dataset ?? null,
    origin: e?.origin ?? null,
    trained_at: e?.trained_at ?? null,
    mlflow_run_id: e?.mlflow_run_id ?? null,
    metrics: e?.metrics ?? null,
    gates: e?.gates ?? null,
    parity: e?.parity ?? null,
    benchmark: e?.benchmark ?? null,
    reproducibility: e?.reproducibility ?? null,
    artifacts: e?.artifacts ?? null,
    comparison: (e as { comparison?: { window_holdout: Record<string, { production: number | null; candidate: number | null }> } } | undefined)?.comparison ?? null,
  };
}

export function modelsView(db: DB) {
  return {
    model_name: REGISTRY.model_name,
    feature_schema: REGISTRY.feature_schema,
    manifest_seq: db.ml.manifest_seq,
    kill_switch: db.ml.kill_switch,
    fusion: db.ml.fusion,
    roles: roleVersions(db),
    lifecycle_now: lifecycleAt(db, Date.now()),
    versions: db.ml.models.map((m) => modelView(db, m)),
  };
}

import type { Metadata } from "next";
import { currentConsoleUser } from "@/lib/server/auth";
import { reviewQueue } from "@/lib/server/ml";
import { actionTitle } from "@/lib/server/gateway";
import { PageHeader } from "@/components/console/shell";
import { IntelTabs } from "@/components/console/intel";
import { ReviewBoard, type FeedbackRow, type QueueItem } from "./review-board";

export const metadata: Metadata = { title: "Review queue · Intelligence" };
export const dynamic = "force-dynamic";

export default async function ReviewPage() {
  const { db, user } = await currentConsoleUser();
  if (!user) return null;
  const q = reviewQueue(db, 40);
  const title = (actionId: string) => {
    const a = db.actions.find((x) => x.id === actionId);
    return a ? actionTitle(a.envelope) : actionId;
  };
  const actor = (id: string) => db.actors.find((a) => a.id === id)?.name ?? id;
  const items: QueueItem[] = q.items.map(({ p, why }) => ({ id: p.id, at: p.at, actor: actor(p.actor_id), title: title(p.action_id), model_version: p.model_version, class: p.class!, risk: p.risk ?? 0, abstain: p.abstain, reasons: p.reasons.map((r) => r.code), explanation: p.explanation, why, decision: db.actions.find((a) => a.id === p.action_id)?.final_status ?? p.deterministic_status, fusion: p.fusion.rule, local: !!p.local }));
  const feedback: FeedbackRow[] = [...db.ml.feedback].reverse().slice(0, 40).map((f) => ({ id: f.id, label: f.label, label_state: f.label_state, reviewed_by: f.reviewed_by, reviewed_at: f.reviewed_at, title: title(f.action_id), note: f.note }));
  return (
    <>
      <PageHeader eyebrow="Ground truth" title="Review queue" description="Most production security events never arrive with labels. Analysts label the cases that teach the model most; “a human approved it” is recorded as a weak proxy, not ground truth." />
      <IntelTabs reviewCount={q.total} />
      <ReviewBoard items={items} total={q.total} feedback={feedback} canLabel={user.roles.some((r) => ["owner", "admin", "policy_admin", "auditor", "responder"].includes(r))} />
    </>
  );
}

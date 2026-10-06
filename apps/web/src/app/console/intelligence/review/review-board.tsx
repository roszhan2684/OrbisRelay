"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { Badge, Button, Card, CardHeader } from "@/components/ui";
import { api } from "@/components/console/live";
import { LABEL_TEXT, LABEL_TONE, LABELS } from "@/lib/ml-format";
import { RelTime } from "@/components/console/time";

export interface QueueItem { id: string; at: string; actor: string; title: string; model_version: string | null; class: string; risk: number; abstain: boolean; reasons: string[]; explanation: string; why: string[]; decision: string; fusion: string; local: boolean }
export interface FeedbackRow { id: string; label: string; label_state: string; reviewed_by: string; reviewed_at: string; title: string; note?: string }

const WHY: Record<string, string> = { out_of_distribution: "out of distribution", uncertain: "uncertain", model_escalated_policy_allowed: "model escalated · policy allowed", policy_escalated_model_allowed: "policy escalated · model allowed", endpoint_cloud_disagreement: "endpoint ≠ cloud", model_changed_outcome: "model changed outcome", novel_combination: "novel combination", high_impact: "high impact" };

export function ReviewBoard({ items, total, feedback, canLabel }: { items: QueueItem[]; total: number; feedback: FeedbackRow[]; canLabel: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const label = async (id: string, l: string) => {
    setBusy(id);
    try {
      await api(`/api/v1/ml/review/${id}`, { method: "POST", json: { label: l } });
      toast.success(`Labelled ${LABEL_TEXT[l]}`, { description: "Queued for the next dataset version — the live model does not change." });
      router.refresh();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="grid gap-4 xl:grid-cols-[1.6fr_1fr]">
      <Card>
        <CardHeader title={`Active-review queue · ${total}`} description="Uncertain predictions, policy/model disagreements, endpoint/cloud disagreements, novel combinations and high-impact escalations — highest priority first." />
        <ul className="divide-y divide-line">
          {items.map((it) => (
            <li key={it.id} className="px-5 py-3.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-[13.5px] font-medium text-ink">{it.title}</div>
                  <div className="text-[12px] text-muted">{it.actor} · <RelTime iso={it.at} /> · policy {it.decision} · model {it.model_version} {it.local && "· endpoint signal"}</div>
                </div>
                <div className="flex items-center gap-1.5"><Badge tone={LABEL_TONE[it.class] === "neutral" ? "neutral" : LABEL_TONE[it.class]}>{LABEL_TEXT[it.class]} · {it.risk.toFixed(2)}</Badge>{it.abstain && <Badge tone="medium">abstained</Badge>}</div>
              </div>
              <p className="mt-1.5 text-[12.5px] text-ink-2">{it.explanation}</p>
              <div className="mt-1.5 flex flex-wrap gap-1">{it.why.map((w) => <span key={w} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted ring-1 ring-inset ring-line">{WHY[w] ?? w}</span>)}</div>
              {canLabel && (
                <div className="mt-2.5 flex flex-wrap gap-1.5">
                  {LABELS.map((l) => <Button key={l} size="sm" variant="secondary" disabled={busy === it.id} onClick={() => label(it.id, l)}>{LABEL_TEXT[l]}</Button>)}
                </div>
              )}
            </li>
          ))}
          {!items.length && <li className="px-5 py-8 text-center text-[13px] text-muted">Queue is empty.</li>}
        </ul>
      </Card>
      <Card>
        <CardHeader title="Labels" description="Analyst reviews (0.95 confidence) and human approval proxies (0.5). Never applied online." action={<a href="/api/v1/ml/feedback/export" className="inline-flex items-center gap-1.5 rounded-[10px] border border-line-strong bg-surface px-3 py-1.5 text-[13px] font-medium text-ink shadow-card hover:bg-surface-2"><Download className="size-3.5" /> JSONL</a>} />
        <ul className="divide-y divide-line">
          {feedback.map((f) => (
            <li key={f.id} className="px-5 py-2.5 text-[12.5px]">
              <div className="flex items-center justify-between gap-2"><span className="truncate text-ink">{f.title}</span><Badge tone={LABEL_TONE[f.label] === "neutral" ? "neutral" : LABEL_TONE[f.label]}>{LABEL_TEXT[f.label]}</Badge></div>
              <div className="text-muted">{f.label_state.replace(/_/g, " ")} · {f.reviewed_by} · <RelTime iso={f.reviewed_at} />{f.note ? ` · ${f.note}` : ""}</div>
            </li>
          ))}
        </ul>
        <p className="border-t border-line px-5 py-3 text-[12px] text-muted">Retrain with <span className="font-mono">python -m orbis_ml retrain --feedback orbis-feedback.jsonl</span> → new dataset version → candidate → release gates.</p>
      </Card>
    </div>
  );
}

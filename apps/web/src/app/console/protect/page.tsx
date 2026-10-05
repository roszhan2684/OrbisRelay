import type { Metadata } from "next";
import { currentConsoleUser } from "@/lib/server/auth";
import { PageHeader } from "@/components/console/shell";
import { ProtectPanel } from "@/components/protect-panel";
import { Badge, Card, CardHeader } from "@/components/ui";
import { RelTime } from "@/components/console/time";
import urlCard from "@/lib/ml/cards/url.json";
import msgCard from "@/lib/ml/cards/message.json";

export const metadata: Metadata = { title: "Protect" };
export const dynamic = "force-dynamic";

type CardJson = { model: string; version: string; task: string; algorithm: string; data: { sources: Array<{ name: string; url: string; license?: string }>; [k: string]: unknown }; metrics: { test: { accuracy: number; precision: number; recall: number; f1: number; roc_auc: number; n: number } }; limitations: string[] };

export default async function ProtectPage() {
  const { db } = await currentConsoleUser();
  const history = [...db.protect].reverse().slice(0, 14);
  const name = (id: string) => db.users.find((u) => u.id === id)?.name ?? id;
  return (
    <>
      <PageHeader eyebrow="Mobile trust tools" title="Protect" description="“Is this safe?” for links, messages, QR codes and screenshots employees explicitly share — powered by two models trained from scratch on public datasets." />
      <ProtectPanel />
      <div className="mt-4 grid gap-4 xl:grid-cols-[1fr_1fr]">
        <Card>
          <CardHeader title="Recent checks across Northstar" description="Shared from Orbis iOS (share sheet, QR scanner, screenshot)" />
          <ul className="divide-y divide-line">
            {history.map((h) => (
              <li key={h.id} className="flex items-center gap-3 px-5 py-2.5 text-[13.5px]">
                <Badge tone={h.verdict === "dangerous" ? "critical" : h.verdict === "caution" ? "medium" : "low"} className="w-[84px] justify-center capitalize">{h.verdict}</Badge>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{h.input_preview}</span>
                  <span className="block text-[12px] text-muted">{name(h.user_id)} · {h.kind} · {h.channel}</span>
                </span>
                <span className="text-[12px] text-muted"><RelTime iso={h.created_at} /></span>
              </li>
            ))}
          </ul>
        </Card>
        <div className="space-y-4">
          {[urlCard as CardJson, msgCard as CardJson].map((c) => (
            <Card key={c.model}>
              <CardHeader title={<span className="font-mono text-[14px]">{c.model}@{c.version}</span>} description={c.task} />
              <div className="space-y-3 p-5 text-[13px]">
                <div className="grid grid-cols-5 gap-2 text-center">
                  {(["roc_auc", "f1", "precision", "recall", "accuracy"] as const).map((k) => (
                    <div key={k} className="rounded-lg bg-surface-2 px-2 py-2">
                      <div className="tnum text-[17px] font-semibold">{c.metrics.test[k].toFixed(3)}</div>
                      <div className="text-[11px] uppercase tracking-wide text-muted">{k.replace("_", "-")}</div>
                    </div>
                  ))}
                </div>
                <p className="text-ink-2">{c.algorithm}. Held-out test set n={c.metrics.test.n.toLocaleString()}.</p>
                <p className="text-muted">Data: {c.data.sources.map((s, i) => <span key={s.url}>{i > 0 && " + "}<a className="text-cobalt hover:underline" href={s.url} target="_blank" rel="noreferrer">{s.name}</a>{s.license ? ` (${s.license})` : ""}</span>)}</p>
                <ul className="list-disc space-y-1 pl-4 text-[12.5px] text-muted">{c.limitations.map((l) => <li key={l}>{l}</li>)}</ul>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </>
  );
}

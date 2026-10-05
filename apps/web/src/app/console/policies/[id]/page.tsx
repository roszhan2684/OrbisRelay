import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { currentConsoleUser } from "@/lib/server/auth";
import { daysAgo } from "@/lib/server/clock";
import { PageHeader } from "@/components/console/shell";
import { Badge } from "@/components/ui";
import { PolicyStudio } from "./policy-studio";

export const metadata: Metadata = { title: "Policy" };
export const dynamic = "force-dynamic";

export default async function PolicyPage({ params }: PageProps<"/console/policies/[id]">) {
  const { id } = await params;
  const { db, user } = await currentConsoleUser();
  const policy = db.policies.find((p) => p.id === id);
  if (!policy || !user) notFound();
  const since = daysAgo(28);
  const hits: Record<string, number> = {};
  for (const a of db.actions) {
    if (new Date(a.received_at).getTime() < since) continue;
    for (const m of a.evaluation.matched) if (m.policy_id === id) hits[m.rule_id] = (hits[m.rule_id] ?? 0) + 1;
  }
  const admins = db.users.filter((u) => u.roles.includes("policy_admin") && u.id !== user.id).map((u) => ({ id: u.id, name: u.name }));
  return (
    <>
      <Link href="/console/policies" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted hover:text-ink"><ChevronLeft className="size-4" /> Policies</Link>
      <PageHeader eyebrow={policy.pack} title={policy.name} description={policy.description} actions={<Badge tone="neutral" className="font-mono">{policy.id}</Badge>} />
      <PolicyStudio key={`${policy.id}-${policy.current_version}-${policy.versions.length}`} policy={policy} admins={admins} hits={hits} />
    </>
  );
}

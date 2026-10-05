import type { Metadata } from "next";
import { Suspense } from "react";
import { currentConsoleUser } from "@/lib/server/auth";
import { actionSummary } from "@/lib/server/present";
import { PageHeader } from "@/components/console/shell";
import { ActionsExplorer } from "./actions-explorer";

export const metadata: Metadata = { title: "Actions" };
export const dynamic = "force-dynamic";

export default async function ActionsPage() {
  const { db } = await currentConsoleUser();
  const rows = db.actions.map((a) => actionSummary(db, a));
  return (
    <>
      <PageHeader eyebrow="Action explorer" title="Actions" description="Every proposed action, the policy that decided it, who was involved, and what actually happened downstream." />
      <Suspense>
        <ActionsExplorer rows={rows} integrations={db.integrations.map((i) => ({ id: i.id, name: i.name }))} actors={db.actors.map((a) => ({ id: a.id, name: a.name }))} />
      </Suspense>
    </>
  );
}

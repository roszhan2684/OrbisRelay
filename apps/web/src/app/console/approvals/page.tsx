import type { Metadata } from "next";
import { Suspense } from "react";
import { currentConsoleUser } from "@/lib/server/auth";
import { approvalView } from "@/lib/server/present";
import { PageHeader } from "@/components/console/shell";
import { ApprovalsBoard } from "./approvals-board";

export const metadata: Metadata = { title: "Approvals" };
export const dynamic = "force-dynamic";

export default async function ApprovalsPage() {
  const { db, user } = await currentConsoleUser();
  if (!user) return null;
  const items = [...db.approvals]
    .sort((a, b) => (a.status === "pending" && b.status === "pending" ? b.risk.score - a.risk.score : b.created_at.localeCompare(a.created_at)))
    .slice(0, 200)
    .map((a) => approvalView(db, a, user));
  items.sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending"));
  const users = Object.fromEntries(db.users.map((u) => [u.id, { name: u.name, color: u.color, title: u.title }]));
  return (
    <>
      <PageHeader eyebrow="Human decisions" title="Approvals" description="Queues, routing, SLA and quorum for actions that need a verified human. The same decisions appear on every assigned approver's iPhone." />
      <Suspense>
        <ApprovalsBoard initial={items as never} users={users} />
      </Suspense>
    </>
  );
}

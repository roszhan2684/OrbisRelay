import type { Metadata } from "next";
import { currentConsoleUser } from "@/lib/server/auth";
import { PageHeader } from "@/components/console/shell";
import { AuditView } from "./audit-view";

export const metadata: Metadata = { title: "Audit" };
export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const { db } = await currentConsoleUser();
  return (
    <>
      <PageHeader eyebrow="Evidence" title="Audit trail" description="Append-only, hash-chained record of every decision, approval, policy change, key and freeze. Exportable for auditors." />
      <AuditView initial={db.audit.slice(-300).reverse()} total={db.audit.length} />
    </>
  );
}

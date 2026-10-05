import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { BookOpen, FileJson } from "lucide-react";
import { currentConsoleUser } from "@/lib/server/auth";
import { DEMO_KEYS } from "@/lib/server/seed";
import { PageHeader } from "@/components/console/shell";
import { Button } from "@/components/ui";
import { DeveloperView } from "./developer-view";

export const metadata: Metadata = { title: "Developer" };
export const dynamic = "force-dynamic";

export default async function DeveloperPage() {
  const { db } = await currentConsoleUser();
  const h = await headers();
  const base = `${h.get("x-forwarded-proto") ?? "http"}://${h.get("host") ?? "localhost:4310"}`;
  return (
    <>
      <PageHeader
        eyebrow="Developer portal"
        title="Developer"
        description="SDKs for TypeScript, Python and Swift, a live sandbox, request inspector and webhook verification — integration time is a product metric."
        actions={<><Button asChild size="sm"><Link href="/docs"><BookOpen className="size-4" /> Docs</Link></Button><Button asChild size="sm"><a href="/api/v1/openapi" target="_blank"><FileJson className="size-4" /> OpenAPI</a></Button></>}
      />
      <DeveloperView sandboxKey={DEMO_KEYS.int_sandbox} base={base} integrations={db.integrations.map((i) => ({ id: i.id, name: i.name }))} />
    </>
  );
}

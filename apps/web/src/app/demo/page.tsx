import type { Metadata } from "next";
import { currentConsoleUser } from "@/lib/server/auth";
import { DemoApp } from "./demo-app";

export const metadata: Metadata = { title: "Northstar demo app", description: "A fictional customer app whose AI agents and workflows ask Orbis Relay before they act." };
export const dynamic = "force-dynamic";

export default async function DemoPage() {
  const { user } = await currentConsoleUser();
  return <DemoApp signedIn={!!user} />;
}

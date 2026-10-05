import type { Metadata } from "next";
import { currentConsoleUser } from "@/lib/server/auth";
import { PageHeader } from "@/components/console/shell";
import { SettingsView } from "./settings-view";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const { db } = await currentConsoleUser();
  const devices = db.devices.map((d) => ({ ...d, user_name: db.users.find((u) => u.id === d.user_id)?.name ?? d.user_id }));
  return (
    <>
      <PageHeader eyebrow="Organization" title="Settings" description="Tenant, roles, SSO/SCIM, retention, devices, notification policy and billing." />
      <SettingsView tenant={db.tenant} users={db.users} devices={devices} />
    </>
  );
}

import { redirect } from "next/navigation";
import { currentConsoleUser } from "@/lib/server/auth";
import { ConsoleShell } from "@/components/console/shell";
import { LiveProvider } from "@/components/console/live";

export const dynamic = "force-dynamic";

export default async function ConsoleLayout({ children }: LayoutProps<"/console">) {
  const { db, user } = await currentConsoleUser();
  if (!user) redirect("/signin?next=/console");
  const pending = db.approvals.filter((a) => a.status === "pending" && user.groups.includes(a.route) && !a.responses.some((r) => r.user_id === user.id)).length;
  const freezes = db.freezes
    .filter((f) => !f.lifted_at)
    .map((f) => ({
      actor_id: f.actor_id,
      actor_name: db.actors.find((a) => a.id === f.actor_id)?.name ?? f.actor_id,
      reason: f.reason,
      by: db.users.find((u) => u.id === f.created_by)?.name ?? f.created_by,
      at: f.created_at,
      blocked: f.blocked_count,
    }));
  return (
    <LiveProvider>
      <ConsoleShell user={{ name: user.name, email: user.email, title: user.title, color: user.color }} tenant={{ name: db.tenant.name, plan: db.tenant.plan }} pending={pending} freezes={freezes}>
        {children}
      </ConsoleShell>
    </LiveProvider>
  );
}

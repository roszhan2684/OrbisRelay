import type { Metadata } from "next";
import { SignInCard } from "./signin-card";
import { getDb } from "@/lib/server/store";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function SignIn({ searchParams }: PageProps<"/signin">) {
  const db = await getDb();
  const sp = await searchParams;
  const personas = db.users
    .filter((u) => ["usr_alex_chen", "usr_avery_kim", "usr_jordan_patel", "usr_quinn_harper"].includes(u.id))
    .map((u) => ({ email: u.email, name: u.name, title: u.title, color: u.color, roles: u.roles }));
  return <SignInCard personas={personas} next={typeof sp.next === "string" && sp.next.startsWith("/") ? sp.next : "/console"} />;
}

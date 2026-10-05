import { cookies } from "next/headers";
import { SESSION_COOKIE } from "@/lib/server/auth";
import { handle, json } from "@/lib/server/http";

export const POST = handle(async () => {
  (await cookies()).delete(SESSION_COOKIE);
  return json({ ok: true });
});

import { requireUser } from "@/lib/server/auth";
import { handle, json } from "@/lib/server/http";

export const GET = handle(async (req: Request) => {
  const { db, user } = await requireUser(req);
  const data = db.integrations
    .filter((i) => i.tenant_id === user.tenant_id)
    .map((i) => ({ ...i, api_keys: i.api_keys.map(({ hash: _h, ...k }) => (void _h, k)), webhook: db.webhooks.find((w) => w.id === i.webhook_id) ?? null }));
  return json({ data });
});

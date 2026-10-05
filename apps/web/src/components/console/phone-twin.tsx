"use client";
import * as React from "react";
import { motion, AnimatePresence } from "motion/react";
import { Inbox, X } from "lucide-react";
import { toast } from "sonner";
import { InboxRow, PhoneApprovalDetail, PhoneFrame, PhoneTabBar, type PhoneApproval, type ResponsePayload } from "@/components/phone";
import { api, useLive, useNow } from "./live";

/**
 * Live web twin of the Orbis iOS decision terminal. Talks to the same API as the native app;
 * step-up here is a simulated passkey (the native app performs real Face ID).
 */
export function PhoneTwin({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [items, setItems] = React.useState<PhoneApproval[]>([]);
  const [selected, setSelected] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<{ status: string; receipt_id?: string | null; message?: string } | null>(null);
  const now = useNow();
  const { subscribe } = useLive();

  const load = React.useCallback(async () => {
    const res = await api<{ data: PhoneApproval[] }>("/api/v1/approvals?status=pending&scope=mine");
    setItems(res.data);
  }, []);

  React.useEffect(() => {
    if (!open) return;
    api<{ data: PhoneApproval[] }>("/api/v1/approvals?status=pending&scope=mine").then((r) => setItems(r.data));
    return subscribe((e) => {
      if (e.type.startsWith("approval.") || e.type === "freeze.changed" || e.type === "demo.reset") void load();
    });
  }, [open, load, subscribe]);

  const [detail, setDetail] = React.useState<PhoneApproval | null>(null);

  const respond = async (p: ResponsePayload) => {
    if (!detail) return;
    setBusy(true);
    try {
      const res = await api<PhoneApproval & { final_status: string; receipt_id: string | null; status: string }>(`/api/v1/approvals/${detail.id}/respond`, {
        method: "POST",
        json: { ...p, step_up: p.decision === "reject" ? undefined : { method: "passkey", verified: true } },
      });
      const msg =
        res.status === "pending"
          ? "Signed — waiting for quorum"
          : res.status === "approved_modified"
            ? p.decision === "safe_alternative"
              ? "Redirected safely"
              : "Approved with edits"
            : res.status === "approved"
              ? "Approved"
              : "Rejected";
      setResult({ status: res.status, receipt_id: res.receipt_id, message: msg });
      toast.success(msg, { description: res.receipt_id ? `Receipt ${res.receipt_id}` : undefined });
      setTimeout(() => {
        setResult(null);
        setSelected(null);
        setDetail(null);
        void load();
      }, 1800);
    } catch (e) {
      const err = e as Error & { remediation?: string };
      toast.error(err.message, { description: err.remediation });
    } finally {
      setBusy(false);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.aside
          initial={{ x: 420, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 420, opacity: 0 }}
          transition={{ type: "spring", stiffness: 260, damping: 30 }}
          className="fixed bottom-0 right-0 top-14 z-30 w-full max-w-[400px] overflow-y-auto border-l border-line bg-page/95 px-6 py-5 backdrop-blur-md"
          aria-label="iPhone twin"
        >
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-[13px] font-semibold">Orbis iOS · live twin</div>
              <div className="text-[12px] text-muted">Same API as the native app</div>
            </div>
            <button onClick={onClose} className="rounded-lg p-1.5 hover:bg-surface-2" aria-label="Close iPhone twin">
              <X className="size-4" />
            </button>
          </div>
          <PhoneFrame className="scale-[0.92] origin-top">
            {detail && selected ? (
              <PhoneApprovalDetail a={detail} now={now} busy={busy} result={result} onBack={() => (setSelected(null), setDetail(null))} onRespond={respond} />
            ) : (
              <div className="h-full">
                <div className="px-5 pb-3 pt-1">
                  <div className="text-[13px] font-medium text-[#6b7280]">Northstar Cloud</div>
                  <h2 className="text-[32px] font-bold tracking-[-0.03em]">Inbox</h2>
                </div>
                <div className="h-[calc(100%-150px)] space-y-2 overflow-y-auto px-3 pb-6">
                  {items.length === 0 ? (
                    <div className="mt-16 flex flex-col items-center text-center text-[#6b7280]">
                      <Inbox className="size-10" strokeWidth={1.3} />
                      <p className="mt-2 text-[15px] font-medium text-ink">All clear</p>
                      <p className="mt-1 max-w-[220px] text-[13px]">Safe work keeps running. Paused actions that need you will appear here.</p>
                    </div>
                  ) : (
                    items.map((a) => <InboxRow key={a.id} a={a} now={now} onOpen={() => (setSelected(a.id), setDetail(a))} />)
                  )}
                </div>
                <PhoneTabBar active="inbox" badge={items.length} />
              </div>
            )}
          </PhoneFrame>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}

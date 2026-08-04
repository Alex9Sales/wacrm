"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRightLeft } from "lucide-react";
import { toast } from "sonner";
import {
  transferDeal,
  listAssignees,
} from "@/app/(dashboard)/pipelines/actions";
import type { Profile } from "@/types";

/**
 * Transferir lead: reatribui o deal a outro membro (mantém a etapa). Abre um
 * pequeno menu com os membros; ao escolher, chama a server action `transferDeal`
 * (grava histórico + notifica). Reusável no detalhe do negócio e no card.
 */
export function TransferDealButton({
  dealId,
  currentAssigneeId,
  onTransferred,
}: {
  dealId: string;
  currentAssigneeId?: string | null;
  onTransferred?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<Profile[] | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open && members === null) {
      listAssignees()
        .then(setMembers)
        .catch(() => setMembers([]));
    }
  }, [open, members]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const doTransfer = async (userId: string) => {
    if (busy) return;
    setBusy(true);
    const { error } = await transferDeal(dealId, userId);
    setBusy(false);
    setOpen(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Lead transferido.");
    onTransferred?.();
  };

  const options = (members ?? []).filter((m) => m.id !== currentAssigneeId);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
        title="Transferir lead para outro atendente"
      >
        <ArrowRightLeft className="h-3.5 w-3.5" />
        Transferir
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-1 max-h-64 w-60 overflow-auto rounded-lg border border-border bg-popover p-1 shadow-lg">
          <p className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">
            Transferir para:
          </p>
          {members === null ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Carregando…</p>
          ) : options.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">
              Nenhum outro membro disponível.
            </p>
          ) : (
            options.map((m) => (
              <button
                key={m.id}
                type="button"
                disabled={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  void doTransfer(m.id);
                }}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted disabled:opacity-50"
              >
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
                  {(m.full_name || m.email || "?").charAt(0).toUpperCase()}
                </span>
                <span className="truncate">{m.full_name || m.email || "—"}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

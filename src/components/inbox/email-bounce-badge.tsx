"use client";

// ============================================================
// 📭 Selo "E-mail voltou" abaixo do e-mail do contato.
//
// 15/09 (GoLink/Vale Modelo): quando uma cobrança por e-mail volta como não
// entregue, a régua para de mandar e-mail pra aquele endereço. Aqui a equipe
// vê o motivo e, se o cliente corrigiu a caixa, libera de novo.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { MailWarning } from "lucide-react";
import { toast } from "sonner";

import {
  getContactEmailBounces,
  releaseContactEmailBounce,
  type ContactEmailBounce,
} from "@/app/(dashboard)/contacts/email-bounce-actions";

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
}

export function EmailBounceBadge({
  contactId,
  canRelease,
}: {
  contactId: string;
  canRelease: boolean;
}) {
  const [bounces, setBounces] = useState<ContactEmailBounce[]>([]);
  const [releasing, setReleasing] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setBounces(await getContactEmailBounces(contactId));
    } catch (err) {
      // Só informativo: sem o selo a conversa segue funcionando.
      console.error("[email-bounce-badge] carregar falhou:", err);
      setBounces([]);
    }
  }, [contactId]);

  useEffect(() => {
    void load();
  }, [load]);

  const release = async (address: string) => {
    setReleasing(address);
    try {
      const res = await releaseContactEmailBounce(address);
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(`E-mail ${address} liberado. A régua volta a mandar e-mail para ele.`);
      setBounces((prev) => prev.filter((b) => b.address !== address));
    } catch (err) {
      console.error("[email-bounce-badge] liberar falhou:", err);
      toast.error("Não foi possível liberar o e-mail agora. Tente de novo.");
    } finally {
      setReleasing(null);
    }
  };

  if (bounces.length === 0) return null;

  return (
    <div className="space-y-1">
      {bounces.map((b) => (
        <div
          key={b.address}
          className="mx-3 rounded-md border border-red-500/25 bg-red-500/[0.05] px-2.5 py-1.5 text-[11px] leading-snug text-red-700 dark:text-red-300/90"
        >
          <div className="flex items-start gap-1.5">
            <MailWarning className="mt-px h-3.5 w-3.5 shrink-0 text-red-500/80" />
            <div className="min-w-0 flex-1">
              <p>
                <b className="font-semibold">E-mail voltou</b>
                {b.lastBouncedAt ? ` em ${fmtDate(b.lastBouncedAt)}` : ""}:{" "}
                <span className="break-all">{b.address}</span> — {b.reason}.
              </p>
              <p className="text-red-600/80 dark:text-red-300/70">
                A régua não manda e-mail para este endereço.
              </p>
            </div>
            {canRelease && (
              <button
                type="button"
                onClick={() => void release(b.address)}
                disabled={releasing === b.address}
                className="shrink-0 font-medium underline decoration-red-400/50 underline-offset-2 hover:decoration-red-500 disabled:opacity-50"
              >
                {releasing === b.address ? "Liberando…" : "Liberar de novo"}
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

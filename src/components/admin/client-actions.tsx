"use client";

// ============================================================
// ClientActions — menu de ações do ciclo de vida de um cliente no /admin.
// Kebab (⋮) → Ligar/Desligar · Cancelar assinatura · Reativar · Lembrete ·
// Histórico · Excluir conta. Diálogos de confirmação pra cancelar (vale até o
// vencimento, com opção de cortar já) e excluir (soft-delete, confirma o nome).
// Fala direto com as rotas /api/admin/clients/[orgId]/*.
// ============================================================

import { useState } from "react";
import { toast } from "sonner";
import {
  MoreVertical,
  Power,
  PowerOff,
  Ban,
  RotateCcw,
  Send,
  History,
  Trash2,
  Loader2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { formatDate, formatDateTime } from "./admin-format";
import type { BillingEventRow, ClientListRow } from "./admin-types";

const EVENT_LABEL: Record<string, string> = {
  provisioned: "Provisionado",
  activated: "Ativado",
  suspended: "Suspenso",
  reactivated: "Reativado",
  canceled: "Assinatura cancelada",
  deleted: "Conta excluída",
  plan_changed: "Plano alterado",
  reminder_sent: "Lembrete enviado",
  payment_received: "Pagamento recebido",
};

const ACTOR_LABEL: Record<string, string> = {
  admin: "admin",
  client: "cliente",
  system: "sistema",
};

export function ClientActions({
  client,
  onDone,
}: {
  client: ClientListRow;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  const isDeleted = client.status === "deleted";
  const isCanceled = client.status === "canceled";
  const isSuspended = client.status === "suspended";

  async function call(
    path: string,
    init: RequestInit,
    okMsg: string,
  ): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/clients/${client.id}${path}`, init);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || "Não foi possível concluir a ação.");
        return false;
      }
      if (payload.asaasWarning) toast.warning(payload.asaasWarning);
      toast.success(okMsg);
      onDone();
      return true;
    } catch {
      toast.error("Não foi possível conectar ao servidor.");
      return false;
    } finally {
      setBusy(false);
    }
  }

  const toggleSuspend = () =>
    call(
      "",
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: isSuspended ? "active" : "suspended" }),
      },
      isSuspended ? "Cliente ligado." : "Cliente desligado.",
    );

  const reactivate = () =>
    call("/reactivate", { method: "POST" }, "Conta reativada.");

  const reminder = () =>
    call("/reminder", { method: "POST" }, "Lembrete enviado.");

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" title="Ações" />}
          disabled={busy}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <MoreVertical className="size-4" />
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-52">
          {isDeleted ? (
            <DropdownMenuItem onClick={reactivate}>
              <RotateCcw className="size-4" /> Reativar conta
            </DropdownMenuItem>
          ) : (
            <>
              {!isCanceled && (
                <DropdownMenuItem onClick={toggleSuspend}>
                  {isSuspended ? (
                    <>
                      <Power className="size-4" /> Ligar (reativar acesso)
                    </>
                  ) : (
                    <>
                      <PowerOff className="size-4" /> Desligar (suspender)
                    </>
                  )}
                </DropdownMenuItem>
              )}
              {isCanceled || isSuspended ? (
                <DropdownMenuItem onClick={reactivate}>
                  <RotateCcw className="size-4" /> Reativar conta
                </DropdownMenuItem>
              ) : null}
              {!isCanceled && (
                <DropdownMenuItem onClick={() => setCancelOpen(true)}>
                  <Ban className="size-4" /> Cancelar assinatura
                </DropdownMenuItem>
              )}
              {client.billingPhone ? (
                <DropdownMenuItem onClick={reminder}>
                  <Send className="size-4" /> Enviar lembrete
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem onClick={() => setHistoryOpen(true)}>
                <History className="size-4" /> Ver histórico
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleteOpen(true)}
              >
                <Trash2 className="size-4" /> Excluir conta
              </DropdownMenuItem>
            </>
          )}
          {isDeleted ? (
            <DropdownMenuItem onClick={() => setHistoryOpen(true)}>
              <History className="size-4" /> Ver histórico
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>

      <CancelDialog
        client={client}
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        onConfirm={(reason, immediate) =>
          call(
            "/cancel",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reason, immediate }),
            },
            "Assinatura cancelada.",
          ).then((ok) => ok && setCancelOpen(false))
        }
      />

      <DeleteDialog
        client={client}
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        onConfirm={(reason) =>
          call(
            "/delete",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ reason }),
            },
            "Conta excluída.",
          ).then((ok) => ok && setDeleteOpen(false))
        }
      />

      <HistoryDialog
        client={client}
        open={historyOpen}
        onOpenChange={setHistoryOpen}
      />
    </>
  );
}

function CancelDialog({
  client,
  open,
  onOpenChange,
  onConfirm,
}: {
  client: ClientListRow;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (reason: string | null, immediate: boolean) => void;
}) {
  const [reason, setReason] = useState("");
  const [immediate, setImmediate] = useState(false);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Cancelar assinatura</DialogTitle>
          <DialogDescription>
            Cancela a cobrança de <strong>{client.name}</strong> no Asaas (não
            gera a próxima).{" "}
            {immediate ? (
              <>O acesso é <strong>cortado agora</strong>.</>
            ) : (
              <>
                O acesso continua até o vencimento atual
                {client.dueAt ? (
                  <>
                    {" "}
                    (<strong>{formatDate(client.dueAt)}</strong>)
                  </>
                ) : null}
                ; depois a conta fica cancelada.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="cancel-reason">Motivo (opcional)</Label>
            <Textarea
              id="cancel-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex.: cliente pediu, inadimplência, migração…"
              rows={2}
            />
          </div>
          <label className="flex cursor-pointer items-start gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={immediate}
              onChange={(e) => setImmediate(e.target.checked)}
              className="mt-0.5"
            />
            <span>Cortar o acesso agora (não esperar o vencimento).</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Voltar
          </Button>
          <Button
            variant="destructive"
            onClick={() => onConfirm(reason.trim() || null, immediate)}
          >
            Cancelar assinatura
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({
  client,
  open,
  onOpenChange,
  onConfirm,
}: {
  client: ClientListRow;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onConfirm: (reason: string | null) => void;
}) {
  const [reason, setReason] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const matches = confirmName.trim() === client.name.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Excluir conta</DialogTitle>
          <DialogDescription>
            Encerra <strong>{client.name}</strong>: o cliente perde o acesso e a
            assinatura é cancelada no Asaas. O registro fica guardado no
            histórico (filtro <em>Excluídas</em>) e você pode reativar depois.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="delete-reason">Motivo (opcional)</Label>
            <Textarea
              id="delete-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ex.: encerramento, duplicidade, teste…"
              rows={2}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="delete-confirm">
              Para confirmar, digite <strong>{client.name}</strong>
            </Label>
            <Input
              id="delete-confirm"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              placeholder={client.name}
              autoComplete="off"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Voltar
          </Button>
          <Button
            variant="destructive"
            disabled={!matches}
            onClick={() => onConfirm(reason.trim() || null)}
          >
            Excluir conta
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistoryDialog({
  client,
  open,
  onOpenChange,
}: {
  client: ClientListRow;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [events, setEvents] = useState<BillingEventRow[] | null>(null);
  const [loading, setLoading] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/clients/${client.id}/history`, {
        cache: "no-store",
      });
      const payload = await res.json().catch(() => ({}));
      setEvents(res.ok ? (payload.events ?? []) : []);
    } catch {
      setEvents([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        onOpenChange(o);
        if (o && events === null) void load();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Histórico — {client.name}</DialogTitle>
          <DialogDescription>
            Tudo que aconteceu com a cobrança desta conta.
          </DialogDescription>
        </DialogHeader>
        <div className="py-1">
          {loading ? (
            <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Carregando…
            </div>
          ) : !events || events.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Sem eventos registrados ainda.
            </p>
          ) : (
            <ol className="space-y-3">
              {events.map((e) => (
                <li
                  key={e.id}
                  className="flex gap-3 border-l-2 border-border pl-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-foreground">
                      {EVENT_LABEL[e.event] ?? e.event}
                      {e.fromStatus && e.toStatus && e.fromStatus !== e.toStatus ? (
                        <span className="text-muted-foreground">
                          {" "}
                          · {e.fromStatus} → {e.toStatus}
                        </span>
                      ) : null}
                    </p>
                    {e.reason ? (
                      <p className="text-xs text-muted-foreground">“{e.reason}”</p>
                    ) : null}
                    <p className="text-[11px] text-muted-foreground">
                      {formatDateTime(e.createdAt)} ·{" "}
                      {ACTOR_LABEL[e.actorType] ?? e.actorType}
                      {e.actorLabel ? ` (${e.actorLabel})` : ""}
                    </p>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

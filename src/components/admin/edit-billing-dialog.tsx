"use client";

// ============================================================
// EditBillingDialog — edit a client's billing (Phase 8).
//
// started_at, due_at, plano, billing_phone, notes → PATCH
// /api/admin/clients/[orgId]. Prefilled from the row. On success the
// parent refetches the list.
// ============================================================

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type {
  ClientBillingStatus,
  ClientListRow,
  PlatformAdminUser,
} from "./admin-types";
import { toDateInput, STATUS_LABEL } from "./admin-format";

interface EditBillingDialogProps {
  client: ClientListRow | null;
  admins: PlatformAdminUser[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function EditBillingDialog({
  client,
  admins,
  open,
  onOpenChange,
  onSaved,
}: EditBillingDialogProps) {
  const [status, setStatus] = useState<ClientBillingStatus>("active");
  const [startedAt, setStartedAt] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [plan, setPlan] = useState("");
  const [billingPhone, setBillingPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [responsibleAdminId, setResponsibleAdminId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Track the client id we last hydrated from so re-opening for a
  // different row refreshes the fields.
  const [hydratedId, setHydratedId] = useState<string | null>(null);

  // Hydrate the form when the dialog opens for a client.
  if (open && client && hydratedId !== client.id) {
    setStatus(client.status);
    setStartedAt(toDateInput(client.startedAt));
    setDueAt(toDateInput(client.dueAt));
    setPlan(client.plan ?? "");
    setBillingPhone(client.billingPhone ?? "");
    setNotes(client.notes ?? "");
    setResponsibleAdminId(client.responsible?.id ?? "");
    setHydratedId(client.id);
  }

  async function handleSave() {
    if (!client) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/admin/clients/${client.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          status,
          started_at: startedAt ? startedAt : null,
          due_at: dueAt ? dueAt : null,
          plan: plan.trim() || null,
          billing_phone: billingPhone.trim() || null,
          notes: notes.trim() || null,
          responsible_admin_id: responsibleAdminId || null,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || "Não foi possível salvar.");
        return;
      }
      toast.success("Cobrança atualizada.");
      onSaved();
      onOpenChange(false);
    } catch (err) {
      console.error("[EditBillingDialog] save error:", err);
      toast.error("Não foi possível conectar ao servidor.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setHydratedId(null);
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar cobrança</DialogTitle>
          <DialogDescription>
            {client?.name ?? ""} — ajuste datas, plano e telefone de
            cobrança.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label className="text-muted-foreground">Status</Label>
            <select
              value={status}
              onChange={(e) =>
                setStatus(e.target.value as ClientBillingStatus)
              }
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            >
              {(["active", "trial", "suspended"] as const).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Converta um teste em <strong>Ativo</strong> (defina plano e
              vencimento) ou suspenda o acesso.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Entrada</Label>
              <Input
                type="date"
                value={startedAt}
                onChange={(e) => setStartedAt(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-muted-foreground">Vencimento</Label>
              <Input
                type="date"
                value={dueAt}
                onChange={(e) => setDueAt(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Plano</Label>
            <Input
              placeholder="ex.: Pro, Essencial…"
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Responsável</Label>
            <select
              value={responsibleAdminId}
              onChange={(e) => setResponsibleAdminId(e.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            >
              <option value="">— (nenhum)</option>
              {admins.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name || a.email}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              Qual admin da plataforma é dono deste cliente.
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">
              Telefone de cobrança (WhatsApp)
            </Label>
            <Input
              placeholder="ex.: 5511999999999"
              value={billingPhone}
              onChange={(e) => setBillingPhone(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Formato E.164 (só dígitos, com DDI 55). Necessário para
              enviar lembretes.
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Notas</Label>
            <Textarea
              placeholder="Observações internas…"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            Cancelar
          </Button>
          <Button onClick={handleSave} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Salvando…
              </>
            ) : (
              "Salvar"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

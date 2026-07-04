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
import type { ClientListRow } from "./admin-types";
import { toDateInput } from "./admin-format";

interface EditBillingDialogProps {
  client: ClientListRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}

export function EditBillingDialog({
  client,
  open,
  onOpenChange,
  onSaved,
}: EditBillingDialogProps) {
  const [startedAt, setStartedAt] = useState("");
  const [dueAt, setDueAt] = useState("");
  const [plan, setPlan] = useState("");
  const [billingPhone, setBillingPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Track the client id we last hydrated from so re-opening for a
  // different row refreshes the fields.
  const [hydratedId, setHydratedId] = useState<string | null>(null);

  // Hydrate the form when the dialog opens for a client.
  if (open && client && hydratedId !== client.id) {
    setStartedAt(toDateInput(client.startedAt));
    setDueAt(toDateInput(client.dueAt));
    setPlan(client.plan ?? "");
    setBillingPhone(client.billingPhone ?? "");
    setNotes(client.notes ?? "");
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
          started_at: startedAt ? startedAt : null,
          due_at: dueAt ? dueAt : null,
          plan: plan.trim() || null,
          billing_phone: billingPhone.trim() || null,
          notes: notes.trim() || null,
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

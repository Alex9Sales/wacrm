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

interface AsaasFound {
  id: string;
  name?: string;
  email?: string;
  cpfCnpj?: string;
}

interface AsaasBilling {
  subscriptions: { id: string; value: number; description?: string; nextDueDate?: string; status?: string }[];
  installments: { id: string; value: number; installmentCount?: number; description?: string }[];
  nextCharge: { value: number; dueDate: string } | null;
}

const brl = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

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
  // 🔗 Vínculo com o Asaas (24/09). O documento é a chave pra achar o cliente
  // lá; o valor é o que ele paga de VERDADE (implantação parcelada, preço
  // travado) e manda sobre o preço de tabela no painel de MRR.
  const [cpfCnpj, setCpfCnpj] = useState("");
  const [monthlyValue, setMonthlyValue] = useState("");
  const [asaasCustomerId, setAsaasCustomerId] = useState("");
  const [asaasSubscriptionId, setAsaasSubscriptionId] = useState("");
  const [asaasBusy, setAsaasBusy] = useState(false);
  const [asaasFound, setAsaasFound] = useState<AsaasFound[] | null>(null);
  const [asaasBilling, setAsaasBilling] = useState<AsaasBilling | null>(null);
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
    setCpfCnpj(client.cpfCnpj ?? "");
    setMonthlyValue(client.monthlyValue != null ? String(client.monthlyValue).replace(".", ",") : "");
    setAsaasCustomerId(client.asaasCustomerId ?? "");
    setAsaasSubscriptionId(client.asaasSubscriptionId ?? "");
    setAsaasFound(null);
    setAsaasBilling(null);
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
          cpf_cnpj: cpfCnpj.trim() || null,
          monthly_value: monthlyValue.trim() || null,
          asaas_customer_id: asaasCustomerId.trim() || null,
          asaas_subscription_id: asaasSubscriptionId.trim() || null,
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

  /** Procura no Asaas por documento, e-mail ou nome do cliente. */
  async function buscarNoAsaas() {
    const termo = cpfCnpj.trim() || client?.owner?.email || client?.name || "";
    if (termo.trim().length < 3) {
      toast.error("Preencha o CPF/CNPJ (ou o cliente precisa ter nome/e-mail).");
      return;
    }
    setAsaasBusy(true);
    setAsaasFound(null);
    try {
      const res = await fetch(`/api/admin/asaas?q=${encodeURIComponent(termo)}`);
      const data = (await res.json().catch(() => ({}))) as { customers?: AsaasFound[]; error?: string };
      if (!res.ok) {
        toast.error(data.error || "Não deu para consultar o Asaas.");
        return;
      }
      const achados = data.customers ?? [];
      setAsaasFound(achados);
      if (achados.length === 0) toast.info("Nenhum cliente com esse dado no Asaas.");
      if (achados.length === 1) await escolherCliente(achados[0]);
    } catch {
      toast.error("Não foi possível conectar ao servidor.");
    } finally {
      setAsaasBusy(false);
    }
  }

  /** Escolhido o cliente, traz o que ele já tem lá (assinatura/parcelamento). */
  async function escolherCliente(c: AsaasFound) {
    setAsaasCustomerId(c.id);
    if (c.cpfCnpj && !cpfCnpj.trim()) setCpfCnpj(c.cpfCnpj);
    setAsaasBusy(true);
    try {
      const res = await fetch(`/api/admin/asaas?customer=${encodeURIComponent(c.id)}`);
      const data = (await res.json().catch(() => ({}))) as AsaasBilling & { error?: string };
      if (!res.ok) {
        toast.error(data.error || "Não deu para ler as cobranças do cliente.");
        return;
      }
      setAsaasBilling(data);
      setAsaasFound(null);
    } catch {
      toast.error("Não foi possível conectar ao servidor.");
    } finally {
      setAsaasBusy(false);
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

          {/* 🔗 Asaas — o que o cliente paga de verdade (24/09). Sem isto o
              painel somava o preço de TABELA e mostrava MRR errado. */}
          <div className="space-y-2 rounded-lg border border-border p-3">
            <Label className="text-muted-foreground">Cobrança no Asaas</Label>

            <div className="flex gap-2">
              <Input
                placeholder="CPF ou CNPJ do cliente"
                value={cpfCnpj}
                onChange={(e) => setCpfCnpj(e.target.value)}
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => void buscarNoAsaas()}
                disabled={asaasBusy}
              >
                {asaasBusy ? <Loader2 className="size-4 animate-spin" /> : "Buscar"}
              </Button>
            </div>

            {asaasFound && asaasFound.length > 0 && (
              <div className="space-y-1 rounded-md bg-muted/40 p-2">
                <p className="text-xs text-muted-foreground">Escolha o cliente:</p>
                {asaasFound.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => void escolherCliente(c)}
                    className="block w-full rounded px-2 py-1 text-left text-sm hover:bg-muted"
                  >
                    {c.name ?? c.id}
                    {c.cpfCnpj ? ` · ${c.cpfCnpj}` : ""}
                  </button>
                ))}
              </div>
            )}

            {asaasBilling && (
              <div className="space-y-1 rounded-md bg-muted/40 p-2 text-sm">
                {asaasBilling.subscriptions.length === 0 &&
                  asaasBilling.installments.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      Este cliente não tem assinatura nem parcelamento no Asaas.
                    </p>
                  )}
                {asaasBilling.subscriptions.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setAsaasSubscriptionId(s.id);
                      setMonthlyValue(String(s.value).replace(".", ","));
                      toast.success("Assinatura vinculada — salve para confirmar.");
                    }}
                    className="block w-full rounded px-2 py-1 text-left hover:bg-muted"
                  >
                    Assinatura · {brl(s.value)}/mês
                    {s.description ? ` · ${s.description}` : ""}
                  </button>
                ))}
                {asaasBilling.installments.map((i) => (
                  <button
                    key={i.id}
                    type="button"
                    onClick={() => {
                      setMonthlyValue(String(i.value).replace(".", ","));
                      toast.success("Valor do parcelamento copiado — salve para confirmar.");
                    }}
                    className="block w-full rounded px-2 py-1 text-left hover:bg-muted"
                  >
                    Parcelamento · {i.installmentCount ?? "?"}× {brl(i.value)}
                    {i.description ? ` · ${i.description}` : ""}
                  </button>
                ))}
                {asaasBilling.nextCharge && (
                  <p className="px-2 pt-1 text-xs text-muted-foreground">
                    Próxima em aberto: {brl(asaasBilling.nextCharge.value)} em{" "}
                    {asaasBilling.nextCharge.dueDate.split("-").reverse().join("/")}
                  </p>
                )}
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Valor contratado por mês
              </Label>
              <Input
                placeholder="ex.: 1298,50 — vazio usa o preço do plano"
                value={monthlyValue}
                onChange={(e) => setMonthlyValue(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                É este valor que entra no MRR do painel. Deixe vazio para usar o
                preço de tabela do plano.
              </p>
            </div>

            {(asaasCustomerId || asaasSubscriptionId) && (
              <p className="text-xs text-muted-foreground">
                Vinculado: {asaasCustomerId || "—"}
                {asaasSubscriptionId ? ` · assinatura ${asaasSubscriptionId}` : ""}
              </p>
            )}
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

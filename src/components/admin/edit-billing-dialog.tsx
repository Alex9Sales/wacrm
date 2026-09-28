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
import {
  BILLING_CYCLES,
  CYCLES,
  chargeForCycle,
  type BillingCycle,
} from "@/lib/billing/cycle";
import { PLAN_LIST } from "@/lib/billing/plans";
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
  installments: {
    id: string;
    value: number;
    /** O valor de CADA parcela (o `value` do Asaas é o total). */
    installmentValue?: number;
    installmentCount?: number;
    description?: string;
  }[];
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
  const [billingEmail, setBillingEmail] = useState("");
  // Endereço de cobrança (migr 0196) — para a nota fiscal, mais à frente.
  // `billingProvince` é BAIRRO: é o nome do campo no Asaas, e traduzir no meio
  // do caminho é onde endereço vira endereço errado.
  const [billingPostalCode, setBillingPostalCode] = useState("");
  const [billingAddress, setBillingAddress] = useState("");
  const [billingAddressNumber, setBillingAddressNumber] = useState("");
  const [billingComplement, setBillingComplement] = useState("");
  const [billingProvince, setBillingProvince] = useState("");
  const [billingCity, setBillingCity] = useState("");
  const [billingState, setBillingState] = useState("");

  const [notes, setNotes] = useState("");
  // 🔗 Vínculo com o Asaas (24/09). O documento é a chave pra achar o cliente
  // lá; o valor é o que ele paga de VERDADE (implantação parcelada, preço
  // travado) e manda sobre o preço de tabela no painel de MRR.
  const [cpfCnpj, setCpfCnpj] = useState("");
  const [monthlyValue, setMonthlyValue] = useState("");
  const [billingCycle, setBillingCycle] = useState("");
  const [asaasCustomerId, setAsaasCustomerId] = useState("");
  const [asaasSubscriptionId, setAsaasSubscriptionId] = useState("");
  // Cobrança única (semestral/anual) — objeto diferente de assinatura no Asaas.
  const [asaasPaymentId, setAsaasPaymentId] = useState("");
  const [asaasBusy, setAsaasBusy] = useState(false);
  const [asaasFound, setAsaasFound] = useState<AsaasFound[] | null>(null);
  const [asaasBilling, setAsaasBilling] = useState<AsaasBilling | null>(null);
  // Criar assinatura: só aparece quando a conta ainda não tem uma vinculada.
  const [criando, setCriando] = useState(false);
  const [novoValor, setNovoValor] = useState("");
  const [novoVenc, setNovoVenc] = useState("");
  const [futuroValor, setFuturoValor] = useState("");
  const [futuroDe, setFuturoDe] = useState("");
  const [responsibleAdminId, setResponsibleAdminId] = useState("");
  const [submitting, setSubmitting] = useState(false);
  // Track the client id we last hydrated from so re-opening for a
  // different row refreshes the fields.
  const [hydratedId, setHydratedId] = useState<string | null>(null);

  // 💰 O que a cobrança vai emitir DE VERDADE (28/09).
  //
  // Num contrato semestral o valor digitado e o valor cobrado são números
  // diferentes — R$ 130/mês viram UMA cobrança de R$ 780 — e a tela antes dizia
  // só "Valor". Quem digitasse 780 pensando no total cobraria R$ 4.680 do
  // cliente, sem desfazer. Então o total é calculado aqui e mostrado antes do
  // clique, no botão e na confirmação.
  const cobranca = (() => {
    const mensal = Number(novoValor.replace(/\./g, "").replace(",", ".")) || 0;
    const ciclo = (
      billingCycle && CYCLES[billingCycle as BillingCycle] ? billingCycle : "monthly"
    ) as BillingCycle;
    // Mesma função que a rota usa para emitir — ver chargeForCycle. Se o número
    // mostrado aqui e o cobrado lá vierem de contas diferentes, um dia divergem.
    const c = chargeForCycle(mensal, ciclo);
    return { mensal: c.monthly, meses: c.months, total: c.total, unica: c.oneOff };
  })();

  // Hydrate the form when the dialog opens for a client.
  if (open && client && hydratedId !== client.id) {
    setStatus(client.status);
    setStartedAt(toDateInput(client.startedAt));
    setDueAt(toDateInput(client.dueAt));
    setPlan(client.plan ?? "");
    setBillingPhone(client.billingPhone ?? "");
    setBillingEmail(client.billingEmail ?? "");
    setBillingPostalCode(client.billingPostalCode ?? "");
    setBillingAddress(client.billingAddress ?? "");
    setBillingAddressNumber(client.billingAddressNumber ?? "");
    setBillingComplement(client.billingComplement ?? "");
    setBillingProvince(client.billingProvince ?? "");
    setBillingCity(client.billingCity ?? "");
    setBillingState(client.billingState ?? "");

    setNotes(client.notes ?? "");
    setResponsibleAdminId(client.responsible?.id ?? "");
    setCpfCnpj(client.cpfCnpj ?? "");
    setMonthlyValue(client.monthlyValue != null ? String(client.monthlyValue).replace(".", ",") : "");
    setBillingCycle(client.billingCycle ?? "");
    setAsaasCustomerId(client.asaasCustomerId ?? "");
    setAsaasSubscriptionId(client.asaasSubscriptionId ?? "");
    setAsaasPaymentId(client.asaasPaymentId ?? "");
    setAsaasFound(null);
    setAsaasBilling(null);
    setNovoValor("");
    setNovoVenc("");
    setFuturoValor("");
    setFuturoDe("");
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
          billing_email: billingEmail.trim() || null,
          billing_postal_code: billingPostalCode.trim() || null,
          billing_address: billingAddress.trim() || null,
          billing_address_number: billingAddressNumber.trim() || null,
          billing_complement: billingComplement.trim() || null,
          billing_province: billingProvince.trim() || null,
          billing_city: billingCity.trim() || null,
          billing_state: billingState.trim() || null,

          notes: notes.trim() || null,
          responsible_admin_id: responsibleAdminId || null,
          cpf_cnpj: cpfCnpj.trim() || null,
          monthly_value: monthlyValue.trim() || null,
          billing_cycle: billingCycle || null,
          asaas_customer_id: asaasCustomerId.trim() || null,
          asaas_subscription_id: asaasSubscriptionId.trim() || null,
          asaas_payment_id: asaasPaymentId.trim() || null,
        }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || "Não foi possível salvar.");
        return;
      }
      // ⚠️ 25/09: salvou, MAS este telefone já é o de cobrança de outro
      // cliente — foi assim que 5 clientes ficaram com o número do
      // responsável. O aviso fica na tela até o clique, senão passa batido.
      const saved = (await res.json().catch(() => ({}))) as {
        phoneWarning?: string | null;
      };
      if (saved.phoneWarning) {
        toast.warning(saved.phoneWarning, { duration: 15_000 });
      } else {
        toast.success("Cobrança atualizada.");
      }
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

  /** ⚠️ Emite cobrança de verdade: o Asaas gera o boleto e avisa o cliente. */
  async function criarAssinatura() {
    if (!client) return;
    if (!novoValor.trim() || !novoVenc.trim()) {
      toast.error("Preencha o valor e o primeiro vencimento.");
      return;
    }
    // ⚠️ A confirmação mostra o TOTAL que vai ser cobrado, não o valor digitado.
    // Num semestral os dois números são diferentes (R$ 130/mês → R$ 780 de uma
    // vez), e quem clica precisa ver o número que vai chegar no cliente antes de
    // clicar — cobrança emitida não tem desfazer.
    const ok = window.confirm(
      cobranca.unica
        ? `Emitir UMA cobrança de ${brl(cobranca.total)} para ${client.name} ` +
            `(${cobranca.meses} meses × ${brl(cobranca.mensal)}), vencimento em ` +
            `${novoVenc.split("-").reverse().join("/")}?\n\n` +
            "É o contrato inteiro de uma vez. O cliente escolhe Pix, boleto ou cartão " +
            "na fatura, e parcela no cartão dele se quiser.\n\n" +
            "O Asaas avisa o cliente. Isso não tem desfazer."
        : `Criar assinatura de R$ ${novoValor} para ${client.name}, primeiro vencimento em ` +
            `${novoVenc.split("-").reverse().join("/")}?\n\n` +
            "O Asaas vai gerar o boleto e avisa o cliente. Isso não tem desfazer.",
    );
    if (!ok) return;
    setCriando(true);
    try {
      const res = await fetch(`/api/admin/clients/${client.id}/subscription`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          value: novoValor,
          first_due_date: novoVenc,
          cycle: billingCycle || null,
          future_value: futuroValor.trim() || null,
          future_from: futuroDe.trim() || null,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        subscriptionId?: string | null;
        paymentId?: string | null;
      };
      if (!res.ok) {
        toast.error(data.error || "Não foi possível criar a cobrança.");
        return;
      }
      toast.success(
        data.paymentId
          ? `Cobrança de ${brl(cobranca.total)} emitida e vinculada.`
          : "Assinatura criada e vinculada.",
      );
      setAsaasSubscriptionId(data.subscriptionId ?? "");
      setAsaasPaymentId(data.paymentId ?? "");
      setMonthlyValue(novoValor);
      onSaved();
      onOpenChange(false);
    } catch {
      toast.error("Não foi possível conectar ao servidor.");
    } finally {
      setCriando(false);
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
      {/* 24/09: com o bloco do Asaas o conteúdo passou da tela e o modal
          ficava estático, sem chegar no botão de salvar. */}
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Editar cobrança</DialogTitle>
          <DialogDescription>
            {client?.name ?? ""} — ajuste datas, plano e telefone de
            cobrança.
          </DialogDescription>
        </DialogHeader>

        <div className="-mr-2 flex-1 space-y-4 overflow-y-auto pr-2 py-2">
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
            {/* ⚠️ 26/09: era campo de texto livre, e o banco já tinha QUATRO
                grafias do mesmo plano — "Pro" (9), "PRO" (2), "pro" (1) e um
                vazio. `planPriceOf` tolera a caixa, mas contar cliente por
                plano vira loteria. Seletor resolve na origem.
                Valor fora da lista (dado antigo) vira opção própria em vez de
                ser apagado em silêncio ao abrir o formulário. */}
            <Label className="text-muted-foreground">Plano</Label>
            <select
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            >
              <option value="">— (sem plano)</option>
              {PLAN_LIST.map((pl) => (
                <option key={pl.key} value={pl.name}>
                  {pl.name} — {brl(pl.price)}/mês
                </option>
              ))}
              {plan && !PLAN_LIST.some((pl) => pl.name === plan) && (
                <option value={plan}>{plan} (como está no cadastro)</option>
              )}
            </select>
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
            <Label className="text-muted-foreground">E-mail de cobrança</Label>
            <Input
              type="email"
              placeholder="ex.: financeiro@empresa.com.br"
              value={billingEmail}
              onChange={(e) => setBillingEmail(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Para onde o boleto vai. Costuma ser o financeiro do cliente, e
              não quem usa o sistema — por isso é separado do e-mail de login.
              O Asaas exige este e-mail para abrir o cadastro do cliente.
            </p>
          </div>

          {/* Endereço de cobrança (28/09). Fica recolhido: hoje NADA depende
              dele — existe para que, quando a nota fiscal entrar, os dados já
              estejam aqui em vez de espalhados em conversa de WhatsApp. Aberto
              por padrão empurraria para baixo o que se usa todo dia; e um
              <details> mostra sozinho quando já há algo preenchido. */}
          <details className="rounded-lg border border-border" open={!!billingPostalCode}>
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-foreground">
              Endereço de cobrança
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {billingCity
                  ? `${billingCity}${billingState ? `/${billingState}` : ""}`
                  : "opcional — para a nota fiscal"}
              </span>
            </summary>
            <div className="space-y-2 border-t border-border p-3">
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">CEP</Label>
                  <Input
                    placeholder="só números"
                    value={billingPostalCode}
                    onChange={(e) => setBillingPostalCode(e.target.value)}
                  />
                </div>
                <div className="col-span-2 space-y-1">
                  <Label className="text-xs text-muted-foreground">Cidade</Label>
                  <Input
                    placeholder="ex.: Belo Horizonte"
                    value={billingCity}
                    onChange={(e) => setBillingCity(e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <div className="col-span-3 space-y-1">
                  <Label className="text-xs text-muted-foreground">Logradouro</Label>
                  <Input
                    placeholder="rua, avenida…"
                    value={billingAddress}
                    onChange={(e) => setBillingAddress(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Número</Label>
                  <Input
                    placeholder="123"
                    value={billingAddressNumber}
                    onChange={(e) => setBillingAddressNumber(e.target.value)}
                  />
                </div>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <div className="col-span-2 space-y-1">
                  <Label className="text-xs text-muted-foreground">Bairro</Label>
                  <Input
                    value={billingProvince}
                    onChange={(e) => setBillingProvince(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Compl.</Label>
                  <Input
                    placeholder="sala 2"
                    value={billingComplement}
                    onChange={(e) => setBillingComplement(e.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">UF</Label>
                  <Input
                    placeholder="MG"
                    maxLength={2}
                    value={billingState}
                    onChange={(e) => setBillingState(e.target.value.toUpperCase())}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Salva com o resto ao clicar em <strong>Salvar</strong>. Nenhuma
                cobrança depende destes campos — quem tiver, preenche; quando a
                nota fiscal entrar, já está tudo cadastrado.
              </p>
            </div>
          </details>

          {/* ⚠️ 26/09: este campo VIVIA DENTRO do quadro "Cobrança no Asaas",
              colado no botão Buscar e sem rótulo — parecia ferramenta de
              busca, não cadastro. O Alex digitou o CPF do João, clicou em
              Buscar, e o documento nunca foi salvo (banco vazio). O campo
              sempre gravou; o que enganava era o lugar. CPF é dado do
              CLIENTE: fica aqui, com os outros dados dele. */}
          <div className="space-y-1">
            <Label className="text-muted-foreground">CPF/CNPJ do cliente</Label>
            <Input
              placeholder="só números — ex.: 34729715845"
              value={cpfCnpj}
              onChange={(e) => setCpfCnpj(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Fica salvo no cadastro ao clicar em <strong>Salvar</strong>. Sem
              ele não dá para criar a cobrança no Asaas — a conta lá só abre
              com documento.
            </p>
          </div>

          {/* 🔗 Asaas — o que o cliente paga de verdade (24/09). Sem isto o
              painel somava o preço de TABELA e mostrava MRR errado. */}
          <div className="space-y-2 rounded-lg border border-border p-3">
            <Label className="text-muted-foreground">Cobrança no Asaas</Label>

            <p className="text-xs text-muted-foreground">
              Procura no Asaas pelo CPF/CNPJ acima (ou pelo nome/e-mail do
              cliente) e traz o valor que ele já paga lá. Buscar NÃO salva
              nada — quem salva é o botão Salvar.
            </p>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              onClick={() => void buscarNoAsaas()}
              disabled={asaasBusy}
            >
              {asaasBusy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                "Buscar no Asaas"
              )}
            </Button>

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
                    className="block w-full rounded border border-border bg-background px-2 py-1.5 text-left hover:bg-muted"
                  >
                    Assinatura · {brl(s.value)}/mês
                    {s.description ? ` · ${s.description}` : ""}
                    <span className="block text-xs text-primary">Clique para usar este valor</span>
                  </button>
                ))}
                {asaasBilling.installments.map((i) => {
                  // A PARCELA é o que o cliente paga por mês; `value` é o total.
                  const parcela = i.installmentValue ?? (i.installmentCount ? i.value / i.installmentCount : i.value);
                  return (
                    <button
                      key={i.id}
                      type="button"
                      onClick={() => {
                        setMonthlyValue(parcela.toFixed(2).replace(".", ","));
                        toast.success("Valor da parcela copiado — salve para confirmar.");
                      }}
                      className="block w-full rounded border border-border bg-background px-2 py-1.5 text-left hover:bg-muted"
                    >
                      Parcelamento · {i.installmentCount ?? "?"}× {brl(parcela)}
                      <span className="text-muted-foreground"> (total {brl(i.value)})</span>
                      {i.description ? ` · ${i.description}` : ""}
                      <span className="block text-xs text-primary">Clique para usar este valor</span>
                    </button>
                  );
                })}
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

            {/* Periodicidade (migr 0194). Aprovado 26/09: mensal cheio,
                semestral −20%, anual −30%. ⚠️ O valor acima continua sendo
                POR MÊS — este campo diz o compromisso, não muda a unidade,
                senão o MRR inflaria 6x num semestral. */}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Periodicidade do contrato
              </Label>
              <select
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                value={billingCycle}
                onChange={(e) => setBillingCycle(e.target.value)}
              >
                <option value="">Não declarado</option>
                {BILLING_CYCLES.map((c) => (
                  <option key={c} value={c}>
                    {CYCLES[c].label} ({CYCLES[c].short})
                    {CYCLES[c].discount > 0
                      ? ` — tabela: -${Math.round(CYCLES[c].discount * 100)}%`
                      : ""}
                  </option>
                ))}
              </select>
              {billingCycle && billingCycle !== "monthly" && (
                <p className="text-xs text-muted-foreground">
                  Compromisso de {CYCLES[billingCycle as BillingCycle].months} meses.
                  {monthlyValue.trim()
                    ? ` Total do contrato: ${(
                        Number(monthlyValue.replace(/\./g, "").replace(",", ".")) *
                        CYCLES[billingCycle as BillingCycle].months
                      ).toLocaleString("pt-BR", {
                        style: "currency",
                        currency: "BRL",
                      })}.`
                    : ""}
                </p>
              )}
            </div>

            {(asaasCustomerId || asaasSubscriptionId || asaasPaymentId) && (
              <p className="text-xs text-muted-foreground">
                Vinculado: {asaasCustomerId || "—"}
                {asaasSubscriptionId ? ` · assinatura ${asaasSubscriptionId}` : ""}
                {asaasPaymentId ? ` · cobrança ${asaasPaymentId}` : ""}
              </p>
            )}

            {/* ⚠️ 24/09: o Renato tem PARCELAMENTO, não assinatura — e o
                formulário de criar aparecia do mesmo jeito, convidando a
                cobrar duas vezes o mesmo cliente. Com parcelamento à vista,
                avisa em vez de oferecer o botão. */}
            {!asaasSubscriptionId && !asaasPaymentId && (asaasBilling?.installments.length ?? 0) > 0 && (
              <p className="border-t border-border pt-3 text-xs text-amber-600 dark:text-amber-400">
                Atenção: este cliente já tem parcelamento no Asaas. Se o
                parcelamento JÁ É o pagamento do CRM, use o valor da parcela
                acima e salve — criar assinatura geraria cobrança dobrada. Se
                for de outro produto (Agente de Cobrança, implantação), pode
                criar a assinatura do CRM abaixo normalmente.
              </p>
            )}

            {/* ⚠️ 26/09: isto ficava ESCONDIDO quando havia qualquer
                parcelamento no Asaas. O João tem 12× do Agente de Cobrança —
                produto diferente — e a assinatura do CRM simplesmente não
                tinha como ser criada pela tela. A regra assumia que
                parcelamento = pagamento do CRM, que é só um dos casos. Agora
                o bloco aparece sempre; quem decide é quem conhece o cliente,
                com o aviso acima e a confirmação do próprio botão. */}
            {!asaasSubscriptionId && !asaasPaymentId && (
              <div className="space-y-2 border-t border-border pt-3">
                <Label className="text-xs text-muted-foreground">
                  {cobranca.unica
                    ? `Emitir a cobrança ${CYCLES[billingCycle as BillingCycle].label.toLowerCase()} no Asaas`
                    : "Criar assinatura mensal no Asaas"}
                </Label>
                <div className="flex gap-2">
                  <Input
                    placeholder={
                      cobranca.unica ? "Valor POR MÊS (ex.: 130)" : "Valor (ex.: 497)"
                    }
                    value={novoValor}
                    onChange={(e) => setNovoValor(e.target.value)}
                  />
                  <Input
                    type="date"
                    value={novoVenc}
                    onChange={(e) => setNovoVenc(e.target.value)}
                  />
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="Passa a valer (ex.: 697)"
                    value={futuroValor}
                    onChange={(e) => setFuturoValor(e.target.value)}
                  />
                  <Input
                    type="date"
                    value={futuroDe}
                    onChange={(e) => setFuturoDe(e.target.value)}
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  O segundo par é o reajuste combinado: o Asaas não agenda troca
                  de valor, então ele fica anotado nas notas do cliente para
                  alguém subir na data.
                </p>

                {/* O que vai sair, em reais, antes do clique. Num semestral o
                    número digitado NÃO é o número cobrado, e é o cobrado que
                    chega no cliente. */}
                {cobranca.unica && cobranca.mensal > 0 && (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                    <p className="text-sm font-semibold text-foreground">
                      Vai emitir UMA cobrança de {brl(cobranca.total)}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {cobranca.meses} meses × {brl(cobranca.mensal)}/mês — o
                      contrato inteiro de uma vez, que é como o{" "}
                      {CYCLES[billingCycle as BillingCycle].label.toLowerCase()}{" "}
                      funciona. O cliente escolhe Pix, boleto ou cartão na fatura
                      e parcela no cartão dele se quiser; aqui entra integral.
                    </p>
                    <p className="mt-1 text-xs text-muted-foreground">
                      No painel o cliente continua valendo{" "}
                      {brl(cobranca.mensal)} de MRR — receita recorrente é
                      mensal, e o semestre não multiplica isso.
                    </p>
                  </div>
                )}

                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={() => void criarAssinatura()}
                  disabled={criando}
                >
                  {criando ? (
                    <Loader2 className="mr-2 size-4 animate-spin" />
                  ) : null}
                  {cobranca.unica && cobranca.mensal > 0
                    ? `Emitir cobrança de ${brl(cobranca.total)}`
                    : "Criar assinatura e cobrar"}
                </Button>
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Gera o boleto no Asaas e avisa o cliente. Não tem desfazer.
                </p>
              </div>
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

"use client";

// ============================================================
// Seção Propostas (menu → Propostas). Cria propostas do zero: preenche o
// cliente (empresa/CNPJ), monta os itens, gera o link e envia. Reusa o
// documento público + PDF + e-mail + rastreio (visualizou/aceitou). Cada
// proposta vive num negócio (novo ou existente) → aparece no lead também.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Plus,
  Copy,
  Trash2,
  ExternalLink,
  FileText,
  Loader2,
  GitBranch,
  Send,
  X,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { formatCurrency } from "@/lib/currency";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { sendDealProposalEmail } from "@/app/(dashboard)/pipelines/actions";
import {
  listAllProposals,
  listProposalPipelines,
  searchLeadsForProposal,
  saveProposalDraft,
  deleteProposal,
  type ProposalListRow,
  type ProposalItemInput,
} from "./actions";
import type { DiscountType } from "@/lib/proposals/shared";

type Pipeline = { id: string; name: string; stages: { id: string; name: string }[] };

const STATUS_META: Record<
  ProposalListRow["status"],
  { label: string; cls: string }
> = {
  aceita: {
    label: "✅ Aceita",
    cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  vista: {
    label: "👀 Vista",
    cls: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  },
  criada: { label: "Criada", cls: "bg-muted text-muted-foreground" },
};

export default function PropostasPage() {
  const [proposals, setProposals] = useState<ProposalListRow[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [p, pl] = await Promise.all([
      listAllProposals().catch(() => [] as ProposalListRow[]),
      listProposalPipelines().catch(() => [] as Pipeline[]),
    ]);
    setProposals(p);
    setPipelines(pl);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleDelete(id: string) {
    if (!confirm("Excluir esta proposta? O link para de funcionar.")) return;
    const { error } = await deleteProposal(id);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Proposta excluída.");
    void load();
  }

  function copy(url: string) {
    navigator.clipboard?.writeText(url);
    toast.success("Link copiado.");
  }

  if (creating) {
    return (
      <ProposalCreator
        pipelines={pipelines}
        onCancel={() => setCreating(false)}
        onSaved={() => {
          setCreating(false);
          void load();
        }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-foreground">Propostas</h1>
          <p className="text-sm text-muted-foreground">
            Crie propostas profissionais, gere o link e acompanhe quem viu e
            aceitou.
          </p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus className="mr-1.5 h-4 w-4" /> Nova proposta
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : proposals.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
          <FileText className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            Nenhuma proposta ainda. Crie a primeira e mande o link pro cliente.
          </p>
          <Button className="mt-4" onClick={() => setCreating(true)}>
            <Plus className="mr-1.5 h-4 w-4" /> Nova proposta
          </Button>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-left text-xs text-muted-foreground">
                <th className="px-4 py-2.5 font-medium">Cliente</th>
                <th className="px-4 py-2.5 font-medium">Negócio</th>
                <th className="px-4 py-2.5 text-right font-medium">Valor</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5" />
              </tr>
            </thead>
            <tbody>
              {proposals.map((p) => (
                <tr
                  key={p.id}
                  className="border-b border-border/60 last:border-0 hover:bg-muted/30"
                >
                  <td className="px-4 py-2.5 text-foreground">
                    {p.clientName || "—"}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {p.dealTitle}
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-foreground">
                    {formatCurrency(p.value, p.currency)}
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] ${STATUS_META[p.status].cls}`}
                    >
                      {STATUS_META[p.status].label}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        type="button"
                        onClick={() => copy(p.publicUrl)}
                        title="Copiar link"
                        className="rounded p-1.5 text-muted-foreground hover:bg-background hover:text-foreground"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                      <a
                        href={p.publicUrl}
                        target="_blank"
                        rel="noreferrer"
                        title="Abrir proposta"
                        className="rounded p-1.5 text-muted-foreground hover:bg-background hover:text-foreground"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                      <a
                        href={`/pipelines/${p.dealId}`}
                        title="Abrir no negócio"
                        className="rounded p-1.5 text-muted-foreground hover:bg-background hover:text-foreground"
                      >
                        <GitBranch className="h-3.5 w-3.5" />
                      </a>
                      <button
                        type="button"
                        onClick={() => void handleDelete(p.id)}
                        title="Excluir"
                        className="rounded p-1.5 text-muted-foreground hover:bg-background hover:text-red-500"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Criador de proposta.
// ------------------------------------------------------------
function ProposalCreator({
  pipelines,
  onCancel,
  onSaved,
}: {
  pipelines: Pipeline[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { defaultCurrency } = useAuth();
  const money = (v: number) => formatCurrency(v, defaultCurrency);

  const [mode, setMode] = useState<"new" | "existing">("new");
  // cliente (novo)
  const [clientName, setClientName] = useState("");
  const [clientCompany, setClientCompany] = useState("");
  const [clientDocument, setClientDocument] = useState("");
  const [clientPhone, setClientPhone] = useState("");
  const [clientEmail, setClientEmail] = useState("");
  const [pipelineId, setPipelineId] = useState("");
  const [stageId, setStageId] = useState("");
  // existente
  const [leadQuery, setLeadQuery] = useState("");
  const [leadResults, setLeadResults] = useState<{ id: string; label: string }[]>([]);
  const [pickedLead, setPickedLead] = useState<{ id: string; label: string } | null>(null);
  // proposta
  const [title, setTitle] = useState("");
  const [items, setItems] = useState<ProposalItemInput[]>([
    { name: "", quantity: 1, unitPrice: 0 },
  ]);
  const [discount, setDiscount] = useState("");
  const [discountType, setDiscountType] = useState<DiscountType>("value");
  const [validUntil, setValidUntil] = useState("");
  const [terms, setTerms] = useState("");
  // marca
  const [brandMode, setBrandMode] = useState<"profile" | "custom">("profile");
  const [ovName, setOvName] = useState("");
  const [ovTagline, setOvTagline] = useState("");
  const [ovPayments, setOvPayments] = useState("");
  const [ovLogo, setOvLogo] = useState("");
  const [uploadingLogo, setUploadingLogo] = useState(false);

  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState<{ url: string; dealId: string } | null>(null);
  const [sendingEmail, setSendingEmail] = useState(false);

  const stages = pipelines.find((p) => p.id === pipelineId)?.stages ?? [];

  const subtotal = items.reduce(
    (s, it) => s + (Number(it.quantity) || 0) * (Number(it.unitPrice) || 0),
    0,
  );
  const disc =
    discountType === "percent"
      ? (subtotal * (parseFloat(discount) || 0)) / 100
      : parseFloat(discount) || 0;
  const total = Math.max(0, subtotal - Math.max(0, Math.min(disc, subtotal)));

  function setItem(i: number, patch: Partial<ProposalItemInput>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }
  function addItem() {
    setItems((prev) => [...prev, { name: "", quantity: 1, unitPrice: 0 }]);
  }
  function removeItem(i: number) {
    setItems((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev));
  }

  async function runLeadSearch(q: string) {
    setLeadQuery(q);
    if (q.trim().length < 2) {
      setLeadResults([]);
      return;
    }
    const res = await searchLeadsForProposal(q).catch(() => []);
    setLeadResults(res);
  }

  async function onLogoPick(file: File | null) {
    if (!file) return;
    setUploadingLogo(true);
    try {
      const { publicUrl } = await uploadAccountMedia("avatars", file);
      setOvLogo(publicUrl);
    } catch {
      toast.error("Falha ao enviar a logo.");
    } finally {
      setUploadingLogo(false);
    }
  }

  async function handleSave() {
    if (mode === "new" && !clientPhone.trim()) {
      toast.error("Informe o WhatsApp do cliente.");
      return;
    }
    if (mode === "existing" && !pickedLead) {
      toast.error("Escolha um negócio para anexar a proposta.");
      return;
    }
    if (items.every((it) => !it.name.trim())) {
      toast.error("Adicione ao menos um item.");
      return;
    }
    setSaving(true);
    const res = await saveProposalDraft({
      mode,
      dealId: mode === "existing" ? pickedLead?.id : null,
      clientName,
      clientCompany,
      clientDocument,
      clientPhone,
      clientEmail,
      pipelineId: pipelineId || null,
      stageId: stageId || null,
      title,
      items,
      discount: parseFloat(discount) || 0,
      discountType,
      validUntil: validUntil || null,
      terms: terms || null,
      sellerOverride:
        brandMode === "custom"
          ? {
              name: ovName,
              tagline: ovTagline,
              paymentMethods: ovPayments,
              logo: ovLogo,
            }
          : null,
    });
    setSaving(false);
    if (res.error || !res.publicUrl || !res.dealId) {
      toast.error(res.error || "Falha ao gerar a proposta.");
      return;
    }
    toast.success("Proposta gerada!");
    setDone({ url: res.publicUrl, dealId: res.dealId });
  }

  async function handleSendEmail() {
    if (!done) return;
    setSendingEmail(true);
    const { error } = await sendDealProposalEmail(done.dealId);
    setSendingEmail(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Proposta enviada por e-mail.");
  }

  const selectCls =
    "h-10 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";

  // Tela de sucesso.
  if (done) {
    return (
      <div className="mx-auto max-w-lg space-y-4 py-8 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl dark:bg-emerald-500/20">
          ✓
        </div>
        <h1 className="text-xl font-bold text-foreground">Proposta pronta!</h1>
        <p className="text-sm text-muted-foreground">
          O link já está no ar. Copie, abra ou envie por e-mail — e você é
          avisado quando o cliente visualizar ou aceitar.
        </p>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/50 px-3 py-2">
          <span className="flex-1 truncate text-left text-xs text-muted-foreground">
            {done.url}
          </span>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard?.writeText(done.url);
              toast.success("Link copiado.");
            }}
            className="rounded p-1 text-muted-foreground hover:text-foreground"
          >
            <Copy className="h-4 w-4" />
          </button>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <a href={done.url} target="_blank" rel="noreferrer">
            <Button variant="outline">
              <ExternalLink className="mr-1.5 h-4 w-4" /> Abrir / PDF
            </Button>
          </a>
          <Button variant="outline" onClick={() => void handleSendEmail()} disabled={sendingEmail}>
            {sendingEmail ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-1.5 h-4 w-4" />
            )}
            Enviar por e-mail
          </Button>
          <a href={`/pipelines/${done.dealId}`}>
            <Button variant="outline">
              <GitBranch className="mr-1.5 h-4 w-4" /> Abrir no negócio
            </Button>
          </a>
        </div>
        <Button variant="ghost" onClick={onSaved}>
          Voltar às propostas
        </Button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Nova proposta</h1>
        <p className="text-sm text-muted-foreground">
          Preencha os dados, monte os itens e gere o link.
        </p>
      </div>

      {/* Destino / cliente */}
      <div className="space-y-4 rounded-xl border border-border bg-card p-4">
        <div className="flex overflow-hidden rounded-lg border border-border">
          {(["new", "existing"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`flex-1 px-3 py-2 text-sm transition ${
                mode === m
                  ? "bg-primary text-primary-foreground"
                  : "bg-transparent text-muted-foreground hover:bg-muted"
              }`}
            >
              {m === "new" ? "Novo cliente / lead" : "Lead existente"}
            </button>
          ))}
        </div>

        {mode === "new" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Nome do cliente</Label>
                <Input value={clientName} onChange={(e) => setClientName(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>WhatsApp *</Label>
                <Input
                  value={clientPhone}
                  onChange={(e) => setClientPhone(e.target.value)}
                  placeholder="Ex.: 67 99999-9999"
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Empresa</Label>
                <Input value={clientCompany} onChange={(e) => setClientCompany(e.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label>CNPJ / CPF</Label>
                <Input value={clientDocument} onChange={(e) => setClientDocument(e.target.value)} />
              </div>
              <div className="grid gap-1.5 sm:col-span-2">
                <Label>E-mail (para enviar por e-mail)</Label>
                <Input value={clientEmail} onChange={(e) => setClientEmail(e.target.value)} />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Funil</Label>
                <select
                  value={pipelineId}
                  onChange={(e) => {
                    setPipelineId(e.target.value);
                    setStageId("");
                  }}
                  className={selectCls}
                >
                  <option value="">Primeiro funil</option>
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid gap-1.5">
                <Label>Etapa</Label>
                <select
                  value={stageId}
                  onChange={(e) => setStageId(e.target.value)}
                  disabled={!pipelineId}
                  className={selectCls}
                >
                  <option value="">Primeira etapa</option>
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </>
        ) : (
          <div className="grid gap-1.5">
            <Label>Buscar negócio</Label>
            {pickedLead ? (
              <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
                <span className="flex-1 truncate text-foreground">{pickedLead.label}</span>
                <button
                  type="button"
                  onClick={() => setPickedLead(null)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            ) : (
              <>
                <Input
                  value={leadQuery}
                  onChange={(e) => void runLeadSearch(e.target.value)}
                  placeholder="Nome do negócio, contato ou telefone"
                />
                {leadResults.length > 0 && (
                  <div className="overflow-hidden rounded-lg border border-border">
                    {leadResults.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        onClick={() => {
                          setPickedLead(r);
                          setLeadResults([]);
                        }}
                        className="block w-full truncate px-3 py-2 text-left text-sm text-foreground hover:bg-muted"
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <div className="grid gap-1.5">
          <Label>Título da proposta (opcional)</Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Ex.: Implantação do CRM Fluxia"
          />
        </div>
      </div>

      {/* Itens */}
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="text-sm font-semibold text-foreground">Itens</div>
        {items.map((it, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <div className="min-w-[140px] flex-1 grid gap-1">
              <label className="text-[11px] text-muted-foreground">Descrição</label>
              <Input value={it.name} onChange={(e) => setItem(i, { name: e.target.value })} />
            </div>
            <div className="grid w-16 gap-1">
              <label className="text-[11px] text-muted-foreground">Qtd</label>
              <Input
                type="number"
                min={0}
                value={it.quantity}
                onChange={(e) => setItem(i, { quantity: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="grid w-28 gap-1">
              <label className="text-[11px] text-muted-foreground">Preço un.</label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={it.unitPrice}
                onChange={(e) => setItem(i, { unitPrice: Number(e.target.value) || 0 })}
              />
            </div>
            <button
              type="button"
              onClick={() => removeItem(i)}
              className="mb-1.5 rounded p-1.5 text-muted-foreground hover:text-red-500"
            >
              <Trash2 className="h-4 w-4" />
            </button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={addItem}>
          <Plus className="mr-1.5 h-3.5 w-3.5" /> Adicionar item
        </Button>

        <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-3">
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">Desconto</span>
            <Input
              type="number"
              min={0}
              value={discount}
              onChange={(e) => setDiscount(e.target.value)}
              className="h-8 w-24"
            />
            <div className="flex overflow-hidden rounded-lg border border-border">
              {(["value", "percent"] as DiscountType[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setDiscountType(t)}
                  className={`px-2 py-1 text-xs ${
                    discountType === t
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground"
                  }`}
                >
                  {t === "value" ? "R$" : "%"}
                </button>
              ))}
            </div>
          </div>
          <div className="text-sm">
            <span className="text-muted-foreground">Total: </span>
            <strong className="tabular-nums text-foreground">{money(total)}</strong>
          </div>
        </div>
      </div>

      {/* Condições */}
      <div className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label>Válida até</Label>
          <Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label>Condições / observações</Label>
          <textarea
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            rows={3}
            className="w-full resize-none rounded-lg border border-border bg-muted px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary"
          />
        </div>
      </div>

      {/* Marca */}
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="text-sm font-semibold text-foreground">Sua marca</div>
        <div className="flex overflow-hidden rounded-lg border border-border">
          {(["profile", "custom"] as const).map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => setBrandMode(b)}
              className={`flex-1 px-3 py-2 text-sm transition ${
                brandMode === b
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {b === "profile" ? "Usar meu perfil" : "Personalizar"}
            </button>
          ))}
        </div>
        {brandMode === "profile" ? (
          <p className="text-xs text-muted-foreground">
            A logo e os dados da sua empresa saem do perfil em Configurações.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label>Nome / empresa</Label>
              <Input value={ovName} onChange={(e) => setOvName(e.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>Slogan / descrição</Label>
              <Input value={ovTagline} onChange={(e) => setOvTagline(e.target.value)} />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>Formas de pagamento</Label>
              <Input value={ovPayments} onChange={(e) => setOvPayments(e.target.value)} />
            </div>
            <div className="grid gap-1.5 sm:col-span-2">
              <Label>Logo</Label>
              <div className="flex items-center gap-3">
                {ovLogo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={ovLogo} alt="logo" className="h-10 w-auto max-w-[120px] object-contain" />
                ) : null}
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => void onLogoPick(e.target.files?.[0] ?? null)}
                  className="text-xs text-muted-foreground"
                />
                {uploadingLogo ? (
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : null}
                {ovLogo ? (
                  <button
                    type="button"
                    onClick={() => setOvLogo("")}
                    className="text-xs text-muted-foreground hover:text-red-500"
                  >
                    remover
                  </button>
                ) : null}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={() => void handleSave()} disabled={saving}>
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
          Gerar proposta
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

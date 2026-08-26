"use client";

import { useState, useEffect } from "react";
import {
  listAssignees,
  listConversationsForContact,
  createDeal,
  updateDeal,
  deleteDeal,
  getLostReasonsConfig,
  openDealConversation,
  openDealWhatsApp,
} from "@/app/(dashboard)/pipelines/actions";
import {
  listProducts,
  type ProductRow,
} from "@/app/(dashboard)/settings/products-actions";
import { useAuth } from "@/hooks/use-auth";
import { ContactPicker } from "@/components/contacts/contact-picker";
import {
  getPickerContact,
  type PickerContact,
} from "@/components/contacts/contact-picker-actions";
import { CURRENCIES } from "@/lib/currency";
import type {
  Contact,
  Conversation,
  Deal,
  DealStatus,
  PipelineStage,
  Profile,
} from "@/types";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Check,
  X,
  Trash2,
  MessageSquare,
  AtSign,
  DollarSign,
  Loader2,
  ExternalLink,
  Star,
} from "lucide-react";
import {
  dealChannelLabel,
  isInstagramProvider,
} from "@/lib/pipelines/channel-label";
import { DEAL_ORIGINS, isDealOrigin } from "@/lib/pipelines/deal-origin";
import { toast } from "sonner";

interface DealFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  deal?: Deal | null;
  pipelineId: string;
  stages: PipelineStage[];
  defaultStageId?: string;
  /** Pre-select this contact on a NEW deal (e.g. opened from a conversation —
   *  the client is already known, so don't make the agent search for them). The
   *  field shows the contact locked, with an "Alterar" to switch it. */
  defaultContactId?: string;
  /** Vincula o negócio NOVO a esta conversa (quando o form abre PELA conversa),
   *  pra o card do funil já mostrar a bolinha de chat. */
  defaultConversationId?: string | null;
  onSaved: () => void;
}

export function DealForm({
  open,
  onOpenChange,
  deal,
  pipelineId,
  stages,
  defaultStageId,
  defaultContactId,
  defaultConversationId,
  onSaved,
}: DealFormProps) {
  const { accountId, defaultCurrency } = useAuth();

  const [title, setTitle] = useState("");
  const [value, setValue] = useState("");
  const [currency, setCurrency] = useState(defaultCurrency);
  const [contactId, setContactId] = useState("");
  const [stageId, setStageId] = useState("");
  const [assignedTo, setAssignedTo] = useState("");
  const [expectedCloseDate, setExpectedCloseDate] = useState("");
  const [notes, setNotes] = useState("");
  const [temperature, setTemperature] = useState("");
  const [source, setSource] = useState("");
  const [origin, setOrigin] = useState("");
  const [qualification, setQualification] = useState(0);

  const [selectedContact, setSelectedContact] = useState<PickerContact | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [catalog, setCatalog] = useState<ProductRow[]>([]);
  const [prodQuery, setProdQuery] = useState("");
  const [prodOpen, setProdOpen] = useState(false);
  const [linkedConversation, setLinkedConversation] =
    useState<Conversation | null>(null);

  // Botão de WhatsApp: vai pra conversa vinculada, ou resolve/cria pelo telefone
  // do contato do negócio (e vincula). Só faz sentido num negócio já salvo.
  const openChat = async () => {
    if (!deal?.id) return;
    const res = await openDealConversation(deal.id);
    if (res.conversationId) {
      window.location.href = `/inbox?c=${res.conversationId}`;
    } else {
      toast.error(res.error || "Não foi possível abrir a conversa");
    }
  };

  // "Falar no WhatsApp": abre/cria a conversa de WhatsApp pelo telefone do
  // contato (mesmo quando o negócio veio de outro canal). Só aparece quando a
  // origem NÃO é WhatsApp e o contato tem telefone.
  const openWhats = async () => {
    if (!deal?.id) return;
    const res = await openDealWhatsApp(deal.id);
    if (res.conversationId) {
      window.location.href = `/inbox?c=${res.conversationId}`;
    } else {
      toast.error(res.error || "Não foi possível abrir o WhatsApp");
    }
  };

  const [saving, setSaving] = useState(false);
  const [statusAction, setStatusAction] = useState<DealStatus | null>(null);
  // Motivo de perda (estilo RD): ao marcar perda, pede o porquê.
  const [lostReasonOpen, setLostReasonOpen] = useState(false);
  const [lostReason, setLostReason] = useState("");
  // Chips = motivos da CONTA. Lista FECHADA (Config→Negócios) = sem texto
  // livre, chip obrigatório.
  const [reasonOptions, setReasonOptions] = useState<string[]>([]);
  const [reasonsLocked, setReasonsLocked] = useState(false);
  const [reasonsLoaded, setReasonsLoaded] = useState(false);
  useEffect(() => {
    if (!lostReasonOpen || reasonsLoaded) return;
    getLostReasonsConfig()
      .then((res) => {
        setReasonOptions(res.reasons);
        setReasonsLocked(res.locked);
        setReasonsLoaded(true);
      })
      .catch(() => {});
  }, [lostReasonOpen, reasonsLoaded]);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // When opened from a conversation the contact is known — show it locked
  // (just the client) instead of an empty "Selecione um contato". "Alterar"
  // flips this to the full picker.

  // Reset the form fields every time the sheet opens or its input
  // props change. This is a legitimate prop-driven sync; the rule is
  // over-cautious here, hence the block-level disable.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setConfirmDelete(false);
    setProdQuery("");
    setProdOpen(false);
    if (deal) {
      setTitle(deal.title);
      setValue(String(deal.value ?? ""));
      setCurrency(deal.currency || defaultCurrency);
      // contact_id is nullable when the contact has been deleted
      // (migration 004: ON DELETE SET NULL). "" means "no selection".
      setContactId(deal.contact_id ?? "");
      setStageId(deal.stage_id);
      setAssignedTo(deal.assigned_to ?? "");
      setExpectedCloseDate(deal.expected_close_date ?? "");
      setNotes(deal.notes ?? "");
      setTemperature(deal.temperature ?? "");
      setSource(deal.source ?? "");
      setOrigin(deal.origin ?? "");
      setQualification(deal.qualification ?? 0);
      setLostReason(deal.lost_reason ?? "");
      setLostReasonOpen(false);
    } else {
      setTitle("");
      setValue("");
      setCurrency(defaultCurrency);
      setContactId(defaultContactId ?? "");
      setStageId(defaultStageId || stages[0]?.id || "");
      setAssignedTo("");
      setExpectedCloseDate("");
      setNotes("");
      setTemperature("");
      setSource("");
      setOrigin("");
      // Opened from a conversation → start with the contact locked-in.
    }
  }, [open, deal, defaultStageId, defaultContactId, stages, defaultCurrency]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Resolve nome/telefone do contato selecionado (edição ou vindo da conversa).
  useEffect(() => {
    if (!contactId) {
      setSelectedContact(null);
      return;
    }
    if (selectedContact?.id === contactId) return;
    let alive = true;
    getPickerContact(contactId)
      .then((c) => alive && c && setSelectedContact(c))
      .catch(() => {});
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contactId]);

  // Load supporting data once the sheet is open
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const p = await listAssignees();
      if (cancelled) return;
      setProfiles(p);
    })();
    // Catálogo (ativos) p/ o seletor de produto no Valor.
    listProducts()
      .then((prods) => !cancelled && setCatalog(prods))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Fetch linked conversation for the selected contact (newest open one).
  // Clearing on no-selection is sync with prop state; the populated
  // case runs setLinkedConversation inside the async fetch callback.
  useEffect(() => {
    if (!open || !contactId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLinkedConversation(null);
      return;
    }
    let cancelled = false;
    (async () => {
      const data = await listConversationsForContact(contactId);
      if (cancelled) return;
      setLinkedConversation(data ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, contactId]);

  async function handleSave() {
    if (!title.trim() || !contactId || !stageId) {
      toast.error("Título, contato e etapa são obrigatórios");
      return;
    }
    setSaving(true);

    const payload = {
      title: title.trim(),
      value: parseFloat(value) || 0,
      currency,
      contact_id: contactId,
      pipeline_id: pipelineId,
      stage_id: stageId,
      assigned_to: assignedTo || null,
      notes: notes.trim() || null,
      expected_close_date: expectedCloseDate || null,
      temperature: temperature || null,
      source: source.trim() || null,
      origin: origin.trim() || null,
      qualification: qualification || null,
    };

    if (deal) {
      const { error } = await updateDeal(deal.id, payload);
      if (error) {
        toast.error("Falha ao salvar negócio");
        setSaving(false);
        return;
      }
    } else {
      if (!accountId) {
        toast.error("Seu perfil não está vinculado a uma conta.");
        setSaving(false);
        return;
      }
      // Vincula a conversa ao negócio NOVO: a conversa de onde o form foi
      // aberto tem prioridade; senão, a conversa vinculada do contato. Assim o
      // card do funil já nasce com a bolinha de chat.
      const { error } = await createDeal({
        ...payload,
        conversation_id: defaultConversationId ?? linkedConversation?.id ?? null,
      });
      if (error) {
        toast.error("Falha ao criar negócio");
        setSaving(false);
        return;
      }
    }

    setSaving(false);
    toast.success(deal ? "Negócio atualizado" : "Negócio criado");
    onOpenChange(false);
    onSaved();
  }

  async function handleStatusChange(status: DealStatus, reason?: string) {
    if (!deal) return;
    setStatusAction(status);
    const { error } = await updateDeal(deal.id, {
      status,
      ...(status === "lost"
        ? { lost_reason: (reason ?? "").trim() || null }
        : {}),
    });
    setStatusAction(null);
    if (error) {
      toast.error("Falha ao atualizar o status do negócio");
      return;
    }
    setLostReasonOpen(false);
    toast.success(
      status === "won" ? "Marcado como ganho" : status === "lost" ? "Marcado como perdido" : "Negócio reaberto",
    );
    onOpenChange(false);
    onSaved();
  }

  async function handleDelete() {
    if (!deal) return;
    setDeleting(true);
    const { error } = await deleteDeal(deal.id);
    setDeleting(false);
    if (error) {
      toast.error("Falha ao excluir negócio");
      return;
    }
    toast.success("Negócio excluído");
    setConfirmDelete(false);
    onOpenChange(false);
    onSaved();
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="bg-popover border-border text-popover-foreground sm:max-w-lg w-full p-0"
      >
        <div className="flex h-full flex-col">
          <SheetHeader className="border-b border-border/50 p-4">
            <SheetTitle className="text-popover-foreground">
              {deal ? "Editar negócio" : "Novo negócio"}
            </SheetTitle>
            {/* Ver no funil — atalho pro detalhe do negócio (mostra a etapa
                atual no topo). Só ao editar um negócio já existente. */}
            {deal && (
              <button
                type="button"
                onClick={() => {
                  window.location.href = `/pipelines/${deal.id}`;
                }}
                className="mt-1 inline-flex items-center gap-1.5 self-start rounded-md bg-primary/10 px-2 py-1 text-xs text-primary hover:bg-primary/20"
              >
                <ExternalLink className="h-3 w-3" />
                Ver no funil
              </button>
            )}
          </SheetHeader>

          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            <div className="grid gap-2">
              <Label className="text-muted-foreground">Título</Label>
              <Input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Título do negócio"
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Contato</Label>
              <ContactPicker
                value={contactId}
                onChange={(id, c) => {
                  setContactId(id);
                  setSelectedContact(c);
                }}
              />

              {deal?.id &&
                (() => {
                  const chIsIg = isInstagramProvider(deal.channel_provider);
                  const originIsWhats =
                    dealChannelLabel(deal.channel_provider) === "WhatsApp";
                  const contactHasPhone =
                    selectedContact?.id === contactId && !!selectedContact.phone;
                  // Primário: abre a conversa de ORIGEM do negócio (o canal de
                  // onde o lead veio). Secundário: WhatsApp pelo telefone, só se a
                  // origem não é WhatsApp e o contato tem telefone preenchido.
                  const showPrimary = !!linkedConversation || contactHasPhone;
                  const showWhats = !originIsWhats && contactHasPhone;
                  if (!showPrimary && !showWhats) return null;
                  return (
                    <div className="mt-1 flex flex-wrap gap-2">
                      {showPrimary && (
                        <button
                          type="button"
                          onClick={openChat}
                          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium ${
                            chIsIg
                              ? "bg-pink-500/10 text-pink-600 hover:bg-pink-500/20"
                              : "bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/20"
                          }`}
                        >
                          {chIsIg ? (
                            <AtSign className="h-3.5 w-3.5" />
                          ) : (
                            <MessageSquare className="h-3.5 w-3.5" />
                          )}
                          Abrir conversa no{" "}
                          {dealChannelLabel(deal.channel_provider)}
                        </button>
                      )}
                      {showWhats && (
                        <button
                          type="button"
                          onClick={openWhats}
                          title="Abrir/continuar no WhatsApp (pelo telefone do contato)"
                          className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 px-2.5 py-1.5 text-xs font-medium text-emerald-600 hover:bg-emerald-500/20"
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                          WhatsApp
                        </button>
                      )}
                    </div>
                  );
                })()}
            </div>

            {/* Produto do catálogo (opcional): busca + scroll (aguenta catálogo
                grande). Escolher preenche o Valor com o preço-base, que continua
                editável (o preço muda por negociação). */}
            {catalog.length > 0 && (
              <div className="grid gap-2">
                <Label className="text-muted-foreground">
                  Produto/serviço (opcional)
                </Label>
                <div className="relative">
                  <input
                    value={prodQuery}
                    onChange={(e) => {
                      setProdQuery(e.target.value);
                      setProdOpen(true);
                    }}
                    onFocus={() => setProdOpen(true)}
                    onBlur={() => setTimeout(() => setProdOpen(false), 150)}
                    placeholder="Escolher do catálogo…"
                    className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
                  />
                  {prodOpen &&
                    (() => {
                      const q = prodQuery.trim().toLowerCase();
                      const list = (
                        q
                          ? catalog.filter((p) =>
                              p.name.toLowerCase().includes(q),
                            )
                          : catalog
                      ).slice(0, 200);
                      return (
                        <ul className="absolute z-30 mt-1 max-h-56 w-full overflow-y-auto rounded-lg border border-border bg-popover p-1 shadow-xl">
                          {list.length === 0 ? (
                            <li className="px-2 py-2 text-center text-xs text-muted-foreground">
                              Nenhum item.
                            </li>
                          ) : (
                            list.map((p) => (
                              <li key={p.id}>
                                <button
                                  type="button"
                                  onMouseDown={(e) => {
                                    e.preventDefault();
                                    setValue(
                                      p.unit_price ? String(p.unit_price) : "",
                                    );
                                    if (!title.trim()) setTitle(p.name);
                                    setProdQuery(p.name);
                                    setProdOpen(false);
                                  }}
                                  className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                                >
                                  <span className="truncate text-foreground">
                                    {p.name}
                                  </span>
                                  <span className="shrink-0 text-xs text-muted-foreground">
                                    {p.unit_price
                                      ? p.unit_price.toLocaleString("pt-BR", {
                                          style: "currency",
                                          currency: "BRL",
                                        })
                                      : ""}
                                  </span>
                                </button>
                              </li>
                            ))
                          )}
                        </ul>
                      );
                    })()}
                </div>
              </div>
            )}

            <div className="grid grid-cols-[1fr_110px] gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Valor</Label>
                <div className="relative">
                  <DollarSign className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    type="number"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="0"
                    className="border-border bg-muted pl-7 text-foreground"
                  />
                </div>
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Moeda</Label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
                >
                  {CURRENCIES.map((c) => (
                    <option key={c.code} value={c.code}>
                      {c.code}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Data prevista de fechamento</Label>
              <Input
                type="date"
                value={expectedCloseDate}
                onChange={(e) => setExpectedCloseDate(e.target.value)}
                className="border-border bg-muted text-foreground"
              />
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Etapa</Label>
              <select
                value={stageId}
                onChange={(e) => setStageId(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Responsável</Label>
              <select
                value={assignedTo}
                onChange={(e) => setAssignedTo(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                <option value="">Sem responsável</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.full_name || p.email}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Temperatura do lead</Label>
              <select
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary"
              >
                <option value="">Não definida</option>
                <option value="frio">🧊 Frio</option>
                <option value="morno">🌤️ Morno</option>
                <option value="quente">🔥 Quente</option>
              </select>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Qualificação</Label>
              <div className="flex items-center gap-1">
                {[1, 2, 3, 4, 5].map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() =>
                      setQualification(qualification === n ? 0 : n)
                    }
                    aria-label={`Qualificação ${n} de 5`}
                    title={`${n} de 5`}
                    className="transition-transform hover:scale-110"
                  >
                    <Star
                      className={`h-5 w-5 ${
                        n <= qualification
                          ? "fill-amber-400 text-amber-400"
                          : "fill-transparent text-muted-foreground"
                      }`}
                    />
                  </button>
                ))}
                {qualification > 0 && (
                  <button
                    type="button"
                    onClick={() => setQualification(0)}
                    className="ml-1 text-[11px] text-muted-foreground hover:text-foreground"
                  >
                    limpar
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Fonte</Label>
                <Input
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="Ex.: Instagram, Indicação"
                  className="border-border bg-muted text-foreground"
                />
              </div>
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Origem</Label>
                <select
                  value={origin}
                  onChange={(e) => setOrigin(e.target.value)}
                  className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                >
                  <option value="">— de onde veio —</option>
                  {origin && !isDealOrigin(origin) && (
                    <option value={origin}>{origin}</option>
                  )}
                  {DEAL_ORIGINS.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Observações</Label>
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Adicionar observações..."
                className="min-h-[100px] border-border bg-muted text-foreground"
              />
            </div>

            {deal && (
              <div className="space-y-2 rounded-lg border border-border bg-muted/50 p-3">
                <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Status
                </p>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    onClick={() => handleStatusChange("won")}
                    disabled={!!statusAction || deal.status === "won"}
                    className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {statusAction === "won" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <Check className="mr-1 h-4 w-4" />
                        Marcar como ganho
                      </>
                    )}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => setLostReasonOpen((v) => !v)}
                    disabled={!!statusAction || deal.status === "lost"}
                    className="flex-1 bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                  >
                    {statusAction === "lost" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <>
                        <X className="mr-1 h-4 w-4" />
                        Marcar como perdido
                      </>
                    )}
                  </Button>
                </div>

                {/* Motivo da perda (estilo RD) — aparece ao clicar "perdido". */}
                {lostReasonOpen && (
                  <div className="space-y-2 rounded-md border border-red-500/30 bg-red-500/5 p-2.5">
                    <Label className="text-xs text-muted-foreground">
                      Motivo da perda
                    </Label>
                    <div className="flex flex-wrap gap-1.5">
                      {reasonOptions.map((r) => (
                        <button
                          key={r}
                          type="button"
                          onClick={() => setLostReason(r)}
                          className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
                            lostReason === r
                              ? "border-red-500 bg-red-500/20 text-red-300"
                              : "border-border text-muted-foreground hover:bg-muted"
                          }`}
                        >
                          {r}
                        </button>
                      ))}
                    </div>
                    {reasonsLocked && reasonOptions.length === 0 && (
                      <p className="text-xs text-muted-foreground">
                        Lista de motivos fechada e vazia — cadastre em{" "}
                        <strong>Configurações → Negócios</strong>.
                      </p>
                    )}
                    {!reasonsLocked && (
                      <Input
                        value={lostReason}
                        onChange={(e) => setLostReason(e.target.value)}
                        placeholder="Ou escreva o motivo…"
                        className="h-8 border-border bg-muted text-sm text-foreground"
                      />
                    )}
                    <Button
                      type="button"
                      onClick={() => handleStatusChange("lost", lostReason)}
                      disabled={!!statusAction || (reasonsLocked && !lostReason)}
                      className="w-full bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {statusAction === "lost" ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        "Confirmar perda"
                      )}
                    </Button>
                  </div>
                )}

                {deal.status && deal.status !== "open" && (
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => handleStatusChange("open")}
                    disabled={!!statusAction}
                    className="w-full text-muted-foreground hover:text-foreground"
                  >
                    Reabrir negócio
                  </Button>
                )}
              </div>
            )}
          </div>

          <div className="border-t border-border/50 bg-popover/80 p-4">
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="flex-1 border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || !title.trim() || !contactId || !stageId}
                className="flex-1 bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? "Salvando..." : deal ? "Salvar alterações" : "Criar negócio"}
              </Button>
            </div>

            {deal &&
              (confirmDelete ? (
                <div className="mt-3 flex items-center justify-between gap-2 rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs">
                  <span className="text-red-300">Excluir este negócio?</span>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(false)}
                      disabled={deleting}
                      className="rounded px-2 py-1 text-muted-foreground hover:bg-muted"
                    >
                      Cancelar
                    </button>
                    <button
                      type="button"
                      onClick={handleDelete}
                      disabled={deleting}
                      className="rounded bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-700 disabled:opacity-50"
                    >
                      {deleting ? "Excluindo..." : "Confirmar"}
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="mt-3 flex w-full items-center justify-center gap-1 text-xs text-red-400 hover:text-red-300"
                >
                  <Trash2 className="h-3 w-3" />
                  Excluir negócio
                </button>
              ))}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  addContactNote,
  listContactDeals,
  listContactNotes,
  listContactTagsWithJoinId,
  listProfiles,
  updateConversationStatus,
  updateConversationAssignment,
  updateConversationPriority,
  deleteConversation,
} from "@/app/(dashboard)/inbox/actions";
import { promptCsatOnClose } from "./csat-prompt";
import {
  getContact,
  getContactTags,
  listCustomFields,
  listContactCustomValues,
  saveContactCustomValues,
} from "@/app/(dashboard)/contacts/actions";
import {
  listPipelines,
  listStages,
  setDealStatus,
  getLostReasonsConfig,
} from "@/app/(dashboard)/pipelines/actions";
import {
  listTasksByContact,
  type TaskLite,
} from "@/app/(dashboard)/tarefas/actions";
import { TaskForm } from "@/components/tarefas/task-form";
import { TaskMiniList } from "@/components/tarefas/task-mini-list";
import {
  listScheduledMessages,
  type ScheduledMessageLite,
} from "@/app/(dashboard)/inbox/schedule-actions";
import { ScheduleMessageForm } from "./schedule-message-form";
import { ScheduleMiniList } from "./schedule-mini-list";
import { CadenceSidebar } from "./cadence-sidebar";
import { Repeat } from "lucide-react";
import { CustomerCodesEditor } from "./customer-codes-editor";
import { CommercialHistory } from "./commercial-history";
import { importGroupMembers } from "@/app/(dashboard)/inbox/group-actions";
import { CustomFieldInput } from "@/components/contacts/custom-field-input";
import { CallButton } from "@/components/calls/call-button";
import type {
  Contact,
  Conversation,
  ConversationPriority,
  ConversationStatus,
  CustomField,
  Deal,
  ContactNote,
  Tag,
  ContactTag,
  Pipeline,
  PipelineStage,
  Profile,
} from "@/types";
import {
  Phone,
  Mail,
  Building2,
  Copy,
  Check,
  Tag as TagIcon,
  DollarSign,
  StickyNote,
  Plus,
  Pencil,
  ChevronDown,
  MessageSquareText,
  ListChecks,
  ListTodo,
  CalendarClock,
  UserPlus,
  Flag,
  Trash2,
  ExternalLink,
  Loader2,
  Trophy,
  XCircle,
  RotateCcw,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ContactForm } from "@/components/contacts/contact-form";
import { DealForm } from "@/components/pipelines/deal-form";
import { ContactAvatar } from "./contact-avatar";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { hasMinRole } from "@/lib/auth/roles";
import { toast } from "sonner";
import { format } from "date-fns";

interface ContactSidebarProps {
  contact: Contact | null;
  /** The active conversation — drives the "Ações da conversa" section
   *  (agent / status / priority). Optional so callers that only care
   *  about the contact keep working. */
  conversation?: Conversation | null;
  /**
   * Fired after the operator edits the contact inline (name/email/company/
   * tags) so the page can update the active contact — which drives the
   * thread header and the conversation-list row — without a reload.
   */
  onContactUpdated?: (contact: Contact) => void;
  /** Mirror the conversation status change up so the thread header +
   *  list row stay in sync (same signature the thread header uses). */
  onStatusChange?: (
    conversationId: string,
    status: ConversationStatus,
  ) => void;
  /** Mirror the assignment change up (same signature as the thread). */
  onAssignChange?: (
    conversationId: string,
    assignedAgentId: string | null,
  ) => void;
  /** Mirror the priority change up so the page state stays in sync. */
  onPriorityChange?: (
    conversationId: string,
    priority: ConversationPriority,
  ) => void;
  /** Fired after the active conversation is deleted from this panel. */
  onConversationDeleted?: (conversationId: string) => void;
}

// ------------------------------------------------------------
// Priority + status option maps (pt-BR labels, coloured).
// ------------------------------------------------------------

const PRIORITY_OPTIONS: {
  value: ConversationPriority;
  label: string;
  color: string;
}[] = [
  { value: "none", label: "Nenhuma", color: "text-muted-foreground" },
  { value: "low", label: "Baixa", color: "text-sky-400" },
  { value: "medium", label: "Média", color: "text-amber-400" },
  { value: "high", label: "Alta", color: "text-orange-400" },
  { value: "urgent", label: "Urgente", color: "text-red-400" },
];

const STATUS_OPTIONS: {
  value: ConversationStatus;
  label: string;
  color: string;
}[] = [
  { value: "open", label: "Aberta", color: "text-primary" },
  { value: "pending", label: "Pendente", color: "text-amber-400" },
  { value: "closed", label: "Fechada", color: "text-muted-foreground" },
];

// ------------------------------------------------------------
// Collapsible section shell — a simple useState toggle per section
// with a chevron. Kept local so the whole panel scrolls naturally
// inside the ScrollArea (base-ui Accordion's measured heights fight
// the scroll container).
// ------------------------------------------------------------

function Section({
  icon: Icon,
  title,
  defaultOpen = false,
  action,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  defaultOpen?: boolean;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-t border-border">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex flex-1 items-center gap-2 px-1 py-3 text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground"
        >
          <Icon className="h-3.5 w-3.5" />
          <span className="flex-1 text-left">{title}</span>
          <ChevronDown
            className={cn(
              "h-3.5 w-3.5 transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
        {action && <div className="pl-1">{action}</div>}
      </div>
      {open && <div className="pb-3">{children}</div>}
    </div>
  );
}

export function ContactSidebar({
  contact,
  conversation,
  onContactUpdated,
  onStatusChange,
  onAssignChange,
  onPriorityChange,
  onConversationDeleted,
}: ContactSidebarProps) {
  // "Ações da conversa" (assign / status / priority) is a management panel —
  // admin/owner only. Agents pulled into a thread by a private @mention can
  // read/reply but must not manage or take over the conversation.
  const { canManageMembers, accountRole } = useAuth();
  // Excluir conversa: mesma regra do cabeçalho da thread (supervisor+).
  const canDeleteConversation = hasMinRole(accountRole ?? "viewer", "supervisor");
  const [deletingConv, setDeletingConv] = useState(false);
  const [copied, setCopied] = useState(false);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [notes, setNotes] = useState<ContactNote[]>([]);
  // Tarefas — this contact's tasks (compact) + the reused create dialog.
  const [tasks, setTasks] = useState<TaskLite[]>([]);
  const [taskFormOpen, setTaskFormOpen] = useState(false);
  // Mensagens agendadas — this conversation's schedule + create dialog.
  const [scheduled, setScheduled] = useState<ScheduledMessageLite[]>([]);
  const [scheduleFormOpen, setScheduleFormOpen] = useState(false);
  // Agendamento em edição (null = criar novo).
  const [editingSchedule, setEditingSchedule] =
    useState<ScheduledMessageLite | null>(null);
  const [tags, setTags] = useState<(Tag & { contact_tag_id: string })[]>([]);
  const [newNote, setNewNote] = useState("");
  const [addingNote, setAddingNote] = useState(false);
  // Inline contact edit — reuses the full Contacts page ContactForm in a
  // dialog so the operator can name/edit the contact right here.
  const [editOpen, setEditOpen] = useState(false);
  const [editTags, setEditTags] = useState<ContactTag[]>([]);

  // Conversation actions — assignee list (account teammates) + local
  // in-flight state. Assignments/status/priority are optimistic: we call
  // the server action then bubble the change up so the page mirrors it.
  const [profiles, setProfiles] = useState<Profile[]>([]);

  // Custom fields — account definitions + this contact's values. Editable
  // inline; saved via saveContactCustomValues (delete-then-reinsert).
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [customValues, setCustomValues] = useState<Record<string, string>>({});
  const [savingCustom, setSavingCustom] = useState(false);
  const [customDirty, setCustomDirty] = useState(false);

  // Deal editor (reuses the pipelines DealForm sheet). We load pipelines +
  // stages lazily the first time the operator opens the editor.
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [pipelineStages, setPipelineStages] = useState<
    Record<string, PipelineStage[]>
  >({});
  const [dealPipelineId, setDealPipelineId] = useState<string>("");

  // Ganho/Perda direto no card da lateral (pedido do Rafael) — sem precisar
  // abrir o funil. A perda abre um mini-painel com os motivos da conta.
  const [dealStatusBusy, setDealStatusBusy] = useState<string | null>(null);
  const [lostPanelDealId, setLostPanelDealId] = useState<string | null>(null);
  const [lostReasonOptions, setLostReasonOptions] = useState<string[]>([]);
  // Lista FECHADA (Config→Negócios): sem texto livre, chip obrigatório.
  const [lostReasonsLocked, setLostReasonsLocked] = useState(false);
  const [lostReasonsLoaded, setLostReasonsLoaded] = useState(false);
  const [lostReasonText, setLostReasonText] = useState("");

  const contactId = contact?.id;
  const conversationId = conversation?.id;

  // 👥 Importar membros do grupo (pedido do Rafael): vira contatos com etiqueta
  // "Grupo: <nome>" pra disparar 1:1 em Disparos.
  const [importingGroup, setImportingGroup] = useState(false);
  const handleImportGroup = useCallback(async () => {
    if (!conversationId || importingGroup) return;
    setImportingGroup(true);
    try {
      const r = await importGroupMembers(conversationId);
      if (!r.ok) {
        toast.error(r.error || "Não consegui importar os membros.");
        return;
      }
      toast.success(
        `${r.tagged} membro(s) na etiqueta "${r.tagName}" (${r.contactsCreated} novo(s)). Use em Disparos.`,
      );
    } catch {
      toast.error("Falha ao importar os membros do grupo.");
    } finally {
      setImportingGroup(false);
    }
  }, [conversationId, importingGroup]);

  const fetchContactData = useCallback(async () => {
    if (!contactId) return;
    // Fetch deals, notes, tags, and custom fields/values in parallel via
    // account-scoped actions.
    try {
      const [
        dealsData,
        notesData,
        tagsData,
        editTagsData,
        fieldsData,
        valuesData,
        tasksData,
      ] = await Promise.all([
        listContactDeals(contactId),
        listContactNotes(contactId),
        listContactTagsWithJoinId(contactId),
        getContactTags(contactId),
        listCustomFields(),
        listContactCustomValues(contactId),
        listTasksByContact(contactId),
      ]);
      setDeals(dealsData);
      setNotes(notesData);
      setTags(tagsData);
      setTasks(tasksData);
      setEditTags(editTagsData);
      setCustomFields(fieldsData);
      const valueMap: Record<string, string> = {};
      for (const v of valuesData) {
        valueMap[v.custom_field_id] = v.value ?? "";
      }
      setCustomValues(valueMap);
      setCustomDirty(false);
    } catch (error) {
      console.error("Failed to fetch contact data:", error);
    }
  }, [contactId]);

  // Load teammate list once — the conversation-actions assignee dropdown.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await listProfiles();
        if (!cancelled) setProfiles(data);
      } catch (error) {
        if (!cancelled) console.error("Failed to fetch profiles:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // After a successful edit, re-read the contact + its tag chips and push
  // the fresh contact up so the thread header + conversation-list row
  // reflect the new name immediately.
  const handleContactSaved = useCallback(async () => {
    if (!contactId) return;
    try {
      const [updated, editTagsData, tagsData] = await Promise.all([
        getContact(contactId),
        getContactTags(contactId),
        listContactTagsWithJoinId(contactId),
      ]);
      setEditTags(editTagsData);
      setTags(tagsData);
      if (updated) {
        onContactUpdated?.(updated);
        toast.success("Contato atualizado");
      }
    } catch (error) {
      console.error("Failed to refresh contact after edit:", error);
    }
  }, [contactId, onContactUpdated]);

  // Load on contact change. setContactData/setTags run inside async
  // callbacks, not synchronously in the effect body.
  useEffect(() => {
    fetchContactData();
  }, [fetchContactData]);

  // Scheduled messages are keyed on the CONVERSATION (not the contact), so
  // load them separately whenever the active conversation changes.
  const refreshScheduled = useCallback(() => {
    if (!conversationId) {
      setScheduled([]);
      return;
    }
    listScheduledMessages(conversationId)
      .then(setScheduled)
      .catch(() => setScheduled([]));
  }, [conversationId]);

  useEffect(() => {
    refreshScheduled();
  }, [refreshScheduled]);

  const handleCopyPhone = useCallback(async () => {
    if (!contact?.phone) return;
    await navigator.clipboard.writeText(contact.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [contact]);

  const handleAddNote = useCallback(async () => {
    if (!contactId || !newNote.trim()) return;
    setAddingNote(true);
    try {
      const data = await addContactNote(contactId, newNote.trim());
      if (data) {
        setNotes((prev) => [data, ...prev]);
        setNewNote("");
      }
    } catch (error) {
      console.error("Failed to add note:", error);
    } finally {
      setAddingNote(false);
    }
  }, [contactId, newNote]);

  // ---- Conversation actions ------------------------------------------

  const handleStatus = useCallback(
    async (status: ConversationStatus) => {
      if (!conversationId) return;
      try {
        const { offerCsat } = await updateConversationStatus(conversationId, status);
        onStatusChange?.(conversationId, status);
        if (status === "closed") promptCsatOnClose(offerCsat, conversationId);
      } catch (error) {
        console.error("Failed to update status:", error);
        toast.error("Falha ao atualizar o status");
      }
    },
    [conversationId, onStatusChange],
  );

  const handleAssign = useCallback(
    async (agentId: string | null) => {
      if (!conversationId) return;
      try {
        await updateConversationAssignment(conversationId, agentId);
        onAssignChange?.(conversationId, agentId);
      } catch (error) {
        console.error("Failed to update assignment:", error);
        toast.error("Falha ao atribuir a conversa");
      }
    },
    [conversationId, onAssignChange],
  );

  const handlePriority = useCallback(
    async (priority: ConversationPriority) => {
      if (!conversationId) return;
      try {
        await updateConversationPriority(conversationId, priority);
        onPriorityChange?.(conversationId, priority);
      } catch (error) {
        console.error("Failed to update priority:", error);
        toast.error("Falha ao atualizar a prioridade");
      }
    },
    [conversationId, onPriorityChange],
  );

  // ---- Custom fields --------------------------------------------------

  const handleSaveCustom = useCallback(async () => {
    if (!contactId) return;
    setSavingCustom(true);
    try {
      const { error } = await saveContactCustomValues(contactId, customValues);
      if (error) {
        toast.error(error);
        return;
      }
      setCustomDirty(false);
      toast.success("Atributos salvos");
    } finally {
      setSavingCustom(false);
    }
  }, [contactId, customValues]);

  // ---- Deals ----------------------------------------------------------

  // Load pipelines + the first pipeline's stages the first time the deal
  // editor is needed, then open the DealForm sheet.
  const openDealEditor = useCallback(
    async (deal: Deal | null) => {
      try {
        let pl = pipelines;
        if (pl.length === 0) {
          pl = await listPipelines();
          setPipelines(pl);
        }
        if (pl.length === 0) {
          toast.error("Crie um funil primeiro em Funis");
          return;
        }
        // For an existing deal, use its pipeline; otherwise the first one.
        const pid = deal?.pipeline_id ?? pl[0].id;
        setDealPipelineId(pid);
        if (!pipelineStages[pid]) {
          const stages = await listStages(pid);
          setPipelineStages((prev) => ({ ...prev, [pid]: stages }));
        }
        setEditingDeal(deal);
        setDealFormOpen(true);
      } catch (error) {
        console.error("Failed to open deal editor:", error);
        toast.error("Falha ao abrir o negócio");
      }
    },
    [pipelines, pipelineStages],
  );

  const handleDealSaved = useCallback(() => {
    // Refetch just the deals so the list reflects the edit/create.
    if (!contactId) return;
    void listContactDeals(contactId)
      .then(setDeals)
      .catch((e) => console.error("Failed to refresh deals:", e));
  }, [contactId]);

  // Ganho / Perda / Reabrir direto da lateral. A perda vai com o motivo
  // escolhido no mini-painel (mesmos chips do detalhe do negócio).
  const markDealStatus = useCallback(
    async (dealId: string, status: "open" | "won" | "lost", reason?: string) => {
      setDealStatusBusy(dealId);
      try {
        const { error } = await setDealStatus(dealId, status, reason ?? null);
        if (error) {
          toast.error(error);
          return;
        }
        toast.success(
          status === "won"
            ? "Negócio marcado como ganho 🏆"
            : status === "lost"
              ? "Negócio marcado como perda"
              : "Negócio reaberto",
        );
        setLostPanelDealId(null);
        setLostReasonText("");
        handleDealSaved();
        // 🔄 Histórico de compras INSTANTÂNEO: ganho registra a venda no
        // histórico (recordSaleOnWon) — avisa o painel comercial pra
        // recarregar sem F5 (pedido do Alex, 31/08).
        if (contactId) {
          window.dispatchEvent(
            new CustomEvent("fluxia:commercial-refresh", {
              detail: { contactId },
            }),
          );
        }
      } catch (e) {
        console.error("Failed to set deal status:", e);
        toast.error("Falha ao atualizar o negócio");
      } finally {
        setDealStatusBusy(null);
      }
    },
    [handleDealSaved, contactId],
  );

  // Abre o mini-painel de perda e carrega os motivos da conta (uma vez).
  const openLostPanel = useCallback(
    (dealId: string) => {
      setLostReasonText("");
      setLostPanelDealId((cur) => (cur === dealId ? null : dealId));
      if (!lostReasonsLoaded) {
        void getLostReasonsConfig()
          .then((res) => {
            setLostReasonOptions(res.reasons);
            setLostReasonsLocked(res.locked);
            setLostReasonsLoaded(true);
          })
          .catch(() => {});
      }
    },
    [lostReasonsLoaded],
  );

  // Refetch just this contact's tasks after a create/toggle/delete.
  const refreshTasks = useCallback(() => {
    if (!contactId) return;
    void listTasksByContact(contactId)
      .then(setTasks)
      .catch((e) => console.error("Failed to refresh tasks:", e));
  }, [contactId]);

  const assignedAgentId = conversation?.assigned_agent_id ?? null;
  const currentAssignee = useMemo(
    () => profiles.find((p) => p.user_id === assignedAgentId),
    [profiles, assignedAgentId],
  );
  const currentPriority = conversation?.priority ?? "none";
  const currentStatus = conversation?.status ?? "open";

  if (!contact) {
    return (
      <div className="flex h-full w-70 items-center justify-center border-l border-border bg-card">
        <p className="text-sm text-muted-foreground">
          Selecione uma conversa
        </p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const dealStages = pipelineStages[dealPipelineId] ?? [];

  return (
    <div className="flex h-full w-70 flex-col border-l border-border bg-card">
      {/* Native overflow (not the custom ScrollArea) so the scrollbar is
          always visible — the atendentes on Windows expect a real bar, and
          the panel is long (Negócio + Ações + Etiquetas + Atributos + …). */}
      <div className="flex-1 overflow-y-auto">
        <div className="p-4">
          {/* ---- Contato (always visible) ---- */}
          <div className="flex flex-col items-center text-center">
            <div className="flex h-16 w-16 items-center justify-center overflow-hidden rounded-full bg-muted text-lg font-semibold text-foreground">
              <ContactAvatar
                avatarUrl={contact.avatar_url}
                displayName={displayName}
                className="h-16 w-16"
              />
            </div>
            <div className="mt-3 flex items-center gap-1">
              <h3 className="text-sm font-semibold text-foreground">
                {displayName}
              </h3>
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                aria-label="Editar contato"
                title="Editar contato"
                className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
            </div>
            {!contact.name && (
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="text-xs text-primary underline-offset-2 hover:underline"
              >
                Adicionar nome
              </button>
            )}

            {/* Código(s) do cliente — ao lado/abaixo do nome, editável na hora. */}
            <CustomerCodesEditor
              contactId={contact.id}
              codes={contact.customer_codes ?? []}
              onChange={(codes) =>
                onContactUpdated?.({ ...contact, customer_codes: codes })
              }
            />
          </div>

          {/* Contact fields: phone (copy + ligar), email, empresa */}
          <div className="mt-4 space-y-1.5">
            <div className="flex items-center gap-1">
              <button
                onClick={handleCopyPhone}
                className="flex flex-1 items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted"
              >
                <Phone className="h-4 w-4 text-muted-foreground" />
                <span className="flex-1 text-left">{contact.phone}</span>
                {copied ? (
                  <Check className="h-3 w-3 text-primary" />
                ) : (
                  <Copy className="h-3 w-3 text-muted-foreground" />
                )}
              </button>
              {contact.phone && !contact.is_group && (
                <CallButton
                  phone={contact.phone}
                  name={contact.name}
                  className="h-9 w-9 shrink-0"
                  title="Ligar para o contato (voz WhatsApp)"
                />
              )}
            </div>

            <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
              <Mail className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {contact.email || (
                  <span className="text-muted-foreground/60">Indisponível</span>
                )}
              </span>
            </div>

            <div className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground">
              <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate">
                {contact.company || (
                  <span className="text-muted-foreground/60">—</span>
                )}
              </span>
            </div>

            {contact.is_group && conversationId && (
              <div className="mt-1">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={handleImportGroup}
                  disabled={importingGroup}
                  title="Cria um contato pra cada membro (com etiqueta do grupo) pra disparar 1:1 em Disparos"
                >
                  {importingGroup ? (
                    <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                  ) : (
                    <UserPlus className="mr-1.5 h-4 w-4" />
                  )}
                  Importar membros do grupo
                </Button>
                <p className="mt-1 px-1 text-[11px] text-muted-foreground">
                  Vira contatos com etiqueta “Grupo…” pra disparar 1:1. Quem tem
                  privacidade pode não vir.
                </p>
              </div>
            )}
          </div>

          {/* 📊 Histórico de compras (CDL) — o humano vê o que a IA vê. */}
          {!contact.is_group && (
            <CommercialHistory contactId={contact.id} />
          )}

          {/* Action buttons: Editar / Abrir contato / Excluir conversa */}
          <div className="mt-3 flex flex-wrap gap-1.5">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditOpen(true)}
              className="h-7 flex-1 border-border bg-transparent text-xs text-muted-foreground hover:bg-muted"
            >
              <Pencil className="h-3 w-3" />
              Editar
            </Button>
            <Link
              href="/contacts"
              title="Abrir contatos"
              className="inline-flex h-7 flex-1 items-center justify-center gap-1.5 rounded-md border border-border bg-transparent text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <ExternalLink className="h-3 w-3" />
              Contato
            </Link>
            {conversationId && onConversationDeleted && canDeleteConversation && (
              <Button
                variant="outline"
                size="sm"
                disabled={deletingConv}
                onClick={async () => {
                  if (deletingConv) return;
                  if (
                    !window.confirm(
                      "Excluir esta conversa? As mensagens serão removidas. Esta ação não pode ser desfeita.",
                    )
                  ) {
                    return;
                  }
                  setDeletingConv(true);
                  try {
                    // Apaga no SERVIDOR primeiro; só some da UI quando confirmado
                    // (senão "some e volta" no próximo reload).
                    const res = await deleteConversation(conversationId);
                    if (res.deleted) {
                      toast.success("Conversa excluída");
                      onConversationDeleted(conversationId);
                    } else {
                      toast.error("Conversa não encontrada ou já removida.");
                    }
                  } catch (err) {
                    console.error("Failed to delete conversation:", err);
                    toast.error(
                      err instanceof Error
                        ? err.message
                        : "Não foi possível excluir a conversa",
                    );
                  } finally {
                    setDeletingConv(false);
                  }
                }}
                className="h-7 flex-1 border-border bg-transparent text-xs text-red-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-50"
              >
                <Trash2 className="h-3 w-3" />
                Excluir
              </Button>
            )}
          </div>

          <div className="mt-3">
            {/* ---- Negócio ---- */}
            <Section
              icon={DollarSign}
              title="Negócio"
              defaultOpen
              action={
                <button
                  type="button"
                  onClick={() => void openDealEditor(null)}
                  aria-label="Criar negócio"
                  title="Criar negócio"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              }
            >
              {deals.length === 0 ? (
                <button
                  type="button"
                  onClick={() => void openDealEditor(null)}
                  className="w-full rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  + Criar negócio
                </button>
              ) : (
                <div className="space-y-2">
                  {deals.map((deal) => {
                    const agent = profiles.find(
                      (p) => p.user_id === deal.assigned_to,
                    );
                    const fonteOrigem = [deal.source, deal.origin]
                      .filter(Boolean)
                      .join(" • ");
                    return (
                      <div
                        key={deal.id}
                        className="rounded-lg bg-muted transition-colors hover:bg-muted/70"
                      >
                        <button
                          type="button"
                          onClick={() => void openDealEditor(deal)}
                          className="block w-full px-3 py-2 text-left"
                        >
                          <p className="text-sm font-medium text-foreground">
                            {deal.title}
                          </p>
                          <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
                            <span>
                              {deal.currency ?? "$"}
                              {deal.value.toLocaleString()}
                            </span>
                            {deal.status === "won" ? (
                              <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                                Ganho
                              </span>
                            ) : deal.status === "lost" ? (
                              <span className="rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-medium text-red-600 dark:text-red-400">
                                Perda
                              </span>
                            ) : (
                              deal.stage && (
                                <span
                                  className="rounded-full px-1.5 py-0.5 text-[10px]"
                                  style={{
                                    backgroundColor: `${deal.stage.color}20`,
                                    color: deal.stage.color,
                                  }}
                                >
                                  {deal.stage.name}
                                </span>
                              )
                            )}
                          </div>
                          {/* Fonte • Origem gravadas no negócio (estilo RD) —
                              agora carregam ao reabrir pela conversa. */}
                          {fonteOrigem && (
                            <p className="mt-1 truncate text-[10px] text-muted-foreground">
                              {fonteOrigem}
                            </p>
                          )}
                          {agent && (
                            <p className="mt-1 text-[10px] text-muted-foreground">
                              {agent.full_name || agent.email}
                            </p>
                          )}
                        </button>
                        {/* Rodapé do card: Ver no funil + Ganho/Perda direto
                            da lateral (pedido do Rafael — sem abrir o funil). */}
                        <div className="flex items-center justify-between gap-2 border-t border-border/50 px-3 py-1.5">
                          <button
                            type="button"
                            onClick={() => {
                              window.location.href = `/pipelines/${deal.id}`;
                            }}
                            className="inline-flex items-center gap-1 text-[11px] text-primary transition-colors hover:underline"
                          >
                            <ExternalLink className="h-3 w-3" />
                            Ver no funil
                          </button>
                          <div className="flex items-center gap-1">
                            {dealStatusBusy === deal.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                            ) : deal.status === "won" || deal.status === "lost" ? (
                              <button
                                type="button"
                                onClick={() => void markDealStatus(deal.id, "open")}
                                title="Reabrir negócio"
                                className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                              >
                                <RotateCcw className="h-3 w-3" />
                                Reabrir
                              </button>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  onClick={() => void markDealStatus(deal.id, "won")}
                                  title="Marcar venda"
                                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-emerald-600 transition-colors hover:bg-emerald-500/10 dark:text-emerald-400"
                                >
                                  <Trophy className="h-3 w-3" />
                                  Ganho
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openLostPanel(deal.id)}
                                  title="Marcar perda"
                                  className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-red-600 transition-colors hover:bg-red-500/10 dark:text-red-400"
                                >
                                  <XCircle className="h-3 w-3" />
                                  Perda
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                        {/* Motivo da perda (mesmos chips do detalhe do negócio). */}
                        {lostPanelDealId === deal.id && deal.status !== "lost" && (
                          <div className="space-y-2 border-t border-red-500/30 bg-red-500/5 px-3 py-2">
                            <p className="text-[11px] font-medium text-muted-foreground">
                              Por que este negócio foi perdido?
                            </p>
                            {lostReasonOptions.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {lostReasonOptions.map((r) => (
                                  <button
                                    key={r}
                                    type="button"
                                    onClick={() => setLostReasonText(r)}
                                    className={cn(
                                      "rounded-full border px-2 py-0.5 text-[10px] transition-colors",
                                      lostReasonText === r
                                        ? "border-red-500 bg-red-500/20 text-red-500"
                                        : "border-border text-muted-foreground hover:bg-muted",
                                    )}
                                  >
                                    {r}
                                  </button>
                                ))}
                              </div>
                            )}
                            {lostReasonsLocked &&
                              lostReasonOptions.length === 0 && (
                                <p className="text-[10px] text-muted-foreground">
                                  Lista de motivos fechada e vazia — cadastre
                                  em <strong>Configurações → Negócios</strong>.
                                </p>
                              )}
                            {!lostReasonsLocked && (
                              <input
                                value={lostReasonText}
                                onChange={(e) => setLostReasonText(e.target.value)}
                                placeholder="Ou escreva um motivo novo"
                                className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-red-400"
                              />
                            )}
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                disabled={
                                  dealStatusBusy === deal.id ||
                                  (lostReasonsLocked && !lostReasonText)
                                }
                                onClick={() =>
                                  void markDealStatus(deal.id, "lost", lostReasonText)
                                }
                                className="rounded-md bg-red-600 px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-50"
                              >
                                Confirmar perda
                              </button>
                              <button
                                type="button"
                                onClick={() => setLostPanelDealId(null)}
                                className="rounded-md px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted"
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Section>

            {/* ---- Ações da conversa (admin/owner only) ---- */}
            {conversation && canManageMembers && (
              <Section
                icon={MessageSquareText}
                title="Ações da conversa"
                defaultOpen
              >
                <div className="space-y-3">
                  {/* Agente atribuído */}
                  <div className="space-y-1">
                    <label className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <UserPlus className="h-3 w-3" />
                      Agente atribuído
                    </label>
                    <select
                      value={assignedAgentId ?? ""}
                      onChange={(e) =>
                        void handleAssign(e.target.value || null)
                      }
                      className="h-8 w-full rounded-lg border border-border bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary"
                    >
                      <option value="">Não atribuído</option>
                      {profiles.map((p) => (
                        <option key={p.id} value={p.user_id}>
                          {p.full_name || p.email}
                        </option>
                      ))}
                    </select>
                    {assignedAgentId && !currentAssignee && (
                      <p className="text-[10px] text-muted-foreground">
                        Atribuído
                      </p>
                    )}
                  </div>

                  {/* Status */}
                  <div className="space-y-1">
                    <label className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <ListChecks className="h-3 w-3" />
                      Status
                    </label>
                    <select
                      value={currentStatus}
                      onChange={(e) =>
                        void handleStatus(
                          e.target.value as ConversationStatus,
                        )
                      }
                      className="h-8 w-full rounded-lg border border-border bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary"
                    >
                      {STATUS_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Prioridade */}
                  <div className="space-y-1">
                    <label className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <Flag className="h-3 w-3" />
                      Prioridade
                    </label>
                    <div className="flex flex-wrap gap-1">
                      {PRIORITY_OPTIONS.map((opt) => {
                        const active = currentPriority === opt.value;
                        return (
                          <button
                            key={opt.value}
                            type="button"
                            onClick={() => void handlePriority(opt.value)}
                            className={cn(
                              "rounded-full border px-2 py-0.5 text-[10px] font-medium transition-colors",
                              opt.color,
                              active
                                ? "border-current bg-current/10"
                                : "border-border opacity-70 hover:opacity-100",
                            )}
                          >
                            {opt.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </Section>
            )}

            {/* ---- Etiquetas ---- */}
            <Section icon={TagIcon} title="Etiquetas" defaultOpen>
              <div className="flex flex-wrap gap-1">
                {tags.length === 0 ? (
                  <p className="px-1 text-xs text-muted-foreground">
                    Sem etiquetas
                  </p>
                ) : (
                  tags.map((tag) => (
                    <span
                      key={tag.contact_tag_id}
                      className="rounded-full px-2 py-0.5 text-[10px] font-medium"
                      style={{
                        backgroundColor: `${tag.color}20`,
                        color: tag.color,
                      }}
                    >
                      {tag.name}
                    </span>
                  ))
                )}
              </div>
              <button
                type="button"
                onClick={() => setEditOpen(true)}
                className="mt-2 text-[11px] text-primary underline-offset-2 hover:underline"
              >
                Gerenciar etiquetas
              </button>
            </Section>

            {/* ---- Atributos do contato (custom fields) ---- */}
            <Section icon={ListChecks} title="Atributos do contato">
              {customFields.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground">
                  Nenhum atributo definido.
                </p>
              ) : (
                <div className="space-y-2">
                  {customFields.map((field) => (
                    <div key={field.id} className="space-y-1">
                      <label className="text-[11px] font-medium text-muted-foreground">
                        {field.field_name}
                      </label>
                      <CustomFieldInput
                        field={field}
                        value={customValues[field.id] ?? ""}
                        onChange={(val) => {
                          setCustomValues((prev) => ({
                            ...prev,
                            [field.id]: val,
                          }));
                          setCustomDirty(true);
                        }}
                      />
                    </div>
                  ))}
                  {customDirty && (
                    <Button
                      size="sm"
                      onClick={() => void handleSaveCustom()}
                      disabled={savingCustom}
                      className="h-7 w-full bg-primary text-xs text-primary-foreground hover:bg-primary/90"
                    >
                      {savingCustom ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        "Salvar atributos"
                      )}
                    </Button>
                  )}
                </div>
              )}
            </Section>

            {/* ---- Tarefas ---- */}
            <Section
              icon={ListTodo}
              title="Tarefas"
              defaultOpen
              action={
                <button
                  type="button"
                  onClick={() => setTaskFormOpen(true)}
                  aria-label="Criar tarefa"
                  title="Criar tarefa"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <Plus className="h-3.5 w-3.5" />
                </button>
              }
            >
              <TaskMiniList
                tasks={tasks}
                onChanged={refreshTasks}
                emptyLabel="Nenhuma tarefa para este contato."
              />
              <button
                type="button"
                onClick={() => setTaskFormOpen(true)}
                className="mt-2 w-full rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              >
                + Criar tarefa
              </button>
            </Section>

            {/* ---- Mensagens agendadas (requer conversa ativa) ---- */}
            {conversation && (
              <Section
                icon={CalendarClock}
                title="Mensagens agendadas"
                defaultOpen
                action={
                  <button
                    type="button"
                    onClick={() => setScheduleFormOpen(true)}
                    aria-label="Agendar mensagem"
                    title="Agendar mensagem"
                    className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                }
              >
                <ScheduleMiniList
                  items={scheduled}
                  onChanged={refreshScheduled}
                  emptyLabel="Nenhuma mensagem agendada."
                  onEdit={(item) => {
                    setEditingSchedule(item);
                    setScheduleFormOpen(true);
                  }}
                />
                <button
                  type="button"
                  onClick={() => {
                    setEditingSchedule(null);
                    setScheduleFormOpen(true);
                  }}
                  className="mt-2 w-full rounded-lg border border-dashed border-border px-3 py-2 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  + Agendar mensagem
                </button>
              </Section>
            )}

            {/* ---- Cadência (requer conversa ativa) ---- */}
            {conversation && (
              <Section icon={Repeat} title="Cadência">
                <CadenceSidebar conversationId={conversation.id} />
              </Section>
            )}

            {/* ---- Notas ---- */}
            <Section icon={StickyNote} title="Notas" defaultOpen>
              <div className="flex gap-2">
                <textarea
                  value={newNote}
                  onChange={(e) => setNewNote(e.target.value)}
                  placeholder="Adicionar uma nota..."
                  rows={2}
                  className="flex-1 resize-none rounded-lg border border-border bg-muted px-3 py-2 text-xs text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
                />
                <Button
                  size="sm"
                  className="h-auto bg-primary px-2 hover:bg-primary/90"
                  onClick={handleAddNote}
                  disabled={!newNote.trim() || addingNote}
                >
                  <Plus className="h-3 w-3" />
                </Button>
              </div>

              <div className="mt-2 space-y-2">
                {notes.map((note) => (
                  <div key={note.id} className="rounded-lg bg-muted px-3 py-2">
                    <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                      {note.note_text}
                    </p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {format(new Date(note.created_at), "dd/MM/yyyy HH:mm")}
                    </p>
                  </div>
                ))}
              </div>
            </Section>
          </div>
        </div>
      </div>

      {/* Inline contact editor — the full Contacts-page form reused in a
          dialog (name, phone, email, company, tags). */}
      <ContactForm
        open={editOpen}
        onOpenChange={setEditOpen}
        contact={contact}
        contactTags={editTags}
        onSaved={handleContactSaved}
      />

      {/* Task creator — reuses the Tarefas TaskForm dialog, prefilled with
          THIS contact so the Cliente picker is pre-selected. The operator
          just fills título/prazo. On save we refetch the section. */}
      <TaskForm
        open={taskFormOpen}
        onOpenChange={setTaskFormOpen}
        contacts={[
          { id: contact.id, label: displayName, sublabel: contact.phone },
        ]}
        deals={[]}
        prefillContactId={contact.id}
        onSaved={refreshTasks}
      />

      {/* Message scheduler — queues a text message into THIS conversation at
          a future time (worker sends it). Only mounted when a conversation is
          active. On save we refetch the "Mensagens agendadas" section. */}
      {conversation && (
        <ScheduleMessageForm
          open={scheduleFormOpen}
          onOpenChange={(o) => {
            setScheduleFormOpen(o);
            if (!o) setEditingSchedule(null);
          }}
          conversationId={conversation.id}
          onSaved={refreshScheduled}
          editing={editingSchedule}
        />
      )}

      {/* Deal editor — reuses the pipelines DealForm sheet for create/edit
          (pipeline, stage, value, assigned agent, notes, status). */}
      {dealPipelineId && (
        <DealForm
          open={dealFormOpen}
          onOpenChange={setDealFormOpen}
          deal={editingDeal}
          pipelineId={dealPipelineId}
          stages={dealStages}
          // Opened from a conversation → pre-fill the client so the agent
          // doesn't have to hunt for the number (only for a NEW deal).
          defaultContactId={contact.id}
          // ...e vincula a conversa atual, pra o card do funil nascer com a
          // bolinha de chat (bug do Felipe/Vin: negócio criado sem o vínculo).
          defaultConversationId={conversationId}
          onSaved={handleDealSaved}
        />
      )}
    </div>
  );
}

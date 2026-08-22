"use client";

import type { Deal, PipelineStage, Profile } from "@/types";
import type { DealTaskCount } from "@/app/(dashboard)/tarefas/actions";
import { useEffect, useState, type SyntheticEvent } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Calendar, Check, X, ListTodo, Plus, Lock, MessageCircle, AtSign,
  Pencil, Trash2, ArrowRightLeft, ChevronRight, Star, Copy, Pause, Play,
  Building2, Clock3,
} from "lucide-react";
import { formatCurrency } from "@/lib/currency";
import { ContactAvatar } from "@/components/inbox/contact-avatar";
import { deleteDeal, transferDeal, duplicateDeal, setDealPaused, setDealNextFollowUp, openDealConversation, openDealWhatsApp } from "@/app/(dashboard)/pipelines/actions";
import { dealChannelLabel, isInstagramProvider } from "@/lib/pipelines/channel-label";
import { listProfiles } from "@/app/(dashboard)/inbox/actions";
import { CallButton } from "@/components/calls/call-button";

interface DealCardProps {
  deal: Deal;
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
  /** Open-task counts for this deal (from a batched board query). */
  taskCount?: DealTaskCount;
  /** Open the reused TaskForm prefilled with this deal (+ its contact). */
  onCreateTask?: (deal: Deal) => void;
  /** "Tocar ligações no CRM" resolvido UMA vez no board (evita 1 fetch/card). */
  callingEnabled?: boolean;
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// dd/MM/yyyy HH:mm — formato da barrinha "próxima ação" (estilo RD).
function formatDateTime(dateStr: string) {
  const d = new Date(dateStr);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}

// ISO → valor do <input type="datetime-local"> (hora local).
function toLocalInput(iso: string) {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(
    d.getHours(),
  )}:${p(d.getMinutes())}`;
}

// Cor do follow-up por proximidade do disparo: vencido = vermelho, perto (<24h)
// = amarelo, distante = neutro/escuro (estilo do kanban do n8n).
function followUpColor(iso: string): string {
  const ms = new Date(iso).getTime();
  const now = Date.now();
  if (ms < now) return "text-red-500";
  if (ms - now < 24 * 3_600_000) return "text-amber-500";
  return "text-foreground";
}

// Tarefas de "ligar/entrar em contato" ganham o ícone de mensagem (estilo o
// WhatsApp do RD); as demais, o ícone de tarefa.
function isContactTask(type: string | null, title: string | null) {
  return /lig|contat|whats|call|telefone/.test(
    `${type ?? ""} ${title ?? ""}`.toLowerCase(),
  );
}

export function DealCard({
  deal,
  stage,
  isOverlay,
  taskCount,
  onEdit,
  onCreateTask,
  callingEnabled,
}: DealCardProps) {
  const router = useRouter();
  const contactLabel = deal.contact?.name || deal.contact?.phone || "No contact";
  const assigneeLabel = deal.assignee?.full_name || null;
  const openTasks = taskCount?.open ?? 0;
  const hasOverdue = (taskCount?.overdue ?? 0) > 0;
  // Próxima ação (barrinha estilo RD): a próxima tarefa aberta do negócio.
  const nextTitle = taskCount?.next_title ?? null;
  const nextDueAt = taskCount?.next_due_at ?? null;
  const nextOverdue = nextDueAt
    ? new Date(nextDueAt).getTime() < Date.now()
    : false;
  const NextTaskIcon = isContactTask(taskCount?.next_type ?? null, nextTitle)
    ? MessageCircle
    : ListTodo;
  // Qualificação (estrela ★N) + dias na etapa atual (estilo RD).
  const qualification = deal.qualification ?? 0;
  const stageSince = deal.stage_changed_at ?? deal.created_at;
  const daysInStage = stageSince
    ? Math.max(
        0,
        Math.floor((Date.now() - new Date(stageSince).getTime()) / 86400000),
      )
    : null;

  // Menu de clique-direito no card: Editar / Transferir / Excluir sem precisar
  // abrir a tela inteira. Guardamos a posição do cursor pra abrir ali.
  const [editingFu, setEditingFu] = useState(false);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const [members, setMembers] = useState<Profile[] | null>(null);
  const [showTransfer, setShowTransfer] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!menuPos) return;
    const close = () => {
      setMenuPos(null);
      setShowTransfer(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, true);
    };
  }, [menuPos]);

  const openMenu = (e: SyntheticEvent & { clientX?: number; clientY?: number }) => {
    if (isOverlay) return;
    e.preventDefault();
    e.stopPropagation();
    const me = e as unknown as MouseEvent;
    setMenuPos({ x: me.clientX, y: me.clientY });
  };

  const loadMembers = () => {
    if (members !== null) return;
    listProfiles()
      .then((ps) =>
        setMembers(ps.filter((p) => p.user_id && p.full_name)),
      )
      .catch(() => setMembers([]));
  };

  const doDelete = async () => {
    if (busy) return;
    if (!confirm(`Excluir o negócio "${deal.title}"? Esta ação não pode ser desfeita.`))
      return;
    setBusy(true);
    const { error } = await deleteDeal(deal.id);
    setBusy(false);
    setMenuPos(null);
    if (error) toast.error(error);
    else {
      toast.success("Negócio excluído");
      router.refresh();
    }
  };

  const doTransfer = async (userId: string) => {
    if (busy) return;
    setBusy(true);
    const { error } = await transferDeal(deal.id, userId);
    setBusy(false);
    setMenuPos(null);
    setShowTransfer(false);
    if (error) toast.error(error);
    else {
      toast.success("Negócio transferido");
      router.refresh();
    }
  };

  // Canal de origem do lead (via conversa vinculada). Só WhatsApp e Instagram
  // por enquanto — o resto cai no ícone de WhatsApp (default do produto).
  const isInstagram = isInstagramProvider(deal.channel_provider);
  const ChannelIcon = isInstagram ? AtSign : MessageCircle;
  const channelLabel = dealChannelLabel(deal.channel_provider);
  const channelColor = isInstagram ? "text-pink-500" : "text-emerald-600";
  // Abre a conversa vinculada; se não tiver, resolve/cria pelo telefone do
  // contato (e vincula) — assim o botão aparece mesmo sem conversa ainda.
  const canOpenChat = !!deal.conversation_id || !!deal.contact?.phone;
  const openConversation = async (e: SyntheticEvent) => {
    e.stopPropagation();
    if (deal.conversation_id) {
      window.location.href = `/inbox?c=${deal.conversation_id}`;
      return;
    }
    const res = await openDealConversation(deal.id);
    if (res.conversationId) {
      window.location.href = `/inbox?c=${res.conversationId}`;
    } else {
      toast.error(res.error || "Não foi possível abrir a conversa");
    }
  };

  // Atalho "WhatsApp": aparece quando a origem NÃO é WhatsApp e o contato tem
  // telefone. Abre/cria a conversa de WhatsApp sem mexer na origem do negócio.
  const showWhats = channelLabel !== "WhatsApp" && !!deal.contact?.phone;
  const openWhats = async (e: SyntheticEvent) => {
    e.stopPropagation();
    const res = await openDealWhatsApp(deal.id);
    if (res.conversationId) {
      window.location.href = `/inbox?c=${res.conversationId}`;
    } else {
      toast.error(res.error || "Não foi possível abrir o WhatsApp");
    }
  };

  // Funil aberto: deal atribuído a OUTRA pessoa aparece TRAVADO (igual conversa)
  // — sem título/contato/valor, não abre. Só "atribuído a X" + a cor da etapa.
  if (deal.read_blocked) {
    return (
      <div
        className="relative w-full rounded-xl border border-dashed border-border/60 bg-muted/40 pl-4 pr-3 py-3 text-left"
        title={assigneeLabel ? `Atribuído a ${assigneeLabel}` : "Atribuído a outro atendente"}
      >
        <span
          aria-hidden
          className="absolute left-0 top-0 h-full w-1 rounded-l-xl opacity-60"
          style={{ backgroundColor: stage?.color ?? "#94a3b8" }}
        />
        <div className="flex items-center gap-2 text-muted-foreground">
          <Lock className="h-3.5 w-3.5 shrink-0" />
          <span className="flex-1 truncate text-xs font-medium">
            {assigneeLabel ? `Atribuído a ${assigneeLabel}` : "Atribuído a outro atendente"}
          </span>
          {/* Avatar do responsável (com foto se tiver) — mostra de quem é. */}
          {assigneeLabel && (
            <span
              title={assigneeLabel}
              className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
            >
              <ContactAvatar
                avatarUrl={deal.assignee?.avatar_url}
                displayName={assigneeLabel}
                className="h-5 w-5"
              />
            </span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground/70">
          Atendimento de outro atendente
        </p>
      </div>
    );
  }

  return (
    <>
    <button
      type="button"
      onContextMenu={openMenu}
      onClick={(e) => {
        // `onClick` still fires after a non-drag tap because the PointerSensor
        // requires 5px movement before it counts as a drag. Abre a página de
        // detalhe do negócio (estilo RD), não mais o mini-diálogo.
        if (isOverlay) return;
        e.stopPropagation();
        window.location.href = `/pipelines/${deal.id}`;
      }}
      className={`group relative w-full cursor-pointer rounded-xl border border-border/50 bg-muted/70 pl-4 pr-3 py-3 text-left shadow-sm transition-all ${
        isOverlay
          ? "shadow-xl"
          : "hover:-translate-y-0.5 hover:border-border hover:bg-muted hover:shadow-lg"
      }`}
    >
      {/* 4px left accent bar using stage color */}
      <span
        aria-hidden
        className="absolute left-0 top-0 h-full w-1 rounded-l-xl"
        style={{ backgroundColor: stage?.color ?? "#94a3b8" }}
      />

      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          {/* Avatar do LEAD no topo — foto do contato se tiver, senão a inicial. */}
          <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[10px] font-semibold text-foreground">
            <ContactAvatar
              avatarUrl={deal.contact?.avatar_url}
              displayName={contactLabel}
              className="h-6 w-6"
            />
          </span>
          <h4 className="min-w-0 flex-1 text-sm font-semibold leading-snug text-foreground break-words">
            {deal.title}
          </h4>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {/* Open-task indicator — count + red dot when any is overdue.
              Clicking it opens the same create-task dialog (a lightweight
              entry point to the deal's tasks). */}
          {!isOverlay && openTasks > 0 && (
            <span
              role={onCreateTask ? "button" : undefined}
              tabIndex={onCreateTask ? 0 : undefined}
              aria-label={`${openTasks} tarefa(s) aberta(s)${hasOverdue ? ", com atraso" : ""}`}
              title={
                hasOverdue
                  ? `${openTasks} tarefa(s) aberta(s) · com atraso`
                  : `${openTasks} tarefa(s) aberta(s)`
              }
              onClick={(e) => {
                if (!onCreateTask) return;
                e.stopPropagation();
                onCreateTask(deal);
              }}
              onKeyDown={(e) => {
                if (!onCreateTask) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onCreateTask(deal);
                }
              }}
              className={`relative inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                hasOverdue
                  ? "bg-red-500/15 text-red-400"
                  : "bg-primary/15 text-primary"
              }`}
            >
              <ListTodo className="h-3 w-3" />
              {openTasks}
              {hasOverdue && (
                <span
                  aria-hidden
                  className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-red-500"
                />
              )}
            </span>
          )}

          {/* "criar tarefa" — appears on card hover; opens the reused
              TaskForm prefilled with this deal (+ its contact). */}
          {!isOverlay && onCreateTask && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Criar tarefa"
              title="Criar tarefa"
              onClick={(e) => {
                e.stopPropagation();
                onCreateTask(deal);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onCreateTask(deal);
                }
              }}
              className="flex h-5 w-5 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity hover:bg-background hover:text-foreground group-hover:opacity-100"
            >
              <Plus className="h-3.5 w-3.5" />
            </span>
          )}

          {deal.status === "won" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold text-primary">
              <Check className="h-3 w-3" />
              Won
            </span>
          )}
          {deal.status === "lost" && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-[10px] font-semibold text-red-400">
              <X className="h-3 w-3" />
              Lost
            </span>
          )}
          {deal.paused_at && (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-500">
              <Pause className="h-3 w-3" />
              Pausado
            </span>
          )}
        </div>
      </div>

      {/* Nome do contato (o avatar do lead já está no topo). */}
      <div className="mt-1.5 truncate text-xs text-muted-foreground">
        {contactLabel}
      </div>

      {/* Empresa (entidade) — chip discreto quando o negócio tem empresa. */}
      {deal.company_name && (
        <div
          className="mt-1 flex items-center gap-1 truncate text-[11px] text-muted-foreground"
          title={deal.company_name}
        >
          <Building2 className="h-3 w-3 shrink-0" />
          <span className="truncate">{deal.company_name}</span>
        </div>
      )}

      {/* Qualificação (★N) + dias na etapa — estilo RD. */}
      {(qualification > 0 || daysInStage !== null) && (
        <div className="mt-1.5 flex items-center justify-between gap-2">
          {qualification > 0 ? (
            <span
              className="flex items-center gap-0.5 text-[11px] font-medium text-amber-400"
              title={`Qualificação: ${qualification}/5`}
            >
              <Star className="h-3 w-3 fill-amber-400" />
              {qualification}
            </span>
          ) : (
            <span />
          )}
          {daysInStage !== null && (
            <span
              className="text-[10px] text-muted-foreground"
              title="Tempo na etapa atual"
            >
              {daysInStage === 0 ? "hoje" : `${daysInStage}d na etapa`}
            </span>
          )}
        </div>
      )}

      {/* Follow-ups: contador de toques (estilo n8n) + o próximo follow-up, com
          COR por proximidade (vencido=vermelho, perto=amarelo, longe=escuro) e
          EDITÁVEL na mão (clique na data). O sistema também atualiza sozinho e ao
          mover o card de etapa. */}
      {((deal.follow_up_count ?? 0) > 0 || deal.next_follow_up_at || editingFu) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
          {(deal.follow_up_count ?? 0) > 0 && (
            <span
              className="flex items-center gap-1 text-muted-foreground"
              title="Follow-ups enviados"
            >
              <MessageCircle className="h-3 w-3" />
              {deal.follow_up_count} follow-up
              {(deal.follow_up_count ?? 0) > 1 ? "s" : ""}
            </span>
          )}
          {editingFu ? (
            <input
              type="datetime-local"
              autoFocus
              defaultValue={
                deal.next_follow_up_at ? toLocalInput(deal.next_follow_up_at) : ""
              }
              onClick={(e) => e.stopPropagation()}
              onBlur={() => setEditingFu(false)}
              onChange={async (e) => {
                e.stopPropagation();
                const v = e.target.value;
                const iso = v ? new Date(v).toISOString() : null;
                const res = await setDealNextFollowUp(deal.id, iso);
                setEditingFu(false);
                if (res.error) toast.error(res.error);
                else {
                  toast.success(iso ? "Follow-up atualizado" : "Follow-up removido");
                  router.refresh();
                }
              }}
              className="h-6 rounded border border-border bg-background px-1 text-[11px] text-foreground"
            />
          ) : (
            deal.next_follow_up_at && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setEditingFu(true);
                }}
                className={`flex items-center gap-1 ${followUpColor(
                  deal.next_follow_up_at,
                )} hover:underline`}
                title="Próximo follow-up — clique pra editar a data/hora"
              >
                <Clock3 className="h-3 w-3" />
                {formatDateTime(deal.next_follow_up_at)}
              </button>
            )
          )}
        </div>
      )}

      <div className="mt-2 flex items-center justify-between">
        <span className="text-sm font-bold text-primary">
          {formatCurrency(deal.value, deal.currency)}
        </span>
        {deal.expected_close_date && (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Calendar className="h-3 w-3" />
            {formatDate(deal.expected_close_date)}
          </span>
        )}
      </div>

      {(canOpenChat || assigneeLabel || deal.origin) && (
        <div className="mt-2 flex items-center justify-between gap-2">
          {/* Esquerda: selo de origem (de onde veio) + canal da conversa +
              (se não-WhatsApp e tiver telefone) atalho WhatsApp. */}
          <div className="flex min-w-0 items-center gap-1.5">
            {deal.origin && (
              <span
                title={`Origem: ${deal.origin}`}
                className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {deal.origin}
              </span>
            )}
            {canOpenChat && (
              <div className="flex items-center gap-1">
                <span
                  role="button"
                  tabIndex={0}
                  aria-label={`Abrir conversa (${channelLabel})`}
                  title={`Abrir conversa (${channelLabel})`}
                  onClick={openConversation}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      openConversation(e);
                    }
                  }}
                  className={`inline-flex h-5 w-5 items-center justify-center rounded-md transition-colors hover:bg-background ${channelColor}`}
                >
                  <ChannelIcon className="h-3.5 w-3.5" />
                </span>
                {showWhats && (
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label="Falar no WhatsApp"
                    title="Falar no WhatsApp (pelo telefone do contato)"
                    onClick={openWhats}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        openWhats(e);
                      }
                    }}
                    className="inline-flex h-5 w-5 items-center justify-center rounded-md text-emerald-600 transition-colors hover:bg-background"
                  >
                    <MessageCircle className="h-3.5 w-3.5" />
                  </span>
                )}
                {deal.contact?.phone && (
                  <CallButton
                    phone={deal.contact.phone}
                    name={deal.contact?.name}
                    enabled={callingEnabled}
                    title="Ligar para o contato (voz WhatsApp)"
                    className="h-5 w-5 hover:bg-background [&_svg]:h-3.5 [&_svg]:w-3.5"
                  />
                )}
              </div>
            )}
          </div>
          {/* Responsável (direita) — foto do perfil se tiver, senão a inicial. */}
          {assigneeLabel && (
            <span
              title={assigneeLabel}
              className="flex h-5 w-5 shrink-0 items-center justify-center overflow-hidden rounded-full bg-primary/15 text-[10px] font-semibold text-primary"
            >
              <ContactAvatar
                avatarUrl={deal.assignee?.avatar_url}
                displayName={assigneeLabel}
                className="h-5 w-5"
              />
            </span>
          )}
        </div>
      )}

      {/* Próxima ação (barrinha estilo RD): próxima tarefa aberta + data/hora,
          vermelha quando atrasada. */}
      {nextTitle && (
        <div
          title={
            nextDueAt
              ? `Próxima tarefa: ${nextTitle} · ${formatDateTime(nextDueAt)}`
              : `Próxima tarefa: ${nextTitle}`
          }
          className={`mt-2 flex items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ${
            nextOverdue
              ? "bg-red-500/15 text-red-300"
              : "bg-muted/70 text-muted-foreground"
          }`}
        >
          <NextTaskIcon className="h-3 w-3 shrink-0" />
          <span className="truncate">{nextTitle}</span>
          {nextDueAt && (
            <span className="ml-auto shrink-0 tabular-nums">
              {formatDateTime(nextDueAt)}
            </span>
          )}
        </div>
      )}
    </button>

    {menuPos && (
      <div
        className="fixed z-[100] min-w-[168px] rounded-lg border border-border bg-popover py-1 text-sm text-popover-foreground shadow-xl"
        style={{ left: menuPos.x, top: menuPos.y }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => e.preventDefault()}
      >
        <button
          type="button"
          onClick={() => {
            setMenuPos(null);
            onEdit(deal);
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted"
        >
          <Pencil className="h-3.5 w-3.5 text-muted-foreground" /> Editar
        </button>

        <button
          type="button"
          onClick={async () => {
            setMenuPos(null);
            const { error } = await duplicateDeal(deal.id);
            if (error) {
              toast.error(error);
              return;
            }
            toast.success("Negócio duplicado");
            router.refresh();
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted"
        >
          <Copy className="h-3.5 w-3.5 text-muted-foreground" /> Duplicar
        </button>

        <button
          type="button"
          onClick={async () => {
            setMenuPos(null);
            const paused = !deal.paused_at;
            const { error } = await setDealPaused(deal.id, paused);
            if (error) {
              toast.error(error);
              return;
            }
            toast.success(paused ? "Negócio pausado" : "Negócio retomado");
            router.refresh();
          }}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted"
        >
          {deal.paused_at ? (
            <>
              <Play className="h-3.5 w-3.5 text-muted-foreground" /> Retomar
            </>
          ) : (
            <>
              <Pause className="h-3.5 w-3.5 text-muted-foreground" /> Pausar
            </>
          )}
        </button>

        <div
          className="relative"
          onMouseEnter={() => {
            setShowTransfer(true);
            loadMembers();
          }}
          onMouseLeave={() => setShowTransfer(false)}
        >
          <button
            type="button"
            className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left hover:bg-muted"
          >
            <span className="flex items-center gap-2">
              <ArrowRightLeft className="h-3.5 w-3.5 text-muted-foreground" />
              Transferir
            </span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
          {showTransfer && (
            <div className="absolute left-full top-0 ml-0.5 max-h-64 min-w-[168px] overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-xl">
              {members === null ? (
                <div className="px-3 py-1.5 text-xs text-muted-foreground">
                  Carregando…
                </div>
              ) : members.length === 0 ? (
                <div className="px-3 py-1.5 text-xs text-muted-foreground">
                  Sem membros
                </div>
              ) : (
                members.map((m) => (
                  <button
                    key={m.user_id}
                    type="button"
                    disabled={busy}
                    onClick={() => doTransfer(m.user_id as string)}
                    className="block w-full truncate px-3 py-1.5 text-left hover:bg-muted disabled:opacity-50"
                  >
                    {m.full_name}
                  </button>
                ))
              )}
            </div>
          )}
        </div>

        <div className="my-1 h-px bg-border" />

        <button
          type="button"
          disabled={busy}
          onClick={doDelete}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-500 hover:bg-red-500/10 disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" /> Excluir
        </button>
      </div>
    )}
    </>
  );
}

"use client";

// Right-click (or Ctrl-click on Mac) menu for a conversation card — a
// Chatwoot-style quick-actions panel. Set priority, change status, toggle
// labels and delete, all without opening the thread. Positioned at the
// cursor; closes on outside click / Esc.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Loader2,
  MailOpen,
  Plus,
  Tag as TagIcon,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";

import type { Conversation, ConversationPriority, ConversationStatus, Tag } from "@/types";
import { PRIORITY_ORDER, PRIORITY_META } from "@/lib/inbox/priority";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { hasMinRole } from "@/lib/auth/roles";
import {
  updateConversationPriority,
  updateConversationStatus,
  deleteConversation,
  markConversationUnread,
  addContactTag,
  removeContactTag,
} from "@/app/(dashboard)/inbox/actions";
import { createTag } from "@/components/settings/actions";

// Same palette the Tags settings uses, so a tag created here looks native.
const TAG_COLORS = [
  "#ef4444",
  "#f97316",
  "#f59e0b",
  "#10b981",
  "#06b6d4",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
];

const STATUS_OPTIONS: { value: ConversationStatus; label: string; dot: string }[] = [
  { value: "open", label: "Aberta", dot: "bg-primary" },
  { value: "pending", label: "Pendente", dot: "bg-amber-500" },
  { value: "closed", label: "Fechada", dot: "bg-muted-foreground" },
];

const MENU_W = 240;
const MENU_MAX_H = 420;

interface Props {
  conversation: Conversation;
  x: number;
  y: number;
  tags: Tag[];
  onClose: () => void;
  onStatusChange?: (id: string, status: ConversationStatus) => void;
  onPriorityChange?: (id: string, priority: ConversationPriority) => void;
  onDeleted?: (id: string) => void;
  onMarkedUnread?: (id: string) => void;
  onContactTagsChange?: (contactId: string, tags: Tag[]) => void;
  /** A brand-new tag was created inline — bubble it up so the account's
   *  tag list (filters, other menus) picks it up without a refetch. */
  onTagCreated?: (tag: Tag) => void;
}

export function ConversationContextMenu({
  conversation,
  x,
  y,
  tags,
  onClose,
  onStatusChange,
  onPriorityChange,
  onDeleted,
  onMarkedUnread,
  onContactTagsChange,
  onTagCreated,
}: Props) {
  const { accountRole } = useAuth();
  const canDelete = hasMinRole(accountRole ?? "viewer", "supervisor");
  const ref = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  // Inline "criar etiqueta" form.
  const [creating, setCreating] = useState(false);
  const [newTagName, setNewTagName] = useState("");
  const [newTagColor, setNewTagColor] = useState(TAG_COLORS[3]);

  const contactId = conversation.contact?.id ?? null;
  const currentPriority = conversation.priority ?? "none";
  const currentTagIds = new Set(
    (conversation.contact?.tags ?? []).map((t) => t.id),
  );

  // Flip within the viewport so the menu never spills off-screen.
  const left = Math.min(x, window.innerWidth - MENU_W - 8);
  const top = Math.min(y, window.innerHeight - MENU_MAX_H - 8);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const handlePriority = useCallback(
    async (p: ConversationPriority) => {
      if (busy) return;
      setBusy(true);
      try {
        await updateConversationPriority(conversation.id, p);
        onPriorityChange?.(conversation.id, p);
      } catch {
        toast.error("Falha ao atualizar a prioridade");
      } finally {
        setBusy(false);
        onClose();
      }
    },
    [busy, conversation.id, onPriorityChange, onClose],
  );

  const handleStatus = useCallback(
    async (s: ConversationStatus) => {
      if (busy) return;
      setBusy(true);
      try {
        await updateConversationStatus(conversation.id, s);
        onStatusChange?.(conversation.id, s);
      } catch {
        toast.error("Falha ao atualizar o status");
      } finally {
        setBusy(false);
        onClose();
      }
    },
    [busy, conversation.id, onStatusChange, onClose],
  );

  const handleToggleTag = useCallback(
    async (tag: Tag) => {
      if (busy || !contactId) return;
      const has = currentTagIds.has(tag.id);
      setBusy(true);
      try {
        if (has) await removeContactTag(contactId, tag.id);
        else await addContactTag(contactId, tag.id);
        const next = has
          ? (conversation.contact?.tags ?? []).filter((t) => t.id !== tag.id)
          : [...(conversation.contact?.tags ?? []), tag];
        onContactTagsChange?.(contactId, next);
      } catch {
        toast.error("Falha ao atualizar a etiqueta");
      } finally {
        setBusy(false);
      }
    },
    [busy, contactId, currentTagIds, conversation.contact?.tags, onContactTagsChange],
  );

  const handleCreateTag = useCallback(async () => {
    const name = newTagName.trim();
    if (busy || !contactId || !name) return;
    setBusy(true);
    try {
      const tag = await createTag({ name, color: newTagColor });
      await addContactTag(contactId, tag.id);
      onTagCreated?.(tag);
      onContactTagsChange?.(contactId, [
        ...(conversation.contact?.tags ?? []),
        tag,
      ]);
      setNewTagName("");
      setCreating(false);
    } catch {
      toast.error("Falha ao criar a etiqueta");
    } finally {
      setBusy(false);
    }
  }, [
    busy,
    contactId,
    newTagName,
    newTagColor,
    conversation.contact?.tags,
    onTagCreated,
    onContactTagsChange,
  ]);

  const handleMarkUnread = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      await markConversationUnread(conversation.id);
      onMarkedUnread?.(conversation.id);
      toast.success("Marcada como não lida.");
    } catch {
      toast.error("Não foi possível marcar como não lida.");
    } finally {
      setBusy(false);
      onClose();
    }
  }, [busy, conversation.id, onMarkedUnread, onClose]);

  const handleDelete = useCallback(async () => {
    if (busy) return;
    if (!confirm("Excluir esta conversa? Esta ação não pode ser desfeita.")) return;
    setBusy(true);
    // Capturador temporário (diagnóstico do "não apaga" da conta do Rafael).
    const probe = (data: Record<string, unknown>) =>
      fetch("/api/debug/delete-probe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from: "context-menu",
          role: accountRole ?? "null",
          conversationId: conversation.id,
          ...data,
        }),
      }).catch(() => {});
    void probe({ stage: "click" });
    try {
      const res = await deleteConversation(conversation.id);
      void probe({ stage: "result", deleted: res.deleted });
      // Só remove da lista quando o servidor CONFIRMA que deletou. Se casou 0
      // linhas (já removida / sem permissão), avisa em vez de sumir-e-voltar.
      if (res.deleted) {
        onDeleted?.(conversation.id);
      } else {
        toast.error("Conversa não encontrada ou já removida.");
      }
    } catch (err) {
      void probe({
        stage: "error",
        message: err instanceof Error ? err.message : String(err),
      });
      // Erro real (ex.: sem permissão, ou bundle velho) — mostra a mensagem em
      // vez de um genérico, e NÃO tira da lista.
      toast.error(
        err instanceof Error ? err.message : "Falha ao excluir a conversa",
      );
    } finally {
      setBusy(false);
      onClose();
    }
  }, [busy, conversation.id, onDeleted, onClose, accountRole]);

  return (
    <>
      {/* Backdrop — swallows the outside click that closes the menu. */}
      <div className="fixed inset-0 z-50" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={ref}
        role="menu"
        style={{ left, top, width: MENU_W, maxHeight: MENU_MAX_H }}
        className="fixed z-50 flex flex-col overflow-y-auto rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="truncate px-2 py-1.5 text-xs font-medium text-muted-foreground">
          {conversation.contact?.name || conversation.contact?.phone || "Conversa"}
        </div>

        {/* Marcar como não lida (Felipe) — mesma ação do botão no cabeçalho,
            agora acessível direto no botão-direito do card. */}
        <button
          type="button"
          disabled={busy}
          onClick={handleMarkUnread}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
        >
          <MailOpen className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-left">Marcar como não lida</span>
        </button>

        <div className="my-1 h-px bg-border" />

        {/* Prioridade */}
        <div className="px-2 pb-1 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Prioridade
        </div>
        {PRIORITY_ORDER.map((p) => {
          const meta = PRIORITY_META[p];
          const active = currentPriority === p;
          return (
            <button
              key={p}
              type="button"
              disabled={busy}
              onClick={() => handlePriority(p)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
              <span className={cn("size-2 shrink-0 rounded-full", meta.dot)} />
              <span className="flex-1 text-left">{meta.label}</span>
              {active && <Check className="size-4 text-primary" />}
            </button>
          );
        })}
        {currentPriority !== "none" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => handlePriority("none")}
            className="rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
          >
            Remover prioridade
          </button>
        )}

        {/* Status */}
        <div className="mt-1 border-t border-border px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Status
        </div>
        {STATUS_OPTIONS.map((s) => {
          const active = conversation.status === s.value;
          return (
            <button
              key={s.value}
              type="button"
              disabled={busy}
              onClick={() => handleStatus(s.value)}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
            >
              <span className={cn("size-2 shrink-0 rounded-full", s.dot)} />
              <span className="flex-1 text-left">{s.label}</span>
              {active && <Check className="size-4 text-primary" />}
            </button>
          );
        })}

        {/* Etiquetas — toggle existentes (clicar numa marcada remove) e
            criar uma nova inline pelo "+". */}
        {contactId && (
          <>
            <div className="mt-1 flex items-center gap-1.5 border-t border-border px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              <TagIcon className="size-3" />
              Etiquetas
            </div>
            {tags.length === 0 && !creating && (
              <p className="px-2 py-1 text-xs text-muted-foreground">
                Nenhuma etiqueta ainda.
              </p>
            )}
            {tags.map((tag) => {
              const has = currentTagIds.has(tag.id);
              return (
                <button
                  key={tag.id}
                  type="button"
                  disabled={busy}
                  onClick={() => handleToggleTag(tag)}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
                >
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                  <span className="flex-1 truncate text-left">{tag.name}</span>
                  {has && <Check className="size-4 text-primary" />}
                </button>
              );
            })}

            {creating ? (
              <div className="px-2 py-1.5">
                <input
                  autoFocus
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleCreateTag();
                    if (e.key === "Escape") {
                      setCreating(false);
                      setNewTagName("");
                    }
                  }}
                  placeholder="Nome da etiqueta"
                  className="h-8 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary"
                />
                <div className="mt-2 flex items-center gap-1.5">
                  {TAG_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => setNewTagColor(c)}
                      aria-label={`Cor ${c}`}
                      className={cn(
                        "size-4 rounded-full",
                        newTagColor === c &&
                          "ring-2 ring-foreground ring-offset-1 ring-offset-popover",
                      )}
                      style={{ backgroundColor: c }}
                    />
                  ))}
                </div>
                <div className="mt-2 flex gap-1.5">
                  <button
                    type="button"
                    disabled={busy || !newTagName.trim()}
                    onClick={() => void handleCreateTag()}
                    className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md bg-primary text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                  >
                    {busy ? (
                      <Loader2 className="size-3.5 animate-spin" />
                    ) : (
                      "Criar e aplicar"
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setNewTagName("");
                    }}
                    className="inline-flex h-7 items-center justify-center rounded-md px-2 text-xs text-muted-foreground hover:bg-accent"
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-primary hover:bg-accent"
              >
                <Plus className="size-4" />
                Criar etiqueta
              </button>
            )}
          </>
        )}

        {/* Excluir */}
        {canDelete && (
          <>
            <div className="mt-1 border-t border-border pt-1" />
            <button
              type="button"
              disabled={busy}
              onClick={handleDelete}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-red-600 hover:bg-red-500/10 disabled:opacity-50 dark:text-red-400"
            >
              <Trash2 className="size-4" />
              Excluir conversa
            </button>
          </>
        )}
      </div>
    </>
  );
}

"use client";

// ============================================================
// Forward a message to one or more conversations (WhatsApp-style). Lists the
// account's conversations, filters by name/number, multi-selects targets, and
// POSTs to /api/messages/:id/forward. The bubble content isn't re-uploaded —
// media keeps its url, so forwarding is a cheap replay.
// ============================================================

import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Search, Send, UserPlus, X } from "lucide-react";

import { listConversations } from "@/app/(dashboard)/inbox/actions";
import type { Conversation, Message } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

function convLabel(c: Conversation): string {
  return c.contact?.name || c.contact?.phone || "Contato";
}

/** A one-line hint of what's being forwarded. */
function messagePreview(m: Message): string {
  if (m.content_type === "audio") return "🎤 Áudio";
  if (m.content_type === "image") return "🖼️ Foto";
  if (m.content_type === "video") return "🎬 Vídeo";
  if (m.content_type === "document") return "📄 Documento";
  const t = (m.content_text ?? "").trim();
  return t ? (t.length > 60 ? `${t.slice(0, 60)}…` : t) : "Mensagem";
}

export function ForwardDialog({
  message,
  onClose,
}: {
  message: Message;
  onClose: () => void;
}) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [resolving, setResolving] = useState(false);

  useEffect(() => {
    listConversations()
      .then((list) => setConversations(list))
      .catch(() => toast.error("Não foi possível carregar as conversas."))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    // Don't offer the conversation the message is already in.
    const base = conversations.filter((c) => c.id !== message.conversation_id);
    if (!q) return base;
    return base.filter((c) => {
      const name = (c.contact?.name ?? "").toLowerCase();
      const phone = (c.contact?.phone ?? "").toLowerCase();
      return name.includes(q) || phone.includes(q);
    });
  }, [conversations, query, message.conversation_id]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // "Forward to a new number": when the query is a phone with no matching
  // conversation, offer to open/create it and add it to the selection.
  const queryDigits = query.replace(/\D/g, "");
  const isPhoneQuery = queryDigits.length >= 10;
  const alreadyListed = filtered.some(
    (c) => (c.contact?.phone ?? "").replace(/\D/g, "").endsWith(queryDigits),
  );
  const showNewNumber = isPhoneQuery && !alreadyListed;

  const addNewNumber = async () => {
    if (resolving) return;
    setResolving(true);
    try {
      const res = await fetch("/api/conversations/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phone: queryDigits }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        conversationId?: string;
      };
      if (!res.ok || !data.conversationId) {
        toast.error("Não foi possível abrir a conversa desse número.");
        return;
      }
      // Fetch fresh so the new conversation shows in the list with its name.
      const list = await listConversations().catch(() => conversations);
      setConversations(list);
      setSelected((prev) => new Set(prev).add(data.conversationId!));
      setQuery("");
    } catch {
      toast.error("Não foi possível abrir a conversa desse número.");
    } finally {
      setResolving(false);
    }
  };

  const forward = async () => {
    if (selected.size === 0 || sending) return;
    setSending(true);
    try {
      const res = await fetch(`/api/messages/${message.id}/forward`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetConversationIds: Array.from(selected) }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        sent?: number;
        failed?: number;
        error?: string;
      };
      if (!res.ok) {
        toast.error(data.error || "Não foi possível encaminhar.");
        return;
      }
      const sent = data.sent ?? 0;
      const failed = data.failed ?? 0;
      toast.success(
        `Encaminhada para ${sent} conversa${sent === 1 ? "" : "s"}${
          failed ? ` · ${failed} falhou` : ""
        }.`,
      );
      onClose();
    } catch {
      toast.error("Não foi possível encaminhar.");
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Encaminhar mensagem</DialogTitle>
        </DialogHeader>

        <p className="truncate rounded-lg bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          {messagePreview(message)}
        </p>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar por nome ou número"
            className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground"
          />
        </div>

        {showNewNumber && (
          <button
            type="button"
            onClick={addNewNumber}
            disabled={resolving}
            className="flex w-full items-center gap-3 rounded-lg border border-dashed border-border px-3 py-2.5 text-left transition hover:bg-muted/50 disabled:opacity-60"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              {resolving ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <UserPlus className="size-4" />
              )}
            </span>
            <span className="flex flex-col leading-tight">
              <span className="text-sm font-medium text-foreground">
                Encaminhar para {queryDigits}
              </span>
              <span className="text-xs text-muted-foreground">
                Número novo — abre a conversa
              </span>
            </span>
          </button>
        )}

        <div className="max-h-72 overflow-y-auto rounded-lg border border-border">
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Carregando…
            </p>
          ) : filtered.length === 0 && !showNewNumber ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Nenhuma conversa encontrada.
            </p>
          ) : filtered.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              Selecione o número acima para encaminhar.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((c) => {
                const isOn = selected.has(c.id);
                return (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => toggle(c.id)}
                      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-muted/50"
                    >
                      <span
                        className={`flex size-5 shrink-0 items-center justify-center rounded-md border ${
                          isOn
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border"
                        }`}
                      >
                        {isOn && <Send className="size-3" />}
                      </span>
                      <span className="flex min-w-0 flex-col leading-tight">
                        <span className="truncate text-sm font-medium text-foreground">
                          {convLabel(c)}
                        </span>
                        {c.channel?.name && (
                          <span className="truncate text-xs text-muted-foreground">
                            {c.channel.name}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-2">
          <button
            onClick={onClose}
            className="flex items-center gap-1 rounded-lg px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted"
          >
            <X className="size-4" />
            Cancelar
          </button>
          <Button onClick={forward} disabled={selected.size === 0 || sending}>
            {sending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-4" />
            )}
            Encaminhar{selected.size > 0 ? ` (${selected.size})` : ""}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

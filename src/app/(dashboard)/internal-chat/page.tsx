"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Hash,
  Lock,
  Plus,
  Send,
  Loader2,
  MessagesSquare,
} from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useServerEvents, type ServerEvent } from "@/hooks/use-server-events";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { CreateChannelDialog } from "@/components/internal-chat/create-channel-dialog";
import { refreshInternalUnread } from "@/hooks/use-internal-unread";
import {
  listInternalChannels,
  getInternalMessages,
  sendInternalMessage,
  markInternalChannelRead,
  listTeamMembers,
} from "./actions";
import type {
  InternalChannel,
  InternalChatMessage,
} from "@/lib/internal-chat/types";
import { MentionComposer, MentionText } from "@/components/inbox/mention-composer";
import type { MentionMember } from "@/lib/inbox/mentions";

function timeOf(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export default function InternalChatPage() {
  const { canEditSettings } = useAuth();

  const [channels, setChannels] = useState<InternalChannel[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<InternalChatMessage[]>([]);
  const [loadingChannels, setLoadingChannels] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [members, setMembers] = useState<MentionMember[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  const insertEmoji = useCallback((emoji: string) => {
    const el = composerRef.current;
    if (!el) {
      setText((t) => t + emoji);
      return;
    }
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? el.value.length;
    setText(el.value.slice(0, start) + emoji + el.value.slice(end));
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + emoji.length;
      el.setSelectionRange(pos, pos);
    });
  }, []);

  const loadChannels = useCallback(async () => {
    try {
      const list = await listInternalChannels();
      setChannels(list);
      setActiveId((cur) => cur ?? list[0]?.id ?? null);
    } catch {
      setChannels([]);
    } finally {
      setLoadingChannels(false);
    }
  }, []);

  useEffect(() => {
    void loadChannels();
    // Members for @mention autocomplete.
    listTeamMembers()
      .then((list) =>
        setMembers(list.map((m) => ({ id: m.id, name: m.name }))),
      )
      .catch(() => {});
  }, [loadChannels]);

  const loadMessages = useCallback(async (channelId: string) => {
    setLoadingMessages(true);
    try {
      setMessages(await getInternalMessages(channelId));
    } catch {
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  }, []);

  // Mark a channel read (clears its dot + the sidebar badge).
  const markRead = useCallback(async (channelId: string) => {
    try {
      await markInternalChannelRead(channelId);
    } catch {
      // best-effort
    }
    setChannels((cs) =>
      cs.map((c) => (c.id === channelId ? { ...c, unread: false } : c)),
    );
    refreshInternalUnread();
  }, []);

  // Opening a channel loads its messages and marks it read.
  useEffect(() => {
    if (activeId) {
      void loadMessages(activeId);
      void markRead(activeId);
    }
  }, [activeId, loadMessages, markRead]);

  // Realtime: a new message anywhere refreshes the channel dots; if it's the
  // channel we're viewing, refetch its thread and keep it read.
  useServerEvents(
    useCallback(
      (e: ServerEvent) => {
        if (e.type !== "internal_message") return;
        void loadChannels();
        if (e.channelId === activeId && activeId) {
          void loadMessages(activeId);
          void markRead(activeId);
        }
      },
      [activeId, loadChannels, loadMessages, markRead],
    ),
  );

  // Stick to the bottom as messages arrive.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const active = channels.find((c) => c.id === activeId) ?? null;

  const send = async () => {
    const body = text.trim();
    if (!body || !activeId || sending) return;
    setSending(true);
    setText("");
    try {
      const msg = await sendInternalMessage(activeId, body);
      setMessages((m) => [...m, msg]);
    } catch (err) {
      setText(body);
      toast.error(err instanceof Error ? err.message : "Não foi possível enviar.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex h-[calc(100dvh-7rem)] gap-4 overflow-hidden">
      {/* Channel list */}
      <aside className="flex w-60 shrink-0 flex-col rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
          <div className="flex items-center gap-2">
            <MessagesSquare className="h-4 w-4 text-primary" />
            <h1 className="text-sm font-semibold text-foreground">
              Chat Interno
            </h1>
          </div>
          {canEditSettings && (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              title="Novo canal"
              aria-label="Novo canal"
              className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <Plus className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          <p className="px-2 pb-1.5 pt-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Canais
          </p>
          {loadingChannels ? (
            <div className="flex justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : channels.length === 0 ? (
            <p className="px-2 py-4 text-xs text-muted-foreground">
              Nenhum canal ainda.
              {canEditSettings ? " Crie o primeiro no +." : ""}
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {channels.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => setActiveId(c.id)}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                      c.id === activeId
                        ? "bg-primary/10 font-medium text-primary"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {c.is_private ? (
                      <Lock className="h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <Hash className="h-3.5 w-3.5 shrink-0" />
                    )}
                    <span
                      className={cn(
                        "flex-1 truncate",
                        c.unread && c.id !== activeId && "font-semibold text-foreground",
                      )}
                    >
                      {c.name}
                    </span>
                    {c.unread && c.id !== activeId && (
                      <span
                        aria-label="Mensagens não lidas"
                        className="h-2 w-2 shrink-0 rounded-full bg-primary"
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* Thread */}
      <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-border bg-card">
        {active ? (
          <>
            <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
              {active.is_private ? (
                <Lock className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Hash className="h-4 w-4 text-muted-foreground" />
              )}
              <div className="min-w-0">
                <h2 className="truncate text-sm font-semibold text-foreground">
                  {active.name}
                </h2>
                {active.description && (
                  <p className="truncate text-xs text-muted-foreground">
                    {active.description}
                  </p>
                )}
              </div>
            </header>

            <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
              {loadingMessages ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-1 text-center">
                  <MessagesSquare className="h-8 w-8 text-muted-foreground/40" />
                  <p className="text-sm text-muted-foreground">
                    Nenhuma mensagem ainda.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Diga um oi para a equipe 👋
                  </p>
                </div>
              ) : (
                messages.map((m) => (
                  <div
                    key={m.id}
                    className={cn(
                      "flex items-end gap-2",
                      m.is_mine ? "flex-row-reverse" : "flex-row",
                    )}
                  >
                    <Avatar className="size-7 shrink-0">
                      {m.sender_image ? (
                        <AvatarImage src={m.sender_image} alt={m.sender_name} />
                      ) : null}
                      <AvatarFallback className="bg-primary/10 text-xs text-primary">
                        {m.sender_name?.charAt(0)?.toUpperCase() ?? "U"}
                      </AvatarFallback>
                    </Avatar>
                    <div
                      className={cn(
                        "max-w-[70%] rounded-2xl px-3 py-2",
                        m.is_mine
                          ? "bg-primary text-primary-foreground"
                          : "bg-muted text-foreground",
                      )}
                    >
                      {!m.is_mine && (
                        <p className="mb-0.5 text-xs font-medium text-primary">
                          {m.sender_name}
                        </p>
                      )}
                      <p className="whitespace-pre-wrap break-words text-sm">
                        <MentionText text={m.content} members={members} />
                      </p>
                      <p
                        className={cn(
                          "mt-0.5 text-right text-[10px]",
                          m.is_mine
                            ? "text-primary-foreground/70"
                            : "text-muted-foreground",
                        )}
                      >
                        {timeOf(m.created_at)}
                      </p>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="shrink-0 border-t border-border p-3">
              <div className="flex items-end gap-2">
                <EmojiPicker onPick={insertEmoji} />
                <MentionComposer
                  value={text}
                  onChange={setText}
                  onSubmit={() => void send()}
                  members={members}
                  placeholder={`Mensagem para #${active.name} · @ para mencionar`}
                />
                <Button
                  size="sm"
                  onClick={() => void send()}
                  disabled={!text.trim() || sending}
                  className="h-9 w-9 shrink-0 bg-primary p-0 hover:bg-primary/90 disabled:opacity-40"
                >
                  {sending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Send className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <MessagesSquare className="h-10 w-10 text-muted-foreground/40" />
            <p className="text-sm font-medium text-foreground">
              Bem-vindo ao Chat Interno
            </p>
            <p className="max-w-xs text-xs text-muted-foreground">
              {channels.length === 0 && canEditSettings
                ? "Crie o primeiro canal no botão + ao lado."
                : channels.length === 0
                  ? "Peça a um administrador para criar um canal."
                  : "Escolha um canal ao lado para começar."}
            </p>
          </div>
        )}
      </section>

      <CreateChannelDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(ch) => {
          setChannels((cs) => [...cs, ch].sort((a, b) => a.name.localeCompare(b.name)));
          setActiveId(ch.id);
        }}
      />
    </div>
  );
}

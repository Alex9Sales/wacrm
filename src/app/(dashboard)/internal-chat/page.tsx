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
  MoreVertical,
  Pencil,
  Trash2,
  Paperclip,
  FileText,
  Download,
  UploadCloud,
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { refreshInternalUnread } from "@/hooks/use-internal-unread";
import {
  listInternalChannels,
  getInternalMessages,
  sendInternalMessage,
  markInternalChannelRead,
  listTeamMembers,
  deleteInternalChannel,
} from "./actions";
import type {
  InternalChannel,
  InternalChatMessage,
} from "@/lib/internal-chat/types";
import { MentionComposer, MentionText } from "@/components/inbox/mention-composer";
import type { MentionMember } from "@/lib/inbox/mentions";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import { CHAT_MEDIA_BUCKET } from "@/components/inbox/message-composer";
import type { InternalMediaKind } from "@/lib/internal-chat/types";

/** Map a file's MIME type to the internal media kind (image/video/audio/doc). */
function internalKindFromFile(file: File): InternalMediaKind {
  const t = file.type.toLowerCase();
  if (t.startsWith("image/")) return "image";
  if (t.startsWith("video/")) return "video";
  if (t.startsWith("audio/")) return "audio";
  return "document";
}

/** Per-kind ceilings (bytes) — mirror the WhatsApp composer caps. */
const INTERNAL_MEDIA_MAX: Record<InternalMediaKind, number> = {
  image: 5 * 1024 * 1024,
  video: 16 * 1024 * 1024,
  audio: 16 * 1024 * 1024,
  document: 100 * 1024 * 1024,
};
import { setActiveInternalChannel } from "@/lib/internal-chat/active-channel";

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
  const [editChannel, setEditChannel] = useState<InternalChannel | null>(null);
  const [members, setMembers] = useState<MentionMember[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

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

  // Tell the notification listener which channel is on screen, so only THIS
  // channel stays silent (others still sound). Clear it when leaving the page.
  useEffect(() => {
    setActiveInternalChannel(activeId);
    return () => setActiveInternalChannel(null);
  }, [activeId]);

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

  const handleDeleteChannel = useCallback(
    async (ch: InternalChannel) => {
      if (
        !confirm(
          `Excluir o canal "${ch.name}"? Todas as mensagens dele serão apagadas. Isso não pode ser desfeito.`,
        )
      )
        return;
      try {
        await deleteInternalChannel(ch.id);
        toast.success(`Canal "${ch.name}" excluído.`);
        setChannels((cs) => cs.filter((c) => c.id !== ch.id));
        setActiveId((cur) => (cur === ch.id ? null : cur));
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Não foi possível excluir o canal.",
        );
      }
    },
    [],
  );

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

  // Upload an attachment (from the paperclip, paste, or drag-drop) and post it
  // as a message. Caption-less — the file IS the message.
  const sendMedia = useCallback(
    async (file: File) => {
      if (!activeId || uploading) return;
      const kind = internalKindFromFile(file);
      if (file.size > INTERNAL_MEDIA_MAX[kind]) {
        toast.error(
          `Arquivo muito grande (${(file.size / 1024 / 1024).toFixed(1)} MB) — limite ${Math.round(
            INTERNAL_MEDIA_MAX[kind] / 1024 / 1024,
          )} MB para ${kind}.`,
        );
        return;
      }
      setUploading(true);
      try {
        const { publicUrl } = await uploadAccountMedia(CHAT_MEDIA_BUCKET, file);
        const named =
          file.name && file.name.includes(".")
            ? file.name
            : `${kind}-${Date.now()}`;
        const msg = await sendInternalMessage(activeId, "", {
          url: publicUrl,
          type: kind,
          name: named,
        });
        setMessages((m) => [...m, msg]);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Falha ao enviar o anexo.",
        );
      } finally {
        setUploading(false);
      }
    },
    [activeId, uploading],
  );

  // Paste an image straight into the chat (Win+Shift+S → Ctrl+V, like WhatsApp).
  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const item = Array.from(e.clipboardData?.items ?? []).find(
        (it) => it.kind === "file" && it.type.startsWith("image/"),
      );
      if (!item) return;
      const file = item.getAsFile();
      if (!file) return;
      e.preventDefault();
      const ext = file.type.split("/")[1] || "png";
      const named =
        file.name && file.name.includes(".")
          ? file
          : new File([file], `captura-${Date.now()}.${ext}`, { type: file.type });
      void sendMedia(named);
    },
    [sendMedia],
  );

  // Drag a file from outside INTO the chat area.
  const dragHasFiles = (e: React.DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  }, []);
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);
  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!dragHasFiles(e)) return;
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragOver(false);
    }
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      dragDepth.current = 0;
      setDragOver(false);
      if (!dragHasFiles(e)) return;
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file) void sendMedia(file);
    },
    [sendMedia],
  );

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
      <section
        className="relative flex min-w-0 flex-1 flex-col rounded-xl border border-border bg-card"
        onDragEnter={active ? onDragEnter : undefined}
        onDragOver={active ? onDragOver : undefined}
        onDragLeave={active ? onDragLeave : undefined}
        onDrop={active ? onDrop : undefined}
      >
        {active && dragOver && (
          <div className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-sm">
            <UploadCloud className="h-10 w-10 text-primary" />
            <p className="text-base font-medium text-primary">
              Solte para enviar no #{active.name}
            </p>
          </div>
        )}
        {active ? (
          <>
            <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
              {active.is_private ? (
                <Lock className="h-4 w-4 text-muted-foreground" />
              ) : (
                <Hash className="h-4 w-4 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold text-foreground">
                  {active.name}
                </h2>
                {active.description && (
                  <p className="truncate text-xs text-muted-foreground">
                    {active.description}
                  </p>
                )}
              </div>
              {canEditSettings && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    title="Gerenciar canal"
                    aria-label="Gerenciar canal"
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <MoreVertical className="h-4 w-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="border-border bg-popover">
                    <DropdownMenuItem onClick={() => setEditChannel(active)}>
                      <Pencil className="mr-2 h-4 w-4" />
                      Editar canal
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void handleDeleteChannel(active)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 className="mr-2 h-4 w-4" />
                      Excluir canal
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
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
                      {/* Attachment (image = draggable out to the desktop). */}
                      {m.media_url && m.media_type === "image" && (
                        <a
                          href={m.media_url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="block"
                        >
                          <img
                            src={m.media_url}
                            alt={m.media_name ?? "imagem"}
                            className="max-h-64 max-w-full rounded-lg"
                          />
                        </a>
                      )}
                      {m.media_url && m.media_type === "video" && (
                        <video
                          src={m.media_url}
                          controls
                          className="max-h-64 max-w-full rounded-lg"
                        />
                      )}
                      {m.media_url && m.media_type === "audio" && (
                        <audio src={m.media_url} controls className="max-w-full" />
                      )}
                      {m.media_url && m.media_type === "document" && (
                        <a
                          href={m.media_url}
                          target="_blank"
                          rel="noreferrer noopener"
                          download={m.media_name ?? undefined}
                          className={cn(
                            "flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm underline-offset-2 hover:underline",
                            m.is_mine ? "bg-primary-foreground/10" : "bg-background/60",
                          )}
                        >
                          <FileText className="h-4 w-4 shrink-0" />
                          <span className="max-w-48 truncate">
                            {m.media_name ?? "documento"}
                          </span>
                          <Download className="h-3.5 w-3.5 shrink-0 opacity-70" />
                        </a>
                      )}
                      {m.content && (
                        <p className="whitespace-pre-wrap break-words text-sm">
                          <MentionText text={m.content} members={members} />
                        </p>
                      )}
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

            <div className="shrink-0 border-t border-border p-3" onPaste={handlePaste}>
              <div className="flex items-end gap-2">
                <EmojiPicker onPick={insertEmoji} />
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.csv,.txt,.zip"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void sendMedia(f);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  title="Anexar imagem, áudio ou documento"
                  aria-label="Anexar arquivo"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition hover:bg-muted hover:text-foreground disabled:opacity-40"
                >
                  {uploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Paperclip className="h-4 w-4" />
                  )}
                </button>
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

      <CreateChannelDialog
        open={!!editChannel}
        onOpenChange={(o) => !o && setEditChannel(null)}
        channel={editChannel}
        onCreated={() => {}}
        onUpdated={(ch) => {
          setChannels((cs) =>
            cs
              .map((c) => (c.id === ch.id ? { ...c, ...ch } : c))
              .sort((a, b) => a.name.localeCompare(b.name)),
          );
          setEditChannel(null);
        }}
      />
    </div>
  );
}

"use client";

import { useState, useEffect, useCallback, useRef, useMemo, type DragEvent } from "react";
import {
  deleteConversation,
  listGroupMentionNames,
  listMessages,
  listProfiles,
  listReactions,
  markConversationRead,
  updateConversationAssignment,
  updateConversationStatus,
  listSectors,
  updateConversationSector,
  transferConversation,
  dismissTransferNote,
  setConversationPrivacy,
} from "@/app/(dashboard)/inbox/actions";
import { useAuth } from "@/hooks/use-auth";
import { hasMinRole } from "@/lib/auth/roles";
import { usePresence } from "@/hooks/use-presence";
import { PresenceDot } from "@/components/presence/presence-dot";
import { presenceLabel } from "@/lib/presence";
import { cn } from "@/lib/utils";
import type {
  ChannelProvider,
  Conversation,
  Message,
  MessageReaction,
  Contact,
  ConversationStatus,
  MessageTemplate,
  Profile,
} from "@/types";
import {
  MessageSquare,
  ChevronDown,
  UserPlus,
  Check,
  Clock,
  ArrowLeft,
  RefreshCw,
  PanelRightOpen,
  PanelRightClose,
  Radio,
  Trash2,
  Loader2,
  Building2,
  ArrowRightLeft,
  PhoneCall,
  X,
  UploadCloud,
  Lock,
  LockOpen,
} from "lucide-react";
import { startOutboundCall } from "@/components/calls/incoming-call-modal";
import { format, isToday, isYesterday, differenceInHours } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ContactAvatar } from "./contact-avatar";
import { MessageBubble } from "./message-bubble";
import { MessageActions } from "./message-actions";
import { ForwardDialog } from "./forward-dialog";
import { listTeamMembers } from "@/app/(dashboard)/internal-chat/actions";
import type { MentionMember } from "@/lib/inbox/mentions";
import {
  MessageComposer,
  CHAT_MEDIA_BUCKET,
  type SendMediaPayload,
} from "./message-composer";
import { deleteAccountMedia } from "@/lib/storage/upload-media";
import { TemplatePicker } from "./template-picker";
import { buildReplyPreview } from "./reply-quote";
import { toast } from "sonner";

interface ReplyDraft {
  id: string;
  authorLabel: string;
  preview: string;
}

/** Short provider labels for the inbox channel badge (pt-BR). Shared
 *  with the conversation list. */
export const CHANNEL_PROVIDER_LABELS: Record<ChannelProvider, string> = {
  meta: "Meta",
  waha: "WAHA",
  evolution: "Evolution",
  evogo: "EvoGo",
};

function renderTemplateBody(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    return params[idx] ?? `{{${raw}}}`;
  });
}

interface MessageThreadProps {
  conversation: Conversation | null;
  contact: Contact | null;
  messages: Message[];
  onMessagesLoaded: (messages: Message[]) => void;
  onNewMessage: (message: Message) => void;
  onUpdateMessage: (id: string, updates: Partial<Message>) => void;
  onStatusChange: (conversationId: string, status: ConversationStatus) => void;
  onAssignChange: (
    conversationId: string,
    assignedAgentId: string | null,
  ) => void;
  /**
   * On mobile, the thread is shown full-screen with the conversation list
   * hidden. This callback lets the page deselect the active conversation
   * and reveal the list again. Rendered as a back-arrow in the header on
   * mobile only.
   */
  onBack?: () => void;
  /**
   * Increment to force the messages + reactions fetch effects to refire.
   * Parent bumps this on realtime reconnect / tab visibility → visible
   * so the open thread catches up on any events sent while the WS was
   * disconnected or the tab was throttled. Optional so existing callers
   * keep working.
   */
  resyncToken?: number;
  /**
   * Fired by the manual-refresh button in the thread header. The parent
   * typically bumps the same `resyncToken` it controls — this gives the
   * user a way to force a refetch when they suspect realtime missed an
   * event (or they're impatient). Optional so existing callers keep
   * working; the button is only rendered when this is provided.
   */
  onRefresh?: () => void;
  /**
   * Desktop-only contact-panel toggle. The page owns the open/closed
   * state (it's the one that renders the sidebar), so the thread just
   * reflects it and asks the page to flip it. Both optional so existing
   * callers keep working; the toggle button only renders when
   * `onToggleContactPanel` is wired up.
   */
  contactPanelOpen?: boolean;
  onToggleContactPanel?: () => void;
  /**
   * Fired after the active conversation is successfully deleted. The page
   * uses it to drop the conversation from the list and clear the open
   * thread. Optional so existing callers keep working; the trash button in
   * the header only renders when this is wired up.
   */
  onConversationDeleted?: (conversationId: string) => void;
}

function formatDateSeparator(dateStr: string): string {
  const date = new Date(dateStr);
  if (isToday(date)) return "Hoje";
  if (isYesterday(date)) return "Ontem";
  return format(date, "d 'de' MMMM 'de' yyyy");
}

function groupMessagesByDate(messages: Message[]) {
  const groups: { date: string; messages: Message[] }[] = [];
  let currentDate = "";

  for (const msg of messages) {
    const day = format(new Date(msg.created_at), "yyyy-MM-dd");
    if (day !== currentDate) {
      currentDate = day;
      groups.push({ date: msg.created_at, messages: [msg] });
    } else {
      groups[groups.length - 1].messages.push(msg);
    }
  }

  return groups;
}

/** WhatsApp only allows editing within ~15 min of sending. */
const EDIT_WINDOW_MS = 15 * 60_000;

/** UI-side editability of a message: an own (agent/bot) TEXT message, not an
 *  internal note, already sent, and within WhatsApp's ~15min window. `now` is
 *  the thread's mount-time clock (pure — the server re-checks the real window,
 *  so a slightly stale UI just yields a clean "janela expirada" toast). */
function isMessageEditable(msg: Message, now: number): boolean {
  if (msg.sender_type !== "agent" && msg.sender_type !== "bot") return false;
  if (msg.content_type !== "text" || msg.is_internal) return false;
  if (msg.status === "sending" || msg.status === "failed") return false;
  // Optimistic message not yet persisted (id is `temp-…`, no real WhatsApp id):
  // wait until the server round-trip replaces it with the real row.
  if (msg.id.startsWith("temp-")) return false;
  const sentMs = msg.created_at ? new Date(msg.created_at).getTime() : 0;
  if (!sentMs) return false;
  return now - sentMs <= EDIT_WINDOW_MS;
}

const STATUS_OPTIONS: { label: string; value: ConversationStatus; color: string }[] = [
  { label: "Aberta", value: "open", color: "text-primary" },
  { label: "Pendente", value: "pending", color: "text-amber-400" },
  { label: "Fechada", value: "closed", color: "text-muted-foreground" },
];

/**
 * WhatsApp-style doodle background applied to the chat area (both the
 * active thread and the empty state). The SVG tile lives at
 * `/public/inbox-doodle.svg`; the slate-950 colour sits underneath so
 * the doodles read as a subtle pattern rather than a stark grid.
 *
 * Defined once at module scope so the two render paths can't drift —
 * if we ever switch the asset, both spots update together.
 */
const DOODLE_BG_CLASSES =
  "bg-background bg-[url('/inbox-doodle.svg')] bg-repeat";

export function MessageThread({
  conversation,
  contact,
  messages,
  onMessagesLoaded,
  onNewMessage,
  onUpdateMessage,
  onStatusChange,
  onAssignChange,
  onBack,
  resyncToken = 0,
  onRefresh,
  contactPanelOpen,
  onToggleContactPanel,
  onConversationDeleted,
}: MessageThreadProps) {
  const { user, accountRole } = useAuth();
  // Deleting a conversation is admin/owner-only (matches the server-side
  // requireRole('admin') in deleteConversation) — hide the button otherwise.
  const canDeleteConversation = hasMinRole(accountRole ?? "viewer", "admin");
  // Assigning a conversation is supervisor+ only (matches the server-side
  // requireRole('supervisor') in updateConversationAssignment). Agents who are
  // pulled into a thread by a private @mention can view/reply but must not
  // be able to take over the conversation.
  const canAssign = hasMinRole(accountRole ?? "viewer", "supervisor");
  const { getPresence, getRow, now } = usePresence();
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Drop a file anywhere on the conversation (not just the composer) — the
  // dropped file is handed to the composer, which stages it for sending.
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const dragDepth = useRef(0);
  // Private-conversation toggle (optimistic; server is authoritative).
  const [isPrivate, setIsPrivate] = useState(!!conversation?.is_private);
  useEffect(() => {
    setIsPrivate(!!conversation?.is_private);
  }, [conversation?.id, conversation?.is_private]);

  const dragHasFiles = (e: DragEvent) =>
    Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onThreadDragEnter = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    dragDepth.current += 1;
    setDragOver(true);
  }, []);
  const onThreadDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  }, []);
  const onThreadDragLeave = useCallback((e: DragEvent<HTMLDivElement>) => {
    if (!dragHasFiles(e)) return;
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragOver(false);
    }
  }, []);
  const onThreadDrop = useCallback((e: DragEvent<HTMLDivElement>) => {
    dragDepth.current = 0;
    setDragOver(false);
    if (!dragHasFiles(e)) return;
    e.preventDefault();
    const file = e.dataTransfer.files?.[0];
    if (file) setDroppedFile(file);
  }, []);

  // Safety net: clear the drag overlay on any drop/dragend anywhere. Capture
  // phase so it fires even when a child (the composer) stops propagation on its
  // own drop — otherwise the overlay could get stuck after such a drop.
  useEffect(() => {
    const clear = () => {
      dragDepth.current = 0;
      setDragOver(false);
    };
    window.addEventListener("drop", clear, true);
    window.addEventListener("dragend", clear, true);
    return () => {
      window.removeEventListener("drop", clear, true);
      window.removeEventListener("dragend", clear, true);
    };
  }, []);

  // Only the assignee or a supervisor+ can privatize a conversation.
  const canTogglePrivacy =
    canAssign ||
    (!!conversation?.assigned_agent_id &&
      conversation.assigned_agent_id === user?.id);
  const handleTogglePrivacy = useCallback(async () => {
    if (!conversation) return;
    const next = !isPrivate;
    setIsPrivate(next); // optimistic
    try {
      await setConversationPrivacy(conversation.id, next);
      toast.success(next ? "Conversa privada." : "Conversa liberada.");
    } catch (err) {
      setIsPrivate(!next); // revert
      toast.error(
        err instanceof Error ? err.message : "Não foi possível alterar a privacidade.",
      );
    }
  }, [conversation, isPrivate, user?.id]);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [reactions, setReactions] = useState<MessageReaction[]>([]);
  // Purely visual spin state for the manual-refresh button. The actual
  // refetch is fire-and-forget through `onRefresh` (which bumps the
  // parent's resyncToken); the 700ms spin is just feedback so the click
  // doesn't feel like a no-op. Cleared via the timer ref on unmount.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current !== null) {
        clearTimeout(refreshTimerRef.current);
      }
    };
  }, []);

  // Team members for internal-note @mention (autocomplete + highlight).
  useEffect(() => {
    listTeamMembers()
      .then((list) =>
        setMentionMembers(list.map((m) => ({ id: m.id, name: m.name }))),
      )
      .catch(() => {});
  }, []);

  // Group participants for the reply @mention autocomplete (groups only).
  const isGroupConversation = contact?.is_group ?? false;
  const conversationIdForMentions = conversation?.id;
  useEffect(() => {
    if (!isGroupConversation || !conversationIdForMentions) {
      setGroupMentions([]);
      return;
    }
    listGroupMentionNames(conversationIdForMentions)
      .then(setGroupMentions)
      .catch(() => setGroupMentions([]));
  }, [isGroupConversation, conversationIdForMentions]);

  const handleRefreshClick = useCallback(() => {
    if (isRefreshing || !onRefresh) return;
    setIsRefreshing(true);
    onRefresh();
    refreshTimerRef.current = setTimeout(() => {
      setIsRefreshing(false);
      refreshTimerRef.current = null;
    }, 700);
  }, [isRefreshing, onRefresh]);
  const [replyTo, setReplyTo] = useState<ReplyDraft | null>(null);
  // The message being forwarded (opens the ForwardDialog).
  const [forwarding, setForwarding] = useState<Message | null>(null);
  // Team members, for internal-note @mention (autocomplete + highlight).
  const [mentionMembers, setMentionMembers] = useState<MentionMember[]>([]);
  // Group participants (name + avatar), for the reply @mention autocomplete —
  // only fetched for a group conversation.
  const [groupMentions, setGroupMentions] = useState<
    { id: string; name: string; avatarUrl: string | null }[]
  >([]);
  // Delete-conversation confirm dialog + in-flight state.
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // Edit-message dialog: the message being edited, its draft text, in-flight.
  const [editingMsg, setEditingMsg] = useState<Message | null>(null);
  const [editText, setEditText] = useState("");
  const [editBusy, setEditBusy] = useState(false);

  // Profiles are scoped to the caller's account by the server action —
  // the assignee dropdown lists every teammate in the workspace.
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

  // 24-hour session timer
  const sessionInfo = useMemo(() => {
    if (!messages.length) return { expired: false, remaining: "" };

    // Find last customer message
    const lastCustomerMsg = [...messages]
      .reverse()
      .find((m) => m.sender_type === "customer");

    if (!lastCustomerMsg) return { expired: true, remaining: "Nenhuma mensagem do cliente" };

    const hoursSince = differenceInHours(new Date(), new Date(lastCustomerMsg.created_at));
    const expired = hoursSince >= 24;

    if (expired) {
      return { expired: true, remaining: "Expirada" };
    }

    const hoursLeft = 24 - hoursSince;
    const remaining =
      hoursLeft >= 1
        ? `${Math.floor(hoursLeft)}h restantes`
        : `${Math.floor(hoursLeft * 60)}m restantes`;

    return { expired, remaining };
  }, [messages]);

  // Store latest callback in a ref so fetchMessages doesn't need to
  // depend on `onMessagesLoaded` — otherwise parent re-renders cause
  // fetchMessages to change → useEffect re-fires → refetch → realtime
  // UPDATE on conversations.unread_count → parent re-renders → LOOP.
  // The ref is written inside an effect so the mutation doesn't happen
  // during render (React 19 refs rule); consumers only read `.current`
  // inside the async fetch completion, which runs after the render.
  const onMessagesLoadedRef = useRef(onMessagesLoaded);
  useEffect(() => {
    onMessagesLoadedRef.current = onMessagesLoaded;
  });

  const conversationId = conversation?.id;
  const hasUnread = (conversation?.unread_count ?? 0) > 0;

  // Fetch messages whenever the selected conversation changes. Kept
  // separate from the unread-reset effect so that incoming messages
  // arriving while the thread is open don't trigger a full refetch —
  // they only flip hasUnread, which only the reset effect listens to.
  useEffect(() => {
    if (!conversationId) return;

    let cancelled = false;

    (async () => {
      setLoading(true);
      try {
        const data = await listMessages(conversationId);
        if (cancelled) return;
        onMessagesLoadedRef.current(data);
      } catch (error) {
        if (cancelled) return;
        console.error("Failed to fetch messages:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the tab regains focus or the user hits refresh — the initial
    // fetch is the only source of truth now that realtime is disabled
    // (TODO(fase-3): realtime via SSE).
  }, [conversationId, resyncToken]);

  // Reactions fetch — pulls the current state from the DB. A `resyncToken`
  // bump (tab focus / manual refresh) refetches the rows. This is the only
  // source of truth for reactions now that the realtime channel is gone.
  useEffect(() => {
    if (!conversationId) {
      setReactions([]);
      return;
    }
    let cancelled = false;

    (async () => {
      try {
        const data = await listReactions(conversationId);
        if (!cancelled) setReactions(data);
      } catch (error) {
        if (!cancelled) console.error("Failed to fetch reactions:", error);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [conversationId, resyncToken]);

  // TODO(fase-3): realtime via SSE
  // The per-conversation reactions realtime subscription (a
  // `reactions:${conversationId}` DB-changes channel) was removed during
  // the Supabase→Drizzle migration. Reactions now only reflect the initial
  // fetch above plus optimistic local updates from postReaction;
  // cross-client live updates return with the SSE work in Phase 3.

  // Clear any in-progress reply draft when the active conversation changes —
  // a quote pulled from conversation A shouldn't bleed into conversation B.
  useEffect(() => {
    setReplyTo(null);
  }, [conversationId]);

  // Reset the server-side unread_count to 0 whenever an unread count
  // surfaces on the active conversation — covers both (a) opening a
  // conversation that had unread messages and (b) new messages arriving
  // while the user is already viewing the thread (webhook server-bumps
  // unread_count to N+1; the realtime UPDATE propagates it into the
  // client, which re-runs this effect and flips it back to 0).
  //
  // Guarding on hasUnread prevents the eq-update loop: once unread_count
  // is 0 the condition is false, so no further UPDATE is issued.
  useEffect(() => {
    if (!conversationId || !hasUnread) return;
    void markConversationRead(conversationId).catch((error) => {
      console.error("Failed to reset unread_count:", error);
    });
  }, [conversationId, hasUnread]);

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      const el = scrollRef.current;
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const handleSend = useCallback(
    async (text: string, replyToId?: string) => {
      if (!conversation) return;

      const tempId = `temp-${Date.now()}`;

      // Optimistic update — shows the message immediately with "sending" status
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "text",
        content_text: text,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "text",
            content_text: text,
            reply_to_message_id: replyToId,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error("Failed to send message:", reason);
          toast.error(`Falha ao enviar: ${reason}`);
          // Mark the optimistic bubble as failed so the user sees what happened
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        // Success — the realtime INSERT event will replace the temp bubble
        // with the real DB row. If realtime hasn't arrived yet, at least
        // flip status to 'sent' so the UI stops showing "sending".
        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send message:", err);
        const reason = err instanceof Error ? err.message : "erro de rede";
        toast.error(`Falha ao enviar: ${reason}`);
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage]
  );

  const handleSendMedia = useCallback(
    async (payload: SendMediaPayload) => {
      if (!conversation) return;

      // Documents show their filename in our own bubble (and to the
      // recipient as the Meta caption when no caption was typed); other
      // kinds use the caption as-is. Audio carries no caption.
      const contentText =
        payload.kind === "document"
          ? payload.caption || payload.filename || "Documento"
          : payload.caption;

      const tempId = `temp-${Date.now()}`;
      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: payload.kind,
        content_text: contentText,
        media_url: payload.mediaUrl,
        status: "sending",
        created_at: new Date().toISOString(),
        reply_to_message_id: payload.replyToId,
      };
      onNewMessage(optimisticMsg);
      setReplyTo(null);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: payload.kind,
            media_url: payload.mediaUrl,
            content_text: contentText,
            filename: payload.filename,
            reply_to_message_id: payload.replyToId,
          }),
        });

        const data = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = data?.error || `HTTP ${res.status}`;
          console.error("Failed to send media:", reason);
          toast.error(`Falha ao enviar: ${reason}`);
          onUpdateMessage(tempId, { status: "failed" });
          // The upload never reached the recipient — GC the orphaned
          // object rather than leaving it in the public bucket forever.
          void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(() => {});
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send media:", err);
        const reason = err instanceof Error ? err.message : "erro de rede";
        toast.error(`Falha ao enviar: ${reason}`);
        onUpdateMessage(tempId, { status: "failed" });
        void deleteAccountMedia(CHAT_MEDIA_BUCKET, payload.path).catch(() => {});
      }
    },
    [conversation, onNewMessage, onUpdateMessage],
  );

  const handleStatusChange = useCallback(
    async (status: ConversationStatus) => {
      if (!conversation) return;

      try {
        await updateConversationStatus(conversation.id, status);
      } catch (err) {
        console.error("Failed to update status:", err);
        toast.error("Falha ao atualizar o status");
        return;
      }

      onStatusChange(conversation.id, status);
    },
    [conversation, onStatusChange]
  );

  const handleOpenTemplates = useCallback(() => {
    setTemplateModalOpen(true);
  }, []);

  const handleSendTemplate = useCallback(
    async (
      template: MessageTemplate,
      values: {
        body: string[];
        headerText?: string;
        buttonParams?: Record<number, string>;
      },
    ) => {
      if (!conversation) return;

      const renderedBody = renderTemplateBody(template.body_text, values.body);
      const tempId = `temp-${Date.now()}`;

      const optimisticMsg: Message = {
        id: tempId,
        conversation_id: conversation.id,
        sender_type: "agent",
        content_type: "template",
        content_text: renderedBody,
        template_name: template.name,
        status: "sending",
        created_at: new Date().toISOString(),
      };
      onNewMessage(optimisticMsg);

      try {
        const res = await fetch("/api/whatsapp/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            conversation_id: conversation.id,
            message_type: "template",
            template_name: template.name,
            template_language: template.language,
            // Structured params drive the new send-builder path
            // (header media + URL button substitution). Body values
            // are mirrored under both shapes so the route can fall
            // back if the template row isn't found locally.
            template_message_params: {
              body: values.body,
              headerText: values.headerText,
              buttonParams: values.buttonParams,
            },
            template_params: values.body,
            content_text: renderedBody,
          }),
        });

        const payload = await res.json().catch(() => ({}));

        if (!res.ok) {
          const reason = payload?.error || `HTTP ${res.status}`;
          console.error("Failed to send template:", reason);
          toast.error(`Falha ao enviar template: ${reason}`);
          onUpdateMessage(tempId, { status: "failed" });
          return;
        }

        onUpdateMessage(tempId, { status: "sent" });
      } catch (err) {
        console.error("Failed to send template:", err);
        const reason = err instanceof Error ? err.message : "erro de rede";
        toast.error(`Falha ao enviar template: ${reason}`);
        onUpdateMessage(tempId, { status: "failed" });
      }
    },
    [conversation, onNewMessage, onUpdateMessage],
  );

  // Build a quick id → Message map so reply quotes can be rendered without
  // an extra fetch — the thread already holds the full conversation.
  const messagesById = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of messages) map.set(m.id, m);
    return map;
  }, [messages]);

  // Bucket reactions by their target message_id for O(1) per-bubble lookup.
  const reactionsByMessageId = useMemo(() => {
    const map = new Map<string, MessageReaction[]>();
    for (const r of reactions) {
      const bucket = map.get(r.message_id);
      if (bucket) bucket.push(r);
      else map.set(r.message_id, [r]);
    }
    return map;
  }, [reactions]);

  const contactDisplayName = contact?.name || contact?.phone || "Cliente";

  // Author label for a quoted message: "You" when we sent the parent,
  // contact name when the customer sent it.
  const authorLabelFor = useCallback(
    (m: Message): string => {
      const isAgentMsg =
        m.sender_type === "agent" || m.sender_type === "bot";
      return isAgentMsg ? "Você" : contactDisplayName;
    },
    [contactDisplayName],
  );

  const handleStartReply = useCallback(
    (msg: Message) => {
      setReplyTo({
        id: msg.id,
        authorLabel: authorLabelFor(msg),
        preview: buildReplyPreview(msg),
      });
    },
    [authorLabelFor],
  );

  // Single reaction-set primitive. emoji === "" removes; otherwise adds/swaps.
  // The "toggle" semantic (pill click) is computed at the call site where the
  // current reactions for the bubble are already in scope — keeps this
  // function dependency-free w.r.t. the reaction list.
  const postReaction = useCallback(
    async (messageId: string, emoji: string) => {
      if (!user?.id || !conversation) {
        console.warn("[reactions] missing user or conversation");
        return;
      }
      if (messageId.startsWith("temp-")) {
        toast.error("Aguarde a mensagem terminar de enviar");
        return;
      }

      const convId = conversation.id;
      const userId = user.id;
      let snapshot: MessageReaction[] = [];

      // Functional updater — captures the freshest reactions list, never a
      // stale closure. Snapshot stored for rollback on POST failure.
      setReactions((prev) => {
        snapshot = prev;
        const own = prev.find(
          (r) =>
            r.message_id === messageId &&
            r.actor_type === "agent" &&
            r.actor_id === userId,
        );
        if (emoji === "") return own ? prev.filter((r) => r !== own) : prev;
        if (own) return prev.map((r) => (r === own ? { ...own, emoji } : r));
        return [
          ...prev,
          {
            id: `temp-${Date.now()}`,
            message_id: messageId,
            conversation_id: convId,
            actor_type: "agent",
            actor_id: userId,
            emoji,
            created_at: new Date().toISOString(),
          },
        ];
      });

      try {
        const res = await fetch("/api/whatsapp/react", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message_id: messageId, emoji }),
        });
        if (!res.ok) {
          const payload = await res.json().catch(() => ({}));
          throw new Error(payload?.error || `HTTP ${res.status}`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : "erro de rede";
        toast.error(`Falha na reação: ${reason}`);
        setReactions(snapshot);
      }
    },
    [conversation, user?.id],
  );

  // Sectors (departments) — set which team sees this conversation.
  const [sectors, setSectors] = useState<
    { id: string; name: string; color: string }[]
  >([]);
  useEffect(() => {
    listSectors()
      .then(setSectors)
      .catch(() => setSectors([]));
  }, []);
  const [sectorId, setSectorId] = useState<string | null>(null);
  useEffect(() => {
    setSectorId(conversation?.sector_id ?? null);
  }, [conversation?.id, conversation?.sector_id]);

  const handleSectorChange = useCallback(
    async (nextSectorId: string | null) => {
      if (!conversation) return;
      const prev = sectorId;
      setSectorId(nextSectorId);
      try {
        await updateConversationSector(conversation.id, nextSectorId);
        toast.success(
          nextSectorId
            ? "Setor atualizado."
            : "Conversa movida para a fila geral.",
        );
      } catch {
        setSectorId(prev);
        toast.error("Falha ao atualizar o setor");
      }
    },
    [conversation, sectorId],
  );

  // Transfer flow: pick a target sector → optional handoff note → move +
  // auto-assign to the least-loaded agent of that sector.
  const [transferSector, setTransferSector] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [transferNote, setTransferNote] = useState("");
  const [transferring, setTransferring] = useState(false);

  const handleTransfer = useCallback(async () => {
    if (!conversation || !transferSector) return;
    setTransferring(true);
    try {
      await transferConversation(
        conversation.id,
        transferSector.id,
        transferNote,
      );
      setSectorId(transferSector.id);
      toast.success(`Transferida para ${transferSector.name}.`);
      setTransferSector(null);
      setTransferNote("");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Não foi possível transferir.",
      );
    } finally {
      setTransferring(false);
    }
  }, [conversation, transferSector, transferNote]);

  // Handoff-note banner (shown to the receiving agent). Dismiss clears it.
  const [noteDismissed, setNoteDismissed] = useState(false);
  useEffect(() => {
    setNoteDismissed(false);
  }, [conversation?.id]);

  const handleAssignChange = useCallback(
    async (agentId: string | null) => {
      if (!conversation) return;

      try {
        await updateConversationAssignment(conversation.id, agentId);
      } catch (err) {
        console.error("Failed to update assignment:", err);
        toast.error("Falha ao atualizar a atribuição");
        return;
      }

      onAssignChange(conversation.id, agentId);
    },
    [conversation, onAssignChange],
  );

  const handleDeleteConversation = useCallback(async () => {
    if (!conversation || deleteBusy) return;
    setDeleteBusy(true);
    try {
      await deleteConversation(conversation.id);
      toast.success("Conversa excluída");
      setDeleteOpen(false);
      onConversationDeleted?.(conversation.id);
    } catch (err) {
      console.error("Failed to delete conversation:", err);
      toast.error("Não foi possível excluir a conversa");
    } finally {
      setDeleteBusy(false);
    }
  }, [conversation, deleteBusy, onConversationDeleted]);

  const handleEditMessage = useCallback(async () => {
    if (!editingMsg || editBusy) return;
    const trimmed = editText.trim();
    if (!trimmed || trimmed === editingMsg.content_text) {
      setEditingMsg(null);
      return;
    }
    setEditBusy(true);
    try {
      const res = await fetch(`/api/messages/${editingMsg.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content_text: trimmed }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
      };
      if (!res.ok) {
        toast.error(payload.error || "Não foi possível editar a mensagem");
        return;
      }
      onUpdateMessage(editingMsg.id, { content_text: trimmed });
      toast.success("Mensagem editada");
      setEditingMsg(null);
    } catch (err) {
      console.error("Failed to edit message:", err);
      toast.error("Não foi possível editar a mensagem");
    } finally {
      setEditBusy(false);
    }
  }, [editingMsg, editText, editBusy, onUpdateMessage]);

  // Empty state — same WhatsApp-style doodle background as the active
  // thread below, so swapping between empty/selected doesn't change the
  // pattern under the user's eye.
  if (!conversation || !contact) {
    return (
      <div className={cn("flex flex-1 flex-col items-center justify-center", DOODLE_BG_CLASSES)}>
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
          <MessageSquare className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="mt-4 text-sm font-medium text-muted-foreground">
          Selecione uma conversa
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Escolha uma conversa à esquerda para começar a conversar
        </p>
      </div>
    );
  }

  const displayName = contact.name || contact.phone;
  const messageGroups = groupMessagesByDate(messages);
  const currentStatus = STATUS_OPTIONS.find(
    (s) => s.value === conversation.status
  );
  const assignedAgentId = conversation.assigned_agent_id ?? null;
  const currentAssignee = profiles.find((p) => p.user_id === assignedAgentId);
  const assignLabel = assignedAgentId
    ? (currentAssignee?.full_name ?? "Atribuída")
    : "Atribuir";
  // Reply lock (mirrors the server-side check in /api/whatsapp/send): a
  // sector teammate who ISN'T the assignee can still see this conversation
  // (shared sector queue) but must not be able to reply to it. Supervisor+
  // always can. Composer-level only — the server is the real enforcement.
  const lockedByOtherAgentName =
    assignedAgentId &&
    assignedAgentId !== user?.id &&
    !hasMinRole(accountRole ?? "viewer", "supervisor")
      ? (currentAssignee?.full_name ?? "outro atendente")
      : null;

  return (
    // `min-w-0` is load-bearing: the page already puts min-w-0 on the
    // thread's flex *wrapper* (issue #165), but this root keeps the
    // default `min-width: auto`, so a single wide message (long unbroken
    // URL/word) expands the whole thread past its flex share and the chat
    // paints on top of the contact sidebar at lg+ — outgoing bubbles get
    // clipped and the hover toolbar overlaps the Tags panel. Letting the
    // root shrink lets the bubbles' break-words / max-w caps apply.
    // Issue #257.
    <div
      className={cn("relative flex min-w-0 flex-1 flex-col", DOODLE_BG_CLASSES)}
      onDragEnter={onThreadDragEnter}
      onDragOver={onThreadDragOver}
      onDragLeave={onThreadDragLeave}
      onDrop={onThreadDrop}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-primary bg-primary/10 backdrop-blur-sm">
          <UploadCloud className="h-10 w-10 text-primary" />
          <p className="text-base font-medium text-primary">
            Solte para enviar na conversa
          </p>
          <p className="text-xs text-primary/80">
            Imagem, vídeo, áudio ou documento
          </p>
        </div>
      )}
      {/* Header — solid card surface sits on top of the doodle so the
          name/avatar/dropdowns stay legible. */}
      <div className="flex items-center justify-between gap-2 border-b border-border bg-card px-3 py-3 sm:px-4">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          {/* Back-to-list button — mobile only. Hidden on lg+ where the
              conversation list is always visible next to the thread. */}
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              aria-label="Voltar às conversas"
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            >
              <ArrowLeft className="h-5 w-5" />
            </button>
          )}
          <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-sm font-medium text-foreground">
            <ContactAvatar
              avatarUrl={contact.avatar_url}
              displayName={displayName}
              className="h-9 w-9"
            />
          </div>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{displayName}</h2>
            <p className="truncate text-xs text-muted-foreground">{contact.phone}</p>
          </div>
          {/* Channel badge — which channel this thread is on (Phase 4).
              Only shown when the conversation carries a channel (legacy
              NULL-channel rows omit it). */}
          {conversation.channel && (
            <Badge
              variant="secondary"
              className="ml-1 hidden gap-1 text-[10px] sm:inline-flex sm:ml-2"
              title={`Canal: ${conversation.channel.name} (${CHANNEL_PROVIDER_LABELS[conversation.channel.provider]})`}
            >
              <Radio className="h-3 w-3" />
              <span className="max-w-28 truncate">
                {conversation.channel.name ||
                  CHANNEL_PROVIDER_LABELS[conversation.channel.provider]}
              </span>
            </Badge>
          )}

          {/* Session timer badge — hidden on the narrowest phones so
              the name + back arrow keep their room. Only meaningful on
              Meta, where the 24h window exists. */}
          {(conversation.channel?.provider ?? "meta") === "meta" && (
            <Badge
              variant="outline"
              className={cn(
                "ml-1 hidden gap-1 border-border text-[10px] sm:inline-flex sm:ml-2",
                sessionInfo.expired ? "text-red-400" : "text-primary"
              )}
            >
              <Clock className="h-3 w-3" />
              {sessionInfo.remaining}
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-2">
          {/* Privar conversa — só o responsável ou supervisor+. Privada = só
              o atribuído, supervisor/admin e participantes veem. */}
          {canTogglePrivacy && (
            <button
              type="button"
              onClick={handleTogglePrivacy}
              aria-label={isPrivate ? "Tornar conversa pública" : "Privar conversa"}
              title={
                isPrivate
                  ? "Conversa privada — só você, supervisão e mencionados veem. Clique para liberar."
                  : "Privar conversa (só você, supervisão e mencionados)"
              }
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors",
                isPrivate
                  ? "text-amber-500 hover:bg-amber-500/10"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {isPrivate ? (
                <Lock className="h-4 w-4" />
              ) : (
                <LockOpen className="h-4 w-4" />
              )}
            </button>
          )}
          {/* Ligar (voz WhatsApp) — só no canal Meta (Business Calling API),
              e só com telefone. Abre o modal de chamada em modo outbound.
              Visível pra todos; o master "Tocar ligações no CRM" (Configurações
              → Notificações, admin/supervisor) é quem liga/desliga a voz. */}
          {(conversation.channel?.provider ?? "meta") === "meta" &&
            contact.phone && (
              <button
                type="button"
                onClick={() =>
                  startOutboundCall(contact.phone, contact.name ?? undefined)
                }
                aria-label="Ligar para o cliente"
                title="Ligar (voz WhatsApp)"
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-emerald-600 transition-colors hover:bg-emerald-500/10"
              >
                <PhoneCall className="h-4 w-4" />
              </button>
            )}
          {/* Ligar via waha-voip (não-oficial) — canal WAHA com telefone.
              Usa o motor de voz waha-voip; não exige permissão do cliente. */}
          {conversation.channel?.provider === "waha" && contact.phone && (
            <button
              type="button"
              onClick={() =>
                startOutboundCall(
                  contact.phone,
                  contact.name ?? undefined,
                  "waha",
                  conversation.id,
                  conversation.channel?.id,
                )
              }
              aria-label="Ligar para o cliente pelo WhatsApp"
              title="Ligar pelo WhatsApp"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-emerald-600 transition-colors hover:bg-emerald-500/10"
            >
              <PhoneCall className="h-4 w-4" />
            </button>
          )}
          {/* Contact-panel toggle — desktop only. The contact sidebar
              eats a chunk of horizontal width that crowds the thread on
              smaller laptops; this lets agents reclaim it when they just
              want to read and reply. Hidden on mobile, where the sidebar
              never renders as a permanent panel anyway. Issue #258. */}
          {onToggleContactPanel && (
            <button
              type="button"
              onClick={onToggleContactPanel}
              aria-label={
                contactPanelOpen ? "Ocultar painel de contato" : "Mostrar painel de contato"
              }
              aria-pressed={contactPanelOpen}
              title={contactPanelOpen ? "Ocultar contato" : "Mostrar contato"}
              className={cn(
                "hidden h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground lg:inline-flex",
                contactPanelOpen ? "text-primary" : "text-muted-foreground",
              )}
            >
              {contactPanelOpen ? (
                <PanelRightClose className="h-4 w-4" />
              ) : (
                <PanelRightOpen className="h-4 w-4" />
              )}
            </button>
          )}

          {/* Delete conversation — opens a confirm dialog, then removes the
              conversation (messages cascade-delete). Only rendered when the
              parent wires up `onConversationDeleted`. */}
          {onConversationDeleted && canDeleteConversation && (
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              aria-label="Excluir conversa"
              title="Excluir conversa"
              className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}

          {/* Manual refresh — forces a refetch of the messages + the
              conversation list (the parent bumps its resyncToken). Useful
              when realtime missed an event or the agent just wants to be
              sure nothing's stale. Only rendered when the parent wires
              up `onRefresh`. */}
          {onRefresh && (
            <button
              type="button"
              onClick={handleRefreshClick}
              disabled={isRefreshing}
              aria-label="Atualizar conversa"
              title="Atualizar"
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-60",
              )}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", isRefreshing && "animate-spin")}
              />
            </button>
          )}

          {/* Status dropdown */}
          <DropdownMenu>
            <DropdownMenuTrigger className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  currentStatus?.color ?? "text-muted-foreground"
                )}>
                {currentStatus?.label ?? "Status"}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              {STATUS_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => handleStatusChange(opt.value)}
                  className={cn("text-sm", opt.color)}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Assign dropdown — admin/owner only (agents can't take over) */}
          {canAssign && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                assignedAgentId ? "text-primary" : "text-muted-foreground"
              )}
            >
              <UserPlus className="h-3 w-3" />
              <span className="hidden sm:inline">{assignLabel}</span>
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              className="border-border bg-popover"
            >
              {profiles.length === 0 ? (
                <DropdownMenuItem disabled className="text-sm text-muted-foreground">
                  Nenhum colega disponível
                </DropdownMenuItem>
              ) : (
                profiles.map((p) => {
                  const isSelected = p.user_id === assignedAgentId;
                  const presence = getPresence(p.user_id);
                  return (
                    <DropdownMenuItem
                      key={p.id}
                      onClick={() => handleAssignChange(p.user_id)}
                      className={cn(
                        "text-sm",
                        isSelected ? "text-primary" : "text-popover-foreground"
                      )}
                    >
                      <PresenceDot
                        status={presence}
                        label={presenceLabel(
                          presence,
                          getRow(p.user_id)?.last_seen_at ?? null,
                          now
                        )}
                        className="mr-2"
                      />
                      <span className="flex-1">
                        {p.full_name}
                        {p.user_id === user?.id ? " (você)" : ""}
                      </span>
                      {isSelected && <Check className="ml-2 h-3 w-3" />}
                    </DropdownMenuItem>
                  );
                })
              )}
              {assignedAgentId && (
                <>
                  <DropdownMenuSeparator className="bg-border" />
                  <DropdownMenuItem
                    onClick={() => handleAssignChange(null)}
                    className="text-sm text-muted-foreground"
                  >
                    Remover atribuição
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          )}

          {/* Sector dropdown — routes/privacy */}
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                sectorId ? "text-primary" : "text-muted-foreground",
              )}
            >
              <Building2 className="h-3 w-3" />
              <span className="hidden sm:inline">
                {sectors.find((s) => s.id === sectorId)?.name ?? "Setor"}
              </span>
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="border-border bg-popover">
              {sectors.length === 0 ? (
                <DropdownMenuItem disabled className="text-sm text-muted-foreground">
                  Nenhum setor criado
                </DropdownMenuItem>
              ) : (
                sectors.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onClick={() =>
                      s.id === sectorId
                        ? undefined
                        : setTransferSector({ id: s.id, name: s.name })
                    }
                    className="text-sm text-popover-foreground"
                  >
                    <span
                      className="mr-2 h-2.5 w-2.5 rounded-full"
                      style={{ backgroundColor: s.color }}
                    />
                    {s.name}
                    {s.id === sectorId && <Check className="ml-2 h-3 w-3" />}
                  </DropdownMenuItem>
                ))
              )}
              {sectorId && (
                <>
                  <DropdownMenuSeparator className="bg-border" />
                  <DropdownMenuItem
                    onClick={() => handleSectorChange(null)}
                    className="text-sm text-muted-foreground"
                  >
                    Fila geral (sem setor)
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Handoff-note banner — context left by whoever transferred this here. */}
      {conversation.transfer_note && !noteDismissed && (
        <div className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2">
          <ArrowRightLeft className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-foreground">
              Transferência
              {conversation.transfer_note_by_name
                ? ` de ${conversation.transfer_note_by_name}`
                : ""}
            </p>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-foreground/90">
              {conversation.transfer_note}
            </p>
          </div>
          <button
            type="button"
            onClick={async () => {
              setNoteDismissed(true);
              try {
                await dismissTransferNote(conversation.id);
              } catch {
                /* best-effort — the banner is already hidden locally */
              }
            }}
            title="Marcar como lido"
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Transfer dialog — target sector + optional handoff note. */}
      <Dialog
        open={!!transferSector}
        onOpenChange={(o) => {
          if (!o) {
            setTransferSector(null);
            setTransferNote("");
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Transferir para {transferSector?.name}</DialogTitle>
            <DialogDescription>
              A conversa vai pro setor e cai no atendente disponível (menor
              carga). Deixe uma nota do que o cliente precisa — o próximo vê no
              topo da conversa.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={transferNote}
            onChange={(e) => setTransferNote(e.target.value)}
            placeholder="Ex.: cliente quer 2ª via do boleto do mês passado. (opcional)"
            rows={3}
            autoFocus
            className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => {
                setTransferSector(null);
                setTransferNote("");
              }}
              disabled={transferring}
            >
              Cancelar
            </Button>
            <Button onClick={handleTransfer} disabled={transferring}>
              {transferring && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Transferir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Messages Area */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12">
            <p className="text-sm text-muted-foreground">Nenhuma mensagem ainda</p>
            <p className="text-xs text-muted-foreground">
              Envie um template para iniciar a conversa
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {messageGroups.map((group) => (
              <div key={group.date}>
                {/* Date separator */}
                <div className="mb-4 flex items-center justify-center">
                  <span className="rounded-full bg-muted px-3 py-1 text-[10px] font-medium text-muted-foreground">
                    {formatDateSeparator(group.date)}
                  </span>
                </div>
                {/* Messages */}
                <div className="space-y-2">
                  {group.messages.map((msg) => {
                    const parent = msg.reply_to_message_id
                      ? messagesById.get(msg.reply_to_message_id)
                      : null;
                    const reply = parent
                      ? {
                          authorLabel: authorLabelFor(parent),
                          preview: buildReplyPreview(parent),
                        }
                      : null;
                    const msgReactions = reactionsByMessageId.get(msg.id);
                    // Toggle is computed at the call site — `msgReactions`
                    // and `user?.id` are already in scope, no extra hook.
                    const handlePillToggle = (emoji: string) => {
                      const own = msgReactions?.find(
                        (r) =>
                          r.actor_type === "agent" &&
                          r.actor_id === user?.id,
                      );
                      const next = own?.emoji === emoji ? "" : emoji;
                      void postReaction(msg.id, next);
                    };
                    return (
                      <MessageActions
                        key={msg.id}
                        message={msg}
                        onReply={() => handleStartReply(msg)}
                        onReact={(emoji) => {
                          if (emoji) void postReaction(msg.id, emoji);
                        }}
                        onForward={() => setForwarding(msg)}
                        onEdit={
                          isMessageEditable(msg, now)
                            ? () => {
                                setEditingMsg(msg);
                                setEditText(msg.content_text ?? "");
                              }
                            : undefined
                        }
                        isGroup={contact.is_group ?? false}
                      >
                        <MessageBubble
                          message={msg}
                          reply={reply}
                          reactions={msgReactions}
                          currentUserId={user?.id}
                          onToggleReaction={handlePillToggle}
                          contactPhone={
                            (conversation.channel?.provider ?? "meta") === "meta"
                              ? contact.phone
                              : null
                          }
                          contactName={contact.name}
                          mentionMembers={mentionMembers}
                          isGroup={contact.is_group ?? false}
                          channelId={conversation.channel?.id}
                          onQuickReply={(text) => void handleSend(text)}
                        />
                      </MessageActions>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Composer */}
      <MessageComposer
        conversationId={conversation.id}
        sessionExpired={sessionInfo.expired}
        onSend={handleSend}
        onSendMedia={handleSendMedia}
        onOpenTemplates={handleOpenTemplates}
        replyTo={replyTo}
        onClearReply={() => setReplyTo(null)}
        provider={conversation.channel?.provider}
        mentionMembers={mentionMembers}
        groupMentions={groupMentions}
        droppedFile={droppedFile}
        onDroppedFileConsumed={() => setDroppedFile(null)}
        lockedByOtherAgent={lockedByOtherAgentName}
      />

      <TemplatePicker
        open={templateModalOpen}
        onOpenChange={setTemplateModalOpen}
        onSelect={handleSendTemplate}
      />

      {forwarding && (
        <ForwardDialog
          message={forwarding}
          sourceChannelId={conversation.channel?.id}
          onClose={() => setForwarding(null)}
        />
      )}

      {/* Delete-conversation confirmation. */}
      <Dialog
        open={deleteOpen}
        onOpenChange={(next) => {
          if (!next && !deleteBusy) setDeleteOpen(false);
        }}
      >
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">
              Excluir conversa
            </DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Excluir esta conversa? As mensagens serão removidas. Esta ação
              não pode ser desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="border-border bg-popover">
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={deleteBusy}
              className="border-border text-muted-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConversation}
              disabled={deleteBusy}
            >
              {deleteBusy ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Excluindo...
                </>
              ) : (
                <>
                  <Trash2 className="size-4" />
                  Excluir
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit-message dialog — edits the real WhatsApp message (via PATCH
          /api/messages/[id]) and, on success, the local copy. */}
      <Dialog
        open={!!editingMsg}
        onOpenChange={(open) => {
          if (!open && !editBusy) setEditingMsg(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Editar mensagem</DialogTitle>
            <DialogDescription>
              A edição vale por até 15 min após o envio, como no WhatsApp.
            </DialogDescription>
          </DialogHeader>
          <textarea
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void handleEditMessage();
              }
            }}
            rows={4}
            autoFocus
            className="w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            placeholder="Digite o novo texto..."
          />
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setEditingMsg(null)}
              disabled={editBusy}
            >
              Cancelar
            </Button>
            <Button onClick={handleEditMessage} disabled={editBusy}>
              {editBusy ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Salvando...
                </>
              ) : (
                "Salvar"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

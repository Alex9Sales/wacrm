"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { listConversations, listTags } from "@/app/(dashboard)/inbox/actions";
import { matchesContactFilters } from "@/lib/inbox/conversations";
import { formatConversationPreview } from "@/lib/inbox/preview";
import { cn } from "@/lib/utils";
import type {
  Conversation,
  ConversationChannel,
  ConversationStatus,
  Tag,
} from "@/types";
import { Search, ChevronDown, X, Radio, Inbox, Users, MessageSquarePlus } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { CHANNEL_PROVIDER_LABELS } from "./message-thread";
import { ContactAvatar } from "./contact-avatar";
import { NewConversationDialog } from "./new-conversation-dialog";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};

type InboxFilter = ConversationStatus | "all" | "unread";

const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = [
  { label: "Todas", value: "all" },
  { label: "Não lidas", value: "unread" },
  { label: "Aberta", value: "open" },
  { label: "Pendente", value: "pending" },
  { label: "Fechada", value: "closed" },
];

// Group segmentation (Grupos Fase 1, etapa E). A monitored group is a
// "contact" with is_group=true; this splits the list so group chatter doesn't
// drown out real clients. Only surfaced when the account actually has groups.
type SegmentFilter = "all" | "clients" | "groups";

const SEGMENT_OPTIONS: { label: string; value: SegmentFilter }[] = [
  { label: "Todos", value: "all" },
  { label: "Clientes", value: "clients" },
  { label: "Grupos", value: "groups" },
];

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [newConvOpen, setNewConvOpen] = useState(false);
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [segment, setSegment] = useState<SegmentFilter>("all");
  const [loading, setLoading] = useState(true);
  // Channel ("caixa") filter — null means "Todas as conversas" (all
  // channels). Seeded from the `?caixa=<channelId>` URL query so the
  // selection survives a refresh / deep link. The list already carries
  // each conversation's `channel.id`, so filtering is a client-side pass
  // over the loaded conversations — instant, no refetch.
  const [selectedChannelId, setSelectedChannelId] = useState<string | null>(
    () => searchParams.get("caixa"),
  );
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const data = await listConversations();
        if (cancelled) return;
        onConversationsLoadedRef.current(data);
      } catch (error) {
        if (cancelled) return;
        console.error("Failed to fetch conversations:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await listTags();
        if (!cancelled) setTags(data);
      } catch (error) {
        if (!cancelled) console.error("Failed to fetch tags:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  // Channel ("caixa") options are derived from the loaded conversations —
  // each conversation already carries its `channel` ({ id, provider,
  // name }), so the set of channels with a live conversation is exactly
  // what's worth offering as an inbox filter. Deduped by id, sorted by
  // name. Legacy conversations with no channel_id (channel === undefined)
  // contribute nothing here.
  const channels = useMemo(() => {
    const map = new Map<string, ConversationChannel>();
    for (const c of conversations) {
      if (c.channel?.id && !map.has(c.channel.id)) {
        map.set(c.channel.id, c.channel);
      }
    }
    return Array.from(map.values()).sort((a, b) =>
      (a.name || CHANNEL_PROVIDER_LABELS[a.provider]).localeCompare(
        b.name || CHANNEL_PROVIDER_LABELS[b.provider],
      ),
    );
  }, [conversations]);

  const selectedChannel = useMemo(
    () => channels.find((c) => c.id === selectedChannelId) ?? null,
    [channels, selectedChannelId],
  );

  // Update the channel filter and mirror it into the URL (`?caixa=<id>`,
  // or drop the param for "Todas as conversas") so a refresh lands on the
  // same caixa. Preserve the existing `?c=<convId>` deep-link param.
  // replace() (not push) keeps browser history clean, matching how the
  // page selects conversations.
  const handleSelectChannel = useCallback(
    (channelId: string | null) => {
      setSelectedChannelId(channelId);
      const params = new URLSearchParams(searchParams.toString());
      if (channelId) params.set("caixa", channelId);
      else params.delete("caixa");
      const qs = params.toString();
      router.replace(qs ? `/inbox?${qs}` : "/inbox", { scroll: false });
    },
    [router, searchParams],
  );

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    // Channel ("caixa") filter — applied alongside status & contact
    // filters. Null = all channels.
    if (selectedChannelId !== null) {
      result = result.filter((c) => c.channel?.id === selectedChannelId);
    }

    // Group segmentation: clients = 1:1 only, groups = monitored groups only.
    if (segment === "groups") {
      result = result.filter((c) => c.contact?.is_group === true);
    } else if (segment === "clients") {
      result = result.filter((c) => !c.contact?.is_group);
    }

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [
    conversations,
    filter,
    segment,
    search,
    selectedTagIds,
    selectedCompany,
    selectedChannelId,
  ]);

  // Only offer the Clientes/Grupos segmentation when the account actually has
  // a monitored group in the list — keeps the toolbar clean otherwise.
  const hasGroups = useMemo(
    () => conversations.some((c) => c.contact?.is_group === true),
    [conversations],
  );
  const activeSegment = SEGMENT_OPTIONS.find((o) => o.value === segment);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters = selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="flex h-full w-full flex-col border-r border-border bg-card lg:w-80">
      {/* Search + Filter */}
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={handleSearchChange}
              placeholder="Buscar conversas..."
              className="border-border bg-muted pl-9 text-sm text-foreground placeholder-muted-foreground focus:border-primary/50"
            />
          </div>
          <button
            type="button"
            onClick={() => setNewConvOpen(true)}
            title="Nova conversa"
            aria-label="Nova conversa"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground transition hover:bg-primary/90"
          >
            <MessageSquarePlus className="h-4 w-4" />
          </button>
        </div>

        {/* Caixa de entrada (channel) selector — Chatwoot-style. Filters
            the list to a single channel's conversations, or shows all.
            Only rendered when the account actually has channels with
            conversations. */}
        {channels.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger
              className={cn(
                "inline-flex w-full items-center justify-between gap-1 rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs hover:bg-muted/70",
                selectedChannel ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <Inbox className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {selectedChannel
                    ? `${selectedChannel.name || CHANNEL_PROVIDER_LABELS[selectedChannel.provider]} (${CHANNEL_PROVIDER_LABELS[selectedChannel.provider]})`
                    : "Todas as conversas"}
                </span>
              </span>
              <ChevronDown className="h-3 w-3 shrink-0" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="max-h-72 w-64 border-border bg-popover"
            >
              <DropdownMenuItem
                onClick={() => handleSelectChannel(null)}
                className={cn(
                  "text-sm",
                  selectedChannelId === null
                    ? "text-primary"
                    : "text-popover-foreground",
                )}
              >
                Todas as conversas
              </DropdownMenuItem>
              {channels.map((ch) => (
                <DropdownMenuItem
                  key={ch.id}
                  onClick={() => handleSelectChannel(ch.id)}
                  className={cn(
                    "text-sm",
                    selectedChannelId === ch.id
                      ? "text-primary"
                      : "text-popover-foreground",
                  )}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Radio className="h-3 w-3 shrink-0" />
                    <span className="truncate">
                      {ch.name || CHANNEL_PROVIDER_LABELS[ch.provider]}
                    </span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {CHANNEL_PROVIDER_LABELS[ch.provider]}
                    </span>
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="inline-flex items-center justify-center h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground rounded-md hover:bg-muted">
                {activeFilter?.label ?? "Todas"}
                <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {hasGroups && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  segment !== "all"
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Users className="h-3 w-3" />
                {activeSegment?.label ?? "Todos"}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover"
              >
                {SEGMENT_OPTIONS.map((opt) => (
                  <DropdownMenuItem
                    key={opt.value}
                    onClick={() => setSegment(opt.value)}
                    className={cn(
                      "text-sm",
                      segment === opt.value
                        ? "text-primary"
                        : "text-popover-foreground",
                    )}
                  >
                    {opt.label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                Tags
                {selectedTagIds.length > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-sm text-popover-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex max-w-40 items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                <span className="truncate">{selectedCompany ?? "Empresa"}</span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-64 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground"
                  )}
                >
                  Todas as empresas
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground"
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tag?.color ?? "var(--muted-foreground)" }}
                  />
                  <span className="max-w-24 truncate">{tag?.name ?? "Etiqueta"}</span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-foreground hover:bg-muted/70"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="px-1 text-[11px] text-muted-foreground hover:text-foreground"
            >
              Limpar tudo
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-sm text-muted-foreground">Nenhuma conversa encontrada</p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      <NewConversationDialog
        open={newConvOpen}
        onOpenChange={setNewConvOpen}
        onStarted={(conversationId) => {
          // Deep-link to the (possibly brand-new) thread; the inbox's ?c=
          // handler hydrates + opens it even before the list refetches.
          router.push(`/inbox?c=${conversationId}`);
        }}
      />
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || "Desconhecido";

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  return (
    <button
      onClick={handleClick}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        isActive && "border-l-2 border-primary bg-muted/70"
      )}
    >
      {/* Avatar */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-sm font-medium text-foreground">
        <ContactAvatar
          avatarUrl={contact?.avatar_url}
          displayName={displayName}
          className="h-10 w-10"
        />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <span className="shrink-0 text-[10px] text-muted-foreground">{timeAgo}</span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="truncate text-xs text-muted-foreground">
            {formatConversationPreview(conversation.last_message_text)}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {contact?.is_group && (
              <span
                className="inline-flex items-center rounded-full bg-muted px-1 py-0.5 text-muted-foreground"
                title="Grupo monitorado"
              >
                <Users className="h-2.5 w-2.5" />
              </span>
            )}
            {conversation.channel && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground"
                title={`Canal: ${conversation.channel.name} (${CHANNEL_PROVIDER_LABELS[conversation.channel.provider]})`}
              >
                <Radio className="h-2.5 w-2.5" />
                <span className="max-w-16 truncate">
                  {conversation.channel.name ||
                    CHANNEL_PROVIDER_LABELS[conversation.channel.provider]}
                </span>
              </span>
            )}
            {conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
      </div>
    </button>
  );
}

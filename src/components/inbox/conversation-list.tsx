"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { listConversations, listTags, listSectors, listProfiles } from "@/app/(dashboard)/inbox/actions";
import { useAuth } from "@/hooks/use-auth";
import { matchesContactFilters } from "@/lib/inbox/conversations";
import { formatConversationPreview } from "@/lib/inbox/preview";
import { cn } from "@/lib/utils";
import type {
  Conversation,
  ConversationChannel,
  ConversationStatus,
  Tag,
} from "@/types";
import { Search, ChevronDown, X, Radio, Inbox, Users, MessageSquarePlus, UserCheck, Layers } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { CHANNEL_PROVIDER_LABELS, ChannelBadge } from "./channel-badge";
import { ContactAvatar } from "./contact-avatar";
import { NewConversationDialog } from "./new-conversation-dialog";
import { ConversationContextMenu } from "./conversation-context-menu";
import { priorityMeta } from "@/lib/inbox/priority";
import type { ConversationPriority } from "@/types";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

/** Tamanho da página da inbox (paginação — perf). 1ª página + "carregar mais". */
const CONVERSATIONS_PAGE_SIZE = 200;

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  /** Called with the new conversation id after "Nova conversa" starts one, so
   *  the parent can hydrate + open it immediately (no manual refresh). */
  onConversationStarted?: (conversationId: string) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /** "Carregar mais" — anexa a próxima página de conversas (mais antigas) ao
   *  estado do pai, deduplicando por id. */
  onConversationsAppended?: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
  /** Right-click menu actions — mirror the page-level handlers so the list
   *  reflects priority/status/tag/delete changes without a refetch. */
  onStatusChange?: (id: string, status: ConversationStatus) => void;
  onPriorityChange?: (id: string, priority: ConversationPriority) => void;
  onConversationDeleted?: (id: string) => void;
  onContactTagsChange?: (contactId: string, tags: Tag[]) => void;
  onMarkedUnread?: (id: string) => void;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};

// Status filter chips. MULTI-SELECT (Felipe/Alex): marcar quantos quiser e
// ver todos juntos (ex.: não lidas + abertas). Conjunto vazio = todas.
type StatusChip = "unread" | ConversationStatus;

const CHIP_OPTIONS: { label: string; value: StatusChip }[] = [
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
  onConversationStarted,
  conversations,
  onConversationsLoaded,
  onConversationsAppended,
  resyncToken = 0,
  onStatusChange,
  onPriorityChange,
  onConversationDeleted,
  onContactTagsChange,
  onMarkedUnread,
}: ConversationListProps) {
  const router = useRouter();
  // Right-click quick-actions menu: which conversation + cursor position.
  const [ctxMenu, setCtxMenu] = useState<{
    conversation: Conversation;
    x: number;
    y: number;
  } | null>(null);
  const searchParams = useSearchParams();
  const [search, setSearch] = useState("");
  const [newConvOpen, setNewConvOpen] = useState(false);
  // Paginação (perf): a inbox carrega a 1ª página (CONVERSATIONS_PAGE_SIZE) e
  // vai anexando com "carregar mais". `hasMore` = a última página veio cheia.
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Busca no SERVIDOR: quando há texto, `searchResults` substitui a lista
  // paginada (acha conversas antigas fora das páginas carregadas). null = sem
  // busca ativa.
  const [searchResults, setSearchResults] = useState<Conversation[] | null>(null);
  const [searching, setSearching] = useState(false);
  // Empty set = todas. Otherwise a conversation shows if it matches ANY chip.
  const [statusFilters, setStatusFilters] = useState<Set<StatusChip>>(
    () => new Set(),
  );
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
  // "Atribuídas a mim" toggle + sector filter (only shown when sectors exist).
  const { user } = useAuth();
  const [assignedToMe, setAssignedToMe] = useState(false);
  const [sectors, setSectors] = useState<{ id: string; name: string; color: string }[]>([]);
  const [selectedSectorId, setSelectedSectorId] = useState<string | null>(null);
  // Assigned-agent names for the per-card badge (user_id → name).
  const [agentNameById, setAgentNameById] = useState<Map<string, string>>(new Map());

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
        // Só a 1ª página (mais recentes). O resto vem por "carregar mais" e a
        // busca vai no servidor — antes puxava TODAS (~2000) a cada abertura.
        const data = await listConversations({ limit: CONVERSATIONS_PAGE_SIZE });
        if (cancelled) return;
        onConversationsLoadedRef.current(data);
        setHasMore(data.length === CONVERSATIONS_PAGE_SIZE);
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

  // Busca no SERVIDOR (com debounce). Sem texto → limpa (mostra a paginada).
  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await listConversations({ search: q, limit: 50 });
        if (!cancelled) setSearchResults(res);
      } catch {
        if (!cancelled) setSearchResults([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search]);

  // "Carregar mais": busca a próxima página (conversas mais antigas que a mais
  // antiga já carregada) e anexa no estado do pai (dedup por id).
  const loadMore = useCallback(async () => {
    if (loadingMore) return;
    // Cursor = menor last_message_at carregado (a lista é DESC; nulls ficam no
    // topo e já vieram na 1ª página).
    let cursor: string | null = null;
    for (const c of conversations) {
      const t = c.last_message_at;
      if (t && (cursor === null || t < cursor)) cursor = t;
    }
    if (!cursor) {
      setHasMore(false);
      return;
    }
    setLoadingMore(true);
    try {
      const more = await listConversations({
        limit: CONVERSATIONS_PAGE_SIZE,
        beforeLastMessageAt: cursor,
      });
      onConversationsAppended?.(more);
      setHasMore(more.length === CONVERSATIONS_PAGE_SIZE);
    } catch (error) {
      console.error("Failed to load more conversations:", error);
    } finally {
      setLoadingMore(false);
    }
  }, [conversations, loadingMore, onConversationsAppended]);

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

  // Sector definitions for the sector filter — only surfaced when the account
  // actually has sectors (otherwise everything is the general queue).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await listSectors();
        if (!cancelled) setSectors(data);
      } catch (error) {
        if (!cancelled) console.error("Failed to fetch sectors:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Team member names for the assigned-agent badge on each card.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const profiles = await listProfiles();
        if (cancelled) return;
        const m = new Map<string, string>();
        for (const p of profiles) {
          if (p.user_id && p.full_name) m.set(p.user_id, p.full_name);
        }
        setAgentNameById(m);
      } catch (error) {
        if (!cancelled) console.error("Failed to fetch profiles:", error);
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
    // Busca ativa → base = resultados do servidor (acha antigas fora das
    // páginas carregadas). Sem busca → a lista paginada do pai. Os demais
    // filtros (canal/setor/etiqueta/etc.) rodam por cima, como antes.
    let result = searchResults ?? conversations;

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

    // Multi-select status filter (OR): empty set = todas; senão a conversa
    // aparece se casar com QUALQUER chip marcado.
    if (statusFilters.size > 0) {
      result = result.filter((c) => {
        for (const f of statusFilters) {
          if (f === "unread") {
            if (c.unread_count > 0) return true;
          } else if (c.status === f) {
            return true;
          }
        }
        return false;
      });
    }

    // "Atribuídas a mim" — only conversations assigned to the current user.
    if (assignedToMe && user?.id) {
      result = result.filter((c) => c.assigned_agent_id === user.id);
    }

    // Sector filter — a specific sector, or "sem setor" (general queue).
    if (selectedSectorId === "__none__") {
      result = result.filter((c) => !c.sector_id);
    } else if (selectedSectorId !== null) {
      result = result.filter((c) => c.sector_id === selectedSectorId);
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
    searchResults,
    statusFilters,
    segment,
    search,
    selectedTagIds,
    selectedCompany,
    selectedChannelId,
    assignedToMe,
    selectedSectorId,
    user?.id,
  ]);

  // Only offer the Clientes/Grupos segmentation when the account actually has
  // a monitored group in the list — keeps the toolbar clean otherwise.
  const hasGroups = useMemo(
    () => conversations.some((c) => c.contact?.is_group === true),
    [conversations],
  );
  // "Sem setor (fila geral)" só faz sentido quando há conversa sem setor
  // (Felipe: se todo canal tem setor, não mostrar a opção vazia).
  const hasGeneralQueue = useMemo(
    () => conversations.some((c) => !c.sector_id),
    [conversations],
  );
  const activeSegment = SEGMENT_OPTIONS.find((o) => o.value === segment);
  const activeSector = sectors.find((s) => s.id === selectedSectorId) ?? null;
  const sectorLabel =
    selectedSectorId === "__none__"
      ? "Sem setor"
      : (activeSector?.name ?? "Setores");

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

  const toggleStatusFilter = useCallback((v: StatusChip) => {
    setStatusFilters((prev) => {
      const next = new Set(prev);
      if (next.has(v)) next.delete(v);
      else next.add(v);
      return next;
    });
  }, []);

  const filterLabel =
    statusFilters.size === 0
      ? "Todas"
      : statusFilters.size === 1
        ? (CHIP_OPTIONS.find((o) => statusFilters.has(o.value))?.label ??
          "Filtro")
        : `${statusFilters.size} filtros`;

  // Running tally of UNREAD conversations (Felipe) — how many threads have the
  // dot right now, across the loaded set.
  const unreadCount = conversations.reduce(
    (n, c) => n + ((c.unread_count ?? 0) > 0 ? 1 : 0),
    0,
  );

  // Reflete o total de não lidas no TÍTULO da aba do navegador — "(N) CRM
  // Fluxia", estilo WhatsApp Web (Felipe). Preserva o nome-base (tira um "(n)"
  // que já esteja lá) e some quando zera. Ao sair da inbox, o Next re-seta o
  // título pela metadata da próxima página.
  useEffect(() => {
    const base = document.title.replace(/^\(\d+\)\s*/, "") || "FluxiaCRM";
    document.title = unreadCount > 0 ? `(${unreadCount}) ${base}` : base;
  }, [unreadCount]);

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

        {/* Contador de conversas não lidas (Felipe) — soma viva das que estão
            com a bolinha; some quando zera. Clicável: filtra só as não lidas
            (mesmo chip "Não lidas" do filtro abaixo). */}
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => toggleStatusFilter("unread")}
            title={
              statusFilters.has("unread")
                ? "Mostrar todas as conversas"
                : "Ver só as não lidas"
            }
            className={cn(
              "flex items-center gap-1.5 rounded-md px-1 py-0.5 text-xs transition-colors hover:bg-muted",
              statusFilters.has("unread")
                ? "text-primary"
                : "text-muted-foreground",
            )}
          >
            <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
              {unreadCount}
            </span>
            {unreadCount === 1 ? "conversa não lida" : "conversas não lidas"}
          </button>
        )}

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
            <DropdownMenuTrigger
              className={cn(
                "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                statusFilters.size > 0
                  ? "text-primary"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {filterLabel}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {/* "Todas" limpa a seleção (nenhum chip = todas). */}
              <DropdownMenuItem
                onClick={() => setStatusFilters(new Set())}
                className={cn(
                  "text-sm",
                  statusFilters.size === 0
                    ? "text-primary"
                    : "text-popover-foreground",
                )}
              >
                Todas
              </DropdownMenuItem>
              {CHIP_OPTIONS.map((opt) => (
                <DropdownMenuCheckboxItem
                  key={opt.value}
                  checked={statusFilters.has(opt.value)}
                  onCheckedChange={() => toggleStatusFilter(opt.value)}
                  className="text-sm text-popover-foreground"
                >
                  {opt.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Atribuídas a mim — toggle rápido */}
          <button
            type="button"
            onClick={() => setAssignedToMe((v) => !v)}
            title="Mostrar só conversas atribuídas a mim"
            className={cn(
              "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
              assignedToMe
                ? "text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <UserCheck className="h-3 w-3" />
            Minhas
          </button>

          {/* Setor — só quando o workspace tem setores criados */}
          {sectors.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "inline-flex items-center justify-center h-7 gap-1 px-2 text-xs rounded-md hover:bg-muted",
                  selectedSectorId !== null
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {activeSector ? (
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: activeSector.color }}
                  />
                ) : (
                  <Layers className="h-3 w-3" />
                )}
                <span className="max-w-24 truncate">{sectorLabel}</span>
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="max-h-72 w-56 border-border bg-popover"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedSectorId(null)}
                  className={cn(
                    "text-sm",
                    selectedSectorId === null
                      ? "text-primary"
                      : "text-popover-foreground",
                  )}
                >
                  Todos os setores
                </DropdownMenuItem>
                {(hasGeneralQueue || selectedSectorId === "__none__") && (
                  <DropdownMenuItem
                    onClick={() => setSelectedSectorId("__none__")}
                    className={cn(
                      "text-sm",
                      selectedSectorId === "__none__"
                        ? "text-primary"
                        : "text-popover-foreground",
                    )}
                  >
                    Sem setor (fila geral)
                  </DropdownMenuItem>
                )}
                {sectors.map((s) => (
                  <DropdownMenuItem
                    key={s.id}
                    onClick={() => setSelectedSectorId(s.id)}
                    className={cn(
                      "flex items-center gap-2 text-sm",
                      selectedSectorId === s.id
                        ? "text-primary"
                        : "text-popover-foreground",
                    )}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: s.color }}
                    />
                    <span className="truncate">{s.name}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

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
            <p className="text-sm text-muted-foreground">
              {searching ? "Buscando..." : "Nenhuma conversa encontrada"}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                onContextMenu={(conversation, x, y) =>
                  setCtxMenu({ conversation, x, y })
                }
                agentName={
                  conv.assigned_agent_id
                    ? agentNameById.get(conv.assigned_agent_id) ?? null
                    : null
                }
              />
            ))}
            {/* "Carregar mais" — só na lista paginada (não durante a busca no
                servidor, que já traz o conjunto certo). */}
            {searchResults === null && hasMore && (
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="mx-3 my-2 rounded-md border border-border py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
              >
                {loadingMore ? "Carregando..." : "Carregar mais conversas"}
              </button>
            )}
          </div>
        )}
      </ScrollArea>

      {ctxMenu && (
        <ConversationContextMenu
          conversation={ctxMenu.conversation}
          x={ctxMenu.x}
          y={ctxMenu.y}
          tags={tags}
          onClose={() => setCtxMenu(null)}
          onStatusChange={onStatusChange}
          onPriorityChange={onPriorityChange}
          onDeleted={onConversationDeleted}
          onContactTagsChange={onContactTagsChange}
          onMarkedUnread={onMarkedUnread}
          onTagCreated={(tag) =>
            setTags((prev) =>
              prev.some((t) => t.id === tag.id) ? prev : [...prev, tag],
            )
          }
        />
      )}

      <NewConversationDialog
        open={newConvOpen}
        onOpenChange={setNewConvOpen}
        onStarted={(conversationId) => {
          // Hand off to the parent, which refetches the list + hydrates + opens
          // the (brand-new) thread immediately. Falls back to a deep-link push
          // if no handler was provided.
          if (onConversationStarted) onConversationStarted(conversationId);
          else router.push(`/inbox?c=${conversationId}`);
        }}
      />
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  /** Open the right-click quick-actions menu at the cursor. */
  onContextMenu: (conversation: Conversation, x: number, y: number) => void;
  /** Name of the assigned agent (resolved from assigned_agent_id), or null. */
  agentName?: string | null;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  onContextMenu,
  agentName,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const baseName = contact?.name || contact?.phone || "Desconhecido";
  // Código do cliente (quando houver) vai NA FRENTE do nome no card, ex.:
  // "20583 Construsul". Sem código, mostra só o nome.
  const code = contact?.customer_codes?.[0]?.trim();
  const displayName = code ? `${code} ${baseName}` : baseName;
  const prio = priorityMeta(conversation.priority);
  const isUrgent = conversation.priority === "urgent";
  const contactTags = contact?.tags ?? [];

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      onContextMenu(conversation, e.clientX, e.clientY);
    },
    [onContextMenu, conversation],
  );

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : "";

  return (
    <button
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      className={cn(
        "flex w-full items-start gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/50",
        // Urgent gets a soft red wash so it jumps out of the list.
        isUrgent && "bg-red-500/5 hover:bg-red-500/10",
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
        {/* Linha 1: nome + horário / não-lidas / status. O cluster da direita é
            `shrink-0` e o nome trunca — nunca se sobrepõem. */}
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-foreground">
            {displayName}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-[10px] text-muted-foreground">{timeAgo}</span>
            {/* Não mostra o badge de não-lidas na conversa aberta (você está
                lendo). O reset no banco é disparado em handleMessageEvent. */}
            {!isActive && conversation.unread_count > 0 && (
              <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold text-primary-foreground">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                STATUS_COLORS[conversation.status],
              )}
              title={conversation.status}
            />
          </div>
        </div>

        {/* Linha 2: prévia da última mensagem — largura total, SEMPRE visível
            (não disputa espaço com os badges, que agora quebram abaixo). */}
        <p className="mt-0.5 truncate text-xs text-muted-foreground">
          {formatConversationPreview(conversation.last_message_text)}
        </p>

        {/* Linha 3: badges (prioridade, atribuído, grupo, setor, canal) +
            etiquetas do contato, todos numa faixa que QUEBRA conforme precisa —
            o card cresce pra baixo e fica alinhado. */}
        {(prio ||
          agentName ||
          contact?.is_group ||
          conversation.sector ||
          conversation.channel ||
          contactTags.length > 0) && (
          <div className="mt-1 flex flex-wrap items-center gap-1">
            {prio && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                  prio.badge,
                )}
                title={`Prioridade: ${prio.label}`}
              >
                <span className={cn("size-1.5 rounded-full", prio.dot)} />
                {prio.label}
              </span>
            )}
            {agentName && (
              <span
                className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary"
                title={`Atribuída a ${agentName}`}
              >
                <UserCheck className="h-2.5 w-2.5" />
                <span className="max-w-24 truncate">{agentName}</span>
              </span>
            )}
            {contact?.is_group && (
              <span
                className="inline-flex items-center rounded-full bg-muted px-1 py-0.5 text-muted-foreground"
                title="Grupo monitorado"
              >
                <Users className="h-2.5 w-2.5" />
              </span>
            )}
            {conversation.sector && (
              <span
                className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium"
                style={{
                  backgroundColor: `${conversation.sector.color}20`,
                  color: conversation.sector.color,
                }}
                title={`Setor: ${conversation.sector.name}`}
              >
                <span
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: conversation.sector.color }}
                />
                <span className="max-w-20 truncate">
                  {conversation.sector.name}
                </span>
              </span>
            )}
            {conversation.channel && (
              <ChannelBadge
                provider={conversation.channel.provider}
                name={conversation.channel.name}
              />
            )}
            {contactTags.slice(0, 3).map((tag) => (
              <span
                key={tag.id}
                className="inline-flex max-w-24 items-center gap-1 rounded-full px-1.5 py-0.5 text-[9px] font-medium"
                style={{ backgroundColor: `${tag.color}20`, color: tag.color }}
                title={tag.name}
              >
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: tag.color }}
                />
                <span className="truncate">{tag.name}</span>
              </span>
            ))}
            {contactTags.length > 3 && (
              <span className="text-[9px] font-medium text-muted-foreground">
                +{contactTags.length - 3}
              </span>
            )}
          </div>
        )}
      </div>
    </button>
  );
}

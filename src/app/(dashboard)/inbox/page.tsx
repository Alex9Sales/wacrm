"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { getConversationWithContact, getWhatsappConnected } from "./actions";
import type {
  Conversation,
  Message,
  Contact,
  ConversationStatus,
  ConversationPriority,
} from "@/types";
import { useRealtime } from "@/hooks/use-realtime";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { ContactSidebar } from "@/components/inbox/contact-sidebar";
import { toast } from "sonner";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

// Remembers the agent's show/hide choice for the desktop contact panel
// across reloads and sessions (device-scoped, like the theme prefs).
const CONTACT_PANEL_STORAGE_KEY = "wacrm:inbox:contact-panel-open";

export default function InboxPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  /**
   * `?c=<id>` deep-link support. Used when landing here from the
   * dashboard's recent-conversations list so the right thread opens
   * automatically instead of showing the empty center panel.
   */
  const deepLinkConvId = searchParams.get("c");

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversation, setActiveConversation] =
    useState<Conversation | null>(null);
  const [activeContact, setActiveContact] = useState<Contact | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(
    null
  );
  /**
   * Bumped whenever we want children (ConversationList, MessageThread)
   * to refetch from the DB — used as a safety net against missed
   * realtime events. Bumped on WS reconnect and on tab visibility →
   * visible. The initial mount fetches don't depend on this; they fire
   * once on conversationId-change as usual.
   */
  const [resyncToken, setResyncToken] = useState(0);

  /**
   * Whether the desktop contact sidebar (tags / deals / notes) is shown.
   * Defaults to `true` (the historical behaviour) and is restored from
   * localStorage after mount. We deliberately do NOT read localStorage in
   * the initializer: the server renders with `true`, so reading a stored
   * `false` synchronously would produce a hydration mismatch. The effect
   * below reconciles to the stored value right after mount instead.
   */
  const [contactPanelOpen, setContactPanelOpen] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CONTACT_PANEL_STORAGE_KEY);
      if (stored !== null) setContactPanelOpen(stored === "true");
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, []);

  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CONTACT_PANEL_STORAGE_KEY, String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  }, []);

  // Fire the deep-link auto-select exactly once per URL — subsequent
  // list refreshes (realtime, manual refetch) must not snap the user
  // back to the deep-linked conversation if they've already clicked
  // elsewhere.
  const autoSelectedForDeepLinkRef = useRef<string | null>(null);

  // Tracks conversations whose hydrate fetch is currently in flight. The
  // conv-INSERT and the first-message-INSERT events both call into
  // hydrateConversation; the dedupe here keeps it at one refetch per
  // new conversation even when both events arrive within milliseconds.
  const hydratingConvIdsRef = useRef<Set<string>>(new Set());

  /**
   * Synchronous mirror of the conversation ids currently in `conversations`
   * state. Event handlers need to know "do we already have this conv?"
   * without waiting for a setState updater to run — updaters fire during
   * reconciliation, *after* the synchronous handler code returns, so a
   * `let foundInList = false; setState(p => { foundInList = ...; return ... })`
   * flag reads as `false` in the same tick (this exact bug shipped in #105
   * and caused #106: every incoming message and every status flip fired a
   * redundant DB hydrate, swamping the supabase client and starving the
   * realtime channel). The ref is kept in sync via the effect below.
   */
  const knownConvIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const next = new Set<string>();
    for (const c of conversations) next.add(c.id);
    knownConvIdsRef.current = next;
  }, [conversations]);

  // Pull the conversation row with its `contact` joined and merge it
  // into state. Needed because Supabase Realtime payloads only carry the
  // row's own columns — a brand-new conversation arrives without a
  // contact, which surfaced as "Unknown" names, empty avatars, and
  // (when the conv-INSERT event was delayed past the message-INSERT)
  // conversations stuck on "Nenhuma mensagem ainda" until the user reloaded.
  // Also self-heals if a realtime event was missed: callers can invoke
  // this whenever they reference a conversation id they don't recognise.
  const hydrateConversation = useCallback(async (convId: string) => {
    if (hydratingConvIdsRef.current.has(convId)) return;
    hydratingConvIdsRef.current.add(convId);
    try {
      let fetched: Conversation | null;
      try {
        // Server action returns the conversation already normalized
        // (contact + contact.tags embedded), account-scoped.
        fetched = await getConversationWithContact(convId);
      } catch (error) {
        console.error("Failed to hydrate conversation:", error);
        return;
      }
      if (!fetched) return;
      const fetchedConv = fetched;
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === fetchedConv.id);
        if (existing) {
          // Already in state — APPLY the freshly-fetched row (its
          // last_message_text / unread_count / last_message_at are the
          // source of truth now: in the SSE world there is no separate
          // postgres_changes UPDATE patching those columns, so the old
          // "only backfill contact" behaviour left the list row stale —
          // the notification fired but the preview/badge never moved).
          // Reorder to the top by recency so the just-active conversation
          // surfaces, and keep whichever contact object we already have if
          // the fetch somehow came back without one.
          const merged = {
            ...existing,
            ...fetchedConv,
            contact: fetchedConv.contact ?? existing.contact,
          };
          return [merged, ...prev.filter((c) => c.id !== fetchedConv.id)];
        }
        return [fetchedConv, ...prev];
      });
    } finally {
      hydratingConvIdsRef.current.delete(convId);
    }
  }, []);

  // External deep-link while the inbox is ALREADY mounted (notification
  // pop-up, a shared /inbox?c= link): the ?c= param changes but the list
  // won't refetch, so handleConversationsLoaded never fires. React ONLY to a
  // genuine ?c= change (never to selection/list state, which would race a
  // fresh in-list click and snap the user back). The ref is claimed
  // synchronously up front, so a list click — which sets the ref BEFORE it
  // updates the URL — short-circuits here as a no-op. We fetch the target
  // directly (one call per external nav) so it works even for a conversation
  // not yet in the loaded list.
  useEffect(() => {
    const target = deepLinkConvId;
    if (!target) return;
    if (autoSelectedForDeepLinkRef.current === target) return;
    autoSelectedForDeepLinkRef.current = target;
    let cancelled = false;
    void (async () => {
      const fetched = await getConversationWithContact(target).catch(() => null);
      if (cancelled || !fetched) return;
      // The user may have moved on while the fetch was in flight.
      if (searchParams.get("c") !== target) return;
      setConversations((prev) =>
        prev.some((c) => c.id === fetched.id)
          ? prev.map((c) =>
              c.id === fetched.id ? { ...c, unread_count: 0 } : c,
            )
          : [{ ...fetched, unread_count: 0 }, ...prev],
      );
      setActiveConversation(fetched);
      setActiveContact(fetched.contact ?? null);
      setMessages([]);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deepLinkConvId]);

  // Check WhatsApp connection status on mount
  useEffect(() => {
    const checkConnection = async () => {
      try {
        // whatsapp_config is one-row-per-account post-multi-user; the
        // server action resolves the caller's account and queries by it,
        // so the banner stays correct for teammates who didn't
        // personally save the config.
        setWhatsappConnected(await getWhatsappConnected());
      } catch {
        // No session / no account — treat as not connected.
        setWhatsappConnected(false);
      }
    };

    checkConnection();
  }, []);

  // Handle realtime message events.
  //
  // Phase 3 (SSE): events are ephemeral pings — `{ type, conversationId }`
  // — not full postgres_changes rows. We can't patch a message into the
  // thread from the ping alone, so we hydrate the affected conversation
  // (refreshing its list preview + unread_count with the joined contact)
  // and, when the ping is for the OPEN thread, bump the resync token so
  // MessageThread refetches its messages. `hydrateConversation` dedupes
  // and self-heals convs we've never seen, so a first-message ping for an
  // unknown conversation surfaces it correctly.
  const handleMessageEvent = useCallback(
    (event: { type: "message.received"; conversationId?: string }) => {
      const convId = event.conversationId;
      if (!convId) {
        // No id to target — fall back to a full resync.
        setResyncToken((n) => n + 1);
        return;
      }

      // Refresh the conversation row (preview text, unread_count, contact).
      hydrateConversation(convId);

      // If the message is for the thread the user is currently viewing,
      // pull its messages so the new bubble appears without a manual
      // refresh. The token also re-fetches the list as a safety net.
      if (activeConversation?.id === convId) {
        setResyncToken((n) => n + 1);
      }
    },
    [activeConversation?.id, hydrateConversation]
  );

  // Local (same-tab) refresh trigger — the waha-voip call modal fires this on
  // hang-up after logging the call, since its SSE ping can race with the modal
  // teardown. Reuses the exact hydrate + resync path as a real message event.
  useEffect(() => {
    const h = (e: Event) => {
      const convId = (e as CustomEvent).detail?.conversationId as
        | string
        | undefined;
      if (convId) handleMessageEvent({ type: "message.received", conversationId: convId });
    };
    window.addEventListener("fluxia:conversation-refresh", h);
    return () => window.removeEventListener("fluxia:conversation-refresh", h);
  }, [handleMessageEvent]);

  // Handle realtime conversation-created events.
  //
  // Phase 3 (SSE): a tiny `{ type, conversationId }` ping. Hydrate the
  // new thread so it surfaces in the list with its joined contact.
  const handleConversationEvent = useCallback(
    (event: { type: "conversation.created"; conversationId?: string }) => {
      const convId = event.conversationId;
      if (!convId) {
        setResyncToken((n) => n + 1);
        return;
      }
      if (!knownConvIdsRef.current.has(convId)) {
        hydrateConversation(convId);
      }
    },
    [hydrateConversation]
  );

  // Subscribe to realtime. The `isConnected` flag below feeds the
  // reconnect resync: realtime is best-effort and events sent while the
  // WS was disconnected (laptop sleep, network blip, background-tab
  // throttle) are simply lost. We need a way to catch up.
  const { isConnected } = useRealtime({
    channelName: "inbox-realtime",
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    enabled: true,
  });

  /**
   * Bump `resyncToken` whenever the realtime channel transitions from
   * disconnected → connected *after* the initial connect. The initial
   * connect is covered by the children's on-mount fetches; only later
   * reconnects need a manual refetch to fill the gap.
   *
   * Tracked via a `was-connected` ref rather than a count so that React
   * strict-mode's dev-only effect double-fire doesn't read as a
   * reconnect.
   */
  const wasConnectedRef = useRef(false);
  const initialConnectDoneRef = useRef(false);
  useEffect(() => {
    if (isConnected && !wasConnectedRef.current) {
      // false → true transition
      if (initialConnectDoneRef.current) {
        setResyncToken((n) => n + 1);
      } else {
        initialConnectDoneRef.current = true;
      }
    }
    wasConnectedRef.current = isConnected;
  }, [isConnected]);

  /**
   * Refetch when the tab regains focus. Background tabs may have their
   * WS throttled by the browser even without a full disconnect, so a
   * visibilitychange → visible is a reliable signal that we may have
   * missed events. Cheap to fire; the children dedupe on their own.
   */
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setResyncToken((n) => n + 1);
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  /**
   * Manual refresh trigger for the thread-header refresh button.
   * Bumps the same resyncToken the reconnect / visibility paths use,
   * so it goes through the existing dedupe & refetch plumbing — no
   * separate code path to keep in sync.
   */
  const handleManualRefresh = useCallback(() => {
    setResyncToken((n) => n + 1);
  }, []);

  const handleConversationsLoaded = useCallback(
    (loaded: Conversation[]) => {
      setConversations(loaded);
      // NOTE: deep-link auto-selection is intentionally NOT done here.
      // The effect keyed on `deepLinkConvId` (above) is the SINGLE owner of
      // "?c= changed → select that thread". Doing it here too caused a
      // focus-stealing race: a realtime resync refetches the list and calls
      // this handler, and during the window between a list click (which sets
      // the ref + router.replace's the URL) and the URL actually committing,
      // `deepLinkConvId` still points at the PREVIOUS thread — so this block
      // re-selected the old conversation and snapped the operator away from
      // the one they'd just opened. The effect doesn't have that race (it
      // reacts to the committed param, and self-fetches the target).
    },
    []
  );

  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      // Re-clicking the already-active conversation would clear the
      // messages array, but the fetch effect in MessageThread only re-runs
      // when conversationId changes — so messages would stay empty until
      // the user navigated away and back. Bail out early instead.
      if (activeConversation?.id === conv.id) return;
      setActiveConversation(conv);
      setActiveContact(conv.contact ?? null);
      setMessages([]);
      // Optimistically clear the unread badge for this conv. The
      // server-side reset is fired by the unread-reset effect inside
      // MessageThread (which reads activeConversation.unread_count, not
      // the list copy — so we deliberately leave that intact below to
      // keep the effect firing), and the realtime UPDATE that comes
      // back will sync to 0 again as a no-op. Zeroing the list copy
      // here means the user sees the badge disappear the instant they
      // click instead of waiting for the round-trip — and it persists
      // even if the realtime UPDATE is dropped.
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conv.id && c.unread_count > 0
            ? { ...c, unread_count: 0 }
            : c,
        ),
      );
      // Record the selection on the deep-link ref BEFORE we change the
      // URL. The router.replace below flips `deepLinkConvId`, which can
      // in turn cause ConversationList to refetch and eventually call
      // handleConversationsLoaded again. Without this line, the ref
      // still points at the previous value, the auto-select block
      // sees `ref !== deepLinkConvId`, fires a second time, and
      // clobbers the messages MessageThread just fetched.
      autoSelectedForDeepLinkRef.current = conv.id;
      // Reflect the selection in the URL so a refresh lands the user
      // back in the same thread, and so copy-paste links work. Use
      // replace() to avoid polluting browser history with every click.
      // Preserve any existing query params (e.g. the `?caixa=<channelId>`
      // channel filter the ConversationList owns) so clicking a
      // conversation doesn't silently drop the active caixa on refresh.
      const params = new URLSearchParams(searchParams.toString());
      params.set("c", conv.id);
      router.replace(`/inbox?${params.toString()}`, { scroll: false });

      // Correct any stale metadata (assignee, status, sector, privacy) with a
      // fresh fetch. There's no live push for these fields (Fase 3 realtime
      // isn't built) — the list row can be minutes old. Real incident: a
      // supervisor reassigned a conversation, and an agent who opened it from
      // an already-loaded list still saw the OLD assignee (and the reply
      // lock showed the wrong name). Background-only — the optimistic paint
      // above keeps the click feeling instant.
      void getConversationWithContact(conv.id)
        .then((fresh) => {
          if (!fresh) return;
          setActiveConversation((cur) => (cur?.id === conv.id ? fresh : cur));
          setConversations((prev) =>
            prev.map((c) =>
              c.id === fresh.id
                ? { ...c, ...fresh, contact: fresh.contact ?? c.contact }
                : c,
            ),
          );
        })
        .catch(() => {});
    },
    [activeConversation?.id, router, searchParams]
  );

  // A conversation just started from the "Nova conversa" dialog. The thread is
  // brand-new (not in the loaded list), so relying on the ?c= deep-link effect
  // alone left it invisible until a manual refresh. Here we do it explicitly:
  // refetch the list (so it's present), hydrate the thread, open it, and set
  // the URL — claiming the deep-link ref so that effect stays a no-op.
  const handleConversationStarted = useCallback(
    async (conversationId: string) => {
      autoSelectedForDeepLinkRef.current = conversationId;
      setResyncToken((n) => n + 1);
      const fetched = await getConversationWithContact(conversationId).catch(
        () => null,
      );
      if (!fetched) return;
      setConversations((prev) =>
        prev.some((c) => c.id === fetched.id)
          ? prev.map((c) =>
              c.id === fetched.id ? { ...c, unread_count: 0 } : c,
            )
          : [{ ...fetched, unread_count: 0 }, ...prev],
      );
      setActiveConversation(fetched);
      setActiveContact(fetched.contact ?? null);
      setMessages([]);
      const params = new URLSearchParams(searchParams.toString());
      params.set("c", conversationId);
      router.replace(`/inbox?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  // Mobile "back" — deselect the conversation so the list pane comes
  // back. Also clears the ?c= param so a refresh lands on the list
  // instead of re-opening the thread the user just backed out of.
  const handleCloseConversation = useCallback(() => {
    setActiveConversation(null);
    setActiveContact(null);
    setMessages([]);
    // Clearing the ref lets the deep-link auto-selector fire again if
    // the user later visits /inbox?c=<same-id> — desirable UX.
    autoSelectedForDeepLinkRef.current = null;
    // Drop the `?c=` thread param but keep the caixa filter (if any) so
    // backing out to the list preserves the selected channel on refresh.
    const params = new URLSearchParams(searchParams.toString());
    params.delete("c");
    const qs = params.toString();
    router.replace(qs ? `/inbox?${qs}` : "/inbox", { scroll: false });
  }, [router, searchParams]);


  // A conversation was deleted from the thread header. Drop it from the
  // list and, if it's the open thread, clear the center pane back to the
  // empty state (and reset the ?c= deep link so a refresh doesn't try to
  // re-open a conversation that no longer exists).
  const handleConversationDeleted = useCallback(
    (conversationId: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      if (activeConversation?.id === conversationId) {
        setActiveConversation(null);
        setActiveContact(null);
        setMessages([]);
        autoSelectedForDeepLinkRef.current = null;
        const params = new URLSearchParams(searchParams.toString());
        params.delete("c");
        const qs = params.toString();
        router.replace(qs ? `/inbox?${qs}` : "/inbox", { scroll: false });
      }
    },
    [activeConversation?.id, router, searchParams]
  );

  // The operator edited the contact from the sidebar. Update the active
  // contact (drives the thread header + the sidebar) and patch the
  // conversation's embedded contact in both the active conversation and
  // the list row so the name/avatar update everywhere without a reload.
  const handleContactUpdated = useCallback(
    (updated: Contact) => {
      setActiveContact(updated);
      setActiveConversation((prev) =>
        prev && prev.contact?.id === updated.id
          ? { ...prev, contact: { ...prev.contact, ...updated } }
          : prev,
      );
      setConversations((prev) =>
        prev.map((c) =>
          c.contact?.id === updated.id
            ? { ...c, contact: { ...c.contact, ...updated } }
            : c,
        ),
      );
    },
    [],
  );

  const handleMessagesLoaded = useCallback((loaded: Message[]) => {
    setMessages(loaded);
  }, []);

  const handleNewMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
  }, []);

  const handleUpdateMessage = useCallback(
    (id: string, updates: Partial<Message>) => {
      setMessages((prev) =>
        prev.map((m) => (m.id === id ? { ...m, ...updates } : m))
      );
    },
    []
  );

  const handleStatusChange = useCallback(
    (conversationId: string, status: ConversationStatus) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, status } : c))
      );
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev) => (prev ? { ...prev, status } : prev));
      }
    },
    [activeConversation]
  );

  const handleAssignChange = useCallback(
    (conversationId: string, assignedAgentId: string | null) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? { ...c, assigned_agent_id: assignedAgentId ?? undefined }
            : c
        )
      );
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev) =>
          prev
            ? { ...prev, assigned_agent_id: assignedAgentId ?? undefined }
            : prev
        );
      }
    },
    [activeConversation]
  );

  // Priority changed from the contact sidebar's "Ações da conversa"
  // section. Mirror into the active conversation + list row so any
  // priority-driven UI stays in sync without a refetch.
  const handlePriorityChange = useCallback(
    (conversationId: string, priority: ConversationPriority) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, priority } : c))
      );
      if (activeConversation?.id === conversationId) {
        setActiveConversation((prev) => (prev ? { ...prev, priority } : prev));
      }
    },
    [activeConversation]
  );

  // On mobile (<lg) we show a SINGLE pane — either the list or the
  // thread — rather than cramming both side-by-side. Selecting a
  // conversation slides the thread in; the thread's back button pops
  // it back to the list. On lg+ both panes render side-by-side as
  // before, unchanged.
  const hasActiveConv = !!activeConversation;

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] flex-col overflow-hidden sm:-m-6">
      {/* WhatsApp connection banner — in the flex column, not absolute,
          so it pushes the panels down instead of overlapping them. */}
      {whatsappConnected === false && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
          <WifiOff className="h-4 w-4 text-amber-400" />
          <p className="text-xs text-amber-400">
            WhatsApp® não está conectado. Vá em Configurações para conectar sua conta.
          </p>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Conversation list.
            Hidden on mobile when a conversation is selected so the
            thread can occupy the full width. Always visible on lg+. */}
        <div
          className={cn(
            "flex h-full flex-1 lg:flex-none",
            hasActiveConv ? "hidden lg:flex" : "flex",
          )}
        >
          <ConversationList
            activeConversationId={activeConversation?.id ?? null}
            onSelect={handleSelectConversation}
            onConversationStarted={handleConversationStarted}
            conversations={conversations}
            onConversationsLoaded={handleConversationsLoaded}
            resyncToken={resyncToken}
          />
        </div>

        {/* Center panel: Message thread.
            Hidden on mobile when no conversation is selected so the
            list can occupy the full width. Always visible on lg+
            (shows its own empty-state if no thread is picked yet).

            `min-w-0` is load-bearing: without it, a single wide piece
            of content inside the thread (long quote preview, very
            long URL in a message body) forces the flex child past
            its share and pushes the contact-sidebar panel off-screen
            on the right. Issue #165. */}
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 lg:flex",
            hasActiveConv ? "flex" : "hidden lg:flex",
          )}
        >
          <MessageThread
            conversation={activeConversation}
            contact={activeContact}
            messages={messages}
            onMessagesLoaded={handleMessagesLoaded}
            onNewMessage={handleNewMessage}
            onUpdateMessage={handleUpdateMessage}
            onStatusChange={handleStatusChange}
            onAssignChange={handleAssignChange}
            onBack={handleCloseConversation}
            resyncToken={resyncToken}
            onRefresh={handleManualRefresh}
            contactPanelOpen={contactPanelOpen}
            onToggleContactPanel={handleToggleContactPanel}
            onConversationDeleted={handleConversationDeleted}
          />
        </div>

        {/* Right panel: Contact sidebar — desktop only, and only when the
            agent hasn't collapsed it via the thread-header toggle (#258).
            On mobile it's always hidden (the `lg:block` below), so the
            toggle — which is itself desktop-only — never affects it. */}
        {contactPanelOpen && (
          <div className="hidden lg:block">
            <ContactSidebar
              contact={activeContact}
              conversation={activeConversation}
              onContactUpdated={handleContactUpdated}
              onStatusChange={handleStatusChange}
              onAssignChange={handleAssignChange}
              onPriorityChange={handlePriorityChange}
              onConversationDeleted={handleConversationDeleted}
            />
          </div>
        )}
      </div>
    </div>
  );
}

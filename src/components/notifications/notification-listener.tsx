"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MessageSquare, Users } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { useServerEvents } from "@/hooks/use-server-events";
import { playNotificationSound } from "@/lib/notifications/sounds";
import { getNotificationPrefs } from "@/lib/notifications/prefs";
import { getConversationPreview } from "@/app/(dashboard)/inbox/actions";

/**
 * Headless global listener. On an inbound `message.received` (customer) or an
 * `internal_message` (team chat) SSE event it plays the chosen sound and shows
 * a clickable pop-up (per-device prefs). Debounced per source so the routing
 * double-emit doesn't double-alert; skips your OWN internal messages and the
 * conversation you're actively viewing.
 */
export function NotificationListener() {
  const router = useRouter();
  const { user } = useAuth();
  const lastAt = useRef<Map<string, number>>(new Map());

  const recentlyAlerted = useCallback((key: string) => {
    const now = Date.now();
    const prev = lastAt.current.get(key) ?? 0;
    if (now - prev < 2500) return true;
    lastAt.current.set(key, now);
    if (lastAt.current.size > 200) lastAt.current.clear();
    return false;
  }, []);

  // A fully clickable pop-up (sonner's toast body isn't clickable — only an
  // action button is — so we render our own card via toast.custom).
  const popup = useCallback(
    (opts: {
      title: string;
      description: string;
      href: string;
      variant: "chat" | "internal";
    }) => {
      toast.custom(
        (id) => (
          <button
            type="button"
            onClick={() => {
              router.push(opts.href);
              toast.dismiss(id);
            }}
            className="flex w-full items-start gap-3 rounded-xl border border-border bg-card p-3 text-left shadow-lg shadow-black/10 transition-colors hover:bg-muted/60"
          >
            <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
              {opts.variant === "internal" ? (
                <Users className="size-4" />
              ) : (
                <MessageSquare className="size-4" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium text-foreground">
                {opts.title}
              </span>
              <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                {opts.description}
              </span>
            </span>
          </button>
        ),
        { duration: 12000 },
      );
    },
    [router],
  );

  const onEvent = useCallback(
    (e: {
      type: string;
      conversationId?: unknown;
      channelId?: unknown;
      senderId?: unknown;
      senderName?: unknown;
    }) => {
      const prefs = getNotificationPrefs();
      const alert = (sound: boolean, showPopup: () => void) => {
        if (sound && prefs.soundEnabled) {
          playNotificationSound(prefs.soundId, prefs.volume);
        }
        if (prefs.toastEnabled) showPopup();
      };

      // ---- Customer message ----
      if (e.type === "message.received") {
        const conversationId =
          typeof e.conversationId === "string" ? e.conversationId : "";
        if (!conversationId) return;
        if (recentlyAlerted(`conv:${conversationId}`)) return;

        // Skip if you're already looking at this conversation.
        const viewingThis =
          typeof window !== "undefined" &&
          !document.hidden &&
          window.location.pathname.startsWith("/inbox") &&
          new URLSearchParams(window.location.search).get("c") ===
            conversationId;
        if (viewingThis) return;

        if (!prefs.soundEnabled && !prefs.toastEnabled) return;
        void getConversationPreview(conversationId)
          .then((info) => {
            if (!info) return; // hidden sector / gone — no leak
            alert(true, () =>
              popup({
                title: info.name,
                description: info.preview || "Nova mensagem",
                href: `/inbox?c=${conversationId}`,
                variant: "chat",
              }),
            );
          })
          .catch(() => {
            alert(true, () =>
              popup({
                title: "Nova mensagem",
                description: "Você recebeu uma mensagem de um cliente.",
                href: `/inbox?c=${conversationId}`,
                variant: "chat",
              }),
            );
          });
        return;
      }

      // ---- Internal team chat ----
      if (e.type === "internal_message") {
        const channelId = typeof e.channelId === "string" ? e.channelId : "";
        const senderId = typeof e.senderId === "string" ? e.senderId : "";
        if (!channelId) return;
        if (senderId && user?.id && senderId === user.id) return; // your own
        if (recentlyAlerted(`internal:${channelId}`)) return;

        // Skip if you're already in the internal chat.
        const viewingInternal =
          typeof window !== "undefined" &&
          !document.hidden &&
          window.location.pathname.startsWith("/internal-chat");
        if (viewingInternal) return;

        const who =
          typeof e.senderName === "string" && e.senderName
            ? e.senderName
            : "Equipe";
        alert(true, () =>
          popup({
            title: `${who} · Chat interno`,
            description: "Nova mensagem no chat interno.",
            href: `/internal-chat`,
            variant: "internal",
          }),
        );
      }
    },
    [popup, recentlyAlerted, user?.id],
  );

  useServerEvents(onEvent);
  return null;
}

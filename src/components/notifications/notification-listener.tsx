"use client";

import { useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MessageSquare } from "lucide-react";

import { useServerEvents } from "@/hooks/use-server-events";
import { playNotificationSound } from "@/lib/notifications/sounds";
import { getNotificationPrefs } from "@/lib/notifications/prefs";
import { getConversationPreview } from "@/app/(dashboard)/inbox/actions";

/**
 * Headless global listener: on an inbound `message.received` SSE event it
 * plays the chosen sound and shows a pop-up (per-device prefs). Debounced per
 * conversation so the routing double-emit doesn't double-alert. Skips the
 * alert while the user is actively looking at that same conversation.
 */
export function NotificationListener() {
  const router = useRouter();
  const lastAt = useRef<Map<string, number>>(new Map());

  const onEvent = useCallback(
    (e: { type: string; conversationId?: unknown }) => {
      if (e.type !== "message.received") return;
      const conversationId =
        typeof e.conversationId === "string" ? e.conversationId : "";
      if (!conversationId) return;

      // Debounce: same conversation within 2.5s → one alert.
      const now = Date.now();
      const prev = lastAt.current.get(conversationId) ?? 0;
      if (now - prev < 2500) return;
      lastAt.current.set(conversationId, now);
      // Keep the map from growing unbounded.
      if (lastAt.current.size > 200) lastAt.current.clear();

      // Skip if the user is right now looking at this conversation.
      const viewingThis =
        typeof window !== "undefined" &&
        !document.hidden &&
        window.location.pathname.startsWith("/inbox") &&
        new URLSearchParams(window.location.search).get("c") === conversationId;
      if (viewingThis) return;

      const prefs = getNotificationPrefs();
      if (prefs.soundEnabled) {
        playNotificationSound(prefs.soundId, prefs.volume);
      }
      if (prefs.toastEnabled) {
        void getConversationPreview(conversationId)
          .then((info) => {
            if (!info) return; // hidden sector / gone — no leak, no toast
            toast(info.name, {
              description: info.preview || "Nova mensagem",
              icon: <MessageSquare className="h-4 w-4 text-primary" />,
              action: {
                label: "Abrir",
                onClick: () => router.push(`/inbox?c=${conversationId}`),
              },
            });
          })
          .catch(() => {
            // Still surface a generic pop-up if the lookup fails.
            toast("Nova mensagem", {
              icon: <MessageSquare className="h-4 w-4 text-primary" />,
              action: {
                label: "Abrir",
                onClick: () => router.push(`/inbox?c=${conversationId}`),
              },
            });
          });
      }
    },
    [router],
  );

  useServerEvents(onEvent);
  return null;
}

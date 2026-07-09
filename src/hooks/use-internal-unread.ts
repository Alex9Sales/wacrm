"use client";

import { useCallback, useEffect, useState } from "react";

import { useServerEvents } from "./use-server-events";
import { getInternalUnreadCount } from "@/app/(dashboard)/internal-chat/actions";

const REFRESH_EVENT = "internal-unread-refresh";

/** Ask any mounted useInternalUnread hooks to refetch now (e.g. after the
 *  chat page marks a channel read, so the badge clears immediately). */
export function refreshInternalUnread(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(REFRESH_EVENT));
  }
}

/**
 * Number of internal-chat channels with unread messages for the current
 * user — drives the sidebar badge on "Chat Interno". Refetches on a new
 * internal message (SSE), on window focus, and when `refreshInternalUnread`
 * fires.
 */
export function useInternalUnread(): number {
  const [count, setCount] = useState(0);

  const refetch = useCallback(async () => {
    try {
      setCount(await getInternalUnreadCount());
    } catch {
      // keep the last known value on a transient failure
    }
  }, []);

  useServerEvents(
    useCallback(
      (e) => {
        if (e.type === "internal_message") void refetch();
      },
      [refetch],
    ),
  );

  useEffect(() => {
    void refetch();
    const onFocus = () => void refetch();
    const onRefresh = () => void refetch();
    window.addEventListener("focus", onFocus);
    window.addEventListener(REFRESH_EVENT, onRefresh);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener(REFRESH_EVENT, onRefresh);
    };
  }, [refetch]);

  return count;
}

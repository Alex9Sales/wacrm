"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

interface ContactAvatarProps {
  /** The contact's re-hosted profile photo URL, if any. */
  avatarUrl?: string | null;
  /** Display name (or phone) — its first letter is the fallback. */
  displayName: string;
  /**
   * Sizing / extra classes applied to BOTH the <img> and the letter
   * fallback so the avatar fills its circular container. The parent
   * container owns `rounded-full`, `overflow-hidden`, and the background.
   */
  className?: string;
}

/**
 * Renders a contact's WhatsApp profile photo when present, falling back to
 * the first letter of their name. If the image URL is broken (expired /
 * 404 / blocked), `onError` flips to the letter fallback so the circle
 * never renders a broken-image glyph. Shared across the conversation list,
 * the thread header, and the contact sidebar so the behaviour can't drift.
 */
export function ContactAvatar({
  avatarUrl,
  displayName,
  className,
}: ContactAvatarProps) {
  const [failed, setFailed] = useState(false);

  // A new avatar_url (e.g. backfill landed, or a different contact) resets
  // the error state so the fresh URL gets a chance to load.
  useEffect(() => {
    setFailed(false);
  }, [avatarUrl]);

  const initials = (displayName || "?").charAt(0).toUpperCase();

  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt={displayName}
        onError={() => setFailed(true)}
        className={cn("rounded-full object-cover", className)}
      />
    );
  }

  return <>{initials}</>;
}

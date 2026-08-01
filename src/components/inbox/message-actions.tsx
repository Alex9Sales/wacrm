"use client";

import { useState, type ReactNode } from "react";
import {
  CornerUpLeft,
  CornerUpRight,
  Copy,
  SmilePlus,
  Pencil,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { ContactAvatar } from "./contact-avatar";
import { groupColor, parseGroupAuthor } from "@/lib/inbox/group-color";
import type { Message } from "@/types";

// WhatsApp's own quick-reaction bar starts with these six. Picking the same
// set keeps the affordance familiar without pulling in a 300KB emoji library.
const QUICK_EMOJIS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

interface MessageActionsProps {
  message: Message;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onForward: () => void;
  /** Edit an own text message (WhatsApp "Editar"). The PARENT decides
   *  editability (own text msg, not internal, inside WhatsApp's ~15min window)
   *  and only passes this when editable — absent → the button is hidden. */
  onEdit?: () => void;
  /** Group conversation → show the sender's avatar in the left gutter. */
  isGroup?: boolean;
  /** Group: clicking a participant's avatar opens the participant panel
   *  (Conversar/Voz/Vídeo/Adicionar). Absent → avatar stays decorative. */
  onAuthorClick?: (p: {
    phone: string;
    name: string;
    avatarUrl?: string | null;
  }) => void;
  children: ReactNode;
}

/**
 * The per-participant avatar in the left gutter of an incoming GROUP bubble.
 * Photo when known (`author_avatar_url`), else the author's first letter over
 * their stable group color — matching how the name is colored in the bubble.
 */
function GroupAuthorAvatar({
  message,
  onClick,
}: {
  message: Message;
  onClick?: () => void;
}) {
  const name = parseGroupAuthor(message.content_text ?? "") ?? "?";
  const cls =
    "mb-0.5 flex size-7 shrink-0 items-center justify-center self-end overflow-hidden rounded-full text-xs font-semibold text-white";
  const inner = (
    <ContactAvatar
      avatarUrl={message.author_avatar_url}
      displayName={name}
      className="size-7"
    />
  );
  // Clickable only when the parent wired a handler AND we know the sender's
  // number (author_key). Otherwise the avatar stays a decorative gutter dot.
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(cls, "cursor-pointer transition hover:ring-2 hover:ring-primary/60")}
        style={{ backgroundColor: groupColor(name) }}
        title={`Ver ${name === "?" ? "participante" : name}`}
      >
        {inner}
      </button>
    );
  }
  return (
    <div
      className={cls}
      style={{ backgroundColor: groupColor(name) }}
      title={name === "?" ? undefined : name}
      aria-hidden
    >
      {inner}
    </div>
  );
}

/**
 * Hover/long-press toolbar wrapper around a `<MessageBubble>`. The bubble
 * itself stays a pure presenter — this component owns the action surface so
 * the bubble's render path is unaffected when the toolbar isn't visible.
 */
export function MessageActions({
  message,
  onReply,
  onReact,
  onForward,
  onEdit,
  isGroup,
  onAuthorClick,
  children,
}: MessageActionsProps) {
  // Touch devices have no hover. Long-press fires `contextmenu`; we capture
  // it, suppress the native menu, and pin the toolbar open until the user
  // interacts elsewhere.
  const [touchOpen, setTouchOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const isAgent =
    message.sender_type === "agent" || message.sender_type === "bot";

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setTouchOpen(true);
  };

  const handleCopy = async () => {
    const text = message.content_text ?? "";
    if (!text) {
      toast.error("Nada para copiar");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copiado");
    } catch {
      toast.error("Falha ao copiar");
    }
    setTouchOpen(false);
  };

  const handlePickEmoji = (emoji: string) => {
    onReact(emoji);
    setPickerOpen(false);
    setTouchOpen(false);
  };

  const handleReply = () => {
    onReply();
    setTouchOpen(false);
  };

  const handleForward = () => {
    onForward();
    setTouchOpen(false);
  };

  const handleEdit = () => {
    onEdit?.();
    setTouchOpen(false);
  };

  // The parent only wires up onEdit for an editable message, so this is enough.
  const canEdit = !!onEdit;

  // Row alignment lives here (not in MessageBubble) so the `group/actions`
  // hover region matches the bubble's content width — hovering empty space
  // in the row no longer reveals the toolbar.
  // The sender's avatar sits in the left gutter of an incoming group bubble —
  // outside the 75% cap, aligned to the bubble's bottom. Never for our own
  // (agent) side or an internal note (both render right-aligned).
  const showAuthorAvatar = !!isGroup && !isAgent && !message.is_internal;

  return (
    <div
      className={cn(
        "flex w-full items-end gap-2",
        isAgent ? "justify-end" : "justify-start",
      )}
      onContextMenu={handleContextMenu}
      onBlur={() => setTouchOpen(false)}
    >
      {showAuthorAvatar && (
        <GroupAuthorAvatar
          message={message}
          onClick={
            onAuthorClick && message.author_key
              ? () =>
                  onAuthorClick({
                    phone: message.author_key!,
                    name: parseGroupAuthor(message.content_text ?? "") ?? "",
                    avatarUrl: message.author_avatar_url,
                  })
              : undefined
          }
        />
      )}
      {/* `min-w-0` lets this flex child actually respect the 75% cap.
       *  Default `min-width: auto` lets content (a long quote preview,
       *  an unbroken URL) push past the cap and shove the row past
       *  100%, which used to bleed across into the contact-sidebar
       *  area. See issue #165. */}
      <div className="group/actions relative min-w-0 max-w-[75%]">
        {children}
      <div
        data-touch-open={touchOpen || pickerOpen ? "true" : undefined}
        className={cn(
          "absolute -top-3 z-10 flex h-7 items-center gap-0.5 rounded-full border border-border bg-popover/95 px-1 shadow-md backdrop-blur-sm transition-opacity",
          "opacity-0 group-hover/actions:opacity-100 group-focus-within/actions:opacity-100",
          "data-[touch-open=true]:opacity-100",
          isAgent ? "right-3" : "left-3",
        )}
      >
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger
            className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground"
            aria-label="Reagir"
          >
            <SmilePlus className="h-3.5 w-3.5" />
          </PopoverTrigger>
          <PopoverContent
            className="flex w-auto flex-row gap-1 p-1.5"
            sideOffset={6}
          >
            {QUICK_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => handlePickEmoji(e)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-lg leading-none transition-transform hover:scale-125 hover:bg-muted"
                aria-label={`Reagir com ${e}`}
              >
                {e}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        <button
          type="button"
          onClick={handleReply}
          className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground"
          aria-label="Responder"
        >
          <CornerUpLeft className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={handleForward}
          className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground"
          aria-label="Encaminhar"
        >
          <CornerUpRight className="h-3.5 w-3.5" />
        </button>
        {canEdit && (
          <button
            type="button"
            onClick={handleEdit}
            className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground"
            aria-label="Editar"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={handleCopy}
          className="flex h-5 w-5 items-center justify-center rounded-full text-popover-foreground hover:bg-muted hover:text-foreground"
          aria-label="Copiar"
        >
          <Copy className="h-3.5 w-3.5" />
        </button>
      </div>
      </div>
    </div>
  );
}

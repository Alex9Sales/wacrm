"use client";

import { Smile } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

// Curated set of common chat/business emojis. No dependency — emojis are
// just unicode characters.
export const EMOJIS = [
  "😀","😃","😄","😁","😆","😅","😂","🤣","🙂","😉","😊","😇",
  "😍","🥰","😘","😗","😋","😜","🤪","😎","🤩","🥳","😏","😌",
  "🤔","🤨","😐","😶","🙄","😬","😴","😷","🤒","🥺","😢","😭",
  "😤","😠","😡","🤯","😱","😨","😥","😓","🤗","🤭","🫡","🙏",
  "👍","👎","👌","✌️","🤞","🤟","🤙","👋","🙌","👏","💪","🫶",
  "👀","🤝","💅","🫣","🤦","🤷","💁","🙆","🙅","💃","🕺","🥂",
  "❤️","🧡","💛","💚","💙","💜","🖤","🤍","💔","❤️‍🔥","💯","🔥",
  "⭐","✨","🎉","🎊","✅","❌","⚠️","❓","❗","💰","💵","🛒",
  "📦","🚀","📞","📱","💬","📅","⏰","📌","🎁","🍺","☕","🎯",
  "💡","📸","🤑","🫰","🤌","➡️","👇","👆","🥳","😅","🙏","🤝",
];

/**
 * A reusable emoji picker button — renders a Smile trigger that opens a
 * Popover grid; clicking an emoji calls `onPick`. The popover stays open so
 * the user can pick several. Used by the WhatsApp composer and the internal
 * chat composer.
 */
export function EmojiPicker({
  onPick,
  disabled,
  className,
  title = "Emojis",
}: {
  onPick: (emoji: string) => void;
  disabled?: boolean;
  className?: string;
  title?: string;
}) {
  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        title={title}
        className={cn(
          "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className,
        )}
      >
        <Smile className="h-4 w-4" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2" aria-label="Selecionar emoji">
        <div className="grid max-h-56 grid-cols-8 gap-0.5 overflow-y-auto">
          {EMOJIS.map((emoji, i) => (
            <button
              key={`${emoji}-${i}`}
              type="button"
              onClick={() => onPick(emoji)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-xl leading-none transition-colors hover:bg-muted"
              aria-label={`Inserir ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

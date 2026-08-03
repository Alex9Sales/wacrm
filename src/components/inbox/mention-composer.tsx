"use client";

// ============================================================
// A textarea with @mention autocomplete. Typing "@" opens a member picker
// filtered by what you type; picking inserts the member's name. Reused by the
// internal chat and (later) conversation internal notes. Submit on Enter
// (Shift+Enter = newline); while the picker is open, Enter/↑/↓ drive it.
// ============================================================

import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";

import { activeMentionQuery, type MentionMember } from "@/lib/inbox/mentions";

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Render message text with @mentions of known members highlighted. */
export function MentionText({
  text,
  members,
  onPrimary,
}: {
  text: string;
  members: MentionMember[];
  /** Rendered inside a filled primary bubble (own internal-chat message).
   *  `text-primary` on a purple bubble is nearly invisible, so switch to a
   *  contrasting chip that reads on the filled background. */
  onPrimary?: boolean;
}) {
  const names = members
    .map((m) => m.name)
    .filter((n): n is string => !!n && !!n.trim())
    .sort((a, b) => b.length - a.length);
  if (names.length === 0 || !text.includes("@")) return <>{text}</>;
  const re = new RegExp(
    `@(?:${names.map(escapeRegex).join("|")})(?![\\p{L}\\p{N}])`,
    "giu",
  );
  const mentionCls = onPrimary
    ? "rounded bg-primary-foreground/25 px-1 font-semibold text-primary-foreground"
    : "font-semibold text-primary";
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) parts.push(text.slice(last, i));
    parts.push(
      <span key={i} className={mentionCls}>
        {m[0]}
      </span>,
    );
    last = i + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <>{parts}</>;
}

export interface MentionComposerHandle {
  focus: () => void;
}

interface Props {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  members: MentionMember[];
  placeholder?: string;
  disabled?: boolean;
}

export const MentionComposer = forwardRef<MentionComposerHandle, Props>(
  function MentionComposer(
    { value, onChange, onSubmit, members, placeholder, disabled },
    ref,
  ) {
    const taRef = useRef<HTMLTextAreaElement>(null);
    const [caret, setCaret] = useState(0);
    const [highlight, setHighlight] = useState(0);

    useImperativeHandle(ref, () => ({ focus: () => taRef.current?.focus() }));

    const query = activeMentionQuery(value, caret);
    const matches = useMemo(() => {
      if (query === null) return [];
      const q = query.toLowerCase();
      return members
        .filter((m) => m.name && m.name.toLowerCase().includes(q))
        .slice(0, 6);
    }, [query, members]);
    const open = matches.length > 0;

    const pick = (m: MentionMember) => {
      if (!m.name) return;
      // Replace the "@query" ending at the caret with "@Name ".
      const before = value.slice(0, caret).replace(/(?:^|\s)@[\p{L}\p{N}]*$/u, (s) =>
        s.replace(/@[\p{L}\p{N}]*$/u, `@${m.name} `),
      );
      const next = before + value.slice(caret);
      onChange(next);
      setHighlight(0);
      // Restore focus + caret after the inserted mention.
      requestAnimationFrame(() => {
        const el = taRef.current;
        if (el) {
          el.focus();
          el.selectionStart = el.selectionEnd = before.length;
          setCaret(before.length);
        }
      });
    };

    return (
      <div className="relative flex-1">
        {open && (
          <ul className="absolute bottom-full left-0 z-20 mb-1 max-h-52 w-64 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg">
            {matches.map((m, i) => (
              <li key={m.id}>
                <button
                  type="button"
                  // onMouseDown (not onClick) so the textarea doesn't blur first.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(m);
                  }}
                  className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm ${
                    i === highlight
                      ? "bg-primary/10 text-foreground"
                      : "text-foreground hover:bg-muted"
                  }`}
                >
                  <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-medium text-primary">
                    {m.name?.[0]?.toUpperCase() ?? "?"}
                  </span>
                  <span className="truncate">{m.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={taRef}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value);
            setCaret(e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyUp={(e) =>
            setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)
          }
          onClick={(e) =>
            setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)
          }
          onKeyDown={(e) => {
            if (open) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHighlight((h) => (h + 1) % matches.length);
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setHighlight((h) => (h - 1 + matches.length) % matches.length);
                return;
              }
              if (e.key === "Enter" || e.key === "Tab") {
                e.preventDefault();
                pick(matches[highlight]);
                return;
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setCaret(-1); // close the picker without changing text
                return;
              }
            }
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSubmit();
            }
          }}
          rows={1}
          placeholder={placeholder}
          className="w-full resize-none rounded-xl border border-border bg-muted px-4 py-2.5 text-sm text-foreground placeholder-muted-foreground outline-none transition-colors focus:border-primary/50"
        />
      </div>
    );
  },
);

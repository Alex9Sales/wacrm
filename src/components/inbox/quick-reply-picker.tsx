"use client";

import { useEffect, useMemo, useState } from "react";
import { Zap, Loader2 } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  listQuickReplies,
  type QuickReplyOption,
} from "@/app/(dashboard)/inbox/actions";

/**
 * Quick-replies (respostas rápidas) picker for the composer. A Zap trigger
 * opens a searchable list of the account's canned messages; picking one calls
 * `onPick(content)`. The composer can also open it programmatically (the "/"
 * trigger) via the controlled `open`/`onOpenChange` props, seeding the search
 * with `initialQuery`.
 */
export function QuickReplyPicker({
  onPick,
  disabled,
  title = "Respostas rápidas",
  open,
  onOpenChange,
  initialQuery,
}: {
  onPick: (content: string) => void;
  disabled?: boolean;
  title?: string;
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
  initialQuery?: string;
}) {
  const [items, setItems] = useState<QuickReplyOption[] | null>(null);
  const [query, setQuery] = useState("");
  const isOpen = open;

  // Load once, the first time it opens (cheap, account-scoped).
  useEffect(() => {
    if (open === false) return;
    if (items !== null) return;
    let stop = false;
    listQuickReplies()
      .then((r) => !stop && setItems(r))
      .catch(() => !stop && setItems([]));
    return () => {
      stop = true;
    };
  }, [open, items]);

  useEffect(() => {
    if (open) setQuery(initialQuery ?? "");
  }, [open, initialQuery]);

  const filtered = useMemo(() => {
    const list = items ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter(
      (i) =>
        i.shortcut.toLowerCase().includes(q) ||
        i.content.toLowerCase().includes(q),
    );
  }, [items, query]);

  return (
    <Popover open={isOpen} onOpenChange={onOpenChange}>
      <PopoverTrigger
        disabled={disabled}
        title={title}
        onClick={() => {
          // Uncontrolled fallback: if the composer isn't driving `open`,
          // let the Popover manage itself.
          if (open === undefined) return;
        }}
        className={cn(
          "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md p-0 text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <Zap className="h-4 w-4" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-80 p-2"
        aria-label="Respostas rápidas"
      >
        {/* Opening (button or the "/" shortcut) focuses this search, seeded
            with whatever was typed after the "/". The agent refines here and
            picks; the pick replaces the "/atalho" token in the composer. */}
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar resposta…"
          autoFocus
          className="mb-2 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus:border-primary/50"
        />
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {items === null ? (
            <div className="flex justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-1 py-3 text-center text-xs text-muted-foreground">
              {(items?.length ?? 0) === 0
                ? "Nenhuma resposta rápida. Crie em Configurações → Respostas rápidas."
                : "Nada encontrado."}
            </p>
          ) : (
            filtered.map((q) => (
              <button
                key={q.id}
                type="button"
                onClick={() => {
                  onPick(q.content);
                  onOpenChange?.(false);
                }}
                className="flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted"
              >
                <span className="font-mono text-xs font-medium text-primary">
                  /{q.shortcut}
                </span>
                <span className="line-clamp-2 text-xs text-muted-foreground">
                  {q.content}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

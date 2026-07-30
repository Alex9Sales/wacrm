"use client";

// Código(s) do cliente (Felipe/cema) — editor de chips ao lado do nome no
// painel do contato. As revendas de autopeças escrevem o código de cadastro do
// ERP na frente do nome; aqui vira um campo de primeira classe, múltiplo,
// editável na hora e exportável/importável em CSV + API.

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X, Hash } from "lucide-react";
import { toast } from "sonner";

import { updateContactCodes } from "@/app/(dashboard)/inbox/actions";
import { cn } from "@/lib/utils";

export function CustomerCodesEditor({
  contactId,
  codes,
  onChange,
}: {
  contactId: string;
  codes: string[];
  /** Bubble the new set up so the thread header / page stay in sync. */
  onChange?: (codes: string[]) => void;
}) {
  const [list, setList] = useState<string[]>(codes ?? []);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-seed when switching to another contact.
  useEffect(() => {
    setList(codes ?? []);
    setAdding(false);
    setDraft("");
  }, [contactId, codes]);

  const persist = useCallback(
    async (next: string[]) => {
      setBusy(true);
      try {
        const res = await updateContactCodes(contactId, next);
        if (!res.ok) {
          toast.error("Falha ao salvar o código.");
          return;
        }
        setList(res.codes);
        onChange?.(res.codes);
      } catch {
        toast.error("Falha ao salvar o código.");
      } finally {
        setBusy(false);
      }
    },
    [contactId, onChange],
  );

  const addCode = useCallback(() => {
    const c = draft.trim();
    if (!c) {
      setAdding(false);
      return;
    }
    if (list.includes(c)) {
      setDraft("");
      setAdding(false);
      return;
    }
    setDraft("");
    setAdding(false);
    void persist([...list, c]);
  }, [draft, list, persist]);

  const removeCode = useCallback(
    (code: string) => {
      void persist(list.filter((c) => c !== code));
    },
    [list, persist],
  );

  return (
    <div className="mt-2 flex flex-wrap items-center justify-center gap-1">
      {list.map((code) => (
        <span
          key={code}
          className="inline-flex items-center gap-1 rounded-full bg-primary/10 py-0.5 pl-2 pr-1 text-xs font-medium text-primary"
          title="Código do cliente"
        >
          <Hash className="size-3" />
          {code}
          <button
            type="button"
            disabled={busy}
            onClick={() => removeCode(code)}
            aria-label={`Remover código ${code}`}
            className="rounded-full p-0.5 hover:bg-primary/20 disabled:opacity-50"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}

      {adding ? (
        <input
          ref={inputRef}
          autoFocus
          value={draft}
          disabled={busy}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={addCode}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addCode();
            }
            if (e.key === "Escape") {
              setDraft("");
              setAdding(false);
            }
          }}
          placeholder="Código"
          className={cn(
            "h-6 w-20 rounded-full border border-border bg-muted px-2 text-xs text-foreground outline-none focus:border-primary",
          )}
        />
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => setAdding(true)}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:border-primary hover:text-primary disabled:opacity-50"
        >
          <Plus className="size-3" />
          {list.length === 0 ? "Código do cliente" : "Código"}
        </button>
      )}
    </div>
  );
}

"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, Plus, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { filterReasons } from "@/lib/deals/lost-reasons";

/**
 * Seletor do MOTIVO DE PERDA — um só para todo "Confirmar perda" (formulário
 * do negócio, detalhe do negócio e card da lateral da conversa).
 *
 * Por quê (02/10/2026, Rafael): a conta dele tem muitos motivos e eles
 * apareciam como uma fila de "chips" que fazia o painel crescer até empurrar
 * o botão "Confirmar perda" pra fora da tela. Agora: busca no topo (sem
 * acento/caixa, ver `filterReasons`), lista com altura máxima e rolagem
 * própria, item escolhido destacado e teclado (↑/↓ + Enter) na busca.
 *
 * Mantém o comportamento de antes:
 *  - a ordem é a que vem da conta (`sortReasons`: alfabética, "Outros" no fim);
 *  - lista FECHADA (Config → Negócios): só dá pra escolher da lista — o texto
 *    livre some e o motivo é obrigatório (quem chama trava o botão);
 *  - lista aberta: continua o campo "Ou escreva um motivo novo" (vira opção
 *    pra próxima no servidor) — ele mostra o motivo escolhido, como antes.
 *
 * `value` é o motivo atual (escolhido ou digitado) e é de quem chama.
 */
export function LostReasonPicker({
  reasons,
  locked,
  value,
  onChange,
  loading = false,
  size = "md",
  autoFocus = false,
  freeTextPlaceholder = "Ou escreva um motivo novo",
}: {
  reasons: string[];
  locked: boolean;
  value: string;
  onChange: (reason: string) => void;
  /** Motivos ainda carregando (some a mensagem de lista vazia enquanto isso). */
  loading?: boolean;
  /** "sm" = card estreito da lateral da conversa. */
  size?: "sm" | "md";
  /** Põe o cursor na busca quando os motivos chegam (sem roubar foco). */
  autoFocus?: boolean;
  freeTextPlaceholder?: string;
}) {
  const baseId = useId();
  const listId = `${baseId}-motivos`;
  const optionId = (i: number) => `${baseId}-motivo-${i}`;
  const [query, setQuery] = useState("");
  // Item "ativo" do teclado (−1 = nenhum). Ao digitar, o 1º resultado fica
  // ativo — "caro" + Enter já escolhe "Achou caro".
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => filterReasons(reasons, query), [reasons, query]);
  const activeIdx = active < filtered.length ? active : -1;
  const typed = query.trim();
  const sm = size === "sm";
  const hasOptions = reasons.length > 0;

  // Foco na busca quando os motivos chegam (carregam depois de abrir o
  // painel). Não usa o atributo autoFocus porque ele roubaria o cursor de
  // quem já começou a escrever no campo de texto livre enquanto carregava.
  useEffect(() => {
    if (!autoFocus || !hasOptions) return;
    const el = document.activeElement as HTMLElement | null;
    if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable)) return;
    searchRef.current?.focus();
  }, [autoFocus, hasOptions]);

  // ↑/↓ levam o item ativo pra dentro da área visível da lista ("nearest":
  // só a lista rola, o painel em volta não sacode). Só no teclado — no
  // mouse o item já está à vista.
  const moveActive = (next: number) => {
    setActive(next);
    const el = listRef.current?.children[next] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  };

  // Lista aberta: o que foi digitado na busca e não existe vira o motivo
  // (mesmo efeito de escrever no campo de texto livre).
  const pickTyped = () => {
    if (locked || !typed) return;
    onChange(typed);
    setQuery("");
    setActive(-1);
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (filtered.length) moveActive(Math.min(filtered.length - 1, activeIdx + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (filtered.length) moveActive(Math.max(0, activeIdx - 1));
    } else if (e.key === "Enter") {
      // Enter nunca "envia" nada por engano: escolhe o item ativo ou, sem
      // resultado e com lista aberta, usa o texto como motivo novo.
      e.preventDefault();
      if (activeIdx >= 0 && filtered[activeIdx]) onChange(filtered[activeIdx]);
      else if (filtered.length === 0) pickTyped();
    }
  };

  const text = sm ? "text-[11px]" : "text-sm";

  return (
    <div className="space-y-1.5">
      {loading && reasons.length === 0 && (
        <p className={cn("text-muted-foreground", sm ? "text-[10px]" : "text-xs")}>
          Carregando motivos…
        </p>
      )}

      {hasOptions && (
        <div className="overflow-hidden rounded-md border border-border bg-background">
          <div className="relative border-b border-border">
            <Search
              className={cn(
                "pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground",
                sm ? "left-2 h-3 w-3" : "left-2.5 h-3.5 w-3.5",
              )}
            />
            <input
              ref={searchRef}
              type="text"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={activeIdx >= 0 ? optionId(activeIdx) : undefined}
              aria-label="Buscar motivo de perda"
              autoComplete="off"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(e.target.value.trim() ? 0 : -1);
              }}
              onKeyDown={onSearchKey}
              placeholder={`Buscar entre ${reasons.length} motivo${reasons.length === 1 ? "" : "s"}…`}
              className={cn(
                "w-full bg-transparent pr-2 text-foreground outline-none placeholder:text-muted-foreground",
                sm ? "h-7 pl-6 text-[11px]" : "h-8 pl-8 text-sm",
              )}
            />
          </div>

          {/* Altura máxima + rolagem PRÓPRIA: 40 motivos não esticam mais o
              painel (overscroll-contain: rolar a lista não arrasta a página). */}
          <ul
            id={listId}
            ref={listRef}
            role="listbox"
            aria-label="Motivos de perda"
            className={cn(
              "overflow-y-auto overscroll-contain p-1",
              sm ? "max-h-44" : "max-h-60",
            )}
          >
            {filtered.length === 0 ? (
              <li className={cn("px-2 py-2 text-center text-muted-foreground", text)}>
                Nenhum motivo com &apos;{typed}&apos;
                {!locked && (
                  <button
                    type="button"
                    onClick={pickTyped}
                    className="mx-auto mt-1.5 flex max-w-full items-center gap-1 rounded-md border border-dashed border-border px-2 py-1 text-foreground transition-colors hover:bg-muted"
                  >
                    <Plus className="h-3 w-3 shrink-0" />
                    <span className="truncate">Usar &ldquo;{typed}&rdquo; como motivo</span>
                  </button>
                )}
              </li>
            ) : (
              filtered.map((r, i) => {
                const selected = value === r;
                return (
                  <li
                    key={r}
                    id={optionId(i)}
                    role="option"
                    aria-selected={selected}
                    // mousedown sem foco: o cursor continua na busca, o
                    // teclado segue funcionando depois do clique.
                    onMouseDown={(e) => e.preventDefault()}
                    onMouseMove={() => activeIdx !== i && setActive(i)}
                    onClick={() => onChange(r)}
                    className={cn(
                      "flex cursor-pointer items-center justify-between gap-2 rounded px-2",
                      sm ? "py-1" : "py-1.5",
                      text,
                      selected
                        ? "bg-red-500/15 font-medium text-red-600 dark:text-red-400"
                        : i === activeIdx
                          ? "bg-muted text-foreground"
                          : "text-foreground",
                    )}
                  >
                    <span className="truncate">{r}</span>
                    {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                  </li>
                );
              })
            )}
          </ul>
        </div>
      )}

      {/* Lista fechada: o escolhido fica escrito mesmo se a busca o esconder. */}
      {locked && value && (
        <p className={cn("text-muted-foreground", sm ? "text-[10px]" : "text-xs")}>
          Motivo escolhido: <strong className="text-foreground">{value}</strong>
        </p>
      )}

      {locked && !loading && reasons.length === 0 && (
        <p className={cn("text-muted-foreground", sm ? "text-[10px]" : "text-xs")}>
          Lista de motivos fechada e vazia — cadastre em{" "}
          <strong>Configurações → Negócios</strong>.
        </p>
      )}

      {!locked && (
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={freeTextPlaceholder}
          aria-label="Motivo de perda (texto livre)"
          className={cn(
            "w-full rounded-md border border-border bg-background px-2 text-foreground outline-none placeholder:text-muted-foreground focus:border-red-400",
            sm ? "h-7 text-xs" : "h-8 text-sm",
          )}
        />
      )}
    </div>
  );
}

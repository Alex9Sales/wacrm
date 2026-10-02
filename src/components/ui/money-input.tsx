"use client";

import * as React from "react";
import { Input } from "@/components/ui/input";
import { formatBrlInput, parseBrlField } from "@/lib/format/parse-brl";

/**
 * Campo de dinheiro no formato brasileiro (02/10/2026, Rafael colava
 * "1.028,67" no valor do negócio e o sistema "não entendia").
 *
 * - É TEXTO com teclado decimal (`inputMode="decimal"`), não
 *   `type="number"`: o campo numérico do navegador recusa a vírgula e devolve
 *   "" ao colar "1.028,67" — o valor sumia calado.
 * - Enquanto digita, o texto fica exatamente como a pessoa escreveu (nada de
 *   reformatar no meio da edição). Ao SAIR do campo, se o valor foi entendido,
 *   ele aparece formatado ("1028.67" → "1.028,67") — a pessoa vê como o
 *   sistema leu antes de salvar.
 * - Texto que não é número fica marcado (borda vermelha + dica) em vez de
 *   virar 0; quem chama confere `parseBrlField(texto).invalid` ao salvar.
 *
 * O estado é o TEXTO (de quem chama); o número sai de `parseBrl`/
 * `parseBrlField` na hora de usar.
 */
export function MoneyInput({
  value,
  onValueChange,
  minFractionDigits = 2,
  onBlur,
  title,
  ...props
}: Omit<
  React.ComponentProps<"input">,
  "type" | "value" | "onChange" | "inputMode" | "defaultValue"
> & {
  value: string;
  onValueChange: (text: string) => void;
  /** Casas decimais mínimas ao formatar na saída: 2 = dinheiro, 0 = percentual. */
  minFractionDigits?: number;
}) {
  const { value: parsed, invalid } = parseBrlField(value);
  return (
    <Input
      autoComplete="off"
      {...props}
      type="text"
      inputMode="decimal"
      value={value}
      aria-invalid={invalid || props["aria-invalid"] || undefined}
      title={invalid ? "Não entendi esse valor — use, por exemplo, 1.028,67" : title}
      onChange={(e) => onValueChange(e.target.value)}
      onBlur={(e) => {
        if (parsed !== null) {
          const pretty = formatBrlInput(parsed, minFractionDigits);
          if (pretty !== value) onValueChange(pretty);
        }
        onBlur?.(e);
      }}
    />
  );
}

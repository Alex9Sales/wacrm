"use client";

import { useState } from "react";
import type { CustomField } from "@/types";
import { MoneyInput } from "@/components/ui/money-input";
import {
  currencyInputToStored,
  currencyStoredToInput,
} from "@/lib/custom-fields/currency";

const DEFAULT_CLASS =
  "h-8 w-full rounded-lg border border-border bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary";

/**
 * Editor de UM valor de campo personalizado. Renderiza o input conforme o
 * field_type: lista(select), número, data, sim/não(boolean), moeda(R$) ou
 * texto. O valor é sempre string (guardado como texto). Reusado no contato
 * (sidebar) e no detalhe do negócio (paridade RD).
 */
export function CustomFieldInput({
  field,
  value,
  onChange,
  className,
}: {
  field: CustomField;
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const base = className ?? DEFAULT_CLASS;
  const type = field.field_type;

  // Lista (select)
  if (type === "select") {
    const options = (field.field_options?.options as string[] | undefined) ?? [];
    return (
      <select value={value} onChange={(e) => onChange(e.target.value)} className={base}>
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  // Sim/Não (boolean) — guardado como 'true' / '' (vazio = não).
  if (type === "boolean") {
    const checked = value === "true";
    return (
      <label className="inline-flex h-8 cursor-pointer items-center gap-2 text-xs text-foreground">
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange(e.target.checked ? "true" : "")}
          className="h-4 w-4 accent-primary"
        />
        {checked ? "Sim" : "Não"}
      </label>
    );
  }

  // Data
  if (type === "date") {
    return (
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={base}
      />
    );
  }

  // Número
  if (type === "number") {
    return (
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="—"
        className={`${base} placeholder-muted-foreground`}
      />
    );
  }

  // Moeda (R$) — ver CurrencyFieldInput.
  if (type === "currency") {
    return <CurrencyFieldInput value={value} onChange={onChange} className={className} />;
  }

  // Texto (padrão)
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="—"
      className={`${base} placeholder-muted-foreground`}
    />
  );
}

/**
 * Campo de MOEDA (02/10/2026, Rafael colava "1.028,67" e o valor sumia: o
 * antigo <input type="number"> recusa a vírgula e devolvia "" calado).
 *
 * Na tela é o MoneyInput (aceita "1.028,67", "R$ 1.028,67", "1028.67" e
 * formata pt-BR ao sair do campo); pro pai — e pro banco — sobe o MESMO
 * formato que o type="number" sempre gravou ("1028.67", "1500"), porque o
 * Disparo, o filtro de público e a IA leem esse texto cru (ver
 * lib/custom-fields/currency.ts). Texto que não é número sobe como digitado e
 * o salvar recusa com aviso — nunca vira 0.
 *
 * O texto da tela é estado LOCAL: "1.028,67" e "1028.67" gravam igual, então
 * não dá pra derivar a tela do valor do pai sem reformatar no meio da
 * digitação. `shown` é o valor gravado que o texto representa; se o pai
 * trocar o valor por fora (recarregou, outra conversa), a tela acompanha.
 */
function CurrencyFieldInput({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  const [text, setText] = useState(() => currencyStoredToInput(value));
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    setText(currencyStoredToInput(value));
  }
  return (
    <div className="flex items-center gap-1">
      <span className="text-xs text-muted-foreground">R$</span>
      <MoneyInput
        value={text}
        onValueChange={(next) => {
          setText(next);
          const stored = currencyInputToStored(next);
          setShown(stored);
          // Formatar ao sair do campo ("1028.67" → "1.028,67") não muda o
          // valor gravado — não pode marcar o formulário como alterado.
          if (stored !== value) onChange(stored);
        }}
        placeholder="0,00"
        // O Input base traz md:text-sm e fundo próprio no escuro; no padrão
        // o campo de moeda fica igual aos vizinhos (text-xs, bg-muted).
        className={
          className
            ? `${className} placeholder-muted-foreground`
            : `${DEFAULT_CLASS} placeholder-muted-foreground md:text-xs dark:bg-muted`
        }
      />
    </div>
  );
}

"use client";

import type { CustomField } from "@/types";

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
  const base =
    className ??
    "h-8 w-full rounded-lg border border-border bg-muted px-2.5 text-xs text-foreground outline-none focus:border-primary";
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

  // Moeda (R$) — input numérico com prefixo; guarda o número em string.
  if (type === "currency") {
    return (
      <div className="flex items-center gap-1">
        <span className="text-xs text-muted-foreground">R$</span>
        <input
          type="number"
          min={0}
          step="0.01"
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="0,00"
          className={`${base} placeholder-muted-foreground`}
        />
      </div>
    );
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

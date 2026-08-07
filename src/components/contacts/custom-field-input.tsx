"use client";

import type { CustomField } from "@/types";

/**
 * Editor de UM valor de campo personalizado. Renderiza `<select>` quando o
 * campo é do tipo 'select' (com `field_options.options`), senão um `<input>`
 * de texto. Reusado no contato (sidebar) e no detalhe do negócio (paridade RD).
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
  const options =
    field.field_type === "select"
      ? ((field.field_options?.options as string[] | undefined) ?? [])
      : null;

  if (options) {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={base}
      >
        <option value="">—</option>
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="—"
      className={`${base} placeholder-muted-foreground`}
    />
  );
}

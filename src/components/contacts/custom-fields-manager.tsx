'use client';

import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import type { CustomField } from '@/types';
import {
  listCustomFields,
  createCustomField,
  renameCustomField,
  deleteCustomField,
  type CustomFieldType,
} from '@/app/(dashboard)/contacts/actions';

const TYPE_LABELS: Record<CustomFieldType, string> = {
  text: 'Texto',
  select: 'Seleção',
  number: 'Número',
  date: 'Data',
  boolean: 'Sim/Não',
  currency: 'Moeda (R$)',
};
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Loader2, Plus, Trash2 } from 'lucide-react';

interface CustomFieldsManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Dialog wrapper around {@link CustomFieldsPanel}, used on the Contacts page.
 * The same panel is rendered inline under Settings → Custom Fields, so the
 * editing UI lives in one place. Radix unmounts the dialog content on close,
 * so the panel remounts (and refetches) on each open.
 */
export function CustomFieldsManager({
  open,
  onOpenChange,
}: CustomFieldsManagerProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">Campos personalizados</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            Defina campos extras do <b>contato</b> (ex.: CEP, origem) ou do{' '}
            <b>negócio</b> (ex.: orçamento, concorrente). Escolha o tipo
            (texto, lista, número, data, sim/não, moeda). Aparecem na ficha do
            contato ou do negócio.
          </DialogDescription>
        </DialogHeader>
        <CustomFieldsPanel />
      </DialogContent>
    </Dialog>
  );
}

/**
 * Create / rename / delete account-wide custom contact field definitions.
 * Per-contact values are edited elsewhere (contact detail → Custom Fields);
 * this only manages the field catalogue. Admin+ gated by the caller — the
 * `custom_fields` RLS also rejects non-admin writes as defense in depth.
 */
export function CustomFieldsPanel() {
  const { user, accountId } = useAuth();

  const [fields, setFields] = useState<CustomField[]>([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<CustomFieldType>('text');
  const [newEntity, setNewEntity] = useState<'contact' | 'deal'>('contact');
  const [newOptions, setNewOptions] = useState('');
  const [creating, setCreating] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const fetchFields = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    try {
      const data = await listCustomFields();
      setFields(data);
    } catch {
      setFields([]);
    }
    setLoading(false);
  }, [accountId]);

  // Load the field list on mount once the account is known. The setters
  // inside fetchFields run after the Supabase await — not synchronously in
  // the effect body — so the cascade the lint rule warns about doesn't apply.
  useEffect(() => {
    if (accountId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      fetchFields();
    }
  }, [accountId, fetchFields]);

  /** Case-insensitive name clash within the SAME entity (contato/negócio). */
  function isDuplicate(name: string, exceptId?: string, entity?: string): boolean {
    const lower = name.toLowerCase();
    const ent = entity ?? newEntity;
    return fields.some(
      (f) =>
        f.id !== exceptId &&
        (f.entity ?? 'contact') === ent &&
        f.field_name.toLowerCase() === lower,
    );
  }

  async function handleCreate() {
    const name = newName.trim();
    if (!name) return;
    if (!accountId || !user) {
      toast.error('Seu perfil não está vinculado a uma conta.');
      return;
    }
    if (isDuplicate(name)) {
      toast.error(`Já existe um campo chamado "${name}".`);
      return;
    }

    const options =
      newType === 'select'
        ? newOptions
            .split(/[\n,]/)
            .map((o) => o.trim())
            .filter(Boolean)
        : [];
    if (newType === 'select' && options.length === 0) {
      toast.error('Adicione ao menos uma opção para o campo de seleção.');
      return;
    }

    setCreating(true);
    const { error } = await createCustomField(name, newType, options, newEntity);
    setCreating(false);

    if (error) {
      toast.error(error || 'Não foi possível criar o campo. Você pode não ter permissão.');
      return;
    }
    toast.success(`"${name}" criado.`);
    setNewName('');
    setNewOptions('');
    setNewType('text');
    await fetchFields();
  }

  /** Returns true on success so the row can keep the new name, false so it
   *  reverts to the previous one. No-ops (blank / unchanged) count as success. */
  async function handleRename(
    field: CustomField,
    nextName: string
  ): Promise<boolean> {
    const name = nextName.trim();
    if (!name || name === field.field_name) return true;
    if (isDuplicate(name, field.id)) {
      toast.error(`Já existe um campo chamado "${name}".`);
      return false;
    }
    setBusyId(field.id);
    const { error } = await renameCustomField(field.id, name);
    setBusyId(null);
    if (error) {
      toast.error(error || 'Não foi possível renomear o campo.');
      return false;
    }
    await fetchFields();
    return true;
  }

  async function handleDelete(field: CustomField) {
    if (
      !window.confirm(
        `Excluir "${field.field_name}"? Isso também remove o valor armazenado em todos os contatos. Esta ação não pode ser desfeita.`
      )
    ) {
      return;
    }
    setBusyId(field.id);
    const { error } = await deleteCustomField(field.id);
    setBusyId(null);
    if (error) {
      toast.error(error || 'Não foi possível excluir o campo.');
      return;
    }
    toast.success(`"${field.field_name}" excluído.`);
    await fetchFields();
  }

  return (
    <div className="space-y-4">
      {/* Create */}
      <div className="space-y-2 rounded-md border border-border bg-muted/30 p-3">
        <div className="flex items-center gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newType === 'text') {
                e.preventDefault();
                void handleCreate();
              }
            }}
            placeholder="Nome do novo campo…"
            className="bg-muted text-foreground"
          />
          <select
            value={newEntity}
            onChange={(e) => setNewEntity(e.target.value as 'contact' | 'deal')}
            title="Onde o campo aparece"
            className="shrink-0 rounded-md border border-border bg-muted px-2 py-1.5 text-xs text-foreground"
          >
            <option value="contact">Contato</option>
            <option value="deal">Negócio</option>
          </select>
          <select
            value={newType}
            onChange={(e) => setNewType(e.target.value as CustomFieldType)}
            title="Tipo do campo"
            className="shrink-0 rounded-md border border-border bg-muted px-2 py-1.5 text-xs text-foreground"
          >
            {(Object.keys(TYPE_LABELS) as CustomFieldType[]).map((t) => (
              <option key={t} value={t}>
                {TYPE_LABELS[t]}
              </option>
            ))}
          </select>
          <Button
            onClick={handleCreate}
            disabled={creating || !newName.trim()}
            className="bg-primary hover:bg-primary/90 text-primary-foreground shrink-0"
          >
            {creating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Adicionar
          </Button>
        </div>
        {newType === 'select' && (
          <Input
            value={newOptions}
            onChange={(e) => setNewOptions(e.target.value)}
            placeholder="Opções separadas por vírgula (ex.: Achou caro, Não responde, Comprou concorrente)"
            className="bg-muted text-foreground text-sm"
          />
        )}
      </div>

      {/* List */}
      <div className="max-h-72 overflow-y-auto rounded-md border border-border">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Carregando…
          </div>
        ) : fields.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Nenhum campo personalizado ainda.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {fields.map((field) => (
              <FieldRow
                key={field.id}
                field={field}
                busy={busyId === field.id}
                onRename={handleRename}
                onDelete={handleDelete}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A single editable row. Controlled local state lets us commit on blur /
 *  Enter and cleanly revert to the last saved name when a rename fails. */
function FieldRow({
  field,
  busy,
  onRename,
  onDelete,
}: {
  field: CustomField;
  busy: boolean;
  onRename: (field: CustomField, name: string) => Promise<boolean>;
  onDelete: (field: CustomField) => void;
}) {
  const [name, setName] = useState(field.field_name);

  async function commit() {
    if (name.trim() === field.field_name) {
      setName(field.field_name); // normalise any whitespace-only edit
      return;
    }
    const ok = await onRename(field, name);
    if (!ok) setName(field.field_name);
  }

  return (
    <li className="flex items-center gap-2 px-3 py-2">
      <Input
        value={name}
        disabled={busy}
        onChange={(e) => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        aria-label={`Renomear ${field.field_name}`}
        className="focus:border-primary h-8 border-transparent bg-transparent text-foreground hover:border-border"
      />
      <span className="shrink-0 whitespace-nowrap rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
        {(field.entity ?? 'contact') === 'deal' ? 'Negócio' : 'Contato'} ·{' '}
        {TYPE_LABELS[field.field_type as CustomFieldType] ?? field.field_type}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        disabled={busy}
        onClick={() => onDelete(field)}
        title="Excluir campo"
        className="shrink-0 text-muted-foreground hover:text-red-400"
      >
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Trash2 className="size-4" />
        )}
      </Button>
    </li>
  );
}

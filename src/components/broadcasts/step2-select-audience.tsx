'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { listTags } from '@/app/(dashboard)/contacts/actions';
import { parseCsv } from '@/lib/broadcasts/csv';
import { toast } from 'sonner';
import {
  listCustomFields,
  estimateAudienceCount,
} from '@/app/(dashboard)/broadcasts/actions';
import { CustomField, Tag } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Users,
  Tags,
  Filter,
  Upload,
  Loader2,
  ArrowRight,
  ArrowLeft,
  X,
} from 'lucide-react';

type AudienceType = 'all' | 'tags' | 'custom_field' | 'csv';
type CustomFieldOperator = 'is' | 'is_not' | 'contains';

interface CustomFieldFilter {
  fieldId: string;
  operator: CustomFieldOperator;
  value: string;
}

interface AudienceConfig {
  type: AudienceType;
  tagIds?: string[];
  customField?: CustomFieldFilter;
  csvContacts?: { phone: string; name?: string }[];
  excludeTagIds?: string[];
}

interface Step2Props {
  audience: AudienceConfig;
  onUpdate: (audience: AudienceConfig) => void;
  onNext: () => void;
  onBack: () => void;
}

const audienceOptions: {
  type: AudienceType;
  label: string;
  description: string;
  icon: typeof Users;
}[] = [
  {
    type: 'all',
    label: 'Todos os contatos',
    description: 'Enviar para todos os contatos da sua base',
    icon: Users,
  },
  {
    type: 'tags',
    label: 'Filtrar por etiquetas',
    description: 'Segmentar contatos com etiquetas específicas',
    icon: Tags,
  },
  {
    type: 'custom_field',
    label: 'Campo personalizado',
    description: 'Filtrar pelo valor de um campo personalizado',
    icon: Filter,
  },
  {
    type: 'csv',
    label: 'Importar CSV',
    description: 'Importar uma lista de números de telefone',
    icon: Upload,
  },
];

const OPERATOR_OPTIONS: { value: CustomFieldOperator; label: string }[] = [
  { value: 'is', label: 'é' },
  { value: 'is_not', label: 'não é' },
  { value: 'contains', label: 'contém' },
];

export function Step2SelectAudience({
  audience,
  onUpdate,
  onNext,
  onBack,
}: Step2Props) {
  const [tags, setTags] = useState<Tag[]>([]);
  // Importar CSV: clique OU arrastar-e-soltar no card.
  const csvFileRef = useRef<HTMLInputElement>(null);
  const [csvFileName, setCsvFileName] = useState('');
  const [csvDragOver, setCsvDragOver] = useState(false);

  const readCsvFile = useCallback(
    (file: File | null) => {
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const parsed = parseCsv(String(reader.result ?? ''));
        if (parsed.length === 0) {
          toast.error(
            'Nenhum telefone encontrado no arquivo. Confira as colunas do CSV.',
          );
          return;
        }
        setCsvFileName(file.name);
        onUpdate({ ...audience, type: 'csv', csvContacts: parsed });
        toast.success(`${parsed.length} contato(s) importados do CSV.`);
      };
      reader.readAsText(file);
    },
    [audience, onUpdate],
  );
  const [customFields, setCustomFields] = useState<CustomField[]>([]);
  const [loadingTags, setLoadingTags] = useState(false);
  const [loadingFields, setLoadingFields] = useState(false);
  const [estimatedCount, setEstimatedCount] = useState<number | null>(null);
  const [loadingCount, setLoadingCount] = useState(false);

  // Tags are used both by the primary "Filter by Tags" audience type
  // AND by the exclude-list below — so always load once on mount.
  useEffect(() => {
    async function fetchTags() {
      setLoadingTags(true);
      try {
        // listTags returns account tags; sort by name to preserve the
        // old `.order('name')` ordering.
        const data = await listTags();
        setTags(
          [...data].sort((a, b) => a.name.localeCompare(b.name)),
        );
      } finally {
        setLoadingTags(false);
      }
    }
    fetchTags();
  }, []);

  // Lazy-load custom fields only when that audience type is active.
  useEffect(() => {
    if (audience.type !== 'custom_field') return;
    async function fetchFields() {
      setLoadingFields(true);
      try {
        // Already ordered by field_name in the action.
        const data = await listCustomFields();
        setCustomFields(data ?? []);
      } finally {
        setLoadingFields(false);
      }
    }
    fetchFields();
  }, [audience.type]);

  const fetchEstimatedCount = useCallback(async () => {
    setLoadingCount(true);
    try {
      // CSV count is known client-side — no round-trip needed.
      if (audience.type === 'csv') {
        if (audience.csvContacts && audience.csvContacts.length > 0) {
          setEstimatedCount(audience.csvContacts.length);
        } else {
          setEstimatedCount(null);
        }
        return;
      }

      // Guard partially-configured audiences so we don't ask the server
      // for a count that would come back null anyway.
      if (
        audience.type === 'tags' &&
        (!audience.tagIds || audience.tagIds.length === 0)
      ) {
        setEstimatedCount(null);
        return;
      }
      if (
        audience.type === 'custom_field' &&
        (!audience.customField?.fieldId || !audience.customField.value)
      ) {
        setEstimatedCount(null);
        return;
      }

      // The action resolves the base set + exclude subtraction server
      // side, all account-scoped.
      const n = await estimateAudienceCount({
        type: audience.type,
        tagIds: audience.tagIds,
        customField: audience.customField,
        excludeTagIds: audience.excludeTagIds,
      });
      setEstimatedCount(n);
    } finally {
      setLoadingCount(false);
    }
  }, [
    audience.type,
    audience.tagIds,
    audience.customField,
    audience.csvContacts,
    audience.excludeTagIds,
  ]);

  useEffect(() => {
    fetchEstimatedCount();
  }, [fetchEstimatedCount]);

  function toggleTag(tagId: string) {
    const current = audience.tagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, tagIds: updated });
  }

  function toggleExcludeTag(tagId: string) {
    const current = audience.excludeTagIds ?? [];
    const updated = current.includes(tagId)
      ? current.filter((id) => id !== tagId)
      : [...current, tagId];
    onUpdate({ ...audience, excludeTagIds: updated });
  }

  function updateCustomField(patch: Partial<CustomFieldFilter>) {
    const prev = audience.customField ?? {
      fieldId: '',
      operator: 'is' as CustomFieldOperator,
      value: '',
    };
    onUpdate({ ...audience, customField: { ...prev, ...patch } });
  }

  const isValid =
    audience.type === 'all' ||
    (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) ||
    (audience.type === 'custom_field' &&
      !!audience.customField?.fieldId &&
      audience.customField.value.length > 0) ||
    (audience.type === 'csv' &&
      audience.csvContacts &&
      audience.csvContacts.length > 0);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Selecionar audiência</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Escolha quem vai receber este disparo.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {audienceOptions.map((option) => {
          const isSelected = audience.type === option.type;
          const Icon = option.icon;
          return (
            <button
              key={option.type}
              onClick={() =>
                onUpdate({
                  ...audience,
                  type: option.type,
                  // Wipe shape fields from other types to avoid stale
                  // config leaking across selections.
                  tagIds: option.type === 'tags' ? audience.tagIds : undefined,
                  customField:
                    option.type === 'custom_field'
                      ? audience.customField
                      : undefined,
                  csvContacts:
                    option.type === 'csv' ? audience.csvContacts : undefined,
                })
              }
              className={`flex items-start gap-3 rounded-xl border p-4 text-left transition-all ${
                isSelected
                  ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                  : 'border-border bg-card/50 hover:border-border'
              }`}
            >
              <div
                className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${
                  isSelected
                    ? 'bg-primary/10 text-primary'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                <Icon className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">{option.label}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {option.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      {audience.type === 'tags' && (
        <div className="rounded-xl border border-border bg-card/50 p-4">
          <p className="mb-3 text-sm font-medium text-foreground">Selecionar etiquetas</p>
          {loadingTags ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : tags.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nenhuma etiqueta encontrada. Crie etiquetas em Configurações.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {tags.map((tag) => {
                const isSelected = audience.tagIds?.includes(tag.id);
                return (
                  <button
                    key={tag.id}
                    onClick={() => toggleTag(tag.id)}
                    className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                      isSelected
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'border-border bg-muted text-muted-foreground hover:border-border'
                    }`}
                  >
                    <span
                      className="mr-1.5 h-2 w-2 rounded-full"
                      style={{ backgroundColor: tag.color }}
                    />
                    {tag.name}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {audience.type === 'custom_field' && (
        <div className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <p className="text-sm font-medium text-foreground">Filtro por campo personalizado</p>
          {loadingFields ? (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          ) : customFields.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              Nenhum campo personalizado definido. Crie um em Configurações → Campos personalizados.
            </p>
          ) : (
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_140px_minmax(0,1fr)]">
              <select
                value={audience.customField?.fieldId ?? ''}
                onChange={(e) => updateCustomField({ fieldId: e.target.value })}
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                <option value="">Selecionar campo…</option>
                {customFields.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.field_name}
                  </option>
                ))}
              </select>
              <select
                value={audience.customField?.operator ?? 'is'}
                onChange={(e) =>
                  updateCustomField({
                    operator: e.target.value as CustomFieldOperator,
                  })
                }
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
              >
                {OPERATOR_OPTIONS.map((op) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                value={audience.customField?.value ?? ''}
                onChange={(e) => updateCustomField({ value: e.target.value })}
                placeholder="Valor"
                className="h-9 rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary focus:ring-1 focus:ring-primary"
              />
            </div>
          )}
        </div>
      )}

      {audience.type === 'csv' && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setCsvDragOver(true);
          }}
          onDragLeave={() => setCsvDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setCsvDragOver(false);
            readCsvFile(e.dataTransfer.files?.[0] ?? null);
          }}
          onClick={() => csvFileRef.current?.click()}
          className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition ${
            csvDragOver
              ? 'border-primary bg-primary/5'
              : 'border-border bg-card/50 hover:border-primary/50'
          }`}
        >
          <input
            ref={csvFileRef}
            type="file"
            accept=".csv,text/csv,text/plain"
            className="hidden"
            onChange={(e) => {
              readCsvFile(e.target.files?.[0] ?? null);
              e.target.value = '';
            }}
          />
          <Upload className="mx-auto mb-2 h-6 w-6 text-muted-foreground" />
          {audience.csvContacts && audience.csvContacts.length > 0 ? (
            <>
              <p className="text-sm font-medium text-foreground">
                {csvFileName || 'CSV importado'} —{' '}
                {audience.csvContacts.length.toLocaleString()} contato(s)
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Arraste outro arquivo (ou clique) para substituir.
              </p>
            </>
          ) : (
            <>
              <p className="text-sm font-medium text-foreground">
                Arraste o arquivo CSV aqui
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                ou clique para escolher. Colunas: telefone (com DDD) e nome —
                com ou sem cabeçalho; vírgula, ponto e vírgula ou tabulação.
              </p>
            </>
          )}
        </div>
      )}

      {/* Exclude list — applies regardless of audience type */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <div className="mb-3 flex items-center gap-2">
          <X className="h-4 w-4 text-red-400" />
          <p className="text-sm font-medium text-foreground">
            Excluir contatos com estas etiquetas
          </p>
          <span className="text-xs text-muted-foreground">(opcional)</span>
        </div>
        {tags.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nenhuma etiqueta disponível.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {tags.map((tag) => {
              const isExcluded = audience.excludeTagIds?.includes(tag.id);
              return (
                <button
                  key={tag.id}
                  onClick={() => toggleExcludeTag(tag.id)}
                  className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium transition-all ${
                    isExcluded
                      ? 'border-red-500/30 bg-red-500/10 text-red-300'
                      : 'border-border bg-muted text-muted-foreground hover:border-border'
                  }`}
                >
                  <span
                    className="mr-1.5 h-2 w-2 rounded-full"
                    style={{ backgroundColor: tag.color }}
                  />
                  {tag.name}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Audience Summary */}
      <div className="rounded-xl border border-border bg-card/50 p-4">
        <p className="mb-2 text-sm font-medium text-foreground">Resumo da audiência</p>
        {loadingCount ? (
          <div className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <span className="text-xs text-muted-foreground">Calculando…</span>
          </div>
        ) : estimatedCount !== null ? (
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-primary" />
            <span className="text-sm text-foreground">
              {estimatedCount.toLocaleString()}
            </span>
            <span className="text-xs text-muted-foreground">destinatários estimados</span>
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">
            Selecione um tipo de audiência para ver a estimativa.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          Voltar
        </Button>
        <Button
          onClick={onNext}
          disabled={!isValid}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Próximo
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

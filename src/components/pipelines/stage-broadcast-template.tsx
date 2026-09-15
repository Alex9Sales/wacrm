'use client'

// Template da API oficial no disparo pela etapa: escolher um template
// APROVADO, dizer o que vai em cada {{n}} (campo do contato ou texto fixo),
// mandar o arquivo quando o cabeçalho é de mídia e ver a prévia com o 1º lead.
// 15/09 (GoLink): a etapa passou a ter os mesmos tipos dos Disparos. Regras
// (validação, "Se faltar", prévia) em lib/broadcasts/template-vars.ts — as
// mesmas que o servidor usa pra montar cada envio.

import { useMemo, useRef } from 'react'
import { toast } from 'sonner'
import { ImageIcon, Loader2, RefreshCw } from 'lucide-react'

import type { MessageTemplate } from '@/types'
import type { ContactVars } from '@/lib/whatsapp/message-vars'
import { MEDIA_MAX_BYTES_BY_KIND, uploadAccountMedia } from '@/lib/storage/upload-media'
import {
  TEMPLATE_VAR_SOURCES,
  previewTemplate,
  templateNeeds,
  type TemplateSendMapping,
  type TemplateVarMapping,
  type TemplateVarSource,
} from '@/lib/broadcasts/template-vars'

const EXAMPLE_LEAD: ContactVars = {
  name: 'Maria Silva',
  phone: '+55 67 99999-8888',
  email: 'maria@exemplo.com',
  company: 'Empresa Exemplo',
}

const HEADER_ACCEPT = {
  image: 'image/jpeg,image/png',
  video: 'video/mp4,video/3gpp',
  document: 'application/pdf',
} as const

const HEADER_LABEL = { image: 'imagem', video: 'vídeo', document: 'documento' } as const

const fieldClass =
  'h-8 w-full rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus:border-primary'

export function templateKey(t: Pick<MessageTemplate, 'name' | 'language'>): string {
  return `${t.name}::${t.language ?? ''}`
}

export function StageBroadcastTemplateFields({
  templates,
  loadError,
  selectedKey,
  onSelect,
  mapping,
  onMappingChange,
  sampleLead,
  uploadingHeader,
  setUploadingHeader,
}: {
  /** null = carregando. */
  templates: MessageTemplate[] | null
  loadError: string | null
  selectedKey: string
  onSelect: (key: string) => void
  mapping: TemplateSendMapping
  onMappingChange: (next: TemplateSendMapping) => void
  sampleLead: ContactVars | null
  uploadingHeader: boolean
  setUploadingHeader: (v: boolean) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const template = templates?.find((t) => templateKey(t) === selectedKey) ?? null
  const needs = useMemo(() => (template ? templateNeeds(template) : null), [template])
  const lead = sampleLead ?? EXAMPLE_LEAD
  const preview = template ? previewTemplate(template, mapping, lead) : null

  if (loadError) {
    return <p className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-600 dark:text-red-400">{loadError}</p>
  }
  if (templates === null) {
    return (
      <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando templates…
      </div>
    )
  }
  if (templates.length === 0) {
    return (
      <p className="rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
        Nenhum template aprovado. Crie um em <strong>Configurações → Templates</strong> e espere a Meta aprovar.
      </p>
    )
  }

  const setVar = (key: string, patch: Partial<TemplateVarMapping>) => {
    const cur = mapping.variables[key] ?? { source: 'static' as const, value: '' }
    onMappingChange({ ...mapping, variables: { ...mapping.variables, [key]: { ...cur, ...patch } } })
  }
  const setHeaderVar = (patch: Partial<TemplateVarMapping>) => {
    const cur = mapping.headerVariable ?? { source: 'static' as const, value: '' }
    onMappingChange({ ...mapping, headerVariable: { ...cur, ...patch } })
  }

  async function uploadHeader(file: File) {
    if (!needs?.headerMedia) return
    const max = MEDIA_MAX_BYTES_BY_KIND[needs.headerMedia]
    if (file.size > max) {
      toast.error(`"${file.name}" é grande demais (máx. ${Math.round(max / 1024 / 1024)}MB).`)
      return
    }
    setUploadingHeader(true)
    try {
      const { publicUrl } = await uploadAccountMedia('media', file)
      onMappingChange({ ...mapping, headerMediaUrl: publicUrl })
      toast.success('Arquivo do cabeçalho enviado.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao enviar o arquivo.')
    } finally {
      setUploadingHeader(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const sampleFor = (i: number) => template?.sample_values?.body?.[i - 1]

  return (
    <div className="space-y-3">
      <div className="grid gap-1">
        <label className="text-xs font-medium text-muted-foreground">Template aprovado</label>
        <select
          value={selectedKey}
          onChange={(e) => onSelect(e.target.value)}
          className="h-9 rounded-lg border border-border bg-background px-2 text-sm text-foreground"
        >
          <option value="">Escolha o template…</option>
          {templates.map((t) => (
            <option key={t.id} value={templateKey(t)}>
              {t.name} · {t.language ?? '—'}
            </option>
          ))}
        </select>
      </div>

      {template && needs && (
        <>
          {(needs.headerText || needs.bodyIndices.length > 0) && (
            <div className="space-y-2">
              <p className="text-xs font-medium text-muted-foreground">O que vai em cada variável</p>
              {needs.headerText && (
                <VariableRow
                  label="Cabeçalho {{1}}"
                  mapping={mapping.headerVariable}
                  onChange={setHeaderVar}
                  sample={template.sample_values?.header?.[0]}
                />
              )}
              {needs.bodyIndices.map((i) => (
                <VariableRow
                  key={i}
                  label={`{{${i}}}`}
                  mapping={mapping.variables[String(i)]}
                  onChange={(patch) => setVar(String(i), patch)}
                  sample={sampleFor(i)}
                />
              ))}
            </div>
          )}

          {needs.headerMedia && (
            <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
              <input
                ref={fileRef}
                type="file"
                accept={HEADER_ACCEPT[needs.headerMedia]}
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void uploadHeader(f)
                }}
              />
              <div className="flex items-center justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5 text-xs text-foreground">
                  <ImageIcon className="h-3.5 w-3.5 shrink-0 text-primary" />
                  <span className="truncate">
                    Cabeçalho com {HEADER_LABEL[needs.headerMedia]}:{' '}
                    {mapping.headerMediaUrl
                      ? mapping.headerMediaUrl === template.header_media_url
                        ? 'arquivo do template'
                        : 'arquivo novo'
                      : 'falta o arquivo'}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploadingHeader}
                  className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                >
                  {uploadingHeader ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                  {mapping.headerMediaUrl ? 'Trocar' : 'Enviar arquivo'}
                </button>
              </div>
              {needs.headerMedia === 'image' && mapping.headerMediaUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={mapping.headerMediaUrl}
                  alt="Imagem do cabeçalho"
                  className="mt-2 max-h-28 rounded-md border border-border object-contain"
                />
              ) : null}
            </div>
          )}

          {needs.urlButtons.map((b) => (
            <div key={b.index} className="grid gap-1">
              <label className="text-xs font-medium text-muted-foreground">
                Final do link do botão &quot;{b.text}&quot;
              </label>
              <input
                value={mapping.buttonValues?.[String(b.index)] ?? ''}
                onChange={(e) =>
                  onMappingChange({
                    ...mapping,
                    buttonValues: { ...(mapping.buttonValues ?? {}), [String(b.index)]: e.target.value },
                  })
                }
                placeholder="Ex.: promocao-setembro"
                className={fieldClass}
              />
            </div>
          ))}

          {preview && (
            <div className="rounded-lg border border-border bg-card/50 p-2.5">
              <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                Prévia ({sampleLead ? sampleLead.name?.trim() || 'lead sem nome' : `exemplo: ${EXAMPLE_LEAD.name}`})
              </p>
              {preview.header && <p className="text-sm font-semibold text-foreground">{preview.header}</p>}
              <p className="whitespace-pre-wrap text-sm text-foreground">{preview.body}</p>
              {preview.footer && <p className="mt-1 text-[11px] text-muted-foreground">{preview.footer}</p>}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function VariableRow({
  label,
  mapping,
  onChange,
  sample,
}: {
  label: string
  mapping: TemplateVarMapping | null | undefined
  onChange: (patch: Partial<TemplateVarMapping>) => void
  sample?: string
}) {
  const source: TemplateVarSource = mapping?.source ?? 'static'
  const isStatic = source === 'static'
  return (
    <div className="grid grid-cols-[4.5rem_1fr] items-center gap-2 sm:grid-cols-[5.5rem_9rem_1fr]">
      <span className="truncate rounded bg-primary/10 px-1.5 py-1 text-center font-mono text-[11px] text-primary">
        {label}
      </span>
      <select
        value={source}
        onChange={(e) => {
          const next = e.target.value as TemplateVarSource
          // Primeiro nome/nome começam com "cliente" no "Se faltar" (dá pra apagar).
          const value = next === 'static' ? '' : next === 'first_name' || next === 'name' ? 'cliente' : ''
          onChange({ source: next, value })
        }}
        className={fieldClass}
        aria-label={`Origem de ${label}`}
      >
        {TEMPLATE_VAR_SOURCES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>
      <input
        value={mapping?.value ?? ''}
        onChange={(e) => onChange({ value: e.target.value })}
        placeholder={isStatic ? (sample ? `Ex.: ${sample}` : 'Texto') : 'Se faltar (opcional)'}
        className={`${fieldClass} col-span-2 sm:col-span-1`}
        aria-label={isStatic ? `Texto de ${label}` : `Se faltar, em ${label}`}
      />
    </div>
  )
}

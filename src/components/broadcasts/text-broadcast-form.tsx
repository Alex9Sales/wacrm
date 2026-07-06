'use client'

// ============================================================
// TextBroadcastForm — create a humanized text drip (RecebAI-style) on a
// non-official channel. Pick a channel, write ONE plain message, choose an
// audience (all / tags / CSV import), set the daily cap. The server spreads
// the sends across business hours (08–18h, Mon–Sat, Campo Grande), at most
// `dailyCap` per day. Server-side + queued, so it survives a browser close
// and runs over days.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Loader2, Upload, Users, CalendarClock, Send, Paperclip, X, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  listTextBroadcastChannels,
  estimateAudienceCount,
  createTextBroadcast,
  type BroadcastChannel,
} from '@/app/(dashboard)/broadcasts/actions'
import { listTags, listContacts } from '@/app/(dashboard)/contacts/actions'
import {
  uploadAccountMedia,
  MEDIA_MAX_BYTES_BY_KIND,
} from '@/lib/storage/upload-media'
import { renderForContact, SUPPORTED_TOKENS } from '@/lib/whatsapp/message-vars'
import type { Tag } from '@/types'
import { cn } from '@/lib/utils'

type MediaKind = 'image' | 'video' | 'document' | 'audio'

function kindFromMime(type: string): MediaKind {
  if (type.startsWith('image/')) return 'image'
  if (type.startsWith('video/')) return 'video'
  if (type.startsWith('audio/')) return 'audio'
  return 'document'
}

/** A sample contact for the live preview. */
const PREVIEW_CONTACT = {
  name: 'Maria Silva',
  phone: '+55 67 99999-8888',
  email: 'maria@exemplo.com',
  company: 'Empresa Exemplo',
}

type AudienceType = 'all' | 'tags' | 'contacts' | 'csv'

interface CsvContact {
  phone: string
  name?: string
}

interface PickContact {
  id: string
  name: string
  phone: string
}

/** Parse pasted/uploaded CSV text into { phone, name } rows. Accepts comma,
 *  semicolon or tab separators; drops an obvious header line. */
function parseCsv(text: string): CsvContact[] {
  const out: CsvContact[] = []
  const lines = text.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const parts = line.split(/[,;\t]/).map((p) => p.trim())
    const phoneRaw = parts[0] ?? ''
    // Skip a header row (e.g. "phone,name" / "telefone;nome").
    if (/[a-zA-Z]/.test(phoneRaw) && /(phone|telefone|numero|número|contato)/i.test(phoneRaw)) {
      continue
    }
    const phone = phoneRaw.replace(/[^\d+]/g, '')
    if (phone.replace(/\D/g, '').length < 8) continue // too short to be a phone
    out.push({ phone, name: parts[1] || undefined })
  }
  return out
}

const DAY_LABELS = 'seg–sáb'

export function TextBroadcastForm() {
  const router = useRouter()

  const [channels, setChannels] = useState<BroadcastChannel[]>([])
  const [tags, setTags] = useState<Tag[]>([])
  const [loading, setLoading] = useState(true)

  const [name, setName] = useState('')
  const [channelId, setChannelId] = useState('')
  const [message, setMessage] = useState('')
  const [dailyCap, setDailyCap] = useState(50)
  const [sendNow, setSendNow] = useState(false)
  const messageRef = useRef<HTMLTextAreaElement>(null)

  // Optional media attachment.
  const [mediaUrl, setMediaUrl] = useState('')
  const [mediaType, setMediaType] = useState<MediaKind | null>(null)
  const [mediaFilename, setMediaFilename] = useState('')
  const [uploadingMedia, setUploadingMedia] = useState(false)
  const mediaRef = useRef<HTMLInputElement>(null)

  const [audienceType, setAudienceType] = useState<AudienceType>('all')
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([])
  const [csvContacts, setCsvContacts] = useState<CsvContact[]>([])
  const [csvName, setCsvName] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  // Pick-specific-contacts audience.
  const [contactSearch, setContactSearch] = useState('')
  const [contactResults, setContactResults] = useState<PickContact[]>([])
  const [searchingContacts, setSearchingContacts] = useState(false)
  const [pickedContacts, setPickedContacts] = useState<PickContact[]>([])

  const [estimate, setEstimate] = useState<number | null>(null)
  const [estimating, setEstimating] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const [chs, tgs] = await Promise.all([
          listTextBroadcastChannels(),
          listTags(),
        ])
        if (cancelled) return
        setChannels(chs)
        setTags(tgs)
        if (chs.length > 0) setChannelId(chs[0].id)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  // Live recipient estimate for the chosen audience.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (audienceType === 'csv') {
        setEstimate(csvContacts.length)
        return
      }
      if (audienceType === 'contacts') {
        setEstimate(pickedContacts.length)
        return
      }
      if (audienceType === 'tags' && selectedTagIds.length === 0) {
        setEstimate(null)
        return
      }
      setEstimating(true)
      try {
        const n = await estimateAudienceCount({
          type: audienceType,
          tagIds: audienceType === 'tags' ? selectedTagIds : undefined,
        })
        if (!cancelled) setEstimate(n)
      } finally {
        if (!cancelled) setEstimating(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [audienceType, selectedTagIds, csvContacts, pickedContacts])

  // Contact search for the "select contacts" audience (server-side, top 50).
  useEffect(() => {
    if (audienceType !== 'contacts') return
    let cancelled = false
    setSearchingContacts(true)
    const run = async () => {
      try {
        const res = await listContacts({
          offset: 0,
          limit: 50,
          search: contactSearch.trim(),
          tagIds: [],
        })
        if (cancelled) return
        setContactResults(
          res.contacts.map((c) => ({
            id: c.id,
            name: c.name || '',
            phone: c.phone || '',
          })),
        )
      } finally {
        if (!cancelled) setSearchingContacts(false)
      }
    }
    // Small debounce so typing doesn't hammer the server.
    const t = setTimeout(run, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [audienceType, contactSearch])

  const handleFile = useCallback(async (file: File) => {
    const text = await file.text()
    const parsed = parseCsv(text)
    setCsvContacts(parsed)
    setCsvName(file.name)
    if (parsed.length === 0) {
      toast.error('Nenhum telefone válido encontrado no arquivo.')
    } else {
      toast.success(`${parsed.length} contatos lidos de ${file.name}.`)
    }
  }, [])

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    )
  }, [])

  const togglePicked = useCallback((c: PickContact) => {
    setPickedContacts((prev) =>
      prev.some((p) => p.id === c.id)
        ? prev.filter((p) => p.id !== c.id)
        : [...prev, c],
    )
  }, [])

  const handleMediaFile = useCallback(async (file: File) => {
    const kind = kindFromMime(file.type)
    const max = MEDIA_MAX_BYTES_BY_KIND[kind]
    if (file.size > max) {
      toast.error(`Arquivo grande demais para ${kind} (máx. ${Math.round(max / 1024 / 1024)}MB).`)
      return
    }
    setUploadingMedia(true)
    try {
      const { publicUrl } = await uploadAccountMedia('media', file)
      setMediaUrl(publicUrl)
      setMediaType(kind)
      setMediaFilename(file.name)
      toast.success('Mídia anexada.')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao enviar a mídia.')
    } finally {
      setUploadingMedia(false)
    }
  }, [])

  const clearMedia = useCallback(() => {
    setMediaUrl('')
    setMediaType(null)
    setMediaFilename('')
    if (mediaRef.current) mediaRef.current.value = ''
  }, [])

  /** Insert a {{token}} at the cursor in the message textarea. */
  const insertToken = useCallback((token: string) => {
    const snippet = `{{${token}}}`
    const el = messageRef.current
    if (!el) {
      setMessage((m) => m + snippet)
      return
    }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    setMessage((m) => m.slice(0, start) + snippet + m.slice(end))
    // Restore focus + caret after the inserted token.
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + snippet.length
      el.setSelectionRange(pos, pos)
    })
  }, [])

  const cap = Math.max(1, Math.min(2000, Math.floor(dailyCap) || 50))
  const estDays = estimate && estimate > 0 ? Math.ceil(estimate / cap) : 0

  const canSubmit =
    !submitting &&
    !uploadingMedia &&
    !!channelId &&
    (message.trim().length > 0 || !!mediaUrl) &&
    ((audienceType === 'all') ||
      (audienceType === 'tags' && selectedTagIds.length > 0) ||
      (audienceType === 'contacts' && pickedContacts.length > 0) ||
      (audienceType === 'csv' && csvContacts.length > 0))

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const res = await createTextBroadcast({
        name: name.trim() || null,
        channelId,
        bodyText: message.trim(),
        mediaUrl: mediaUrl || null,
        mediaType,
        mediaFilename: mediaFilename || null,
        dailyCap: cap,
        sendNow,
        audience: {
          type: audienceType,
          tagIds: audienceType === 'tags' ? selectedTagIds : undefined,
          csvContacts: audienceType === 'csv' ? csvContacts : undefined,
          contactIds:
            audienceType === 'contacts'
              ? pickedContacts.map((c) => c.id)
              : undefined,
        },
      })
      if (res.error || !res.broadcastId) {
        toast.error(res.error || 'Falha ao criar o disparo.')
        return
      }
      toast.success(
        sendNow
          ? `Disparo iniciado agora — ${res.totalRecipients} contatos.`
          : `Disparo criado — ${res.totalRecipients} contatos, ${cap}/dia (${DAY_LABELS}).`,
      )
      router.push('/broadcasts')
    } finally {
      setSubmitting(false)
    }
  }, [canSubmit, name, channelId, message, mediaUrl, mediaType, mediaFilename, cap, sendNow, audienceType, selectedTagIds, csvContacts, pickedContacts, router])

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-8 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
      </div>
    )
  }

  if (channels.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card/50 p-6 text-sm text-muted-foreground">
        Nenhum canal não-oficial (WAHA/Evolution/EvoGo) conectado. Conecte um
        canal em <strong>Configurações → Canais</strong> para fazer disparos de
        texto.
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      {/* Channel + name */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label>Canal</Label>
          <Select value={channelId} onValueChange={(v) => v && setChannelId(v)}>
            <SelectTrigger className="w-full bg-muted border-border">
              <SelectValue placeholder="Escolha o canal" />
            </SelectTrigger>
            <SelectContent>
              {channels.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                  {c.phone_number ? ` · ${c.phone_number}` : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label>Nome do disparo (opcional)</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Promoção de julho"
            className="bg-muted border-border"
          />
        </div>
      </div>

      {/* Message */}
      <div className="space-y-1.5">
        <Label>Mensagem</Label>
        {/* Variable helper chips — insert {{token}} at the cursor. */}
        <div className="flex flex-wrap gap-1.5">
          {SUPPORTED_TOKENS.map((tok) => (
            <button
              key={tok}
              type="button"
              onClick={() => insertToken(tok)}
              className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
              title={`Inserir {{${tok}}}`}
            >
              {`{{${tok}}}`}
            </button>
          ))}
        </div>
        <textarea
          ref={messageRef}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={5}
          placeholder="Ex.: Olá {{primeiro_nome|cliente}}, tudo bem? Temos uma novidade…"
          className="w-full resize-none rounded-lg border border-border bg-muted px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
        />
        <p className="text-xs text-muted-foreground">
          Use as variáveis acima para personalizar. Ex.:{' '}
          <code>{'{{primeiro_nome|cliente}}'}</code> usa o primeiro nome, ou
          &quot;cliente&quot; se estiver vazio. {message.trim().length} caracteres.
        </p>
        {/* Live preview with a sample contact. */}
        {message.trim().length > 0 && (
          <div className="rounded-lg border border-border bg-card/50 p-3">
            <p className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">
              Prévia (exemplo: {PREVIEW_CONTACT.name})
            </p>
            <p className="whitespace-pre-wrap text-sm text-foreground">
              {renderForContact(message, PREVIEW_CONTACT)}
            </p>
          </div>
        )}
      </div>

      {/* Media attachment */}
      <div className="space-y-1.5">
        <Label>Mídia (opcional)</Label>
        <input
          ref={mediaRef}
          type="file"
          accept="image/*,video/*,audio/*,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) void handleMediaFile(f)
          }}
        />
        {mediaUrl ? (
          <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-muted px-3 py-2">
            <span className="flex items-center gap-2 truncate text-xs text-foreground">
              <Paperclip className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="truncate">{mediaFilename}</span>
              <span className="shrink-0 rounded-full bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
                {mediaType}
              </span>
            </span>
            <button
              type="button"
              onClick={clearMedia}
              className="shrink-0 text-muted-foreground hover:text-red-400"
              aria-label="Remover mídia"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => mediaRef.current?.click()}
            disabled={uploadingMedia}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground disabled:opacity-50"
          >
            {uploadingMedia ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Enviando…
              </>
            ) : (
              <>
                <Paperclip className="h-4 w-4" /> Anexar imagem, vídeo, áudio ou PDF
              </>
            )}
          </button>
        )}
        {mediaType === 'audio' && message.trim().length > 0 && (
          <p className="text-[11px] text-amber-400">
            Áudio não leva legenda — o texto acima não será enviado junto.
          </p>
        )}
      </div>

      {/* Audience */}
      <div className="space-y-2">
        <Label>Para quem</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(
            [
              { key: 'all', label: 'Todos os contatos' },
              { key: 'contacts', label: 'Selecionar contatos' },
              { key: 'tags', label: 'Por etiquetas' },
              { key: 'csv', label: 'Importar planilha' },
            ] as { key: AudienceType; label: string }[]
          ).map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setAudienceType(opt.key)}
              className={cn(
                'rounded-lg border px-3 py-2 text-xs transition-colors',
                audienceType === opt.key
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:border-primary/40',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {audienceType === 'tags' && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {tags.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nenhuma etiqueta criada ainda.
              </p>
            ) : (
              tags.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => toggleTag(t.id)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 text-xs transition-colors',
                    selectedTagIds.includes(t.id)
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:border-primary/40',
                  )}
                >
                  {t.name}
                </button>
              ))
            )}
          </div>
        )}

        {audienceType === 'contacts' && (
          <div className="space-y-2 pt-1">
            <Input
              value={contactSearch}
              onChange={(e) => setContactSearch(e.target.value)}
              placeholder="Buscar por nome ou telefone…"
              className="bg-muted border-border"
            />
            {/* Selected chips */}
            {pickedContacts.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {pickedContacts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => togglePicked(c)}
                    className="flex items-center gap-1 rounded-full border border-primary bg-primary/10 px-2.5 py-1 text-xs text-foreground"
                    title="Remover"
                  >
                    {c.name || c.phone}
                    <X className="h-3 w-3" />
                  </button>
                ))}
              </div>
            )}
            {/* Results list */}
            <div className="max-h-56 overflow-y-auto rounded-lg border border-border">
              {searchingContacts ? (
                <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Buscando…
                </div>
              ) : contactResults.length === 0 ? (
                <p className="px-3 py-3 text-xs text-muted-foreground">
                  Nenhum contato encontrado.
                </p>
              ) : (
                contactResults.map((c) => {
                  const checked = pickedContacts.some((p) => p.id === c.id)
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => togglePicked(c)}
                      className="flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-xs last:border-b-0 hover:bg-muted"
                    >
                      <span
                        className={cn(
                          'flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                          checked
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-muted-foreground/50',
                        )}
                      >
                        {checked && <Check className="h-3 w-3" />}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        {c.name || '(sem nome)'}
                      </span>
                      <span className="shrink-0 text-muted-foreground">{c.phone}</span>
                    </button>
                  )
                })
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {pickedContacts.length} selecionado
              {pickedContacts.length === 1 ? '' : 's'}. Mostrando os 50 primeiros —
              use a busca para achar mais.
            </p>
          </div>
        )}

        {audienceType === 'csv' && (
          <div className="pt-1">
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.txt"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) void handleFile(f)
              }}
            />
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-3 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
            >
              <Upload className="h-4 w-4" />
              {csvName
                ? `${csvName} — ${csvContacts.length} contatos`
                : 'Enviar planilha (.csv) — uma linha por contato: telefone,nome'}
            </button>
          </div>
        )}
      </div>

      {/* Send now vs humanized drip */}
      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
        <input
          type="checkbox"
          checked={sendNow}
          onChange={(e) => setSendNow(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-primary"
        />
        <span className="text-sm">
          <span className="text-foreground">Enviar agora</span>
          <span className="block text-xs text-muted-foreground">
            Dispara imediatamente, ignorando o horário comercial. Use para testes
            ou envios urgentes (cuidado com bloqueio em listas grandes).
          </span>
        </span>
      </label>

      {/* Daily cap — only relevant for the humanized drip */}
      {!sendNow && (
        <div className="space-y-1.5">
          <Label>Máximo por dia</Label>
          <Input
            type="number"
            min={1}
            max={2000}
            value={dailyCap}
            onChange={(e) => setDailyCap(Number(e.target.value))}
            className="w-32 bg-muted border-border"
          />
          <p className="text-xs text-muted-foreground">
            Recomendado até 50/dia em canal não-oficial para evitar bloqueio.
          </p>
        </div>
      )}

      {/* Summary */}
      <div className="rounded-xl border border-border bg-card/50 p-4 text-sm">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-primary" />
          {estimating ? (
            <span className="text-muted-foreground">Calculando…</span>
          ) : estimate === null ? (
            <span className="text-muted-foreground">
              Escolha a audiência para ver o total.
            </span>
          ) : (
            <span className="text-foreground">
              {estimate.toLocaleString('pt-BR')} contatos
            </span>
          )}
        </div>
        {estimate !== null && estimate > 0 && (
          <div className="mt-2 flex items-center gap-2 text-muted-foreground">
            <CalendarClock className="h-4 w-4 text-primary" />
            {sendNow ? (
              <span>Envio imediato (sem espaçar no horário)</span>
            ) : (
              <span>
                ~{cap}/dia · leva ~{estDays} dia{estDays > 1 ? 's' : ''} útil
                {estDays > 1 ? 'eis' : ''} · 08h–18h ({DAY_LABELS})
              </span>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={() => router.push('/broadcasts')}
          disabled={submitting}
          className="border-border text-muted-foreground"
        >
          Cancelar
        </Button>
        <Button
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {submitting ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Criando…
            </>
          ) : (
            <>
              <Send className="h-4 w-4" /> Iniciar disparo
            </>
          )}
        </Button>
      </div>
    </div>
  )
}

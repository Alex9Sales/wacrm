'use client'

// Disparo por ETAPA (item 6 do funil): manda pra todos os leads (negócios
// abertos) da etapa, reusando o motor de Disparos (fila do worker, ritmo
// seguro, opt-out). Cada envio vira nota no histórico do negócio.
//
// 15/09 (GoLink): mesmos tipos dos Disparos, e o TIPO segue o canal escolhido
// — WhatsApp (texto + anexos), E-mail (assunto + anexos, só quem tem e-mail)
// e API oficial (template aprovado, variáveis por lead). Padrão = número de
// quem dispara; número de outra pessoa só com confirmação; quem já recebeu a
// mesma mensagem hoje fica de fora, a não ser que marque o contrário.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Megaphone } from 'lucide-react'

import type { MessageTemplate } from '@/types'
import { renderForContact, SUPPORTED_TOKENS } from '@/lib/whatsapp/message-vars'
import { useAuth } from '@/hooks/use-auth'
import { channelOwnerLabel, otherPersonOwner } from '@/lib/broadcasts/channel-choice'
import {
  STAGE_KIND_LABEL,
  defaultStageChannelId,
  validateStageBroadcastBasics,
  type StageBroadcastKind,
} from '@/lib/broadcasts/stage-broadcast'
import {
  emptyTemplateMapping,
  templateNeeds,
  validateTemplateMapping,
  type TemplateSendMapping,
} from '@/lib/broadcasts/template-vars'
import { duplicateSkipNotice, SEND_AGAIN_HINT } from '@/lib/broadcasts/duplicate-notice'

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import {
  stageBroadcastInfo,
  broadcastToStage,
  type StageBroadcastInfo,
} from '@/app/(dashboard)/pipelines/actions'
import { listApprovedTemplates } from '@/app/(dashboard)/broadcasts/actions'
import { StageBroadcastAttachments, type StageMediaItem } from './stage-broadcast-attachments'
import { StageBroadcastTemplateFields, templateKey } from './stage-broadcast-template'

const KIND_GROUPS: StageBroadcastKind[] = ['text', 'email', 'template']

export function StageBroadcastDialog({
  stageId,
  stageName,
  open,
  onOpenChange,
}: {
  stageId: string
  stageName: string
  open: boolean
  onOpenChange: (v: boolean) => void
}) {
  const { user } = useAuth()
  const userId = user?.id ?? null
  const [info, setInfo] = useState<StageBroadcastInfo | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [channelId, setChannelId] = useState('')
  // 15/09 (GoLink): padrão = número de quem dispara (não o 1º da lista);
  // número de outra pessoa só com confirmação.
  const [channelTouched, setChannelTouched] = useState(false)
  const [confirmOtherNumber, setConfirmOtherNumber] = useState(false)
  const [text, setText] = useState('')
  const [subject, setSubject] = useState('')
  const [media, setMedia] = useState<StageMediaItem[]>([])
  const [uploading, setUploading] = useState(false)
  // Desmarcado = quem já recebeu esta mensagem hoje fica de fora.
  const [sendAgain, setSendAgain] = useState(false)
  const [templates, setTemplates] = useState<MessageTemplate[] | null>(null)
  const [templatesError, setTemplatesError] = useState<string | null>(null)
  const [templateSel, setTemplateSel] = useState('')
  const [mapping, setMapping] = useState<TemplateSendMapping>({ variables: {} })
  const [uploadingHeader, setUploadingHeader] = useState(false)
  const [sending, setSending] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)
  const templatesRequested = useRef(false)

  /** Insere {{token}} na posição do cursor (cada lead recebe o valor dele). */
  const insertToken = useCallback((token: string) => {
    const snippet = `{{${token}}}`
    const el = textRef.current
    if (!el) {
      setText((m) => m + snippet)
      return
    }
    const start = el.selectionStart ?? el.value.length
    const end = el.selectionEnd ?? el.value.length
    setText((m) => m.slice(0, start) + snippet + m.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + snippet.length
      el.setSelectionRange(pos, pos)
    })
  }, [])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setInfo(null)
    setLoadError(null)
    setText('')
    setSubject('')
    setMedia([])
    setSendAgain(false)
    // Templates recarregam a cada abertura (um aprovado há pouco já aparece).
    templatesRequested.current = false
    setTemplates(null)
    setTemplatesError(null)
    setTemplateSel('')
    setMapping({ variables: {} })
    setChannelTouched(false)
    setConfirmOtherNumber(false)
    stageBroadcastInfo(stageId)
      .then((i) => {
        if (!cancelled) setInfo(i)
      })
      .catch((err) => {
        console.error('[stage-broadcast] info', err)
        if (!cancelled) {
          setLoadError('Não deu pra carregar os leads e canais desta etapa. Feche e abra de novo.')
          setInfo({ leadCount: 0, leadCountWithEmail: 0, sampleLead: null, channels: [] })
        }
      })
    return () => {
      cancelled = true
    }
  }, [open, stageId])

  useEffect(() => {
    if (!info || channelTouched || info.channels.length === 0) return
    const id = defaultStageChannelId(info.channels, userId)
    if (id && id !== channelId) setChannelId(id)
  }, [info, userId, channelTouched, channelId])

  const channel = info?.channels.find((c) => c.id === channelId) ?? null
  const kind: StageBroadcastKind = channel?.kind ?? 'text'
  const otherOwner = otherPersonOwner(channel, userId)

  // Templates só quando precisa (canal da API oficial escolhido).
  useEffect(() => {
    if (!open || kind !== 'template' || templatesRequested.current) return
    templatesRequested.current = true
    listApprovedTemplates()
      .then((rows) => setTemplates(rows))
      .catch((err) => {
        console.error('[stage-broadcast] templates', err)
        templatesRequested.current = false
        setTemplatesError('Não deu pra carregar os templates. Feche e abra de novo.')
      })
  }, [open, kind])

  const selectedTemplate = templates?.find((t) => templateKey(t) === templateSel) ?? null
  const needs = useMemo(() => (selectedTemplate ? templateNeeds(selectedTemplate) : null), [selectedTemplate])

  function selectTemplate(key: string) {
    setTemplateSel(key)
    const t = templates?.find((x) => templateKey(x) === key)
    setMapping(t ? emptyTemplateMapping(templateNeeds(t), t) : { variables: {} })
  }

  const noLeads = !!info && info.leadCount === 0
  const noEmailLeads = kind === 'email' && !!info && info.leadCountWithEmail === 0

  /** O que ainda falta pra disparar (mesmas regras do servidor); null = pronto. */
  const blocker = useMemo((): string | null => {
    if (!info || !channel) return null
    if (noLeads) return null
    const basics = validateStageBroadcastBasics(
      { channelId, kind, text, subject, media, templateName: selectedTemplate?.name ?? '' },
      channel.kind,
    )
    if (basics) return basics
    if (kind === 'template' && needs) {
      const err = validateTemplateMapping(needs, mapping)
      if (err) return err
    }
    if (noEmailLeads) return 'Nenhum lead desta etapa tem e-mail.'
    if (otherOwner && !confirmOtherNumber) return `Confirme que quer enviar pelo número de ${otherOwner}.`
    return null
  }, [info, channel, noLeads, channelId, kind, text, subject, media, selectedTemplate, needs, mapping, noEmailLeads, otherOwner, confirmOtherNumber])

  async function send() {
    if (blocker) {
      toast.error(blocker)
      return
    }
    if (!channel) {
      toast.error('Escolha o canal.')
      return
    }
    setSending(true)
    try {
      const res = await broadcastToStage({
        stageId,
        channelId,
        kind,
        ...(kind === 'template'
          ? {
              templateName: selectedTemplate?.name ?? '',
              templateLanguage: selectedTemplate?.language ?? '',
              variables: mapping.variables,
              headerVariable: mapping.headerVariable ?? null,
              buttonValues: mapping.buttonValues ?? {},
              headerMediaUrl: mapping.headerMediaUrl ?? undefined,
            }
          : {
              text: text.trim(),
              subject: kind === 'email' ? subject.trim() : undefined,
              media: media.length > 0 ? media : undefined,
            }),
        confirmOtherPersonNumber: !!otherOwner && confirmOtherNumber,
        skipRecentDuplicates: !sendAgain,
      })
      const skipped = res.skippedDuplicates ?? []
      if (!res.ok) {
        toast.error(res.error ?? 'Falha ao disparar.', skipped.length > 0 ? { description: SEND_AGAIN_HINT } : undefined)
        return
      }
      toast.success(`Disparo enviado para ${res.total ?? 0} lead(s) da etapa.`)
      const notice = duplicateSkipNotice(skipped)
      if (notice) toast.info(notice, { duration: 10_000 })
      onOpenChange(false)
    } catch (err) {
      console.error('[stage-broadcast] send', err)
      toast.error('Falha ao disparar para a etapa. Tente de novo.')
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 pr-6">
            <Megaphone className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">Disparar para &quot;{stageName}&quot;</span>
          </DialogTitle>
          <DialogDescription>
            Manda pra todos os leads desta etapa pelo WhatsApp, e-mail ou API oficial. Vai no
            ritmo seguro e cada envio fica no histórico do negócio.
          </DialogDescription>
        </DialogHeader>

        {info === null ? (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : loadError ? (
          <p className="py-4 text-center text-sm text-red-600 dark:text-red-400">{loadError}</p>
        ) : info.channels.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Nenhum canal de disparo (WhatsApp, e-mail ou API oficial). Conecte um em{' '}
            <strong>Configurações → Canais</strong>.
          </p>
        ) : info.leadCount === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Nenhum lead com contato nesta etapa.
          </p>
        ) : (
          <div className="space-y-3">
            {kind === 'email' ? (
              <div
                className={
                  noEmailLeads
                    ? 'rounded-lg border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-sm text-amber-800 dark:text-amber-300'
                    : 'rounded-lg bg-muted/40 px-3 py-2 text-sm text-foreground'
                }
              >
                {noEmailLeads ? (
                  <>Nenhum dos {info.leadCount} lead(s) desta etapa tem e-mail — escolha um canal de WhatsApp.</>
                ) : (
                  <>
                    <strong>{info.leadCountWithEmail}</strong> de {info.leadCount} lead(s) têm e-mail — só
                    eles recebem.
                  </>
                )}
              </div>
            ) : (
              <div className="rounded-lg bg-muted/40 px-3 py-2 text-sm text-foreground">
                <strong>{info.leadCount}</strong> lead(s) nesta etapa receberão a mensagem.
              </div>
            )}

            <div className="grid gap-1">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="stage-broadcast-channel" className="text-xs font-medium text-muted-foreground">
                  Enviar pelo canal
                </label>
                <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                  {STAGE_KIND_LABEL[kind]}
                </span>
              </div>
              <select
                id="stage-broadcast-channel"
                value={channelId}
                onChange={(e) => {
                  setChannelTouched(true)
                  setConfirmOtherNumber(false)
                  setChannelId(e.target.value)
                }}
                className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground"
              >
                {KIND_GROUPS.map((k) => {
                  const list = info.channels.filter((c) => c.kind === k)
                  if (list.length === 0) return null
                  return (
                    <optgroup key={k} label={STAGE_KIND_LABEL[k]}>
                      {list.map((c) => {
                        const owner = channelOwnerLabel(c, userId)
                        return (
                          <option key={c.id} value={c.id}>
                            {c.name}
                            {owner ? ` · ${owner}` : ''}
                            {c.status !== 'connected' ? ' (desconectado)' : ''}
                          </option>
                        )
                      })}
                    </optgroup>
                  )
                })}
              </select>
              {kind === 'template' ? (
                <p className="text-[11px] text-muted-foreground">
                  API oficial: só sai com template aprovado pela Meta, que cobra por mensagem.
                </p>
              ) : null}
            </div>

            {otherOwner ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-[11px] leading-snug text-amber-800 dark:text-amber-300">
                <p>
                  {info.channels.length === 1 ? 'O único canal de disparo é o ' : 'Este é o '}
                  <strong>número de {otherOwner}</strong>. As mensagens saem pelo canal de{' '}
                  {otherOwner} e as respostas chegam pra essa pessoa.
                </p>
                <label className="mt-1.5 flex cursor-pointer items-center gap-1.5 font-medium">
                  <input
                    type="checkbox"
                    checked={confirmOtherNumber}
                    onChange={(e) => setConfirmOtherNumber(e.target.checked)}
                    className="h-3.5 w-3.5 accent-amber-600"
                  />
                  Quero enviar pelo número de {otherOwner} mesmo assim
                </label>
              </div>
            ) : null}

            {kind === 'template' ? (
              <StageBroadcastTemplateFields
                templates={templates}
                loadError={templatesError}
                selectedKey={templateSel}
                onSelect={selectTemplate}
                mapping={mapping}
                onMappingChange={setMapping}
                sampleLead={info.sampleLead}
                uploadingHeader={uploadingHeader}
                setUploadingHeader={setUploadingHeader}
              />
            ) : (
              <>
                {kind === 'email' ? (
                  <div className="grid gap-1">
                    <label htmlFor="stage-broadcast-subject" className="text-xs font-medium text-muted-foreground">
                      Assunto do e-mail
                    </label>
                    <input
                      id="stage-broadcast-subject"
                      value={subject}
                      onChange={(e) => setSubject(e.target.value)}
                      placeholder="Ex.: Novidades de setembro"
                      className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-primary"
                    />
                  </div>
                ) : null}
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[11px] text-muted-foreground">Variáveis:</span>
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
                    ref={textRef}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Ex.: Olá {{primeiro_nome|cliente}}, tudo bem? Passando pra saber…"
                    rows={4}
                    aria-label={kind === 'email' ? 'Texto do e-mail' : 'Mensagem'}
                    className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
                  />
                  {text.trim() ? (
                    <div className="rounded-lg border border-border bg-card/50 p-2.5">
                      <p className="mb-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        Prévia ({info.sampleLead?.name?.trim() || 'lead sem nome'})
                      </p>
                      <p className="whitespace-pre-wrap text-sm text-foreground">
                        {renderForContact(text, info.sampleLead ?? {})}
                      </p>
                    </div>
                  ) : (
                    <p className="text-[11px] text-muted-foreground">
                      Cada lead recebe o valor dele (nome, empresa…). Use{' '}
                      <code>{'{{primeiro_nome|cliente}}'}</code> pra ter um padrão quando faltar.
                    </p>
                  )}
                </div>
                <StageBroadcastAttachments
                  items={media}
                  setItems={setMedia}
                  uploading={uploading}
                  setUploading={setUploading}
                  isEmail={kind === 'email'}
                  hasText={!!text.trim()}
                />
              </>
            )}

            <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-border px-3 py-2">
              <input
                type="checkbox"
                checked={sendAgain}
                onChange={(e) => setSendAgain(e.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 accent-primary"
              />
              <span className="text-xs">
                <span className="text-foreground">Enviar também pra quem já recebeu esta mensagem hoje</span>
                <span className="block text-[11px] text-muted-foreground">
                  Desmarcado, quem recebeu a mesma mensagem nas últimas 24 h fica de fora.
                </span>
              </span>
            </label>

            {blocker ? <p className="text-[11px] text-muted-foreground">{blocker}</p> : null}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={sending}>
            Cancelar
          </Button>
          <Button
            onClick={() => void send()}
            disabled={
              sending ||
              uploading ||
              uploadingHeader ||
              !info ||
              !!loadError ||
              info.channels.length === 0 ||
              info.leadCount === 0 ||
              !!blocker
            }
          >
            {sending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Disparar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

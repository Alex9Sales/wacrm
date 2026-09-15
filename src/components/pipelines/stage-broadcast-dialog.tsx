'use client'

// Disparo por ETAPA (item 6 do funil): manda uma mensagem de texto pra todos
// os leads (negócios abertos) da etapa, reusando o motor de Disparos
// (rate-limit + opt-out). Cada envio vira nota no histórico do negócio.

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Megaphone } from 'lucide-react'

import { SUPPORTED_TOKENS } from '@/lib/whatsapp/message-vars'
import { useAuth } from '@/hooks/use-auth'
import {
  channelOwnerLabel,
  defaultBroadcastChannelId,
  otherPersonOwner,
} from '@/lib/broadcasts/channel-choice'

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
  const [channelId, setChannelId] = useState('')
  // 15/09 (GoLink): padrão = número de quem dispara (não o 1º da lista);
  // número de outra pessoa só com confirmação.
  const [channelTouched, setChannelTouched] = useState(false)
  const [confirmOtherNumber, setConfirmOtherNumber] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)

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
    setInfo(null)
    setText('')
    setChannelTouched(false)
    setConfirmOtherNumber(false)
    stageBroadcastInfo(stageId)
      .then((i) => setInfo(i))
      .catch(() => setInfo({ leadCount: 0, channels: [] }))
  }, [open, stageId])

  useEffect(() => {
    if (!info || channelTouched || info.channels.length === 0) return
    const id = defaultBroadcastChannelId(info.channels, userId)
    if (id && id !== channelId) setChannelId(id)
  }, [info, userId, channelTouched, channelId])

  const otherOwner = otherPersonOwner(info?.channels.find((c) => c.id === channelId), userId)

  async function send() {
    const body = text.trim()
    if (!body) {
      toast.error('Escreva a mensagem.')
      return
    }
    if (!channelId) {
      toast.error('Escolha o canal.')
      return
    }
    if (otherOwner && !confirmOtherNumber) {
      toast.error(`Confirme que quer enviar pelo número de ${otherOwner}.`)
      return
    }
    setSending(true)
    const res = await broadcastToStage({
      stageId,
      channelId,
      text: body,
      confirmOtherPersonNumber: !!otherOwner && confirmOtherNumber,
    })
    setSending(false)
    if (!res.ok) {
      toast.error(res.error ?? 'Falha ao disparar.')
      return
    }
    toast.success(`Disparo enviado para ${res.total ?? 0} lead(s) da etapa.`)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="h-4 w-4 text-primary" /> Disparar para &quot;{stageName}&quot;
          </DialogTitle>
          <DialogDescription>
            Manda a mensagem pra todos os leads desta etapa. Vai no ritmo seguro
            (anti-ban) e com a opção de descadastro; cada envio fica no histórico
            do negócio.
          </DialogDescription>
        </DialogHeader>

        {info === null ? (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : info.channels.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Nenhum canal de WhatsApp (WAHA) conectado para disparo.
          </p>
        ) : info.leadCount === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Nenhum lead com contato nesta etapa.
          </p>
        ) : (
          <div className="space-y-3">
            <div className="rounded-lg bg-muted/40 px-3 py-2 text-sm text-foreground">
              <strong>{info.leadCount}</strong> lead(s) nesta etapa receberão a
              mensagem.
            </div>
            {info.channels.length > 1 && (
              <div className="grid gap-1">
                <label className="text-xs font-medium text-muted-foreground">
                  Enviar pelo canal
                </label>
                <select
                  value={channelId}
                  onChange={(e) => {
                    setChannelTouched(true)
                    setConfirmOtherNumber(false)
                    setChannelId(e.target.value)
                  }}
                  className="h-9 rounded-lg border border-border bg-background px-2 text-sm text-foreground"
                >
                  {info.channels.map((c) => {
                    const owner = channelOwnerLabel(c, userId)
                    return (
                      <option key={c.id} value={c.id}>
                        {c.name}
                        {owner ? ` · ${owner}` : ''}
                        {c.status !== 'connected' ? ' (desconectado)' : ''}
                      </option>
                    )
                  })}
                </select>
              </div>
            )}
            {otherOwner ? (
              <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 text-[11px] leading-snug text-amber-800 dark:text-amber-300">
                <p>
                  {info.channels.length === 1 ? 'O único canal de disparo é o ' : 'Este é o '}
                  <strong>número de {otherOwner}</strong>. As mensagens saem pelo WhatsApp de{' '}
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
                className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary"
              />
              <p className="text-[11px] text-muted-foreground">
                Cada lead recebe o valor dele (nome, empresa…). Use{' '}
                <code>{'{{primeiro_nome|cliente}}'}</code> pra ter um padrão quando faltar.
              </p>
            </div>
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
              !info ||
              info.channels.length === 0 ||
              info.leadCount === 0 ||
              !text.trim() ||
              (!!otherOwner && !confirmOtherNumber)
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

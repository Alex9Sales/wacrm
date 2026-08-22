'use client'

// Disparo por ETAPA (item 6 do funil): manda uma mensagem de texto pra todos
// os leads (negócios abertos) da etapa, reusando o motor de Disparos
// (rate-limit + opt-out). Cada envio vira nota no histórico do negócio.

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Megaphone } from 'lucide-react'

import { SUPPORTED_TOKENS } from '@/lib/whatsapp/message-vars'

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
  const [info, setInfo] = useState<StageBroadcastInfo | null>(null)
  const [channelId, setChannelId] = useState('')
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
    stageBroadcastInfo(stageId)
      .then((i) => {
        setInfo(i)
        setChannelId(i.channels[0]?.id ?? '')
      })
      .catch(() => setInfo({ leadCount: 0, channels: [] }))
  }, [open, stageId])

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
    setSending(true)
    const res = await broadcastToStage({ stageId, channelId, text: body })
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
                  onChange={(e) => setChannelId(e.target.value)}
                  className="h-9 rounded-lg border border-border bg-background px-2 text-sm text-foreground"
                >
                  {info.channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}
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
              !text.trim()
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

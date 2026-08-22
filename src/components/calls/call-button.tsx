'use client'

// ============================================================
// CallButton — click-to-call de qualquer lugar do CRM (card do funil, ficha do
// contato, etc.). Reusa o motor de voz do WhatsApp que já existe
// (startOutboundCall / o modal global). Autossuficiente: dado só o telefone,
// resolve o canal (1 = liga direto; vários = escolhe) e a conversa, e dispara.
//
// Gating: só aparece quando "Tocar ligações no CRM" (crmCallingEnabled) está on
// e o contato tem telefone. Em listas grandes (board do funil) passe `enabled`
// de cima pra não fazer um fetch por card.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { PhoneCall, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { startOutboundCall } from './incoming-call-modal'
import { useCrmCallingEnabled } from '@/hooks/use-crm-calling'
import {
  listWahaChannels,
  type DialerChannel,
} from '@/app/(dashboard)/calls/actions'

// Um fetch de canais compartilhado por TODOS os botões (cacheado por 30s). Evita
// N chamadas quando há muitos botões e o agente clica em vários.
let channelsCache: { at: number; promise: Promise<DialerChannel[]> } | null = null
function loadConnectedChannels(): Promise<DialerChannel[]> {
  const fresh =
    channelsCache && Date.now() - channelsCache.at < 30_000
      ? channelsCache.promise
      : null
  if (fresh) return fresh
  const promise = listWahaChannels()
    .then((list) => list.filter((c) => c.status === 'connected'))
    .catch(() => [] as DialerChannel[])
  channelsCache = { at: Date.now(), promise }
  return promise
}

interface CallButtonProps {
  phone: string | null | undefined
  name?: string | null
  /** Já sei a conversa? passe pra pular o resolve. */
  conversationId?: string
  /** Já sei o canal (ex.: canal da conversa)? passe pra pular a escolha. */
  channelId?: string
  /** Override do gate (passe de cima em listas grandes p/ evitar 1 fetch/card).
   *  Estável por local de uso — nunca alterna entre definido/indefinido. */
  enabled?: boolean
  variant?: 'ghost' | 'solid' | 'pill'
  className?: string
  title?: string
}

// Quando `enabled` não vem de cima, resolvemos o gate aqui com o hook (1 fetch).
// O branch é estável por call-site (o mesmo local sempre passa ou nunca passa
// `enabled`), então a ordem de hooks nunca muda entre renders da instância.
export function CallButton(props: CallButtonProps) {
  return props.enabled === undefined ? (
    <CallButtonAuto {...props} />
  ) : (
    <CallButtonView {...props} enabled={props.enabled} />
  )
}

function CallButtonAuto(props: CallButtonProps) {
  const enabled = useCrmCallingEnabled()
  return <CallButtonView {...props} enabled={enabled} />
}

function CallButtonView({
  phone,
  name,
  conversationId,
  channelId,
  enabled,
  variant = 'ghost',
  className,
  title = 'Ligar (voz WhatsApp)',
}: CallButtonProps & { enabled: boolean }) {
  const callingEnabled = enabled
  const [busy, setBusy] = useState(false)
  const [picker, setPicker] = useState<{
    channels: DialerChannel[]
    x: number
    y: number
  } | null>(null)
  const mounted = useRef(false)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const digits = (phone ?? '').replace(/\D/g, '')
  const dialable = digits.length >= 10

  /** Resolve a conversa (se preciso) e dispara a ligação pelo canal escolhido. */
  const place = useCallback(
    async (chId: string) => {
      setBusy(true)
      try {
        let convId = conversationId
        if (!convId) {
          const res = await fetch('/api/conversations/resolve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone: digits, channelId: chId }),
          })
          const data = (await res.json().catch(() => ({}))) as {
            conversationId?: string
          }
          convId = res.ok ? data.conversationId : undefined
        }
        startOutboundCall(digits, name ?? undefined, 'waha', convId, chId)
      } catch {
        // Liga mesmo sem conversa resolvida — não trava o agente.
        startOutboundCall(digits, name ?? undefined, 'waha', undefined, chId)
      } finally {
        if (mounted.current) setBusy(false)
      }
    },
    [conversationId, digits, name],
  )

  const onClick = useCallback(
    async (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (busy) return
      if (!dialable) {
        toast.error('Contato sem telefone válido para ligar.')
        return
      }
      // Canal já conhecido → liga direto.
      if (channelId) {
        void place(channelId)
        return
      }
      setBusy(true)
      const channels = await loadConnectedChannels()
      if (mounted.current) setBusy(false)
      if (channels.length === 0) {
        toast.error('Nenhum canal de WhatsApp conectado para ligar.')
        return
      }
      if (channels.length === 1) {
        void place(channels[0].id)
        return
      }
      // Vários canais → escolher de qual número ligar.
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
      setPicker({ channels, x: rect.left, y: rect.bottom + 4 })
    },
    [busy, dialable, channelId, place],
  )

  if (!callingEnabled || !dialable) return null

  const base =
    variant === 'solid'
      ? 'inline-flex items-center justify-center rounded-full bg-emerald-500 text-white transition hover:bg-emerald-600 disabled:opacity-40'
      : variant === 'pill'
        ? 'inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 px-2.5 py-1 text-xs font-medium text-emerald-600 transition hover:bg-emerald-500/10 disabled:opacity-40'
        : 'inline-flex items-center justify-center rounded-md text-emerald-600 transition-colors hover:bg-emerald-500/10 disabled:opacity-40'

  return (
    <>
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        aria-label="Ligar para o contato"
        title={title}
        className={`${base} ${className ?? ''}`}
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <PhoneCall className="h-4 w-4" />
        )}
        {variant === 'pill' && <span>Ligar</span>}
      </button>

      {picker &&
        createPortal(
          <div
            className="fixed inset-0 z-[70]"
            onClick={(e) => {
              e.stopPropagation()
              setPicker(null)
            }}
          >
            <div
              className="absolute w-52 overflow-hidden rounded-lg border border-border bg-card shadow-xl"
              style={{ left: picker.x, top: picker.y }}
              onClick={(e) => e.stopPropagation()}
            >
              <p className="border-b border-border px-3 py-2 text-[11px] font-medium text-muted-foreground">
                Ligar pelo número
              </p>
              {picker.channels.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => {
                    setPicker(null)
                    void place(c.id)
                  }}
                  className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition hover:bg-muted"
                >
                  <PhoneCall className="h-3.5 w-3.5 text-emerald-600" />
                  <span className="truncate">{c.name}</span>
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  )
}

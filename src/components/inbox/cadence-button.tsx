'use client'

// ============================================================
// Ícone de CADÊNCIA no compositor da conversa (do lado do ✨/⚡). Clica →
// popover: se o lead não está em cadência, lista as cadências pra escolher e
// ACIONAR ali; se está, mostra o progresso + histórico curto + "Encerrar".
// (Alex: "acima do raio um símbolo da cadência; clica e escolhe qual".)
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Repeat, Loader2, Check, Square, Play } from 'lucide-react'

import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover'
import {
  getContactCadenceState,
  getDealCadenceState,
  getCadenceBadge,
  listCadenceOptions,
  enrollLeadInCadence,
  stopLeadCadence,
  resumeLeadCadence,
  type CadenceState,
} from '@/app/(dashboard)/automations/cadencias/actions'
import { onCadenceChange, emitCadenceChange } from './cadence-bus'

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—'
  try {
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return '—'
  }
}

const EVENT_LABEL: Record<string, string> = {
  enrolled: 'entrou na cadência',
  step_scheduled: 'toque agendado',
  step_sent: 'toque enviado',
  step_skipped: 'toque pulado',
  paused: 'pausada (respondeu)',
  cancelled: 'encerrada',
  completed: 'concluída',
}

export function CadenceButton({
  conversationId,
  dealId,
  variant = 'icon',
  disabled,
  onChanged,
}: {
  conversationId?: string
  dealId?: string
  /** 'icon' = ícone do compositor; 'button' = botão rotulado (detalhe do negócio). */
  variant?: 'icon' | 'button'
  disabled?: boolean
  onChanged?: () => void
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [state, setState] = useState<CadenceState | null>(null)
  const [badge, setBadge] = useState<{ active: boolean; name: string | null }>({
    active: false,
    name: null,
  })
  const [options, setOptions] = useState<{ id: string; name: string }[]>([])
  const [loadError, setLoadError] = useState(false)
  const [busy, setBusy] = useState(false)

  const busKey = dealId ?? conversationId ?? ''

  // Indicador leve (dot/rótulo) — carrega no mount + quando o outro controle muda.
  const loadBadge = useCallback(async () => {
    setBadge(await getCadenceBadge({ conversationId, dealId }))
  }, [conversationId, dealId])

  useEffect(() => {
    void loadBadge()
  }, [loadBadge])
  useEffect(() => onCadenceChange(busKey, loadBadge), [busKey, loadBadge])

  const refresh = useCallback(async () => {
    setLoading(true)
    setLoadError(false)
    try {
      const [st, opts] = await Promise.all([
        dealId
          ? getDealCadenceState(dealId)
          : getContactCadenceState({ conversationId }),
        listCadenceOptions(),
      ])
      // null = a busca FALHOU (não é "sem cadências") — mostra o aviso de
      // recarregar em vez do enganoso "Nenhuma cadência criada".
      if (opts === null) {
        setLoadError(true)
        setOptions([])
      } else {
        setOptions(opts)
      }
      setState(st)
      setBadge({
        active: st?.status === 'active',
        name: st?.status === 'active' ? st.cadence_name : null,
      })
    } catch {
      // Server Action falhou no transporte (clássico: bundle velho após
      // deploy). O aviso manda recarregar — nunca finge lista vazia.
      setLoadError(true)
    } finally {
      setLoading(false)
    }
  }, [conversationId, dealId])

  function onOpenChange(v: boolean) {
    setOpen(v)
    if (v) void refresh()
  }

  const active = state && state.status === 'active' ? state : null

  async function enroll(cadenceId: string) {
    setBusy(true)
    const res = await enrollLeadInCadence({ cadenceId, conversationId, dealId })
    setBusy(false)
    if (!res.ok) {
      toast.error(res.error ?? 'Falha ao iniciar a cadência.')
      return
    }
    toast.success(
      `Cadência iniciada — ${res.scheduled ?? 0} toque(s) agendado(s)` +
        (res.skipped ? `, ${res.skipped} pulado(s)` : ''),
    )
    void refresh()
    emitCadenceChange(busKey)
    onChanged?.()
  }

  async function stop() {
    if (!active) return
    setBusy(true)
    const { error } = await stopLeadCadence(active.enrollment_id)
    setBusy(false)
    if (error) {
      toast.error(error)
      return
    }
    toast.success('Cadência encerrada.')
    void refresh()
    emitCadenceChange(busKey)
    onChanged?.()
  }

  async function resume() {
    if (!state || state.status !== 'paused') return
    setBusy(true)
    const res = await resumeLeadCadence(state.enrollment_id)
    setBusy(false)
    if (!res.ok) {
      toast.error(res.error ?? 'Falha ao retomar a cadência.')
      return
    }
    toast.success(
      `Cadência retomada — ${res.scheduled ?? 0} toque(s) restante(s) reagendado(s).`,
    )
    void refresh()
    emitCadenceChange(busKey)
    onChanged?.()
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {variant === 'button' ? (
        <PopoverTrigger
          disabled={disabled}
          className={`inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted disabled:opacity-40 ${
            badge.active ? 'text-primary' : 'text-foreground'
          }`}
        >
          <Repeat className="h-4 w-4" />
          <span className="max-w-[10rem] truncate">
            {badge.active && badge.name ? badge.name : 'Cadência'}
          </span>
          {badge.active && <span className="h-2 w-2 rounded-full bg-primary" />}
        </PopoverTrigger>
      ) : (
        <PopoverTrigger
          disabled={disabled}
          title={badge.active ? `Cadência: ${badge.name}` : 'Cadência de mensagens'}
          className={`relative flex h-9 w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-40 ${
            badge.active ? 'text-primary' : ''
          }`}
        >
          <Repeat className="h-5 w-5" />
          {badge.active && (
            <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-primary" />
          )}
        </PopoverTrigger>
      )}
      <PopoverContent align="end" className="w-80 p-0">
        {loading ? (
          <div className="flex justify-center p-6 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : active ? (
          <div className="p-3">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-foreground">
                {active.cadence_name}
              </span>
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                em andamento
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {active.sent} de {active.sent + active.pending} enviados
              {active.next_at ? ` · próximo ${fmtDateTime(active.next_at)}` : ''}
            </p>
            {active.events.length > 0 && (
              <ul className="mt-2 max-h-40 space-y-1 overflow-y-auto border-t border-border pt-2">
                {active.events.slice(0, 8).map((e, idx) => (
                  <li
                    key={idx}
                    className="flex items-center gap-1.5 text-[11px] text-muted-foreground"
                  >
                    <span className="text-muted-foreground/60">
                      {fmtDateTime(e.created_at)}
                    </span>
                    <span>{EVENT_LABEL[e.type] ?? e.type}</span>
                    {e.channel ? <span>· {e.channel}</span> : null}
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={() => void stop()}
              disabled={busy}
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm text-red-500 hover:bg-red-500/10 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Square className="h-3.5 w-3.5" />
              )}
              Encerrar cadência
            </button>
          </div>
        ) : (
          <div className="p-3">
            <p className="text-sm font-semibold text-foreground">
              Colocar em cadência
            </p>
            {state && state.status !== 'active' && (
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Última: {state.cadence_name} ({EVENT_LABEL[state.status] ?? state.status})
              </p>
            )}
            {/* Pausada (o lead respondeu) → retomar de onde parou, sem
                recomeçar do degrau 1. Só reagenda os toques que faltam. */}
            {state && state.status === 'paused' && (
              <button
                onClick={() => void resume()}
                disabled={busy}
                className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                Retomar de onde parou
              </button>
            )}
            {loadError ? (
              <p className="mt-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
                ⚠️ Não consegui carregar as cadências — recarregue a página
                (Ctrl+Shift+R) e tente de novo.
              </p>
            ) : options.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">
                Nenhuma cadência criada. Crie em Automações → Cadências.
              </p>
            ) : (
              <ul className="mt-2 space-y-1">
                {options.map((o) => (
                  <li key={o.id}>
                    <button
                      onClick={() => void enroll(o.id)}
                      disabled={busy}
                      className="flex w-full items-center gap-2 rounded-lg border border-border px-3 py-2 text-left text-sm text-foreground hover:border-primary/50 hover:bg-muted disabled:opacity-50"
                    >
                      <Check className="h-3.5 w-3.5 text-primary opacity-0" />
                      <span className="flex-1 truncate">{o.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

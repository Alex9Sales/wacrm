'use client'

// Bloco "Cadência" da aba lateral da conversa: mostra a cadência do lead
// (nome, progresso, próximo envio, histórico curto) + o botão de gerenciar.

import { useCallback, useEffect, useState } from 'react'

import {
  getContactCadenceState,
  type CadenceState,
} from '@/app/(dashboard)/automations/cadencias/actions'
import { CadenceButton } from './cadence-button'
import { onCadenceChange } from './cadence-bus'

const STATUS_LABEL: Record<string, string> = {
  active: 'em andamento',
  paused: 'pausada',
  done: 'concluída',
  cancelled: 'encerrada',
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

function fmt(iso: string | null): string {
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

export function CadenceSidebar({ conversationId }: { conversationId: string }) {
  const [state, setState] = useState<CadenceState | null>(null)
  const [loaded, setLoaded] = useState(false)

  const refresh = useCallback(async () => {
    const st = await getContactCadenceState({ conversationId })
    setState(st)
    setLoaded(true)
  }, [conversationId])

  useEffect(() => {
    void refresh()
  }, [refresh])
  // Sincroniza com o botão do compositor (mesma conversa).
  useEffect(() => onCadenceChange(conversationId, refresh), [conversationId, refresh])

  return (
    <div className="space-y-2">
      {loaded && state ? (
        <div className="rounded-lg border border-border bg-muted/30 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium text-foreground">
              {state.cadence_name}
            </span>
            <span
              className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
                state.status === 'active'
                  ? 'bg-primary/10 text-primary'
                  : 'bg-muted text-muted-foreground'
              }`}
            >
              {STATUS_LABEL[state.status] ?? state.status}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {state.sent} de {state.sent + state.pending} enviados
            {state.status === 'active' && state.next_at
              ? ` · próximo ${fmt(state.next_at)}`
              : ''}
          </p>
          {state.events.length > 0 && (
            <ul className="mt-2 max-h-32 space-y-1 overflow-y-auto border-t border-border pt-2">
              {state.events.slice(0, 6).map((e, i) => (
                <li key={i} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="text-muted-foreground/60">{fmt(e.created_at)}</span>
                  <span>{EVENT_LABEL[e.type] ?? e.type}</span>
                  {e.channel ? <span>· {e.channel}</span> : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : loaded ? (
        <p className="text-xs text-muted-foreground">Este lead não está em nenhuma cadência.</p>
      ) : null}
      <CadenceButton conversationId={conversationId} variant="button" onChanged={refresh} />
    </div>
  )
}

'use client'

// ============================================================
// BrokenChannelAlert — o aviso de "número fora do ar com agendadas presas".
//
// O canal de uma mensagem agendada é o canal da CONVERSA dela. Quando esse
// número cai (ban do WhatsApp, logout no aparelho), tudo que estava marcado
// ali falha na hora do envio — e antes disso acontecia em silêncio.
//
// Aqui a conta vê o estrago e escolhe outro número. Sem fallback automático
// (decisão do Alex, 01/09): pular sozinho pra outro número pode empurrar a
// fila pra um número que também está banido.
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  listBrokenChannelSchedules,
  reassignScheduledChannel,
  type BrokenChannelSchedules,
} from '@/app/(dashboard)/agendamentos/actions'
import {
  listSendableChannels,
  type SendableChannel,
} from '@/app/(dashboard)/inbox/actions'

export function BrokenChannelAlert({ onFixed }: { onFixed: () => void }) {
  const [broken, setBroken] = useState<BrokenChannelSchedules[]>([])
  const [channels, setChannels] = useState<SendableChannel[]>([])
  const [target, setTarget] = useState<Record<string, string>>({})
  const [withFailed, setWithFailed] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const load = useCallback(() => {
    void Promise.all([
      listBrokenChannelSchedules().catch(() => [] as BrokenChannelSchedules[]),
      listSendableChannels().catch(() => [] as SendableChannel[]),
    ]).then(([b, c]) => {
      setBroken(b)
      setChannels(c)
    })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function move(row: BrokenChannelSchedules) {
    // Número no ar com falhas antigas: reenvia pelo MESMO número (não há
    // troca a fazer). Número fora do ar: exige escolher outro.
    const to = row.is_down ? target[row.channel_id] : row.channel_id
    if (!to) {
      toast.error('Escolha por qual número as mensagens devem sair.')
      return
    }
    setBusy(row.channel_id)
    try {
      const res = await reassignScheduledChannel({
        fromChannelId: row.channel_id,
        toChannelId: to,
        includeFailed: row.is_down ? !!withFailed[row.channel_id] : true,
      })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(
        res.requeued > 0
          ? `${res.moved} mensagem(ns) movida(s) — ${res.requeued} volta(m) a sair, espaçadas para não queimar o número.`
          : `${res.moved} mensagem(ns) movida(s) para o novo número.`,
      )
      load()
      onFixed()
    } catch {
      toast.error('Falha ao trocar o número.')
    } finally {
      setBusy(null)
    }
  }

  if (broken.length === 0) return null

  return (
    <div className="space-y-3">
      {broken.map((row) => {
        const name = row.channel_name ?? 'sem nome'
        const oldest = row.failed_oldest
          ? new Date(row.failed_oldest).toLocaleDateString('pt-BR', {
              day: '2-digit',
              month: '2-digit',
            })
          : null
        return (
          <div
            key={row.channel_id}
            className={`rounded-xl border p-4 ${
              row.is_down
                ? 'border-destructive/40 bg-destructive/10'
                : 'border-amber-500/40 bg-amber-500/10'
            }`}
          >
            <div className="flex items-start gap-3">
              <AlertTriangle
                className={`mt-0.5 size-5 shrink-0 ${
                  row.is_down ? 'text-destructive' : 'text-amber-500'
                }`}
              />
              <div className="min-w-0 flex-1 space-y-3">
                {row.is_down ? (
                  <div>
                    <p className="font-semibold text-foreground">
                      {row.pending + row.failed} mensagem
                      {row.pending + row.failed > 1 ? 's' : ''} agendada
                      {row.pending + row.failed > 1 ? 's' : ''} presa
                      {row.pending + row.failed > 1 ? 's' : ''} no número
                      &quot;{name}&quot;, que está fora do ar
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      Esse número está desconectado ou banido — nada marcado
                      nele vai sair. Escolha outro número para essas mensagens.
                      {row.failed > 0 &&
                        ` ${row.failed} já falhou por causa disso.`}
                    </p>
                  </div>
                ) : (
                  <div>
                    <p className="font-semibold text-foreground">
                      {row.failed} mensagem{row.failed > 1 ? 's' : ''} agendada
                      {row.failed > 1 ? 's' : ''} não saiu porque o número
                      &quot;{name}&quot; estava fora do ar
                    </p>
                    <p className="mt-0.5 text-sm text-muted-foreground">
                      O número já voltou. Você pode reenviar essas mensagens
                      agora — elas saem <strong>espaçadas</strong>, uma a cada
                      ~1 minuto, para não queimar o número.
                      {oldest && ` A mais antiga era para ${oldest}`}
                      {oldest && ' — confira se ainda faz sentido enviar.'}
                    </p>
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {row.is_down && (
                    <select
                      value={target[row.channel_id] ?? ''}
                      onChange={(e) =>
                        setTarget((t) => ({
                          ...t,
                          [row.channel_id]: e.target.value,
                        }))
                      }
                      className="min-w-[220px] rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
                    >
                      <option value="">Enviar pelo número…</option>
                      {channels.map((ch) => (
                        <option key={ch.id} value={ch.id}>
                          {ch.name}
                          {ch.phoneNumber ? ` · ${ch.phoneNumber}` : ''}
                        </option>
                      ))}
                    </select>
                  )}

                  <Button
                    onClick={() => void move(row)}
                    disabled={
                      busy === row.channel_id ||
                      (row.is_down && channels.length === 0)
                    }
                  >
                    {busy === row.channel_id ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        {row.is_down ? 'Trocando…' : 'Reenviando…'}
                      </>
                    ) : row.is_down ? (
                      'Trocar número'
                    ) : (
                      `Reenviar ${row.failed}`
                    )}
                  </Button>
                </div>

                {row.is_down && row.failed > 0 && (
                  <label className="flex cursor-pointer items-start gap-2 text-sm text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={!!withFailed[row.channel_id]}
                      onChange={(e) =>
                        setWithFailed((w) => ({
                          ...w,
                          [row.channel_id]: e.target.checked,
                        }))
                      }
                      className="mt-1 size-4 accent-[var(--primary)]"
                    />
                    <span>
                      Reenviar também as {row.failed} que já falharam — elas
                      voltam para a fila <strong>espaçadas</strong> (uma a cada
                      ~1 min) para não queimar o número novo.
                    </span>
                  </label>
                )}

                {row.is_down && channels.length === 0 && (
                  <p className="text-sm text-destructive">
                    Nenhum outro número conectado. Reconecte um canal para
                    liberar essas mensagens.
                  </p>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

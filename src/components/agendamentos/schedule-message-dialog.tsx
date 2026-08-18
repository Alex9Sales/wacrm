'use client'

// ============================================================
// Nova mensagem agendada a partir da Central de Agendamentos.
// Busca um CONTATO ou um NEGÓCIO (funil) → acha/cria a conversa do contato
// (startNewConversation) → agenda a mensagem (scheduleMessage).
// ============================================================

import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { CalendarClock, Plus, X, Search, User, GitBranch, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { listContacts } from '@/app/(dashboard)/contacts/actions'
import { searchDealsForSchedule } from '@/app/(dashboard)/agendamentos/actions'
import {
  listSendableChannels,
  startNewConversation,
  type SendableChannel,
} from '@/app/(dashboard)/inbox/actions'
import {
  scheduleMessage,
  countScheduledPendingOnDay,
} from '@/app/(dashboard)/inbox/schedule-actions'

type Target = { kind: 'contact' | 'deal'; label: string; phone: string; name: string | null }

function pad(n: number) {
  return String(n).padStart(2, '0')
}
function defaultWhen(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000) // +1h
  d.setMinutes(0, 0, 0)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function ScheduleMessageDialog({ onScheduled }: { onScheduled: () => void }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'contact' | 'deal'>('contact')
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<Target[]>([])
  const [searching, setSearching] = useState(false)
  const [target, setTarget] = useState<Target | null>(null)
  const [channels, setChannels] = useState<SendableChannel[]>([])
  const [channelId, setChannelId] = useState('')
  const [text, setText] = useState('')
  const [when, setWhen] = useState(defaultWhen)
  const [submitting, setSubmitting] = useState(false)
  // Anti-ban: quando o dia escolhido já tem 30+ agendadas, guarda a contagem
  // pra pedir uma 2ª confirmação ("agendar mesmo assim"). null = sem aviso.
  const [dayWarn, setDayWarn] = useState<number | null>(null)
  const seq = useRef(0)

  const reset = () => {
    setTab('contact')
    setQuery('')
    setResults([])
    setTarget(null)
    setChannelId('')
    setText('')
    setWhen(defaultWhen())
    setDayWarn(null)
  }

  useEffect(() => {
    if (!open) return
    listSendableChannels()
      .then((list) => setChannels(list))
      .catch(() => setChannels([]))
  }, [open])

  // Trocar a data/hora limpa o aviso de volume (recheca no próximo Agendar).
  useEffect(() => {
    setDayWarn(null)
  }, [when])

  // Busca (contato ou negócio), debounced.
  useEffect(() => {
    if (!open || target) return
    const q = query.trim()
    if (!q) {
      setResults([])
      return
    }
    const id = ++seq.current
    setSearching(true)
    const t = setTimeout(async () => {
      try {
        if (tab === 'contact') {
          const { contacts } = await listContacts({ offset: 0, limit: 6, search: q, tagIds: [] })
          const list: Target[] = contacts
            .filter((c) => !c.is_group && c.phone)
            .map((c) => ({
              kind: 'contact',
              label: c.name || c.phone,
              phone: c.phone,
              name: c.name ?? null,
            }))
          if (id === seq.current) setResults(list)
        } else {
          const deals = await searchDealsForSchedule(q)
          const list: Target[] = deals.map((d) => ({
            kind: 'deal',
            label: `${d.title}${d.contactName ? ` · ${d.contactName}` : ''}`,
            phone: d.contactPhone ?? '',
            name: d.contactName,
          }))
          if (id === seq.current) setResults(list)
        }
      } catch {
        if (id === seq.current) setResults([])
      } finally {
        if (id === seq.current) setSearching(false)
      }
    }, 250)
    return () => clearTimeout(t)
  }, [query, tab, open, target])

  const needsChannel = channels.length > 1 && !channelId
  const canSubmit =
    !!target && text.trim().length > 0 && !!when && !needsChannel && !submitting

  const submit = async () => {
    if (!target || !target.phone) {
      toast.error('Selecione um contato/negócio com telefone.')
      return
    }
    if (!text.trim()) {
      toast.error('Escreva a mensagem.')
      return
    }
    // Anti-ban: se o dia já tem 30+ agendadas, avisa e pede 2ª confirmação.
    if (dayWarn === null) {
      try {
        const n = await countScheduledPendingOnDay(new Date(when).toISOString())
        if (n >= 30) {
          setDayWarn(n)
          toast.warning(
            `Você já tem ${n} mensagens agendadas para esse dia. Mandar muitas no mesmo dia aumenta o risco de bloqueio — considere outra data.`,
          )
          return
        }
      } catch {
        // Se a checagem falhar, não trava o agendamento.
      }
    }
    setSubmitting(true)
    try {
      const { conversationId } = await startNewConversation({
        phone: target.phone,
        name: target.name,
        channelId: channelId || null,
      })
      const r = await scheduleMessage({
        conversationId,
        contentText: text.trim(),
        scheduledAt: new Date(when).toISOString(),
      })
      if (!r.ok) {
        toast.error(r.error)
        return
      }
      toast.success('Mensagem agendada.')
      setOpen(false)
      reset()
      onScheduled()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao agendar.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-4 w-4" /> Nova mensagem
      </Button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !submitting && setOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h3 className="flex items-center gap-2 font-heading text-base font-semibold">
                <CalendarClock className="h-4 w-4 text-primary" />
                Agendar mensagem
              </h3>
              <button
                onClick={() => setOpen(false)}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex flex-col gap-3">
              {/* Alvo: contato ou negócio */}
              {target ? (
                <div className="flex items-center justify-between rounded-lg bg-muted px-3 py-2 text-sm">
                  <span className="flex items-center gap-2 truncate">
                    {target.kind === 'contact' ? (
                      <User className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <GitBranch className="h-4 w-4 text-muted-foreground" />
                    )}
                    <span className="truncate">{target.label}</span>
                    <span className="text-xs text-muted-foreground">{target.phone}</span>
                  </span>
                  <button
                    onClick={() => {
                      setTarget(null)
                      setQuery('')
                    }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div>
                  <div className="mb-2 flex overflow-hidden rounded-lg ring-1 ring-border">
                    <button
                      type="button"
                      onClick={() => {
                        setTab('contact')
                        setResults([])
                      }}
                      className={`flex-1 px-3 py-1.5 text-xs font-medium ${tab === 'contact' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                    >
                      Contato
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTab('deal')
                        setResults([])
                      }}
                      className={`flex-1 px-3 py-1.5 text-xs font-medium ${tab === 'deal' ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                    >
                      Negócio (funil)
                    </button>
                  </div>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      autoFocus
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder={tab === 'contact' ? 'Buscar contato…' : 'Buscar negócio ou contato…'}
                      className="pl-8"
                    />
                    {searching && (
                      <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
                    )}
                  </div>
                  {results.length > 0 && (
                    <div className="mt-1 max-h-44 overflow-y-auto rounded-lg border border-border">
                      {results.map((r, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => {
                            setTarget(r)
                            setResults([])
                          }}
                          className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                        >
                          <span className="truncate">{r.label}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">{r.phone}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  {query.trim() && !searching && results.length === 0 && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Nada encontrado (só {tab === 'contact' ? 'contatos' : 'negócios'} com telefone).
                    </p>
                  )}
                </div>
              )}

              {/* Canal (se houver mais de um) */}
              {channels.length > 1 && (
                <div>
                  <Label className="mb-1 block text-xs">Enviar pelo número</Label>
                  <Select value={channelId} onValueChange={(v) => v && setChannelId(v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue placeholder="Escolha o canal">
                        {(v: string) => {
                          const ch = channels.find((c) => c.id === v)
                          if (!ch) return 'Escolha o canal'
                          return `${ch.name || 'WhatsApp'}${ch.phoneNumber ? ` · ${ch.phoneNumber}` : ''}`
                        }}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {channels.map((ch) => (
                        <SelectItem key={ch.id} value={ch.id}>
                          {ch.name || 'WhatsApp'}
                          {ch.phoneNumber ? ` · ${ch.phoneNumber}` : ''}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {channels.length === 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Nenhum canal conectado — conecte um WhatsApp para agendar.
                </p>
              )}

              {/* Mensagem */}
              <div>
                <Label className="mb-1 block text-xs">Mensagem</Label>
                <Textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  rows={4}
                  placeholder="Escreva a mensagem que será enviada…"
                />
              </div>

              {/* Quando */}
              <div>
                <Label className="mb-1 block text-xs">Enviar em</Label>
                <input
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                />
              </div>
            </div>

            {dayWarn !== null && (
              <div className="mt-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300">
                ⚠️ Esse dia já tem <strong>{dayWarn}</strong> mensagens agendadas.
                Mandar muitas no mesmo dia aumenta o risco de bloqueio — o ideal é
                escolher <strong>outra data</strong>. Se quiser mesmo assim, é só
                clicar em Agendar de novo.
              </div>
            )}

            <div className="mt-5 flex items-center justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
                Cancelar
              </Button>
              <Button onClick={submit} disabled={!canSubmit || channels.length === 0}>
                {submitting
                  ? 'Agendando…'
                  : dayWarn !== null
                    ? 'Agendar mesmo assim'
                    : 'Agendar'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

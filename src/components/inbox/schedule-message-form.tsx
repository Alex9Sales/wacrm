'use client'

// ============================================================
// ScheduleMessageForm — schedule a single text message into the current
// conversation. Fields: Mensagem* (textarea) · Enviar em* (datetime-local
// with quick presets). The datetime-local is local wall-clock; we convert
// it to an absolute ISO instant (new Date(local).toISOString()) before
// calling the server so the worker fires at the right moment regardless of
// server timezone.
// ============================================================

import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Loader2, Paperclip, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { QuickReplyPicker } from '@/components/inbox/quick-reply-picker'
import {
  scheduleMessage,
  updateScheduledMessage,
  getConversationChannel,
  type ScheduledMessageLite,
} from '@/app/(dashboard)/inbox/schedule-actions'
import {
  listSendableChannels,
  type SendableChannel,
} from '@/app/(dashboard)/inbox/actions'
import { listTeamMembers } from '@/app/(dashboard)/internal-chat/actions'
import { uploadAccountMedia, deleteAccountMedia, mediaMaxBytesFor } from '@/lib/storage/upload-media'
import { useAuth } from '@/hooks/use-auth'
import { hasMinRole } from '@/lib/auth/roles'

interface ScheduleMessageFormProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversationId: string
  onSaved: () => void
  /** Quando setado, o form edita este agendamento (pendente) em vez de criar. */
  editing?: ScheduledMessageLite | null
}

const pad = (n: number) => String(n).padStart(2, '0')

/** A Date → the value a <input type="datetime-local"> expects (local, mins). */
function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Presets relative to now, returned as datetime-local strings. */
function presets(): { label: string; value: string }[] {
  const now = new Date()
  const inHour = new Date(now.getTime() + 60 * 60 * 1000)
  const in3h = new Date(now.getTime() + 3 * 60 * 60 * 1000)
  const tomorrow9 = new Date(now)
  tomorrow9.setDate(tomorrow9.getDate() + 1)
  tomorrow9.setHours(9, 0, 0, 0)
  const nextWeek9 = new Date(now)
  nextWeek9.setDate(nextWeek9.getDate() + 7)
  nextWeek9.setHours(9, 0, 0, 0)
  return [
    { label: 'Em 1 hora', value: toLocalInput(inHour) },
    { label: 'Em 3 horas', value: toLocalInput(in3h) },
    { label: 'Amanhã 9h', value: toLocalInput(tomorrow9) },
    { label: 'Próx. semana', value: toLocalInput(nextWeek9) },
  ]
}

export function ScheduleMessageForm({
  open,
  onOpenChange,
  conversationId,
  onSaved,
  editing,
}: ScheduleMessageFormProps) {
  const { accountRole } = useAuth()
  // Só admin/supervisor escolhem o responsável (agente agenda pro próprio lead).
  const canAssign = hasMinRole(accountRole ?? 'viewer', 'supervisor')

  const [text, setText] = useState('')
  const [when, setWhen] = useState('')
  const [assignee, setAssignee] = useState('') // '' = herda o dono do lead
  const [optOut, setOptOut] = useState(false) // anexar "responda SAIR"
  const [modelOpen, setModelOpen] = useState(false)
  const [members, setMembers] = useState<{ id: string; name: string | null }[]>(
    [],
  )
  const [saving, setSaving] = useState(false)
  // "Enviar pelo número" — igual à Central de Agendamentos. Pré-selecionado no
  // canal da própria conversa; se esse canal caiu/foi banido, avisa e obriga a
  // escolher outro (nada de fallback automático: cair pra um número que também
  // está banido só espalha o problema).
  const [channels, setChannels] = useState<SendableChannel[]>([])
  const [channelId, setChannelId] = useState('')
  const [convChannel, setConvChannel] = useState<{
    channelId: string | null
    channelName: string | null
    isDown: boolean
  } | null>(null)

  // Ao abrir: se estiver editando, prefill com o agendamento; senão, novo
  // (padrão daqui a 1 hora).
  useEffect(() => {
    if (!open) return
    if (editing) {
      setText(editing.content_text ?? '')
      setWhen(toLocalInput(new Date(editing.scheduled_at)))
    } else {
      setText('')
      setWhen(toLocalInput(new Date(Date.now() + 60 * 60 * 1000)))
      setAssignee('')
      setOptOut(false)
    }
  }, [open, editing])

  // Canais disponíveis + qual é o da conversa (pra pré-selecionar / avisar).
  useEffect(() => {
    if (!open || editing) return
    let alive = true
    void Promise.all([
      listSendableChannels().catch(() => [] as SendableChannel[]),
      getConversationChannel(conversationId).catch(() => null),
    ]).then(([list, current]) => {
      if (!alive) return
      setChannels(list)
      setConvChannel(current)
      // Canal da conversa quando ele está no ar; se caiu, deixa VAZIO pra
      // pessoa escolher conscientemente por qual número vai sair.
      const usable =
        current?.channelId && list.some((c) => c.id === current.channelId)
      setChannelId(usable ? (current!.channelId as string) : '')
    })
    return () => {
      alive = false
    }
  }, [open, editing, conversationId])

  // Carrega os membros p/ o seletor de responsável (só admin/supervisor).
  useEffect(() => {
    if (!open || !canAssign) return
    listTeamMembers()
      .then((m) => setMembers(m as { id: string; name: string | null }[]))
      .catch(() => setMembers([]))
  }, [open, canAssign])

  // Mesmo bucket do compositor da conversa — o anexo agendado é mídia de chat.
  const BUCKET_ANEXO = 'chat-media'

  // 📎 12/09 (João): "preciso criar um agendamento pra enviar um contrato pro
  // cliente". A tabela e o worker já mandavam mídia; faltava a tela.
  const [anexo, setAnexo] = useState<{ url: string; path: string; nome: string; tipo: 'image' | 'video' | 'document' } | null>(null)
  const [subindo, setSubindo] = useState(false)

  function tipoDoArquivo(f: File): 'image' | 'video' | 'document' {
    if (f.type.startsWith('image/')) return 'image'
    if (f.type.startsWith('video/')) return 'video'
    return 'document'
  }

  async function anexar(file: File | undefined) {
    if (!file) return
    const tipo = tipoDoArquivo(file)
    // Sem o provedor à mão aqui, vale o teto do WhatsApp (o menor).
    const max = mediaMaxBytesFor(undefined, tipo)
    if (file.size > max) {
      toast.error(`O arquivo tem ${(file.size / 1024 / 1024).toFixed(1)} MB e o limite para ${tipo} é ${Math.round(max / 1024 / 1024)} MB.`)
      return
    }
    setSubindo(true)
    try {
      const { publicUrl, path } = await uploadAccountMedia(BUCKET_ANEXO, file)
      // Trocar o anexo apaga o anterior, pra não deixar arquivo órfão no bucket.
      if (anexo?.path) void deleteAccountMedia(BUCKET_ANEXO, anexo.path).catch(() => {})
      setAnexo({ url: publicUrl, path, nome: file.name, tipo })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha no upload.')
    } finally {
      setSubindo(false)
    }
  }

  function removerAnexo() {
    if (anexo?.path) void deleteAccountMedia(BUCKET_ANEXO, anexo.path).catch(() => {})
    setAnexo(null)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const body = text.trim()
    if (!body && !anexo) {
      toast.error('Escreva a mensagem ou anexe um arquivo.')
      return
    }
    if (subindo) {
      toast.error('Espere o anexo terminar de subir.')
      return
    }
    if (!when) {
      toast.error('Escolha data e hora.')
      return
    }
    const local = new Date(when)
    if (Number.isNaN(local.getTime())) {
      toast.error('Data/hora inválida.')
      return
    }
    if (local.getTime() - Date.now() < 60_000) {
      toast.error('Escolha um horário pelo menos 1 min à frente.')
      return
    }
    // Número da conversa fora do ar e nenhum outro escolhido: a mensagem
    // nasceria condenada a falhar na hora do envio.
    if (!editing && convChannel?.isDown && !channelId) {
      toast.error('Escolha por qual número enviar — o desta conversa está fora do ar.')
      return
    }

    setSaving(true)
    try {
      const res = editing
        ? await updateScheduledMessage(editing.id, {
            contentText: body,
            scheduledAt: local.toISOString(),
          })
        : await scheduleMessage({
            conversationId,
            contentText: body,
            // Absolute instant — local wall-clock converted to UTC ISO.
            scheduledAt: local.toISOString(),
            // '' = herda o dono do lead; admin/supervisor podem atribuir.
            assignedTo: assignee || null,
            includeOptOut: optOut,
            channelId: channelId || null,
            messageType: anexo?.tipo ?? 'text',
            mediaUrl: anexo?.url ?? null,
            filename: anexo?.nome ?? null,
          })
      if (!res.ok) {
        toast.error(res.error)
        return
      }
      toast.success(editing ? 'Agendamento atualizado.' : 'Mensagem agendada.')
      onOpenChange(false)
      onSaved()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao agendar.')
    } finally {
      setSaving(false)
    }
  }

  const nowLocal = toLocalInput(new Date())

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto border-border bg-popover text-popover-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">
            {editing ? 'Editar mensagem agendada' : 'Agendar mensagem'}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            A mensagem será enviada automaticamente nesta conversa no horário
            escolhido.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label htmlFor="sched-text">
                Mensagem {anexo ? <span className="font-normal text-muted-foreground">(opcional, vira a legenda)</span> : <span className="text-destructive">*</span>}
              </Label>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span>Modelos</span>
                <QuickReplyPicker
                  open={modelOpen}
                  onOpenChange={setModelOpen}
                  onPick={(c) => setText((m) => (m.trim() ? `${m}\n${c}` : c))}
                  title="Inserir um modelo (resposta rápida)"
                />
              </div>
            </div>
            <textarea
              id="sched-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Escreva a mensagem que será enviada…"
              rows={4}
              autoFocus
              className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder-muted-foreground outline-none focus:border-primary/50"
            />
            {/* 📎 Anexo: imagem, vídeo ou documento (contrato, boleto, PDF). */}
            {!editing && (
              <div className="pt-1">
                {anexo ? (
                  <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-2.5 py-2 text-xs">
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-foreground">{anexo.nome}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {anexo.tipo === 'image' ? 'imagem' : anexo.tipo === 'video' ? 'vídeo' : 'documento'}
                    </span>
                    <button
                      type="button"
                      onClick={removerAnexo}
                      className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-background hover:text-foreground"
                      title="Remover o anexo"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ) : (
                  <label className="inline-flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                    {subindo ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Paperclip className="h-3.5 w-3.5" />}
                    <span>{subindo ? 'Subindo o anexo…' : 'Anexar imagem, vídeo ou documento'}</span>
                    <input
                      type="file"
                      className="hidden"
                      disabled={subindo}
                      onChange={(e) => {
                        void anexar(e.target.files?.[0])
                        e.currentTarget.value = ''
                      }}
                    />
                  </label>
                )}
              </div>
            )}
            {!editing && (
              <label className="flex cursor-pointer items-start gap-2 pt-1 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={optOut}
                  onChange={(e) => setOptOut(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  <strong className="text-foreground">
                    Incluir opção de descadastro
                  </strong>{' '}
                  — anexa <em>&quot;responda SAIR&quot;</em> no fim. Quem responder
                  SAIR é bloqueado (não perturbe) e não recebe mais.
                </span>
              </label>
            )}
          </div>

          {/* Enviar pelo número — só ao criar (editar não muda o canal). */}
          {!editing && (channels.length > 1 || convChannel?.isDown) && (
            <div className="space-y-1.5">
              <Label htmlFor="sched-channel">
                Enviar pelo número
                {convChannel?.isDown && (
                  <span className="text-destructive"> *</span>
                )}
              </Label>
              {convChannel?.isDown && (
                <p className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  O número desta conversa
                  {convChannel.channelName ? ` (${convChannel.channelName})` : ''}{' '}
                  está fora do ar — desconectado ou banido. Escolha outro número
                  para a mensagem sair no horário marcado.
                </p>
              )}
              <select
                id="sched-channel"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
              >
                <option value="">Escolha o número…</option>
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.name}
                    {ch.phoneNumber ? ` · ${ch.phoneNumber}` : ''}
                  </option>
                ))}
              </select>
              {channels.length === 0 && (
                <p className="text-[11px] text-destructive">
                  Nenhum número conectado no momento.
                </p>
              )}
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="sched-when">
              Enviar em <span className="text-destructive">*</span>
            </Label>
            <Input
              id="sched-when"
              type="datetime-local"
              value={when}
              min={nowLocal}
              onChange={(e) => setWhen(e.target.value)}
              required
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {presets().map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => setWhen(p.value)}
                  className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground"
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Responsável — só admin/supervisor, só ao criar. Vazio = dono do lead. */}
          {canAssign && !editing && members.length > 0 && (
            <div className="space-y-1.5">
              <Label htmlFor="sched-assignee">Responsável</Label>
              <select
                id="sched-assignee"
                value={assignee}
                onChange={(e) => setAssignee(e.target.value)}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
              >
                <option value="">Dono do lead (padrão)</option>
                {members.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name ?? 'Sem nome'}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground">
                Quem fica responsável por esta mensagem. Se for outra pessoa, ela
                é notificada e a mensagem aparece na central dela.
              </p>
            </div>
          )}

          <DialogFooter className="border-border bg-popover">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={saving}
            >
              Cancelar
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {editing ? 'Salvando…' : 'Agendando…'}
                </>
              ) : editing ? (
                'Salvar'
              ) : (
                'Agendar'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

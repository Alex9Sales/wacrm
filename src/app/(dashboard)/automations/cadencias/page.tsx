'use client'

// ============================================================
// Construtor de Cadências (Automações → Cadências). Lista de cadências
// reutilizáveis + editor de degraus multicanal {quando · canal · mensagem}.
// O lead entra na cadência pelo funil ou pela conversa (ícone). Aqui só se
// MONTA a sequência. Ver src/lib/cadences/cadence.ts (motor).
// ============================================================

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ArrowLeft,
  Plus,
  Pencil,
  Trash2,
  Loader2,
  Send,
  MessageCircle,
  Mail,
  AtSign,
  GripVertical,
} from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  listCadences,
  getCadence,
  createCadence,
  updateCadence,
  deleteCadence,
  listStagesForCadence,
  type CadenceRow,
  type CadenceStepInput,
  type StagePickerOption,
} from './actions'

type Draft = {
  id: string | null
  name: string
  description: string
  active: boolean
  pauseOnReply: boolean
  funnelAutomation: boolean
  contactedStageId: string
  steps: CadenceStepInput[]
}

const EMPTY_DRAFT: Draft = {
  id: null,
  name: '',
  description: '',
  active: true,
  pauseOnReply: true,
  funnelAutomation: false,
  contactedStageId: '',
  steps: [{ delayValue: 0, delayUnit: 'days', channel: 'whatsapp', subject: '', body: '' }],
}

const CHANNEL_META: Record<
  string,
  { label: string; Icon: typeof MessageCircle; color: string }
> = {
  whatsapp: { label: 'WhatsApp', Icon: MessageCircle, color: 'text-emerald-500' },
  email: { label: 'E-mail', Icon: Mail, color: 'text-sky-500' },
  instagram: { label: 'Instagram', Icon: AtSign, color: 'text-fuchsia-500' },
}

function whenLabel(v: number, unit: string): string {
  if (v === 0) return 'na hora'
  const u = unit === 'minutes' ? 'min' : unit === 'hours' ? 'h' : 'd'
  return `+${v}${u}`
}

export default function CadenciasPage() {
  const router = useRouter()
  const [items, setItems] = useState<CadenceRow[] | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [stageOptions, setStageOptions] = useState<StagePickerOption[]>([])

  const load = useCallback(async () => {
    setItems(await listCadences())
  }, [])

  useEffect(() => {
    void load()
    listStagesForCadence().then(setStageOptions).catch(() => {})
  }, [load])

  function openNew() {
    setDraft({ ...EMPTY_DRAFT, steps: [{ ...EMPTY_DRAFT.steps[0] }] })
    setFormOpen(true)
  }

  async function openEdit(id: string) {
    setBusyId(id)
    const cad = await getCadence(id)
    setBusyId(null)
    if (!cad) {
      toast.error('Cadência não encontrada.')
      return
    }
    setDraft({
      id: cad.id,
      name: cad.name,
      description: cad.description ?? '',
      active: cad.active,
      pauseOnReply: cad.pause_on_reply,
      funnelAutomation: cad.funnel_automation,
      contactedStageId: cad.contacted_stage_id ?? '',
      steps: cad.steps.map((s) => ({
        delayValue: s.delay_value,
        delayUnit: s.delay_unit as CadenceStepInput['delayUnit'],
        channel: s.channel as CadenceStepInput['channel'],
        subject: s.subject ?? '',
        body: s.body,
      })),
    })
    setFormOpen(true)
  }

  function patchStep(i: number, patch: Partial<CadenceStepInput>) {
    setDraft((d) => ({
      ...d,
      steps: d.steps.map((s, idx) => (idx === i ? { ...s, ...patch } : s)),
    }))
  }
  function addStep() {
    setDraft((d) => ({
      ...d,
      steps: [
        ...d.steps,
        { delayValue: 1, delayUnit: 'days', channel: 'whatsapp', subject: '', body: '' },
      ],
    }))
  }
  function removeStep(i: number) {
    setDraft((d) => ({ ...d, steps: d.steps.filter((_, idx) => idx !== i) }))
  }

  async function save() {
    const name = draft.name.trim()
    if (!name) {
      toast.error('Dê um nome à cadência.')
      return
    }
    const steps = draft.steps.filter((s) => s.body.trim())
    if (steps.length === 0) {
      toast.error('Adicione ao menos um degrau com mensagem.')
      return
    }
    setSaving(true)
    const payload = {
      name,
      description: draft.description,
      active: draft.active,
      pauseOnReply: draft.pauseOnReply,
      funnelAutomation: draft.funnelAutomation,
      contactedStageId: draft.funnelAutomation && draft.contactedStageId
        ? draft.contactedStageId
        : null,
      steps,
    }
    const res = draft.id
      ? await updateCadence(draft.id, payload)
      : await createCadence(payload)
    setSaving(false)
    if ('error' in res && res.error) {
      toast.error(res.error)
      return
    }
    toast.success('Cadência salva.')
    setFormOpen(false)
    void load()
  }

  async function remove(id: string) {
    if (!window.confirm('Excluir esta cadência? As inscrições ativas param.')) return
    setBusyId(id)
    const { error } = await deleteCadence(id)
    setBusyId(null)
    if (error) {
      toast.error(error)
      return
    }
    void load()
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <button
          onClick={() => router.push('/automations')}
          className="rounded-lg p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Voltar"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-foreground">Cadências</h1>
          <p className="text-sm text-muted-foreground">
            Sequências de mensagens fixas, multicanal. Coloque o lead na cadência
            pelo funil ou pela conversa.
          </p>
        </div>
        <Button onClick={openNew}>
          <Plus className="mr-1.5 h-4 w-4" /> Nova cadência
        </Button>
      </div>

      {items === null ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : items.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
          <Send className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-2 text-sm font-medium text-foreground">
            Nenhuma cadência ainda
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Crie uma por serviço/produto (ex.: &quot;Consultoria&quot;, &quot;Plano
            mensal&quot;) com os toques que quiser.
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-card p-4"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-gradient-to-tr from-violet-500 to-fuchsia-500 text-white">
                <Send className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-semibold text-foreground">
                    {c.name}
                  </span>
                  {!c.active && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      inativa
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {c.step_count} {c.step_count === 1 ? 'degrau' : 'degraus'}
                  {c.active_enrollments > 0
                    ? ` · ${c.active_enrollments} em andamento`
                    : ''}
                  {c.description ? ` · ${c.description}` : ''}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void openEdit(c.id)}
                disabled={busyId === c.id}
              >
                {busyId === c.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Pencil className="h-4 w-4" />
                )}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void remove(c.id)}
                disabled={busyId === c.id}
                className="text-muted-foreground hover:text-red-400"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Dialog open={formOpen} onOpenChange={setFormOpen}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{draft.id ? 'Editar cadência' : 'Nova cadência'}</DialogTitle>
            <DialogDescription>
              Cada degrau dispara sozinho no canal escolhido — se o lead não tem
              aquele canal, o degrau é pulado.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid gap-2">
              <Label>Nome</Label>
              <Input
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                placeholder="Ex.: Consultoria — captação"
              />
            </div>
            <div className="grid gap-2">
              <Label>Descrição (opcional)</Label>
              <Input
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                placeholder="Pra que serve esta cadência"
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border bg-muted/40 px-3 py-2">
              <div>
                <p className="text-sm font-medium text-foreground">
                  Pausar se o lead responder
                </p>
                <p className="text-xs text-muted-foreground">
                  Para a sequência quando o cliente responde (evita disparo frio).
                </p>
              </div>
              <Switch
                checked={draft.pauseOnReply}
                onCheckedChange={(v) => setDraft((d) => ({ ...d, pauseOnReply: v }))}
              />
            </div>

            {/* Automação de funil — move o negócio sozinho (pedido do Rafael). */}
            <div className="rounded-lg border border-border bg-muted/40 px-3 py-2">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium text-foreground">
                    Mover o negócio automaticamente
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Ao entrar/responder, avança o card. Se a cadência terminar
                    sem resposta, marca <strong>perdido</strong> e fecha a
                    conversa.
                  </p>
                </div>
                <Switch
                  checked={draft.funnelAutomation}
                  onCheckedChange={(v) =>
                    setDraft((d) => ({ ...d, funnelAutomation: v }))
                  }
                />
              </div>
              {draft.funnelAutomation && (
                <div className="mt-3 grid gap-1.5 border-t border-border pt-3">
                  <Label className="text-xs">
                    Etapa de “contato feito” (ao entrar ou o lead responder)
                  </Label>
                  <select
                    value={draft.contactedStageId}
                    onChange={(e) =>
                      setDraft((d) => ({ ...d, contactedStageId: e.target.value }))
                    }
                    className="h-9 rounded-md border border-border bg-background px-2 text-sm"
                  >
                    <option value="">Não mover ao entrar/responder</option>
                    {stageOptions.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-muted-foreground">
                    O negócio só é movido se a etapa for do funil dele e estiver à
                    frente da atual (nunca volta pra trás).
                  </p>
                </div>
              )}
            </div>

            {/* Degraus */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Degraus</Label>
                <span className="text-xs text-muted-foreground">
                  Variáveis: {'{{primeiro_nome}}'} {'{{nome}}'} {'{{empresa}}'}{' '}
                  {'{{telefone}}'} {'{{email}}'}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                O tempo de cada degrau conta a partir da{' '}
                <strong>1ª mensagem</strong> (d0, d2, d4…), não do degrau
                anterior.
              </p>
              {draft.steps.map((step, i) => {
                const meta = CHANNEL_META[step.channel] ?? CHANNEL_META.whatsapp
                return (
                  <div
                    key={i}
                    className="rounded-lg border border-border bg-background p-3"
                  >
                    <div className="mb-2 flex items-center gap-2">
                      <GripVertical className="h-4 w-4 text-muted-foreground" />
                      <span className="text-xs font-medium text-muted-foreground">
                        Toque {i + 1}
                      </span>
                      <span className="ml-auto inline-flex items-center gap-1 text-xs">
                        <meta.Icon className={`h-3.5 w-3.5 ${meta.color}`} />
                        <span className="text-muted-foreground">
                          {whenLabel(step.delayValue, step.delayUnit)}
                        </span>
                      </span>
                      {draft.steps.length > 1 && (
                        <button
                          onClick={() => removeStep(i)}
                          className="text-muted-foreground hover:text-red-400"
                          aria-label="Remover toque"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xs text-muted-foreground">Enviar</span>
                      <Input
                        type="number"
                        min={0}
                        value={step.delayValue}
                        onChange={(e) =>
                          patchStep(i, { delayValue: parseInt(e.target.value, 10) || 0 })
                        }
                        className="h-8 w-16"
                      />
                      <select
                        value={step.delayUnit}
                        onChange={(e) =>
                          patchStep(i, {
                            delayUnit: e.target.value as CadenceStepInput['delayUnit'],
                          })
                        }
                        className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                      >
                        <option value="minutes">min depois</option>
                        <option value="hours">horas depois</option>
                        <option value="days">dias depois</option>
                      </select>
                      <span className="text-xs text-muted-foreground">por</span>
                      <select
                        value={step.channel}
                        onChange={(e) =>
                          patchStep(i, {
                            channel: e.target.value as CadenceStepInput['channel'],
                          })
                        }
                        className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
                      >
                        <option value="whatsapp">WhatsApp</option>
                        <option value="email">E-mail</option>
                        <option value="instagram">Instagram</option>
                      </select>
                    </div>
                    {step.channel === 'email' && (
                      <Input
                        value={step.subject ?? ''}
                        onChange={(e) => patchStep(i, { subject: e.target.value })}
                        placeholder="Assunto do e-mail"
                        className="mt-2 h-8 text-sm"
                      />
                    )}
                    <textarea
                      value={step.body}
                      onChange={(e) => patchStep(i, { body: e.target.value })}
                      placeholder="Mensagem deste toque…"
                      rows={2}
                      className="mt-2 w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-primary"
                    />
                  </div>
                )
              })}
              <Button variant="outline" size="sm" onClick={addStep} className="w-full">
                <Plus className="mr-1.5 h-4 w-4" /> Adicionar toque
              </Button>
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setFormOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={() => void save()} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
              Salvar cadência
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

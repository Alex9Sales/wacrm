'use client'

// ============================================================
// Agenda — cliente (visão de mês). Base interna; o sync Google e a
// integração com o agente de Follow-up entram por cima depois.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ChevronLeft, ChevronRight, Plus, X, Trash2, MapPin, RefreshCw, Link2, Unlink, User, AlertTriangle } from 'lucide-react'
import { ContactPicker } from '@/components/contacts/contact-picker'
import {
  avisoNaAgenda,
  rotuloDoBloqueio,
  type MeetingReminderBlock,
} from '@/lib/ai/meeting-reminder-block'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import {
  listCalendars,
  listEvents,
  createEvent,
  updateEvent,
  deleteEvent,
  getAgendaPrefs,
  getGoogleStatus,
  syncGoogleNow,
  disconnectGoogle,
  type CalendarRow,
  type ConfirmacaoNaTela,
  type EventRow,
  type GoogleStatus,
} from '@/app/(dashboard)/agenda/actions'
import {
  baseDaConfirmacao,
  diaEHoraNoFuso,
  fraseDaConsulta,
  horaDaFila,
  impedimentoDaConfirmacao,
  tipoDaConfirmacaoNaEdicao,
  FUSO_PADRAO,
  type DesfechoDaConfirmacao,
  type TipoConfirmacao,
} from '@/lib/agenda/confirmacao-agendamento'
import { getPickerContact } from '@/components/contacts/contact-picker-actions'
import { inkOn } from '@/lib/ui/ink-on'
import { cn } from '@/lib/utils'
import {
  WEEKDAYS,
  addDays,
  capColumns,
  changeStartInput,
  isSameDay,
  layoutDayEvents,
  monthGrid,
  pad,
  parseDateInput,
  parseLocalInput,
  scheduleError,
  startOfDay,
  toDateInput,
  toLocalInput,
  weekDays,
  weekRangeLabel,
} from './agenda-dates'

type View = 'month' | 'week' | 'day'

type Draft = {
  id: string | null
  title: string
  /**
   * '' = ainda não escolhida (02/10). Compromisso NOVO não nasce mais numa
   * agenda: abria na primeira do Google (a da dona da clínica), a recepção
   * salvava sem olhar e a confirmação saía "com a Dra." errada.
   */
  calendarId: string
  allDay: boolean
  start: string // datetime-local ou date
  end: string
  location: string
  description: string
  /**
   * Quem é o paciente/cliente do compromisso. Vazio = compromisso interno.
   * ⚠️ É ESTE campo que faz o lembrete sair: o follow-up procura o evento
   * pelo contact_id (`lib/ai/followup.ts`), não pelo título. Marcar sem
   * contato é marcar sem confirmação — foi o que manteve 157 de 158
   * consultas da Dra. Joyce sem aviso.
   */
  contactId: string
  /** Só leitura: por que o lembrete deste compromisso não saiu (null = saiu ou não travou). */
  reminderBlock: MeetingReminderBlock | null
  /**
   * Caixa "Enviar confirmação ao paciente pelo WhatsApp" (01/10, pedido da
   * Dra. Joyce). Só aparece quando a conta ligou a opção e o salvamento muda
   * algo que o paciente precisa saber. null = ninguém mexeu: vale o padrão,
   * marcada — inclusive quando só trocou o profissional (02/10, ver
   * `caixaMarcada`).
   */
  notifyPatient: boolean | null
  /** Conversa de onde a recepção clicou "Agendar": a confirmação sai por ela. */
  conversationId: string | null
  /**
   * Contra o que a confirmação deste salvar é comparada (baseDaConfirmacao):
   * o que o paciente já sabe; ou, sem isso, o compromisso como abriu. null =
   * consulta nova para o paciente (compromisso novo, ou marcação ainda na fila).
   */
  original: { startsAt: string; calendarId: string; contactId: string | null } | null
  /** Confirmação na fila (02/10): quando sai (ISO). null = nada pendente. */
  confirmacaoNaFila: string | null
  /** Último desfecho da fila, para dizer no compromisso o que não saiu (02/10). */
  ultimaConfirmacao: DesfechoDaConfirmacao | null
  /** Status do compromisso: cancelado não recebe confirmação (a caixa não promete). */
  status: 'confirmed' | 'cancelled'
  /**
   * Grupo / "não perturbe" do paciente escolhido, para a caixa não prometer o
   * que o servidor recusa (01/10, revisão). null = ainda não carregado.
   */
  contatoFlags: { optedOut: boolean; isGroup: boolean } | null
}

/** Preferências da conta para o modal (getAgendaPrefs). */
type AgendaPrefs = { confirmacaoAoAgendar: boolean; timezone: string }

/** Início/fim do rascunho em ISO — o que vai para a action. null = data inválida. */
function draftIso(d: Pick<Draft, 'allDay' | 'start' | 'end'>): { startsAt: string; endsAt: string } | null {
  const s = d.allDay ? new Date(d.start + 'T00:00') : new Date(d.start)
  const e = d.allDay ? new Date(d.end + 'T23:59') : new Date(d.end)
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return null
  return { startsAt: s.toISOString(), endsAt: e.toISOString() }
}

/**
 * Falta escolher a agenda (02/10)? Só com mais de uma: com uma só, o
 * compromisso nasce nela; sem nenhuma carregada, o servidor usa a padrão.
 */
function faltaEscolherAgenda(d: Pick<Draft, 'calendarId'>, calendars: CalendarRow[]): boolean {
  return !d.calendarId && calendars.length > 1
}

/**
 * Salvar este rascunho pede confirmação ao paciente? Mesma regra da fila
 * (tipoDaConfirmacaoNaEdicao contra baseDaConfirmacao): sem base → marcação;
 * com base, só se mudou dia/hora, o profissional (agenda de outra pessoa) ou
 * o paciente. Horário que já passou não oferece. Sem agenda escolhida também
 * não (02/10): a prévia diria "com" quem ainda não se sabe.
 */
function confirmacaoDoRascunho(d: Draft, calendars: CalendarRow[]): TipoConfirmacao | null {
  if (!d.contactId) return null
  if (faltaEscolherAgenda(d, calendars)) return null
  const iso = draftIso(d)
  if (!iso) return null
  if (new Date(d.allDay ? iso.endsAt : iso.startsAt).getTime() <= Date.now()) return null
  if (!d.original) return 'marcacao'
  const nomeDe = (id: string) => calendars.find((c) => c.id === id)?.name ?? null
  return tipoDaConfirmacaoNaEdicao({
    antes: { ...d.original, nomeAgenda: nomeDe(d.original.calendarId) },
    depois: {
      startsAt: iso.startsAt,
      calendarId: d.calendarId,
      contactId: d.contactId,
      nomeAgenda: nomeDe(d.calendarId),
    },
  })
}

/**
 * A caixa está marcada? Quem mexeu manda; senão, marcada.
 *
 * 02/10: a troca de profissional (mesmo dia e hora) nascia DESMARCADA. Na
 * clínica, a confirmação tinha saído "com a Dra." errada; a recepção trocou a
 * agenda, salvou sem reparar na caixa e o paciente ficou com a informação
 * errada. Avisar quem atende agora é o padrão, como nos outros tipos.
 */
function caixaMarcada(d: Draft): boolean {
  return d.notifyPatient ?? true
}

/**
 * A mensagem que a action devolveu, se for de gente ("Agenda não encontrada.");
 * erro técnico (SQL do Drizzle, stack) vira o texto padrão.
 */
function erroLegivel(msg: string, padrao: string): string {
  return /failed query|insert into|update "|select |error:|\bat\s/i.test(msg) || msg.length > 160
    ? padrao
    : msg
}

/** Diz o que aconteceu com a confirmação. Não enviada nunca passa calada. */
function avisarConfirmacao(c: ConfirmacaoNaTela | undefined, tz: string): void {
  if (!c) return
  if (c === 'enviada') {
    toast.success('Confirmação enviada ao paciente.')
    return
  }
  // 02/10: o salvar só põe na fila. A hora é a do fuso da conta.
  if ('agendada' in c) {
    toast.info(
      `Confirmação na fila: sai às ${horaDaFila(c.agendada, tz)}, já com a versão final — se mudar algo até lá, vai só a última.`,
      { duration: 8_000 },
    )
    return
  }
  if ('descartada' in c) {
    toast.info('A confirmação que estava na fila foi cancelada: nada vai ao paciente.')
    return
  }
  // Resultado incerto (o WhatsApp demorou): NÃO diz "não enviada" — pode ter
  // chegado, e a recepção mandaria de novo (01/10, revisão).
  if ('incerta' in c) {
    toast.warning(`Confirmação ao paciente: ${c.incerta}.`, {
      description: 'O compromisso foi salvo.',
      duration: 12_000,
    })
    return
  }
  toast.warning(`Confirmação não enviada: ${c.naoEnviada}.`, {
    description: 'O compromisso foi salvo. Se precisar, avise o paciente pela conversa.',
    duration: 12_000,
  })
}

export function AgendaClient() {
  const [anchor, setAnchor] = useState(() => new Date())
  const [calendars, setCalendars] = useState<CalendarRow[]>([])
  const [events, setEvents] = useState<EventRow[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [google, setGoogle] = useState<GoogleStatus | null>(null)
  // null enquanto carrega: sem saber se a conta ligou a confirmação, a caixa
  // não aparece (e nada é enviado).
  const [prefs, setPrefs] = useState<AgendaPrefs | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [view, setView] = useState<View>('month')
  /** Ver só UMA agenda (id) ou todas (null). Escolha da sessão, não é salva. */
  const [calendarFilter, setCalendarFilter] = useState<string | null>(null)
  /** Dia em foco nas visões Dia e Semana (a Semana mostra a semana dele). */
  const [dayDate, setDayDate] = useState<Date>(() => new Date())
  const viewRef = useRef(view)
  viewRef.current = view

  const grid = useMemo(() => monthGrid(anchor), [anchor])
  const week = useMemo(() => weekDays(dayDate), [dayDate])
  // A recepção deixa o CRM aberto de um dia para o outro: "hoje" é refeito
  // quando a aba volta a ficar visível (01/10), senão a Semana destacava ontem.
  const [today, setToday] = useState(() => new Date())
  useEffect(() => {
    const atualiza = () => {
      if (document.hidden) return
      const agora = new Date()
      setToday((t) => (isSameDay(t, agora) ? t : agora))
    }
    window.addEventListener('focus', atualiza)
    document.addEventListener('visibilitychange', atualiza)
    return () => {
      window.removeEventListener('focus', atualiza)
      document.removeEventListener('visibilitychange', atualiza)
    }
  }, [])

  // Só a chamada MAIS RECENTE grava na tela (01/10). Na Semana o mês carregado
  // troca a cada 4–5 cliques: duas cargas corriam juntas e a mais velha, se
  // chegasse por último, deixava a semana da tela vazia — parecendo livre.
  const loadSeq = useRef(0)
  const load = useCallback(async () => {
    const seq = ++loadSeq.current
    setLoading(true)
    try {
      const cals = await listCalendars()
      if (seq !== loadSeq.current) return
      setCalendars(cals)
      const from = startOfDay(grid[0]).toISOString()
      const to = new Date(
        grid[41].getFullYear(),
        grid[41].getMonth(),
        grid[41].getDate(),
        23,
        59,
        59,
      ).toISOString()
      const evs = await listEvents({ from, to })
      if (seq !== loadSeq.current) return
      setEvents(evs)
    } finally {
      if (seq === loadSeq.current) setLoading(false)
    }
  }, [grid])
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    void load()
  }, [load])

  // Auto-sync Google→CRM (sem precisar clicar Sincronizar): silencioso, com
  // throttle. Roda ao abrir, ao focar a aba e a cada 2 min.
  const lastAutoSync = useRef(0)
  const autoSync = useCallback(async () => {
    const now = Date.now()
    if (now - lastAutoSync.current < 45_000) return
    lastAutoSync.current = now
    try {
      const r = await syncGoogleNow()
      // O load de AGORA (loadRef), não o da closure de quando o sync começou:
      // o sync leva segundos e, nesse meio-tempo, a pessoa pode ter ido para
      // outro mês — o load velho recarregava a grade do mês antigo (01/10).
      if (!r.error) await loadRef.current()
    } catch {
      /* silencioso */
    }
  }, [])

  useEffect(() => {
    if (!google?.connected) return
    void autoSync()
    const onFocus = () => {
      if (!document.hidden) void autoSync()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    const id = window.setInterval(() => void autoSync(), 120_000)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      window.clearInterval(id)
    }
  }, [google?.connected, autoSync])

  // Voltar do navegador no Dia ou na Semana retorna pro Mês (em vez de sair da página).
  useEffect(() => {
    const onPop = () => {
      if (viewRef.current !== 'month') setView('month')
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  // Estado da conexão Google + feedback do retorno do OAuth (?google=...).
  useEffect(() => {
    void getGoogleStatus().then(setGoogle).catch(() => {})
    void getAgendaPrefs()
      .then(setPrefs)
      .catch((err) => console.error('[agenda] preferências da conta:', err))
    const params = new URLSearchParams(window.location.search)
    const g = params.get('google')
    if (g === 'connected') {
      toast.success(`Google conectado${params.get('email') ? `: ${params.get('email')}` : ''}`)
      window.history.replaceState(null, '', '/agenda')
    } else if (g === 'error') {
      toast.error(`Falha ao conectar o Google: ${params.get('reason') ?? ''}`)
      window.history.replaceState(null, '', '/agenda')
    }
  }, [])

  // Vindo da conversa ("Marcar compromisso"): /agenda?contato=<id> abre o modal
  // já com a pessoa escolhida. Espera as agendas carregarem: o seletor precisa
  // das opções, e a conta com UMA agenda só já abre com ela escolhida. Com
  // várias, a recepção escolhe o profissional (02/10 — ver agendaDoNovo).
  // &conversa=<id> (01/10): a confirmação ao paciente sai por essa conversa.
  const veioDaConversa = useRef(false)
  useEffect(() => {
    if (veioDaConversa.current || calendars.length === 0) return
    const params = new URLSearchParams(window.location.search)
    const contato = params.get('contato')
    if (!contato) return
    veioDaConversa.current = true
    window.history.replaceState(null, '', '/agenda')
    openNew(undefined, undefined, contato, null, params.get('conversa'))
    // openNew depende de `calendars` e do filtro (via agendaDoNovo); aqui só
    // importa a primeira carga das agendas.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [calendars])

  // Grupo / "não perturbe" do paciente do rascunho (01/10, revisão): a caixa
  // da confirmação não pode prometer "Sai ao salvar" para quem o servidor
  // recusa. O ContactPicker já traz as flags; aqui chegam as do paciente que
  // veio só pelo id (link da conversa, compromisso aberto para editar).
  const contatoSemFlags = draft?.contactId && !draft.contatoFlags ? draft.contactId : null
  useEffect(() => {
    if (!contatoSemFlags) return
    let vivo = true
    getPickerContact(contatoSemFlags)
      .then((c) => {
        if (!vivo || !c) return
        const flags = { optedOut: c.optedOut === true, isGroup: c.isGroup === true }
        setDraft((d) => (d && d.contactId === c.id && !d.contatoFlags ? { ...d, contatoFlags: flags } : d))
      })
      .catch(() => {})
    return () => {
      vivo = false
    }
  }, [contatoSemFlags])

  const onSyncGoogle = async () => {
    setSyncing(true)
    try {
      const r = await syncGoogleNow()
      if (r.error) toast.error(r.error)
      else {
        toast.success(`Sincronizado (${r.imported} novo(s) evento(s))`)
        // loadRef: o sync leva segundos e a pessoa pode ter trocado de mês.
        await loadRef.current()
      }
    } finally {
      setSyncing(false)
    }
  }

  const onDisconnectGoogle = async () => {
    // Um clique sem pergunta nenhuma parava a sincronização da clínica inteira —
    // e, até 30/09, ainda levava os compromissos junto. Quem clica aqui costuma
    // estar tentando CONSERTAR alguma coisa, não desligar a agenda.
    if (
      !window.confirm(
        'Desconectar o Google?\n\n' +
          'Os compromissos que já estão aqui continuam na agenda, mas o CRM para ' +
          'de receber o que for marcado no Google — e para de mandar o lembrete ' +
          'das consultas novas.\n\n' +
          'Para só atualizar agora, use "Sincronizar" em vez de desconectar.',
      )
    )
      return
    const r = await disconnectGoogle()
    if (r.error) toast.error(r.error)
    else {
      toast.success('Google desconectado')
      setGoogle((g) => (g ? { ...g, connected: false, email: null } : g))
      await loadRef.current()
    }
  }

  const eventsForDay = useCallback(
    (day: Date): EventRow[] => {
      const s = startOfDay(day).getTime()
      const e = s + 86_400_000 - 1
      return events.filter((ev) => {
        if (calendarFilter && ev.calendarId !== calendarFilter) return false
        const es = new Date(ev.startsAt).getTime()
        const ee = new Date(ev.endsAt).getTime()
        return es <= e && ee >= s
      })
    },
    [events, calendarFilter],
  )

  /**
   * Em que agenda o compromisso NOVO abre (02/10). Só o que a pessoa escolheu:
   * a agenda pedida (horário clicado com uma agenda no filtro), o filtro
   * ativo, ou a única agenda da conta. Senão, nenhuma ('') — o modal pede.
   *
   * Antes abria na primeira agenda do Google, que numa clínica é a da dona. A
   * recepção salvou sem reparar, a confirmação saiu "com a Dra." dona e a
   * consulta era com outra profissional.
   */
  const agendaDoNovo = (pedida: string | null): string => {
    const valida = (id: string | null) => (id && calendars.some((c) => c.id === id) ? id : null)
    return valida(pedida) ?? valida(calendarFilter) ?? (calendars.length === 1 ? calendars[0].id : '')
  }

  const openNew = (
    day?: Date,
    hour?: number,
    contactId = '',
    calendarId: string | null = null,
    conversationId: string | null = null,
  ) => {
    const base = day ?? new Date()
    const start = new Date(base)
    if (hour != null) start.setHours(hour, 0, 0, 0)
    else if (!day) start.setMinutes(0, 0, 0)
    else start.setHours(9, 0, 0, 0)
    const end = new Date(start)
    end.setHours(start.getHours() + 1)
    setDraft({
      id: null,
      title: '',
      calendarId: agendaDoNovo(calendarId),
      allDay: false,
      start: toLocalInput(start),
      end: toLocalInput(end),
      location: '',
      description: '',
      contactId,
      reminderBlock: null,
      notifyPatient: null,
      conversationId,
      original: null,
      confirmacaoNaFila: null,
      ultimaConfirmacao: null,
      status: 'confirmed',
      // Vindo da conversa, só o id: as flags chegam pelo efeito abaixo.
      contatoFlags: null,
    })
  }

  const openEdit = (ev: EventRow) => {
    const s = new Date(ev.startsAt)
    const e = new Date(ev.endsAt)
    const start = ev.allDay ? toDateInput(s) : toLocalInput(s)
    const end = ev.allDay ? toDateInput(e) : toLocalInput(e)
    setDraft({
      id: ev.id,
      title: ev.title,
      calendarId: ev.calendarId,
      allDay: ev.allDay,
      start,
      end,
      location: ev.location ?? '',
      description: ev.description ?? '',
      contactId: ev.contactId ?? '',
      reminderBlock: ev.reminderBlock,
      // Padrão: se a edição mudar dia/hora, a caixa já aparece ligada.
      notifyPatient: null,
      conversationId: null,
      status: ev.status,
      contatoFlags: null,
      // Contra o que comparar (02/10): a MESMA base que a fila usa — o que o
      // paciente já sabe; marcação ainda na fila = nada (consulta nova para
      // ele); senão o compromisso como abriu. O início "de antes" passa pelo
      // MESMO caminho do salvar (campo da tela → ISO): abrir e salvar sem
      // mexer dá o mesmo valor, mesmo com segundos vindos do Google ou dia
      // inteiro gravado no fuso da conta. Comparar com o valor cru do banco
      // ofereceria "remarcação" sem ninguém ter remarcado.
      original: baseDaConfirmacao({
        conhecido: ev.confirmationKnown,
        pendente: Boolean(ev.confirmationDueAt),
        atual: {
          startsAt: draftIso({ allDay: ev.allDay, start, end })?.startsAt ?? ev.startsAt,
          calendarId: ev.calendarId,
          contactId: ev.contactId,
        },
      }),
      confirmacaoNaFila: ev.confirmationDueAt,
      ultimaConfirmacao: ev.confirmationResult,
    })
  }

  const onToggleAllDay = (allDay: boolean) => {
    if (!draft) return
    if (allDay) {
      const s = new Date(draft.start)
      setDraft({ ...draft, allDay, start: toDateInput(s), end: toDateInput(s) })
    } else {
      const s = new Date(draft.start + 'T09:00')
      const e = new Date(draft.start + 'T10:00')
      setDraft({ ...draft, allDay, start: toLocalInput(s), end: toLocalInput(e) })
    }
  }

  const save = async () => {
    if (!draft || !draft.title.trim()) return
    // O botão já fica desligado e o erro aparece no formulário; isto é a trava.
    if (scheduleError(draft.start, draft.end, draft.allDay)) return
    if (faltaEscolherAgenda(draft, calendars)) return
    const iso = draftIso(draft)
    if (!iso) return
    setSaving(true)
    try {
      const { startsAt, endsAt } = iso
      // Só pede a confirmação quando a caixa está NA TELA e marcada; e só tira
      // da fila quando ela estava NA TELA e foi desmarcada (02/10). Sem a
      // caixa na tela (só mudou o título), a fila fica como está.
      const tipo = confirmacaoDoRascunho(draft, calendars)
      const caixaNaTela =
        prefs?.confirmacaoAoAgendar === true &&
        tipo !== null &&
        impedimentoDaConfirmacao({ status: draft.status, contato: draft.contatoFlags }) === null
      const confirmar = caixaNaTela && caixaMarcada(draft)
      const payload = {
        title: draft.title,
        calendarId: draft.calendarId || null,
        allDay: draft.allDay,
        startsAt,
        endsAt,
        location: draft.location,
        description: draft.description,
        contactId: draft.contactId || null,
        notifyPatient: confirmar,
        descartarConfirmacaoPendente: caixaNaTela && !confirmar,
        conversationId: draft.conversationId,
      }
      // Dia do evento (pra pular a visão pra lá e evitar confusão de mês/data).
      const eventDate = new Date(draft.start.slice(0, 10) + 'T12:00:00')
      const r = draft.id ? await updateEvent(draft.id, payload) : await createEvent(payload)
      if (r.error) {
        // As actions não lançam: devolvem { error }. Até 01/10 isso era
        // ignorado — o modal fechava com "Evento criado." e nada tinha sido
        // gravado. Agora o erro aparece e o modal fica aberto, com o que foi
        // digitado, para tentar de novo.
        toast.error(erroLegivel(r.error, 'Não foi possível salvar o evento. Tente de novo.'))
        return
      }
      setDraft(null)
      // Ditos ANTES de recarregar a grade (01/10): o compromisso já está salvo
      // e a confirmação já foi para a fila (ou não). Uma recarga que falhasse
      // caía no catch abaixo e dizia "Não foi possível salvar" — a recepção
      // salvaria de novo sem precisar.
      toast.success(draft.id ? 'Evento atualizado.' : 'Evento criado.')
      avisarConfirmacao(r.confirmacao, prefs?.timezone || FUSO_PADRAO)
      if (viewRef.current !== 'month') setDayDate(eventDate)
      const sameMonth =
        eventDate.getMonth() === anchor.getMonth() &&
        eventDate.getFullYear() === anchor.getFullYear()
      if (sameMonth) {
        // mês não muda → recarrega a visão atual
        await load().catch((err) => console.error('[agenda] recarregar depois de salvar:', err))
      } else {
        // muda o mês → o efeito de load dispara sozinho e mostra o evento
        setAnchor(new Date(eventDate.getFullYear(), eventDate.getMonth(), 1))
      }
    } catch (err) {
      // Era try/finally SEM catch: falhando, o modal ficava aberto e nada
      // explicava (em produção o erro de Server Action chega sanitizado).
      console.error('[agenda] salvar falhou:', err)
      toast.error('Não foi possível salvar o evento. Tente de novo.')
    } finally {
      setSaving(false)
    }
  }

  const remove = async () => {
    if (!draft?.id) return
    // Apagar evento não tem desfazer — confirma antes (o botão era direto).
    if (!window.confirm(`Excluir o evento "${draft.title || 'sem título'}"? Não dá pra desfazer.`)) return
    setSaving(true)
    try {
      const r = await deleteEvent(draft.id)
      if (r?.error) {
        toast.error(erroLegivel(r.error, 'Não foi possível excluir o evento.'))
        return
      }
      setDraft(null)
      await load()
      toast.success('Evento excluído.')
    } catch (err) {
      console.error('[agenda] excluir falhou:', err)
      toast.error('Não foi possível excluir o evento.')
    } finally {
      setSaving(false)
    }
  }

  const monthLabel = anchor.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' })

  // Abre a visão de Dia ou de Semana focada em `day`. O carregamento é o do
  // mês do dia focado: a grade de 42 dias desse mês sempre contém a semana
  // inteira dele (testado em agenda-dates.test.ts), então basta trocar o mês.
  const openTimeView = (next: 'day' | 'week', day: Date) => {
    setDayDate(day)
    if (day.getMonth() !== anchor.getMonth() || day.getFullYear() !== anchor.getFullYear()) {
      setAnchor(new Date(day.getFullYear(), day.getMonth(), 1))
    }
    // Empilha 1x ao SAIR do Mês (trocar Dia↔Semana ou de dia não empilha) →
    // o voltar do navegador sempre leva de volta pro Mês.
    if (viewRef.current === 'month') window.history.pushState({ agendaView: true }, '')
    setView(next)
  }
  const openDay = (day: Date) => openTimeView('day', day)
  const openWeek = (day: Date) => openTimeView('week', day)
  const backToMonth = () => {
    if (view !== 'month') window.history.back()
    else setView('month')
  }
  const shift = (delta: number) => {
    if (view === 'month') setAnchor(new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1))
    else openTimeView(view, addDays(dayDate, view === 'week' ? 7 * delta : delta))
  }
  const navToday = () => {
    const now = new Date()
    if (view === 'month') setAnchor(now)
    else openTimeView(view, now)
  }
  const headerLabel =
    view === 'month'
      ? monthLabel
      : view === 'week'
        ? weekRangeLabel(dayDate)
        : dayDate.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })
  const viewButton = (active: boolean) =>
    cn(
      'px-3 py-1 text-xs font-medium',
      active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted',
    )

  return (
    <div className="flex flex-col gap-4">
      {/* Barra de navegação */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" onClick={() => shift(-1)} aria-label="Anterior">
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="sm" onClick={navToday}>
            Hoje
          </Button>
          <Button variant="outline" size="sm" onClick={() => shift(1)} aria-label="Próximo">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <h2
          className={cn(
            'font-heading text-lg font-semibold text-foreground',
            view !== 'week' && 'capitalize',
          )}
        >
          {headerLabel}
        </h2>
        {/* Alternância Mês / Semana / Dia. 01/10: a clínica pediu a Semana para
            ver a semana toda de uma vez, com as agendas dos profissionais. */}
        <div className="flex overflow-hidden rounded-lg ring-1 ring-border">
          <button type="button" onClick={backToMonth} className={viewButton(view === 'month')}>
            Mês
          </button>
          <button
            type="button"
            onClick={() => openWeek(view === 'month' ? new Date() : dayDate)}
            className={viewButton(view === 'week')}
          >
            Semana
          </button>
          <button
            type="button"
            onClick={() => openDay(view === 'month' ? new Date() : dayDate)}
            className={viewButton(view === 'day')}
          >
            Dia
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {/* Google Calendar */}
          {google?.connected ? (
            <div className="flex items-center gap-1.5">
              <span
                className="hidden max-w-[160px] truncate rounded-full bg-muted px-2 py-1 text-xs text-muted-foreground md:inline"
                title={google.email ?? 'Google'}
              >
                {google.email ?? 'Google'}
              </span>
              <Button variant="outline" size="sm" onClick={onSyncGoogle} disabled={syncing}>
                <RefreshCw className={`mr-1.5 h-4 w-4 ${syncing ? 'animate-spin' : ''}`} />
                Sincronizar
              </Button>
              <Button variant="outline" size="sm" onClick={onDisconnectGoogle} title="Desconectar Google">
                <Unlink className="h-4 w-4" />
              </Button>
            </div>
          ) : google?.configured ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                window.location.href = '/api/google/calendar/connect'
              }}
            >
              <Link2 className="mr-1.5 h-4 w-4" /> Conectar Google
            </Button>
          ) : null}

          <Button size="sm" onClick={() => openNew()}>
            <Plus className="mr-1.5 h-4 w-4" /> Novo evento
          </Button>
        </div>
      </div>

      {/* Agendas — clicar filtra a grade para ver só aquela.
          30/09 (clínica da Dra. Joyce): assim que o Google reconectou, entraram
          as agendas dos 10 profissionais e o mês virou uma parede de eventos de
          todo mundo junto. A recepção precisa olhar UMA agenda por vez, que era
          o pedido do Rafael: "aparecer só os compromissos da Letícia". Era
          legenda — informação sem ação; agora é o filtro. */}
      {calendars.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {calendars.length > 1 && (
            <button
              type="button"
              onClick={() => setCalendarFilter(null)}
              className={cn(
                'rounded-full px-2 py-0.5 text-xs transition-colors',
                calendarFilter === null
                  ? 'bg-foreground/10 font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-muted',
              )}
            >
              Todas
            </button>
          )}
          {calendars.map((c) => {
            const ativa = calendarFilter === c.id
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setCalendarFilter(ativa ? null : c.id)}
                title={ativa ? `Mostrando só ${c.name} — clique para ver todas` : `Ver só ${c.name}`}
                className={cn(
                  'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs transition-colors',
                  ativa
                    ? 'bg-foreground/10 font-medium text-foreground'
                    : calendarFilter === null
                      ? 'text-muted-foreground hover:bg-muted'
                      : 'text-muted-foreground/50 hover:bg-muted hover:text-muted-foreground',
                )}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: c.color }} />
                {c.name}
              </button>
            )
          })}
        </div>
      )}

      {/* Grade do mês */}
      {view === 'month' && (
      <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
        <div className="grid grid-cols-7 border-b border-border bg-muted/40">
          {WEEKDAYS.map((w) => (
            <div key={w} className="px-2 py-2 text-center text-xs font-medium text-muted-foreground">
              {w}
            </div>
          ))}
        </div>
        <div className="grid grid-cols-7">
          {grid.map((day, i) => {
            const inMonth = day.getMonth() === anchor.getMonth()
            const isToday = isSameDay(day, today)
            const dayEvents = eventsForDay(day)
            return (
              <button
                key={i}
                type="button"
                onClick={() => openDay(day)}
                className={[
                  'group min-h-[104px] border-b border-r border-border p-1.5 text-left align-top transition-colors hover:bg-muted/40',
                  i % 7 === 0 ? 'border-l' : '',
                  inMonth ? 'bg-card' : 'bg-muted/20',
                ].join(' ')}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span
                    className={[
                      'inline-flex h-6 w-6 items-center justify-center rounded-full text-xs tabular-nums',
                      isToday
                        ? 'bg-primary font-semibold text-primary-foreground'
                        : inMonth
                          ? 'text-foreground'
                          : 'text-muted-foreground/50',
                    ].join(' ')}
                  >
                    {day.getDate()}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  {dayEvents.slice(0, 3).map((ev) => (
                    <span
                      key={ev.id}
                      onClick={(e) => {
                        e.stopPropagation()
                        openEdit(ev)
                      }}
                      className="flex items-center gap-1 truncate rounded px-1 py-0.5 text-[11px] font-medium"
                      style={{ background: ev.calendarColor, color: inkOn(ev.calendarColor) }}
                      title={
                        ev.reminderBlock
                          ? `${ev.title}${ev.contactName ? ` — ${ev.contactName}` : ''}: ${avisoNaAgenda(ev.reminderBlock)}`
                          : ev.contactName
                            ? `${ev.title} — ${ev.contactName}`
                            : ev.title
                      }
                    >
                      {/* A Agenda ABRE no mês: um compromisso cujo paciente não
                          foi avisado tem que dar sinal aqui, senão o aviso só
                          existe para quem já foi procurar na visão de dia. */}
                      {ev.reminderBlock && <AlertTriangle className="h-3 w-3 shrink-0" />}
                      {!ev.allDay && (
                        <span className="tabular-nums opacity-90">
                          {pad(new Date(ev.startsAt).getHours())}:{pad(new Date(ev.startsAt).getMinutes())}
                        </span>
                      )}
                      <span className="truncate">{ev.title}</span>
                    </span>
                  ))}
                  {dayEvents.length > 3 && (
                    <span className="px-1 text-[11px] text-muted-foreground">
                      +{dayEvents.length - 3} mais
                    </span>
                  )}
                </div>
              </button>
            )
          })}
        </div>
      </div>
      )}

      {/* Visões de dia e de semana (grade de horários) */}
      {view !== 'month' && (
        <TimeGrid
          days={view === 'week' ? week : [dayDate]}
          today={today}
          eventsForDay={eventsForDay}
          // Horário vazio clicado com UMA agenda no filtro → o compromisso nasce
          // nela (01/10). Antes caía na primeira agenda do Google: filtrando um
          // profissional, a consulta ia para a agenda de outro e sumia da grade.
          onNewAt={(day, hour) => openNew(day, hour, '', calendarFilter)}
          onEdit={openEdit}
          onOpenDay={openDay}
          showCalendar={calendarFilter === null && calendars.length > 1}
        />
      )}

      {loading && <p className="text-center text-sm text-muted-foreground">Carregando…</p>}

      {/* Modal criar/editar */}
      {draft && (
        <EventModal
          draft={draft}
          setDraft={setDraft}
          calendars={calendars}
          prefs={prefs}
          saving={saving}
          onToggleAllDay={onToggleAllDay}
          onSave={save}
          onDelete={remove}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  )
}

const HOUR_H = 48
/** A grade abre aqui (o começo do expediente da clínica), não à meia-noite. */
const ABRE_NA_HORA = 8
/** Semana: no máximo isso lado a lado por dia; o resto vira "+N" (abre o Dia). */
const MAX_LADO_A_LADO = 3

/**
 * O que aparece ao passar o mouse num compromisso da grade de horas.
 * Em "Todas", diz também de QUAL agenda é (01/10): com 12 profissionais e
 * cores parecidas, a cor sozinha não dizia de quem era o horário.
 */
function eventTooltip(ev: EventRow, showCalendar: boolean, continua: boolean): string {
  const base = ev.reminderBlock
    ? `${ev.title}${ev.contactName ? ` — ${ev.contactName}` : ''}: ${avisoNaAgenda(ev.reminderBlock)}`
    : ev.contactName
      ? `${ev.title} — ${ev.contactName} (recebe os lembretes)`
      : `${ev.title} — sem cliente/paciente: ninguém é avisado`
  const linhas = [base]
  if (continua) {
    const s = new Date(ev.startsAt)
    linhas.push(`Começou em ${pad(s.getDate())}/${pad(s.getMonth() + 1)} ${pad(s.getHours())}:${pad(s.getMinutes())}`)
  }
  if (showCalendar) linhas.push(`Agenda: ${ev.calendarName}`)
  return linhas.join('\n')
}

/**
 * Grade de horas das visões Dia (1 coluna) e Semana (7 colunas).
 * Uma rolagem só, nos dois sentidos: no celular a Semana rola de lado DENTRO
 * da grade (a página não), com a coluna das horas e o cabeçalho dos dias
 * grudados na borda.
 */
function TimeGrid({
  days,
  today,
  eventsForDay,
  onNewAt,
  onEdit,
  onOpenDay,
  showCalendar,
}: {
  days: Date[]
  today: Date
  eventsForDay: (day: Date) => EventRow[]
  onNewAt: (day: Date, hour: number) => void
  onEdit: (ev: EventRow) => void
  /** Semana: clicar no cabeçalho (ou no "+N") abre aquele dia. */
  onOpenDay: (day: Date) => void
  /** Filtro em "Todas" (e há mais de uma agenda): mostra de quem é cada compromisso. */
  showCalendar: boolean
}) {
  const isWeek = days.length > 1
  const scrollRef = useRef<HTMLDivElement>(null)
  // Abre no começo do expediente. Só ao abrir e ao trocar Dia↔Semana: ao
  // andar de semana em semana a posição fica onde a pessoa deixou (01/10 —
  // antes voltava para 07:00 a cada clique).
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = ABRE_NA_HORA * HOUR_H
  }, [isWeek])

  const columns = days.map((day) => {
    const evs = eventsForDay(day)
    const slots = layoutDayEvents(
      evs.filter((e) => !e.allDay),
      day,
    )
    return {
      day,
      allDay: evs.filter((e) => e.allDay),
      // No Dia a coluna é larga: todos cabem. Na Semana, até 3 lado a lado.
      ...(isWeek ? capColumns(slots, MAX_LADO_A_LADO) : { visible: slots, hidden: [] }),
    }
  })
  const hasAllDay = columns.some((c) => c.allDay.length > 0)

  return (
    <div className="overflow-hidden rounded-xl ring-1 ring-foreground/10">
      {/* Altura da tela (01/10): presa em 560px, a grade mostrava só até ~15h–17h
          e a clínica atende até 20h. O que sobra (~16rem) é o cabeçalho do
          CRM, o título da página, a barra e o filtro de agendas. */}
      <div ref={scrollRef} className="h-[max(560px,calc(100dvh-16rem))] overflow-auto bg-card">
        <div className={isWeek ? 'min-w-[728px]' : undefined}>
          {(isWeek || hasAllDay) && (
            <div className="sticky top-0 z-20 border-b border-border bg-card">
              {isWeek && (
                <div className="flex">
                  <div className="sticky left-0 z-10 w-14 shrink-0 bg-card" />
                  {days.map((day) => {
                    const isToday = isSameDay(day, today)
                    return (
                      <button
                        key={day.getTime()}
                        type="button"
                        onClick={() => onOpenDay(day)}
                        title={`Abrir ${day.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' })}`}
                        className="flex min-w-0 flex-1 flex-col items-center gap-0.5 border-l border-border/50 py-1.5 transition-colors hover:bg-muted/40"
                      >
                        <span
                          className={cn(
                            'text-[11px] font-medium',
                            isToday ? 'text-primary' : 'text-muted-foreground',
                          )}
                        >
                          {WEEKDAYS[day.getDay()]}
                        </span>
                        <span
                          className={cn(
                            'inline-flex h-7 w-7 items-center justify-center rounded-full text-sm tabular-nums',
                            isToday ? 'bg-primary font-semibold text-primary-foreground' : 'text-foreground',
                          )}
                        >
                          {day.getDate()}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
              {hasAllDay && (
                <div className={cn('flex', isWeek && 'border-t border-border/50')}>
                  <div className="sticky left-0 z-10 flex w-14 shrink-0 items-center bg-card px-1.5 text-[10px] leading-tight text-muted-foreground">
                    dia todo
                  </div>
                  {columns.map(({ day, allDay }) => (
                    <div
                      key={day.getTime()}
                      className={cn(
                        'flex min-w-0 flex-1 gap-1 border-l border-border/50 p-1',
                        isWeek ? 'flex-col' : 'flex-wrap',
                      )}
                    >
                      {(isWeek ? allDay.slice(0, 3) : allDay).map((ev) => (
                        <button
                          key={ev.id}
                          type="button"
                          onClick={() => onEdit(ev)}
                          className="max-w-full truncate rounded px-2 py-0.5 text-left text-xs font-medium"
                          style={{ background: ev.calendarColor, color: inkOn(ev.calendarColor) }}
                          title={showCalendar ? `${ev.title}\nAgenda: ${ev.calendarName}` : ev.title}
                        >
                          {ev.title}
                        </button>
                      ))}
                      {isWeek && allDay.length > 3 && (
                        <button
                          type="button"
                          onClick={() => onOpenDay(day)}
                          className="px-1 text-left text-[11px] text-muted-foreground hover:text-foreground"
                        >
                          +{allDay.length - 3} mais
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex" style={{ height: 24 * HOUR_H }}>
            {/* coluna das horas */}
            <div className="sticky left-0 z-10 w-14 shrink-0 bg-card">
              {Array.from({ length: 24 }, (_, h) => (
                <span
                  key={h}
                  className="absolute left-1.5 text-[11px] tabular-nums text-muted-foreground"
                  style={{ top: h * HOUR_H + 2 }}
                >
                  {pad(h)}:00
                </span>
              ))}
            </div>
            {columns.map(({ day, visible, hidden }) => (
              <div
                key={day.getTime()}
                className={cn(
                  'relative min-w-0 flex-1 border-l border-border/50',
                  isWeek && isSameDay(day, today) && 'bg-primary/5',
                )}
              >
                {/* faixas de hora (clique cria evento naquele dia e horário) */}
                {Array.from({ length: 24 }, (_, h) => (
                  <button
                    key={h}
                    type="button"
                    onClick={() => onNewAt(day, h)}
                    className="absolute inset-x-0 border-b border-border/50 transition-colors hover:bg-muted/40"
                    style={{ top: h * HOUR_H, height: HOUR_H }}
                    aria-label={`Criar ${isWeek ? `${WEEKDAYS[day.getDay()]} ${day.getDate()} ` : ''}às ${pad(h)}:00`}
                  />
                ))}
                {/* eventos posicionados por horário; quem se sobrepõe divide a largura */}
                {visible.map(({ event: ev, startMin, endMin, col, cols }) => {
                  const s = new Date(ev.startsAt)
                  const durMin = Math.max(30, endMin - startMin)
                  // Pedaço de um compromisso que começou no dia anterior (ex.:
                  // plantão 22:00–02:00): mostrar "22:00" no topo da coluna das
                  // 00:00 parecia que começava às 22h DESTE dia (01/10).
                  const continua = s < startOfDay(day)
                  return (
                    <div
                      key={ev.id}
                      onClick={() => onEdit(ev)}
                      className={cn(
                        'absolute cursor-pointer overflow-hidden rounded-md shadow-sm',
                        isWeek ? 'px-1.5 py-0.5 text-[11px] leading-tight' : 'px-2 py-1 text-xs',
                      )}
                      style={{
                        top: (startMin / 60) * HOUR_H + 1,
                        height: Math.max(20, (durMin / 60) * HOUR_H - 2),
                        left: `calc(${(col / cols) * 100}% + 2px)`,
                        width: `calc(${100 / cols}% - 4px)`,
                        background: ev.calendarColor,
                        color: inkOn(ev.calendarColor),
                      }}
                      title={eventTooltip(ev, showCalendar, continua)}
                    >
                      {/* Fora do bloco do nome de propósito: uma consulta de 30 min é
                          baixa demais para mostrar o nome, e era justamente nela que
                          o alerta sumia. O aviso não pode depender da duração. */}
                      {ev.reminderBlock && <AlertTriangle className="mr-1 inline h-3 w-3" />}
                      <span className="font-medium tabular-nums">
                        {continua ? '↳' : `${pad(s.getHours())}:${pad(s.getMinutes())}`}
                      </span>{' '}
                      {ev.title}
                      {/* Em "Todas", de quem é a agenda — antes do paciente: é o que
                          a recepção procura quando vê dois blocos no mesmo horário. */}
                      {showCalendar && durMin >= 45 && (
                        <div className="truncate opacity-80">{ev.calendarName}</div>
                      )}
                      {/* Com quem é o compromisso, quando há altura pra mostrar. Quem
                          olha a agenda quer ver a PESSOA, não só o título. */}
                      {ev.contactName && durMin >= 45 && (
                        <div className="truncate opacity-80">
                          <User className="mr-1 inline h-3 w-3" />
                          {ev.contactName}
                        </div>
                      )}
                    </div>
                  )
                })}
                {/* Semana: o que não coube lado a lado (mais de 3 no mesmo horário)
                    vira "+N" na última coluna, no horário deles; abre o Dia. */}
                {hidden.map((run) => {
                  const lista = run.events
                    .map((ev) => {
                      const s = new Date(ev.startsAt)
                      return `${pad(s.getHours())}:${pad(s.getMinutes())} ${ev.title}${showCalendar ? ` (${ev.calendarName})` : ''}`
                    })
                    .join('\n')
                  const hora = `${pad(Math.floor(run.startMin / 60))}:${pad(run.startMin % 60)}`
                  return (
                    <button
                      key={`mais-${run.startMin}`}
                      type="button"
                      onClick={() => onOpenDay(day)}
                      className="absolute flex items-start justify-center rounded-md border border-dashed border-foreground/30 bg-muted pt-0.5 text-[11px] font-semibold text-foreground shadow-sm transition-colors hover:bg-muted/70"
                      style={{
                        top: (run.startMin / 60) * HOUR_H + 1,
                        height: Math.max(20, ((run.endMin - run.startMin) / 60) * HOUR_H - 2),
                        left: `calc(${((MAX_LADO_A_LADO - 1) / MAX_LADO_A_LADO) * 100}% + 2px)`,
                        width: `calc(${100 / MAX_LADO_A_LADO}% - 4px)`,
                      }}
                      title={`Mais ${run.events.length} a partir das ${hora} — clique para abrir o dia:\n${lista}`}
                      aria-label={`Mais ${run.events.length} compromisso(s) a partir das ${hora}: abrir o dia ${day.getDate()}`}
                    >
                      +{run.events.length}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function EventModal({
  draft,
  setDraft,
  calendars,
  prefs,
  saving,
  onToggleAllDay,
  onSave,
  onDelete,
  onClose,
}: {
  draft: Draft
  setDraft: (d: Draft) => void
  calendars: CalendarRow[]
  prefs: AgendaPrefs | null
  saving: boolean
  onToggleAllDay: (v: boolean) => void
  onSave: () => void
  onDelete: () => void
  onClose: () => void
}) {
  // Mudou o início → o fim anda junto, com a mesma duração (changeStartInput).
  // O campo devolve "" (ou um ano pela metade: 0002, 0020, 0202) enquanto a
  // pessoa digita a data; guarda o último início válido para a duração não se
  // perder no meio da digitação.
  const lastValidStart = useRef(draft.start)
  const parseStart = draft.allDay ? parseDateInput : parseLocalInput
  const changeStart = (value: string) => {
    const next = changeStartInput(
      { start: draft.start, end: draft.end, lastValidStart: lastValidStart.current },
      value,
      draft.allDay,
    )
    lastValidStart.current = next.lastValidStart
    setDraft({ ...draft, start: next.start, end: next.end })
  }
  const timeError = scheduleError(draft.start, draft.end, draft.allDay)
  // Compromisso novo sem agenda escolhida, com mais de uma na conta (02/10):
  // o Salvar fica desligado e a linha abaixo do seletor diz por quê.
  const faltaAgenda = faltaEscolherAgenda(draft, calendars)
  const tz = prefs?.timezone || FUSO_PADRAO
  // A caixa da confirmação: só com a opção da conta ligada, a agenda escolhida
  // e um salvamento que muda algo para o paciente. A prévia mostra o miolo da
  // mensagem, no fuso da conta, com o profissional da agenda escolhida.
  const tipoConfirmacao =
    prefs?.confirmacaoAoAgendar && !timeError ? confirmacaoDoRascunho(draft, calendars) : null
  // Cancelado, grupo, "não perturbe": no lugar da caixa, o porquê (01/10,
  // revisão) — antes a caixa prometia "Sai ao salvar" e o aviso desmentia.
  const semConfirmacao = tipoConfirmacao
    ? impedimentoDaConfirmacao({ status: draft.status, contato: draft.contatoFlags })
    : null
  const marcada = caixaMarcada(draft)
  const isoRascunho = tipoConfirmacao ? draftIso(draft) : null
  const previaConfirmacao =
    tipoConfirmacao && !semConfirmacao && isoRascunho && prefs
      ? fraseDaConsulta({
          tipo: tipoConfirmacao,
          nomeAgenda: calendars.find((c) => c.id === draft.calendarId)?.name,
          startsAt: isoRascunho.startsAt,
          allDay: draft.allDay,
          tz: prefs.timezone,
        })
      : null
  const rotuloCaixa =
    tipoConfirmacao === 'profissional'
      ? 'Avisar o paciente da troca de profissional pelo WhatsApp'
      : 'Enviar confirmação ao paciente pelo WhatsApp'
  // O que a caixa promete (02/10): a confirmação não sai mais NO salvar — vai
  // para a fila e sai uns minutos depois do último salvar, só a versão final.
  const naFila = draft.confirmacaoNaFila
  const legendaCaixa = marcada
    ? naFila
      ? 'Já está na fila; salvando, sai 3 min depois, só a versão final'
      : 'Sai 3 min depois de salvar (se mudar algo até lá, vai só a versão final)'
    : naFila
      ? 'Desmarcada: a confirmação que estava na fila é cancelada ao salvar'
      : 'Não vai nada ao salvar'
  // A linha "na fila" só quando a caixa não está na tela (ela já diz isso).
  const linhaDaFila = naFila && !previaConfirmacao ? horaDaFila(naFila, tz) : null
  // O último desfecho, no compromisso (02/10): quem marcou já saiu do modal
  // quando o worker tenta, então "não enviada" fica aqui e na conversa.
  const ultima = draft.ultimaConfirmacao
  const ultimaNaoSaiu = ultima && (ultima.status === 'naoEnviada' || ultima.status === 'incerta') ? ultima : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      {/* max-h + rolagem (01/10): no celular o painel passava da altura da tela
          (ainda mais com o aviso de lembrete e a linha de erro do fim) e o
          Salvar ficava fora, sem como chegar nele. */}
      <div
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-xl bg-card p-5 shadow-xl ring-1 ring-foreground/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-heading text-base font-semibold">
            {draft.id ? 'Editar evento' : 'Novo evento'}
          </h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex flex-col gap-3">
          {/* O lembrete deste compromisso não conseguiu sair. Fica no ALTO do
              formulário, com o que fazer — antes isso não aparecia em lugar
              nenhum e o paciente simplesmente não era avisado. */}
          {draft.reminderBlock && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="min-w-0 text-xs">
                {/* 01/10: "o lembrete", não "a confirmação" — confirmação é a
                    mensagem da caixa no fim do formulário, que o salvar põe na
                    fila (02/10). */}
                <p className="font-medium text-foreground">
                  Este contato não recebeu o lembrete —{' '}
                  {rotuloDoBloqueio(draft.reminderBlock).curto}.
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {rotuloDoBloqueio(draft.reminderBlock).explicacao}
                </p>
                <p className="mt-1 text-foreground/80">
                  {rotuloDoBloqueio(draft.reminderBlock).comoResolver}
                </p>
              </div>
            </div>
          )}

          <div>
            <Label className="mb-1 block text-xs">Título</Label>
            <Input
              autoFocus
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              placeholder="Ex.: Reunião com cliente"
            />
          </div>

          <div>
            <Label className="mb-1 block text-xs">
              <User className="mr-1 inline h-3 w-3" />
              Cliente / paciente
            </Label>
            <ContactPicker
              value={draft.contactId}
              onChange={(contactId, contact) =>
                setDraft({
                  ...draft,
                  contactId,
                  // Título em branco ganha o nome de quem é — o atendente digita
                  // o mínimo e o compromisso já fica reconhecível na agenda.
                  title: draft.title || (contact?.name ? contact.name : draft.title),
                  // Grupo / "não perturbe" de quem foi escolhido (a caixa da
                  // confirmação depende disso). Sem o contato, o efeito busca.
                  contatoFlags:
                    contact && contact.id === contactId
                      ? { optedOut: contact.optedOut === true, isGroup: contact.isGroup === true }
                      : null,
                })
              }
              placeholder="Buscar por nome ou telefone..."
            />
            {/* Campo que, em branco, desliga o lembrete em silêncio: diz isso aqui,
                no lugar, e não num toast que some. 01/10: dizia "recebe a
                confirmação", mas salvar não mandava nada — só os lembretes do
                agente, perto da consulta. A confirmação ao marcar é a caixa
                abaixo (sai uns minutos depois do salvar — 02/10). */}
            <p className="mt-1 text-[11px] text-muted-foreground">
              {draft.contactId ? (
                <>
                  Quem estiver aqui <strong>recebe os lembretes</strong> da consulta pelo
                  WhatsApp, se os lembretes do agente estiverem ligados.
                </>
              ) : (
                <>
                  Sem preencher, o compromisso entra na agenda mas{' '}
                  <strong>ninguém é avisado</strong> — o lembrete procura a pessoa por
                  este campo.
                </>
              )}
            </p>
          </div>

          <div>
            <Label className="mb-1 block text-xs">Agenda</Label>
            <select
              value={draft.calendarId}
              onChange={(e) => setDraft({ ...draft, calendarId: e.target.value })}
              aria-invalid={faltaAgenda ? true : undefined}
              className={cn(
                'h-9 w-full rounded-md border border-border bg-background px-2 text-sm',
                faltaAgenda && 'border-amber-500/60',
              )}
            >
              {/* Compromisso novo nasce sem agenda (02/10): a escolha é da
                  recepção, não da ordem das agendas. */}
              {!draft.calendarId && (
                <option value="" disabled>
                  Escolha a agenda…
                </option>
              )}
              {calendars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.source === 'google' ? ' · Google (sincroniza)' : ' · local (não sincroniza)'}
                </option>
              ))}
            </select>
            {/* No lugar, e não num toast: sem isso o Salvar só fica cinza. */}
            {faltaAgenda ? (
              <p role="alert" className="mt-1 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400">
                <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                Escolha a agenda do profissional que vai atender — é ela que diz ao paciente com quem é a consulta.
              </p>
            ) : (
              <p className="mt-1 text-[11px] text-muted-foreground">
                Agendas do Google sincronizam nos dois sentidos. A agenda local fica só no CRM.
              </p>
            )}
          </div>

          <label className="flex items-center gap-2 text-sm">
            <Switch checked={draft.allDay} onCheckedChange={onToggleAllDay} />
            Dia inteiro
          </label>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label className="mb-1 block text-xs">Início</Label>
              <input
                type={draft.allDay ? 'date' : 'datetime-local'}
                value={draft.start}
                onFocus={() => {
                  if (parseStart(draft.start)) lastValidStart.current = draft.start
                }}
                onChange={(e) => changeStart(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
              />
            </div>
            <div>
              <Label className="mb-1 block text-xs">Fim</Label>
              <input
                type={draft.allDay ? 'date' : 'datetime-local'}
                value={draft.end}
                min={draft.start || undefined}
                aria-invalid={timeError ? true : undefined}
                onChange={(e) => setDraft({ ...draft, end: e.target.value })}
                className={cn(
                  'h-9 w-full rounded-md border border-border bg-background px-2 text-sm',
                  timeError && 'border-destructive',
                )}
              />
            </div>
          </div>
          {/* No lugar, e não num toast que some: sem isso o Salvar só fica
              cinza e ninguém sabe por quê. */}
          {timeError && (
            <p role="alert" className="-mt-1 flex items-start gap-1 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              {timeError}
            </p>
          )}

          <div>
            <Label className="mb-1 block text-xs">
              <MapPin className="mr-1 inline h-3 w-3" />
              Local
            </Label>
            <Input
              value={draft.location}
              onChange={(e) => setDraft({ ...draft, location: e.target.value })}
              placeholder="Opcional"
            />
          </div>

          <div>
            <Label className="mb-1 block text-xs">Descrição</Label>
            <Textarea
              value={draft.description}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              rows={3}
              placeholder="Opcional"
            />
          </div>

          {/* O último desfecho da confirmação (02/10), no estilo do aviso do
              lembrete: o que não saiu fica NO compromisso, não num toast. */}
          {ultimaNaoSaiu && (
            <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="min-w-0 text-xs">
                <p className="font-medium text-foreground">
                  {ultimaNaoSaiu.status === 'incerta'
                    ? `Confirmação ao paciente (${diaEHoraNoFuso(ultimaNaoSaiu.at, tz)}): ${ultimaNaoSaiu.motivo ?? 'não deu para confirmar se saiu'}.`
                    : `A confirmação ao paciente não foi enviada (${diaEHoraNoFuso(ultimaNaoSaiu.at, tz)}) — ${ultimaNaoSaiu.motivo ?? 'o envio falhou'}.`}
                </p>
                <p className="mt-0.5 text-muted-foreground">
                  {ultimaNaoSaiu.status === 'incerta'
                    ? 'Confira a conversa antes de mandar de novo.'
                    : 'Se precisar, avise o paciente pela conversa — há uma nota lá também.'}
                </p>
              </div>
            </div>
          )}
          {ultima?.status === 'enviada' && !naFila && (
            <p className="text-[11px] text-muted-foreground">
              Confirmação enviada ao paciente em {diaEHoraNoFuso(ultima.at, tz)}.
            </p>
          )}
          {linhaDaFila && (
            <p className="rounded-lg border border-border px-3 py-2.5 text-[11px] text-muted-foreground">
              ⏳ Confirmação na fila: sai às {linhaDaFila} com a versão final.
            </p>
          )}

          {/* ✅ 01/10, Dra. Joyce: "no momento que eu fiz o agendamento, ele
              recebe". Junto do Salvar porque é o salvar que a põe na fila
              (02/10: sai 3 min depois do último salvar, só a versão final).
              Marcada por padrão; a prévia diz exatamente o que vai. */}
          {previaConfirmacao && (
            <label className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
              <Checkbox
                checked={marcada}
                onCheckedChange={(v) => setDraft({ ...draft, notifyPatient: v === true })}
                aria-label={rotuloCaixa}
                className="mt-0.5"
              />
              <span className="min-w-0">
                <span className="block text-sm text-foreground">{rotuloCaixa}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {legendaCaixa}
                  {marcada && (
                    <>
                      , na conversa do paciente: “{previaConfirmacao}”
                    </>
                  )}
                </span>
              </span>
            </label>
          )}
          {/* Cancelado, grupo, "não perturbe": diz por que não vai, em vez de
              uma caixa que o servidor recusaria (01/10, revisão). */}
          {semConfirmacao && (
            <p className="rounded-lg border border-border px-3 py-2.5 text-[11px] text-muted-foreground">
              Nenhuma confirmação vai ao paciente ao salvar: {semConfirmacao}.
            </p>
          )}
        </div>

        <div className="mt-5 flex items-center justify-between">
          {draft.id ? (
            <Button variant="outline" onClick={onDelete} disabled={saving}>
              <Trash2 className="mr-1.5 h-4 w-4 text-red-500" /> Excluir
            </Button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onClose} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={onSave} disabled={saving || !draft.title.trim() || !!timeError || faltaAgenda}>
              {saving ? 'Salvando…' : 'Salvar'}
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}

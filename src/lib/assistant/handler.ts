// ============================================================
// 🤝 Assistente do dono — roteador (Fase 3a, 08/09/2026).
//
// Entra DEPOIS do comando de cobrança (que tem prioridade) e ANTES da IA de
// vendas, só quando quem escreveu é o telefone do dono (Avisos/Sócio IA).
// Leitura responde na hora; escrita vira proposta + SIM (15 min no Redis).
// Pedido que não é pro CRM → devolve false e a IA de vendas segue (o dono
// testa o agente pelo próprio celular).
// Worker-reachable. Nunca lança: erro vira resposta curta ao dono.
// ============================================================

import { engineSendText } from '@/lib/flows/meta-send'
import { looksLikeCancel, looksLikeConfirmation } from '@/lib/collections/owner-command-rules'
import { previewDigest } from '@/lib/reports/owner-digest'

import { agendaBetween, collectionsSnapshot, customerCard, latestOpenConversationOf, latestOpenDealOf, matchMembers, membersOf, stalledDeals, teamSnapshot } from './data'
import { ownerModelJson } from './model'
import { clearPending, getPending, setPending, type AssistantPending } from './pending'
import {
  fmtDate,
  fmtDateTime,
  formatAgenda,
  formatAssignProposal,
  formatCollections,
  formatCustomerCard,
  formatCustomerChoices,
  formatEventProposal,
  formatStalledDeals,
  formatTaskProposal,
  formatTeam,
  helpText,
  looksLikeAssistantRequest,
  normalizeIntent,
  parseTime,
  parseWhenDate,
  todayInTz,
  zonedIso,
  type AssistantIntent,
} from './rules'
import { assignConversationCore, createEventCore, createTaskCore, transferDealCore } from './writes'

export interface AssistantArgs {
  accountId: string
  conversationId: string
  /** Contato do DONO (quem escreveu). */
  contactId: string
  ownerUserId: string
  text: string
  tz: string
  staleDays: number
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)

function classifierPrompt(memberNames: string[], todayYmd: string): string {
  return [
    'Você classifica o pedido do DONO/ADMIN de uma empresa para o assistente do CRM (funil, clientes, agenda, cobranças, equipe, tarefas).',
    'Responda SOMENTE um JSON, sem texto em volta, com as chaves:',
    '{"kind": "...", "customer": nome do cliente/lead citado ou null, "assignee": nome da pessoa da EQUIPE citada ou null, "title": título curto da tarefa/compromisso ou null, "when": quando ("hoje","amanhã","sexta","10/09","+2") ou null, "time": hora "HH:MM" ou null, "duration": minutos ou null}',
    'kind é UM destes: stalled_deals (negócios parados/esfriando/sem resposta no funil), summary (resumo do dia/como estamos/panorama), find_customer (achar/dados/histórico de um cliente), agenda (o que tem na agenda/compromissos), collections (cobranças/devendo/pagou/quanto entrou), team (equipe/atendimentos/fila/quem está esperando), create_task (tarefa/lembrete), assign (atribuir/transferir/passar lead ou conversa pra alguém da equipe), create_event (marcar/agendar reunião/visita/consulta), help (o que você faz), other (não é pedido pro CRM, conversa comum).',
    `Equipe: ${memberNames.join(', ') || '(vazia)'}. Hoje é ${todayYmd}.`,
    'Não invente: campo ausente vira null. Em assign, "customer" é o lead e "assignee" é quem recebe.',
  ].join('\n')
}

export async function handleOwnerAssistant(args: AssistantArgs): Promise<boolean> {
  const say = (text: string) =>
    engineSendText({ accountId: args.accountId, userId: args.ownerUserId, conversationId: args.conversationId, contactId: args.contactId, text })
  const text = args.text.trim()
  if (!text) return false

  try {
    // ---- proposta pendente (SIM / NÃO / outra coisa)
    const pending = await getPending(args.conversationId)
    if (pending) {
      if (looksLikeConfirmation(text)) {
        await clearPending(args.conversationId)
        await say(await executePending(args, pending))
        return true
      }
      if (looksLikeCancel(text)) {
        await clearPending(args.conversationId)
        await say('Cancelado. Nada foi feito.')
        return true
      }
      // Pedido novo substitui; senão relembra a proposta.
      if (!looksLikeAssistantRequest(text)) {
        await say('Ficou pendente: ' + pending.summary)
        return true
      }
      await clearPending(args.conversationId)
    }

    if (!looksLikeAssistantRequest(text)) return false

    const members = await membersOf(args.accountId)
    const today = todayInTz(args.tz)
    const raw = await ownerModelJson(args.accountId, classifierPrompt(members.map((m) => m.name), ymd(today)), text)
    const intent = normalizeIntent(raw)
    if (!intent || intent.kind === 'other') return false

    const reply = await dispatch(args, intent, members, today)
    if (reply === null) return false
    await say(reply)
    return true
  } catch (err) {
    console.error('[assistente] falhou:', err instanceof Error ? err.message : err)
    try {
      await say('Deu um erro aqui ao atender seu pedido. Tenta de novo ou faz pela tela.')
    } catch {
      /* nada */
    }
    return true
  }
}

async function dispatch(args: AssistantArgs, intent: AssistantIntent, members: { id: string; name: string; role: string }[], today: Date): Promise<string | null> {
  const { accountId, tz } = args
  switch (intent.kind) {
    case 'help':
      return helpText()

    case 'summary':
      return previewDigest(accountId)

    case 'stalled_deals': {
      const r = await stalledDeals(accountId, args.staleDays)
      return formatStalledDeals(r.rows, r.total, args.staleDays)
    }

    case 'find_customer': {
      if (!intent.customer) return 'De qual cliente? Me diga o nome ou o telefone.'
      const r = await customerCard(accountId, intent.customer)
      if (r.choices.length) return formatCustomerChoices(r.choices)
      if (!r.card) return `Não achei "${intent.customer}" nos contatos.`
      return formatCustomerCard(r.card, tz)
    }

    case 'agenda': {
      const when = intent.when ? parseWhenDate(intent.when, today) : null
      const isWeek = /semana/i.test(intent.when ?? '') || /semana/i.test(args.text)
      const from = when ?? ymd(today)
      const fromDate = new Date(from + 'T00:00:00')
      const toDate = addDays(fromDate, isWeek ? 7 : 1)
      const events = await agendaBetween(accountId, zonedIso(from, '00:00', tz), zonedIso(ymd(toDate), '00:00', tz))
      const label = isWeek ? `de ${fmtDate(from)} a ${fmtDate(ymd(addDays(toDate, -1)))}` : from === ymd(today) ? 'de hoje' : from === ymd(addDays(today, 1)) ? 'de amanhã' : `de ${fmtDate(from)}`
      return formatAgenda(events, tz, label)
    }

    case 'collections':
      return formatCollections(await collectionsSnapshot(accountId, ymd(today)))

    case 'team':
      return formatTeam(await teamSnapshot(accountId, zonedIso(ymd(today), '00:00', tz)))

    case 'create_task': {
      const title = intent.title ?? args.text.replace(/^(me\s+)?(lembra|lembre|cria|criar|anota|anote)\s+(de\s+)?/i, '').trim()
      if (!title) return 'Qual é a tarefa? Ex.: "me lembra sexta de ligar pro Carlos".'
      const date = intent.when ? parseWhenDate(intent.when, today) : null
      const time = intent.time ?? parseTime(args.text)
      const dueAt = date ? zonedIso(date, time ?? '09:00', tz) : null
      let assigneeId: string | null = null
      let assigneeName: string | null = null
      if (intent.assignee) {
        const m = matchMembers(members, intent.assignee)
        if (m.length === 0) return `Não achei "${intent.assignee}" na equipe. Membros: ${members.map((x) => x.name).join(', ')}.`
        if (m.length > 1) return `Tem mais de um "${intent.assignee}": ${m.map((x) => x.name).join(', ')}. Diga o nome completo.`
        assigneeId = m[0].id
        assigneeName = m[0].name
      }
      let contactId: string | null = null
      let contactName: string | null = null
      if (intent.customer) {
        const r = await customerCard(accountId, intent.customer)
        if (r.choices.length) return formatCustomerChoices(r.choices)
        if (r.contactId) {
          contactId = r.contactId
          contactName = r.card?.name ?? null
        }
      }
      const summary = formatTaskProposal({ title, dueLabel: dueAt ? fmtDateTime(dueAt, tz) : null, assigneeName, contactName })
      await setPending(args.conversationId, { kind: 'task', title, dueAt, assigneeId, contactId, dealId: null, summary })
      return summary
    }

    case 'assign': {
      if (!intent.assignee) return 'Passar pra quem? Ex.: "passa o João Silva pro Vitor".'
      if (!intent.customer) return 'Passar qual lead? Ex.: "passa o João Silva pro Vitor".'
      const m = matchMembers(members, intent.assignee)
      if (m.length === 0) return `Não achei "${intent.assignee}" na equipe. Membros: ${members.map((x) => x.name).join(', ')}.`
      if (m.length > 1) return `Tem mais de um "${intent.assignee}": ${m.map((x) => x.name).join(', ')}. Diga o nome completo.`
      const r = await customerCard(accountId, intent.customer)
      if (r.choices.length) return formatCustomerChoices(r.choices)
      if (!r.contactId) return `Não achei "${intent.customer}" nos contatos.`
      const deal = await latestOpenDealOf(accountId, r.contactId)
      const conv = await latestOpenConversationOf(accountId, r.contactId)
      if (!deal && !conv) return `${r.card?.name ?? intent.customer} não tem negócio aberto nem conversa aberta pra passar.`
      const what = deal && conv ? 'o lead' : deal ? 'o negócio' : 'a conversa'
      const label = `${r.card?.name ?? intent.customer}${deal ? ` · ${deal.title}` : ''}${conv?.channel ? ` · ${conv.channel}` : ''}`
      const summary = formatAssignProposal({ what, label, toName: m[0].name })
      await setPending(args.conversationId, { kind: 'assign', toUserId: m[0].id, dealId: deal?.id ?? null, conversationId: conv?.id ?? null, contactId: r.contactId, summary })
      return summary
    }

    case 'create_event': {
      const title = intent.title ?? 'Compromisso'
      const date = intent.when ? parseWhenDate(intent.when, today) : null
      const time = intent.time ?? parseTime(args.text)
      if (!date) return 'Que dia? Ex.: "marca reunião com a Ana amanhã às 15h".'
      if (!time) return `Que horas ${date === ymd(today) ? 'hoje' : fmtDate(date)}? Ex.: "às 15h".`
      const startsAt = zonedIso(date, time, tz)
      const endsAt = new Date(new Date(startsAt).getTime() + (intent.duration ?? 60) * 60_000).toISOString()
      let contactId: string | null = null
      let contactName: string | null = null
      if (intent.customer) {
        const r = await customerCard(accountId, intent.customer)
        if (r.choices.length) return formatCustomerChoices(r.choices)
        if (r.contactId) {
          contactId = r.contactId
          contactName = r.card?.name ?? null
        }
      }
      const fullTitle = contactName && !title.toLowerCase().includes(contactName.toLowerCase()) ? `${title} — ${contactName}` : title
      const summary = formatEventProposal({ title: fullTitle, startLabel: fmtDateTime(startsAt, tz), endLabel: fmtDateTime(endsAt, tz).slice(-5), contactName })
      await setPending(args.conversationId, { kind: 'event', title: fullTitle, startsAt, endsAt, contactId, dealId: null, summary })
      return summary
    }

    default:
      return null
  }
}

async function executePending(args: AssistantArgs, p: AssistantPending): Promise<string> {
  try {
    if (p.kind === 'task') {
      await createTaskCore({ accountId: args.accountId, userId: args.ownerUserId, title: p.title, dueAt: p.dueAt, assigneeId: p.assigneeId, contactId: p.contactId, dealId: p.dealId })
      return `Pronto ✅ Tarefa "${p.title}" criada${p.dueAt ? ` para ${fmtDateTime(p.dueAt, args.tz)}` : ''}.`
    }
    if (p.kind === 'assign') {
      const done: string[] = []
      if (p.dealId) {
        await transferDealCore({ accountId: args.accountId, actorUserId: args.ownerUserId, dealId: p.dealId, toUserId: p.toUserId })
        done.push('negócio')
      }
      if (p.conversationId) {
        await assignConversationCore({ accountId: args.accountId, actorUserId: args.ownerUserId, conversationId: p.conversationId, toUserId: p.toUserId })
        done.push('conversa')
      }
      return `Pronto ✅ ${done.join(' e ')} transferid${done.length > 1 ? 'os' : done[0] === 'conversa' ? 'a' : 'o'}. A pessoa foi avisada.`
    }
    if (p.kind === 'event') {
      await createEventCore({ accountId: args.accountId, userId: args.ownerUserId, title: p.title, startsAt: p.startsAt, endsAt: p.endsAt, contactId: p.contactId, dealId: p.dealId })
      return `Pronto ✅ "${p.title}" marcado ${fmtDateTime(p.startsAt, args.tz)}.`
    }
    return 'Não entendi o que confirmar.'
  } catch (err) {
    console.error('[assistente] executar falhou:', err instanceof Error ? err.message : err)
    return 'Não consegui executar. Nada foi alterado — tenta pela tela.'
  }
}

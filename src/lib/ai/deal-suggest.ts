// ============================================================
// Núcleo das "Sugestões da IA" para Negociações (IA v2 — Fases 1/2/3).
//
// SEM 'use server': é usado tanto pela server action `generateDealSuggestions`
// (com auth) quanto pelo worker proativo (Fase 3, SEM contexto de auth). Toda
// query aqui é explicitamente account-scoped por parâmetro.
//
// A IA lê a conversa + campos do negócio e propõe, como SUGESTÕES pendentes:
//   - campos (temperatura/qualificação/valor/observações/personalizados) com
//     evidência — conservador;
//   - UM próximo passo: uma TAREFA interna ou uma MENSAGEM pronta p/ agendar.
// Nada é gravado/enviado sozinho — o humano confirma no card do negócio.
// ============================================================

import { and, desc, eq, sql } from 'drizzle-orm'

import {
  db,
  deals,
  contacts,
  customFields,
  dealSuggestions,
  dealEvents,
  notifications,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import type { CustomField } from '@/types'
import { loadAiConfig } from './config'
import { generateReply } from './generate'
import { buildConversationContext } from './context'
import type { ChatMessage } from './types'
import { getAccountSettings } from '@/lib/settings/account-settings'

// ---- Campos do NEGÓCIO que a IA pode sugerir, com validação do valor. ----
export const DEAL_FIELD_TARGETS: {
  target: string
  label: string
  hint: string
  normalize: (v: string) => string | null
}[] = [
  {
    target: 'deal:temperature',
    label: 'Temperatura',
    hint: 'um de: frio | morno | quente',
    normalize: (v) => {
      const s = v.toLowerCase().trim()
      return ['frio', 'morno', 'quente'].includes(s) ? s : null
    },
  },
  {
    target: 'deal:qualification',
    label: 'Qualificação (1-5)',
    hint: 'número inteiro de 1 a 5',
    normalize: (v) => {
      const n = parseInt(String(v), 10)
      return n >= 1 && n <= 5 ? String(n) : null
    },
  },
  {
    target: 'deal:value',
    label: 'Valor',
    hint: 'número em R$ (ex.: 1500)',
    normalize: (v) => {
      const n = parseFloat(
        String(v).replace(/[^\d.,]/g, '').replace(/\.(?=\d{3})/g, '').replace(',', '.'),
      )
      return isFinite(n) && n > 0 ? String(n) : null
    },
  },
  {
    target: 'deal:notes',
    label: 'Observações',
    hint: 'texto curto',
    normalize: (v) => (v.trim() ? v.trim() : null),
  },
]

export function customOptions(cf: CustomField): string[] {
  return cf.field_type === 'select'
    ? ((cf.field_options?.options as string[] | undefined) ?? [])
    : []
}

/** Offset (ms) do fuso `tz` em `date`: (relógio-de-parede lido como UTC) − UTC. */
function tzOffsetMs(date: Date, tz: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date)
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value ?? 0)
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour') % 24,
    get('minute'),
    get('second'),
  )
  return asUtc - date.getTime()
}

/** Instante UTC (ISO) para "daqui a `days` dias, às `hour`:00 no fuso `tz`". */
function zonedSendAt(days: number, hour: number, tz: string): string {
  const base = new Date(Date.now() + days * 86400000)
  const dp = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(base)
  const g = (t: string) => Number(dp.find((x) => x.type === t)?.value ?? 0)
  const guess = Date.UTC(g('year'), g('month') - 1, g('day'), hour, 0, 0)
  const off = tzOffsetMs(new Date(guess), tz)
  return new Date(guess - off).toISOString()
}

/** Forma mínima do negócio de que o prompt precisa (sem acoplar ao tipo Deal). */
export interface DealForSuggest {
  id: string
  title: string | null
  status: string | null
  notes: string | null
  temperature: string | null
  value: number | null
  conversationId: string | null
  contactId: string | null
  assignedTo: string | null
  contactName: string | null
}

function buildSuggestionsPrompt(
  deal: DealForSuggest,
  convo: ChatMessage[],
  fields: CustomField[],
  tz: string,
): string {
  const transcript = convo
    .slice(-50)
    .map((m) => `${m.role === 'user' ? 'Cliente' : 'Atendente'}: ${m.content}`)
    .join('\n')
  const dealTargets = DEAL_FIELD_TARGETS.map(
    (t) => `- "${t.target}" (${t.label}) → ${t.hint}`,
  ).join('\n')
  const customTargets = fields
    .map((cf) => {
      const opts = customOptions(cf)
      return `- "custom:${cf.id}" (${cf.field_name}) → ${
        opts.length ? `um de: ${opts.join(' | ')}` : 'texto curto'
      }`
    })
    .join('\n')
  // Contexto atual do negócio: ancora o próximo passo e evita re-sugerir um
  // campo que já tem o mesmo valor (a nota "de novo", por ex.).
  const isOpen = (deal.status ?? 'open') === 'open'
  const atuais = [
    `- Título: ${deal.title || '(sem título)'}`,
    `- Situação: ${
      isOpen ? 'ABERTO (em negociação)' : `FECHADO (${deal.status})`
    }`,
    deal.temperature ? `- Temperatura atual: ${deal.temperature}` : null,
    deal.value ? `- Valor atual: R$ ${deal.value}` : null,
    deal.notes ? `- Observações atuais: ${deal.notes}` : null,
  ]
    .filter(Boolean)
    .join('\n')
  const contactName = deal.contactName || 'o cliente'
  const agora = (() => {
    try {
      return new Intl.DateTimeFormat('pt-BR', {
        timeZone: tz,
        weekday: 'long',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(new Date())
    } catch {
      return 'agora'
    }
  })()
  return `Você é um assistente de vendas. A partir de uma conversa de WhatsApp, você faz DUAS coisas independentes para o CRM.

## 1) FATOS (campos) — seja CONSERVADOR
Só proponha um valor de campo quando a CONVERSA der evidência CLARA. Nada de adivinhar. Sem evidência → NÃO inclua o campo. Um fato errado é pior que um campo vazio.
Também NÃO re-sugira um campo cujo valor atual já é igual/equivalente ao que você proporia (veja "Situação atual" abaixo).
Campos disponíveis (use exatamente o "target"):
${dealTargets}
${customTargets || '(sem campos personalizados)'}

## 2) PRÓXIMO PASSO (NO MÁXIMO 1) — seja PROATIVO
Isto é uma RECOMENDAÇÃO DE AÇÃO do vendedor, não um fato sobre o cliente — NÃO exige "evidência dura".
Se o negócio está ABERTO e existe um próximo passo plausível, proponha exatamente 1 — escolhendo o tipo certo:
- Se o próximo passo é ENVIAR uma mensagem ao cliente (cobrar retorno, confirmar escopo/valor, reengajar): use "message", com a mensagem JÁ PRONTA (tom WhatsApp, natural, curta, chamando ${contactName} pelo nome, sem colchetes/placeholders) e o melhor dia/hora para disparar.
- Se o próximo passo é uma AÇÃO INTERNA do vendedor (ligar, preparar proposta/documento, checar algo): use "task".
Para o horário: agora é ${agora} (fuso ${tz}). Prefira horário comercial (9h–18h), evite fim de semana e não sugira um horário que já passou. "send_days" = 0 hoje, 1 amanhã, etc.
NÃO proponha próximo passo se o negócio estiver FECHADO, ou se a bola já está claramente com o cliente e não há nada a fazer agora.

Responda SOMENTE com um array JSON, sem texto fora dele. Cada item é UM destes:
- Campo: {"kind":"field","target":"<target>","value":"<valor>","evidence":"<trecho curto da conversa que prova>"}
- Mensagem (próximo passo): {"kind":"message","text":"<mensagem pronta pro cliente>","send_days":<inteiro>,"send_hour":<inteiro 0-23, hora local>,"reason":"<por que agora, baseado na conversa>"}
- Tarefa (próximo passo): {"kind":"task","title":"<o que fazer, curto e acionável>","due_days":<inteiro>,"reason":"<por que agora>"}
Só 1 próximo passo no total (message OU task). Se realmente não houver nada a propor, responda [].

## Situação atual do negócio
${atuais}

## Conversa
${transcript || '(sem conversa)'}`
}

export interface ParsedSuggestion {
  kind: 'field' | 'task' | 'message'
  target: string
  label: string
  value: string
  evidence: string
  dueAt: string | null
}

export function parseSuggestions(
  raw: string,
  fields: CustomField[],
  tz: string,
): ParsedSuggestion[] {
  // Extrai o array JSON (tolera ```json ... ``` ou texto ao redor).
  const start = raw.indexOf('[')
  const end = raw.lastIndexOf(']')
  if (start === -1 || end === -1 || end < start) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const cfById = new Map(fields.map((c) => [c.id, c]))
  const out: ParsedSuggestion[] = []
  let nextStepCount = 0 // no máximo 1 próximo passo (message OU task)
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const kind = String(o.kind ?? 'field')

    // ---- Próximo passo: MENSAGEM pronta p/ agendar ----
    if (kind === 'message') {
      if (nextStepCount >= 1) continue
      const text = String(o.text ?? '').trim()
      const reason = String(o.reason ?? '').trim()
      if (!text) continue
      const days = Math.max(0, Math.min(365, parseInt(String(o.send_days ?? 1), 10) || 0))
      let hour = parseInt(String(o.send_hour ?? 10), 10)
      if (!Number.isFinite(hour) || hour < 0 || hour > 23) hour = 10
      let due = zonedSendAt(days, hour, tz)
      // Nunca sugerir um horário no passado (ou colado no agora).
      if (new Date(due).getTime() <= Date.now() + 15 * 60000) {
        due = zonedSendAt(days + 1, hour, tz)
      }
      out.push({
        kind: 'message',
        target: 'message',
        label: 'Mensagem de follow-up',
        value: text,
        evidence: reason,
        dueAt: due,
      })
      nextStepCount++
      continue
    }

    // ---- Próximo passo: TAREFA interna ----
    if (kind === 'task') {
      if (nextStepCount >= 1) continue
      const title = String(o.title ?? '').trim()
      const reason = String(o.reason ?? '').trim()
      if (!title) continue
      const days = Math.max(0, Math.min(365, parseInt(String(o.due_days ?? 1), 10) || 1))
      const due = new Date(Date.now() + days * 86400000).toISOString()
      out.push({
        kind: 'task',
        target: 'task',
        label: 'Follow-up',
        value: title,
        evidence: reason,
        dueAt: due,
      })
      nextStepCount++
      continue
    }

    // ---- Campo ----
    const target = String(o.target ?? '')
    const rawValue = String(o.value ?? '')
    const evidence = String(o.evidence ?? '')
    if (!target || !rawValue) continue
    const dealField = DEAL_FIELD_TARGETS.find((t) => t.target === target)
    if (dealField) {
      const v = dealField.normalize(rawValue)
      if (v)
        out.push({
          kind: 'field',
          target,
          label: dealField.label,
          value: v,
          evidence,
          dueAt: null,
        })
      continue
    }
    if (target.startsWith('custom:')) {
      const cf = cfById.get(target.slice('custom:'.length))
      if (!cf) continue
      const opts = customOptions(cf)
      if (opts.length && !opts.includes(rawValue)) continue // select fora das opções
      out.push({
        kind: 'field',
        target,
        label: cf.field_name,
        value: rawValue.trim(),
        evidence,
        dueAt: null,
      })
    }
  }
  return out
}

/** Negócio para o prompt, SEM auth (account-scoped por parâmetro). */
async function loadDealForSuggest(
  accountId: string,
  dealId: string,
): Promise<DealForSuggest | null> {
  const row = firstOrNull(
    await db
      .select({
        id: deals.id,
        title: deals.title,
        status: deals.status,
        notes: deals.notes,
        temperature: deals.temperature,
        value: deals.value,
        conversationId: deals.conversationId,
        contactId: deals.contactId,
        assignedTo: deals.assignedTo,
        contactName: contacts.name,
      })
      .from(deals)
      .leftJoin(contacts, eq(deals.contactId, contacts.id))
      .where(and(eq(deals.id, dealId), eq(deals.accountId, accountId)))
      .limit(1),
  )
  if (!row) return null
  return { ...row, value: row.value != null ? Number(row.value) : null }
}

/** Campos personalizados da conta, SEM auth. */
export async function loadCustomFieldsForAccount(
  accountId: string,
): Promise<CustomField[]> {
  const rows = await db
    .select({
      id: customFields.id,
      user_id: customFields.userId,
      account_id: customFields.accountId,
      field_name: customFields.fieldName,
      field_type: customFields.fieldType,
      field_options: customFields.fieldOptions,
      created_at: customFields.createdAt,
    })
    .from(customFields)
    .where(eq(customFields.accountId, accountId))
    .orderBy(customFields.fieldName)
  return rows as unknown as CustomField[]
}

/**
 * Gera sugestões e SUBSTITUI as pendentes deste negócio. Núcleo compartilhado
 * pela server action (com auth por fora) e pelo worker proativo. Retorna quantas
 * criou. `createdBy` = usuário que disparou, ou null quando foi a IA (proativo).
 */
export async function runDealSuggestions(args: {
  accountId: string
  dealId: string
  createdBy: string | null
}): Promise<{ count: number; error?: string }> {
  const { accountId, dealId, createdBy } = args
  const cfg = await loadAiConfig(accountId, { requireActive: false }).catch(
    () => null,
  )
  if (!cfg) {
    return {
      count: 0,
      error: 'IA não configurada nesta conta (Configurações → Agente IA).',
    }
  }
  const deal = await loadDealForSuggest(accountId, dealId)
  if (!deal) return { count: 0, error: 'Negócio não encontrado.' }
  if (!deal.conversationId) {
    return { count: 0, error: 'Sem conversa vinculada para analisar.' }
  }
  const [convo, fields, settings] = await Promise.all([
    buildConversationContext(deal.conversationId).catch(
      () => [] as ChatMessage[],
    ),
    loadCustomFieldsForAccount(accountId).catch(() => [] as CustomField[]),
    getAccountSettings(accountId).catch(() => null),
  ])
  if (convo.length === 0) {
    return { count: 0, error: 'A conversa ainda não tem mensagens.' }
  }
  const tz = settings?.businessTimezone || 'America/Sao_Paulo'
  const result = await generateReply({
    config: cfg,
    systemPrompt: buildSuggestionsPrompt(deal, convo, fields, tz),
    messages: [{ role: 'user', content: 'Analise a conversa e proponha.' }],
  })
  const items = parseSuggestions(result.text ?? '', fields, tz)
  // Regenera: limpa as pendentes antigas deste negócio antes de inserir.
  await db
    .delete(dealSuggestions)
    .where(
      and(
        eq(dealSuggestions.dealId, dealId),
        eq(dealSuggestions.accountId, accountId),
        eq(dealSuggestions.status, 'pending'),
      ),
    )
  if (items.length > 0) {
    await db.insert(dealSuggestions).values(
      items.map((it) => ({
        accountId,
        dealId,
        kind: it.kind,
        target: it.target,
        label: it.label,
        value: it.value,
        evidence: it.evidence || null,
        dueAt: it.dueAt,
        createdBy,
      })),
    )
  }
  return { count: items.length }
}

async function recordDealEventPlain(
  accountId: string,
  dealId: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  try {
    await db
      .insert(dealEvents)
      .values({ accountId, actorUserId: null, dealId, type, data })
  } catch (err) {
    console.error('[deal-suggest] event insert failed:', err)
  }
}

/** Cooldown por negócio (min) para o modo proativo. Env: DEAL_SUGGEST_COOLDOWN_MINUTES. */
const PROACTIVE_COOLDOWN_MS = Math.max(
  0,
  (Number(process.env.DEAL_SUGGEST_COOLDOWN_MINUTES) || 180) * 60000,
)

/**
 * Fase 3 — proativo. Disparado pelo worker (debounced por conversa) quando
 * chega mensagem do cliente. Acha o negócio ABERTO vinculado, respeita os gates
 * de custo (não empilha se já há pendentes; cooldown por negócio) e, se a IA
 * propuser algo, cria as sugestões + registra na timeline + notifica o dono.
 * Best-effort: qualquer erro é logado, nunca propaga.
 */
export async function runProactiveDealSuggestions(args: {
  accountId: string
  conversationId: string
}): Promise<void> {
  const { accountId, conversationId } = args
  try {
    // Negócio ABERTO vinculado a esta conversa (o mais recente).
    const deal = firstOrNull(
      await db
        .select({
          id: deals.id,
          title: deals.title,
          assignedTo: deals.assignedTo,
          contactId: deals.contactId,
        })
        .from(deals)
        .where(
          and(
            eq(deals.conversationId, conversationId),
            eq(deals.accountId, accountId),
            eq(deals.status, 'open'),
          ),
        )
        .orderBy(desc(deals.updatedAt))
        .limit(1),
    )
    if (!deal) return

    // Já tem sugestões pendentes? não empilha — o humano ainda nem olhou.
    const pend = firstOrNull(
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(dealSuggestions)
        .where(
          and(
            eq(dealSuggestions.dealId, deal.id),
            eq(dealSuggestions.status, 'pending'),
          ),
        ),
    )
    if ((pend?.n ?? 0) > 0) return

    // Cooldown por negócio: analisou faz pouco? pula (bound de custo).
    if (PROACTIVE_COOLDOWN_MS > 0) {
      const last = firstOrNull(
        await db
          .select({ createdAt: dealSuggestions.createdAt })
          .from(dealSuggestions)
          .where(eq(dealSuggestions.dealId, deal.id))
          .orderBy(desc(dealSuggestions.createdAt))
          .limit(1),
      )
      if (
        last &&
        Date.now() - new Date(last.createdAt).getTime() < PROACTIVE_COOLDOWN_MS
      ) {
        return
      }
    }

    const { count } = await runDealSuggestions({
      accountId,
      dealId: deal.id,
      createdBy: null,
    })
    if (count <= 0) return

    await recordDealEventPlain(accountId, deal.id, 'note', {
      text: `IA revisou a conversa e deixou ${count} sugest${
        count === 1 ? 'ão' : 'ões'
      } para você revisar.`,
    })
    if (deal.assignedTo) {
      try {
        await db.insert(notifications).values({
          accountId,
          userId: deal.assignedTo,
          type: 'deal_ai_suggestion',
          dealId: deal.id,
          contactId: deal.contactId,
          actorUserId: null,
          title: 'A IA tem sugestões',
          body: `${count} sugest${count === 1 ? 'ão' : 'ões'} da IA no negócio "${
            deal.title ?? ''
          }".`,
        })
      } catch (err) {
        console.error('[deal-suggest] notify failed:', err)
      }
    }
  } catch (err) {
    console.error('[deal-suggest] proactive failed:', err)
  }
}

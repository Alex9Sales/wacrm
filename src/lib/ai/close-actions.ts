// ============================================================
// Encerramento inteligente — ações que a IA pode disparar ao terminar um
// atendimento (via marcadores no texto gerado). Server/worker-safe: recebe
// accountId/userId explícitos (não usa sessão). Best-effort: nunca lança.
//
//   [[RESOLVER]]        → fecha a conversa (status 'closed').
//   [[FUNIL:<etapa>]]   → move o card do funil ligado pra etapa cujo NOME casa.
//   [[PERDER:<motivo>]] → perde EM PÉ (mantém a etapa).
//   [[GANHO]]           → ganha EM PÉ (o card cumpriu o objetivo do funil dele).
//   [[GANHO]] ou [[PERDER:…]] + [[FUNIL:<funil> > <etapa>]] → fecha este card
//                         e abre um NOVO no outro funil (spawnDealInFunnel).
//
// A IA escolhe a etapa pelo nome (injetamos as etapas do funil no prompt).
// ============================================================

import { and, asc, desc, eq, sql } from 'drizzle-orm'
import {
  db,
  deals,
  pipelines,
  pipelineStages,
  conversations,
  dealEvents,
  tags,
  contactTags,
  messages,
  customFields,
  contactCustomValues,
  organization,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { autoCreateStageTasks } from '@/lib/pipelines/stage-tasks'
import { SAME_ORDER_WINDOW_MS } from './order-window'
import {
  resolveFunnelTarget,
  splitCrossFunnel,
  type FunnelOption,
  type FunnelTarget,
} from './funnel-target'

/** Nota interna na conversa (só pra equipe, nunca vai pro cliente). */
export async function postInternalNote(input: {
  conversationId: string
  text: string
}): Promise<boolean> {
  const text = (input.text || '').trim()
  if (!text) return false
  try {
    await db.insert(messages).values({
      conversationId: input.conversationId,
      senderType: 'bot',
      contentType: 'text',
      contentText: text,
      isInternal: true,
      status: 'sent',
    })
    return true
  } catch (err) {
    console.error('[ai note] falhou:', err)
    return false
  }
}

/** Nomes dos campos personalizados do contato (pra injetar no prompt). */
export async function listContactFieldNames(accountId: string): Promise<string[]> {
  try {
    const rows = await db
      .select({ name: customFields.fieldName })
      .from(customFields)
      .where(eq(customFields.accountId, accountId))
      .orderBy(asc(customFields.fieldName))
    return rows.map((r) => r.name).filter(Boolean)
  } catch {
    return []
  }
}

/** Grava um atributo (campo personalizado EXISTENTE) no contato. Best-effort. */
export async function setContactAttribute(input: {
  accountId: string
  contactId: string | null
  field: string
  value: string
}): Promise<boolean> {
  const { accountId, contactId, field, value } = input
  if (!contactId || !field) return false
  try {
    const fields = await db
      .select({ id: customFields.id, name: customFields.fieldName })
      .from(customFields)
      .where(eq(customFields.accountId, accountId))
    const want = field.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
    const match =
      fields.find(
        (f) => f.name.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase() === want,
      ) ?? null
    if (!match) return false
    await db
      .insert(contactCustomValues)
      .values({ contactId, customFieldId: match.id, value: value.slice(0, 500) })
      .onConflictDoUpdate({
        target: [contactCustomValues.contactId, contactCustomValues.customFieldId],
        set: { value: value.slice(0, 500) },
      })
    return true
  } catch (err) {
    console.error('[ai attribute] falhou:', err)
    return false
  }
}

/** Registra a preferência de voz do cliente na conversa. */
export async function setVoicePreference(input: {
  accountId: string
  conversationId: string
  pref: 'audio' | 'text'
}): Promise<boolean> {
  try {
    await db
      .update(conversations)
      .set({ voicePreference: input.pref })
      .where(
        and(
          eq(conversations.id, input.conversationId),
          eq(conversations.accountId, input.accountId),
        ),
      )
    return true
  } catch (err) {
    console.error('[ai voice-pref] falhou:', err)
    return false
  }
}

export interface DealCloseContext {
  dealId: string
  pipelineId: string
  currentStageId: string
  /** Nomes das etapas do funil do deal — a IA escolhe uma pelo nome. */
  stageNames: string[]
}

/**
 * Os OUTROS funis da conta (nome + etapas em ordem) — pra ferramenta
 * 'move_funnel' saber pra onde pode levar o card. Funil sem etapa fica fora.
 */
export async function listOtherFunnels(
  accountId: string,
  exceptPipelineId: string,
): Promise<{ name: string; stages: string[] }[]> {
  const rows = await db
    .select({ id: pipelines.id, name: pipelines.name, stage: pipelineStages.name })
    .from(pipelines)
    .innerJoin(pipelineStages, eq(pipelineStages.pipelineId, pipelines.id))
    .where(eq(pipelines.accountId, accountId))
    .orderBy(asc(pipelines.name), asc(pipelineStages.position))
  const out = new Map<string, { name: string; stages: string[] }>()
  for (const r of rows) {
    if (r.id === exceptPipelineId) continue
    const f = out.get(r.id) ?? { name: r.name, stages: [] }
    f.stages.push(r.stage)
    out.set(r.id, f)
  }
  return [...out.values()]
}

/** Deal ABERTO ligado à conversa + as etapas do funil dele. Null se não há. */
export async function loadDealCloseContext(
  accountId: string,
  conversationId: string,
): Promise<DealCloseContext | null> {
  const deal = firstOrNull(
    await db
      .select({
        id: deals.id,
        pipelineId: deals.pipelineId,
        stageId: deals.stageId,
      })
      .from(deals)
      .where(
        and(
          eq(deals.accountId, accountId),
          eq(deals.conversationId, conversationId),
          eq(deals.status, 'open'),
        ),
      )
      .orderBy(desc(deals.createdAt))
      .limit(1),
  )
  if (!deal) return null
  const stages = await db
    .select({ name: pipelineStages.name })
    .from(pipelineStages)
    .where(eq(pipelineStages.pipelineId, deal.pipelineId))
    .orderBy(pipelineStages.position)
  return {
    dealId: deal.id,
    pipelineId: deal.pipelineId,
    currentStageId: deal.stageId,
    stageNames: stages.map((s) => s.name),
  }
}

/* (createDealFromAi definido acima) */

/** Nomes das etiquetas EXISTENTES da conta (pra injetar no prompt). */
export async function listAccountTagNames(accountId: string): Promise<string[]> {
  const rows = await db
    .select({ name: tags.name })
    .from(tags)
    .where(eq(tags.accountId, accountId))
    .orderBy(tags.name)
  return rows.map((r) => r.name)
}

/**
 * Anexa ao contato as etiquetas (por NOME) que a IA pediu — casando só com
 * etiquetas EXISTENTES da conta (não cria novas). Best-effort. Devolve as que
 * anexou.
 */
export async function applyTagsByName(input: {
  accountId: string
  contactId: string | null
  tagNames: string[]
}): Promise<string[]> {
  const { accountId, contactId, tagNames } = input
  if (!contactId || tagNames.length === 0) return []
  const applied: string[] = []
  try {
    const existing = await db
      .select({ id: tags.id, name: tags.name })
      .from(tags)
      .where(eq(tags.accountId, accountId))
    for (const wanted of tagNames) {
      const w = norm(wanted)
      const match =
        existing.find((t) => norm(t.name) === w) ??
        existing.find((t) => norm(t.name).includes(w) || w.includes(norm(t.name)))
      if (!match) continue
      await db
        .insert(contactTags)
        .values({ contactId, tagId: match.id })
        .onConflictDoNothing({
          target: [contactTags.contactId, contactTags.tagId],
        })
      applied.push(match.name)
    }
  } catch (err) {
    console.error('[ai tags] anexar falhou:', err)
  }
  return applied
}

/** De onde veio o card reaproveitado (null = card novo). */
export type AiDealReuse = 'conversation' | 'contact'

/**
 * Qual card existente vale como "o mesmo" em vez de criar outro. Pura.
 *   1. card ABERTO desta conversa;
 *   2. card desta conversa criado dentro da janela do mesmo pedido, em
 *      QUALQUER status — na Família do Gás a equipe arrasta pra Ganho em
 *      minutos e a trava antiga (só aberto) sumia (casos de 14/09 e 11/09);
 *   3. card ABERTO do mesmo contato no MESMO funil, vindo de outra conversa
 *      (cliente que volta por outro anúncio/número — Alex 16/09: só no mesmo
 *      funil). Ganho/perdido de outra conversa não conta: é compra nova.
 */
export function pickDealToReuse(input: {
  now: number
  /** Cards desta conversa, mais recente primeiro. */
  conversationDeals: { id: string; status: string; createdAt: string }[]
  /** Cards abertos do contato no funil de destino, mais recente primeiro. */
  contactOpenDeals: { id: string }[]
}): { dealId: string; reuse: AiDealReuse } | null {
  const open = input.conversationDeals.find((d) => d.status === 'open')
  if (open) return { dealId: open.id, reuse: 'conversation' }
  const recent = input.conversationDeals.find(
    (d) => input.now - new Date(d.createdAt).getTime() < SAME_ORDER_WINDOW_MS,
  )
  if (recent) return { dealId: recent.id, reuse: 'conversation' }
  const sameContact = input.contactOpenDeals[0]
  if (sameContact) return { dealId: sameContact.id, reuse: 'contact' }
  return null
}

/** Card desta conversa criado há tão pouco que é o MESMO turno (marcador +
 *  fallback do pedido): reaproveita calado, sem nota repetida no histórico. */
const SAME_TURN_MS = 5 * 60 * 1000

/**
 * Cria um card (negócio) no funil a partir do que a IA identificou — ou
 * REAPROVEITA um existente (ver pickDealToReuse), deixando uma observação no
 * histórico dele. Usa o funil do agente (ou o 1º da conta) + a 1ª etapa.
 * Best-effort. Devolve o id (com `reused` quando não criou) ou null.
 */
export async function createDealFromAi(input: {
  accountId: string
  userId: string | null
  conversationId: string
  contactId: string | null
  title: string
  /** Valor fechado com o cliente (moeda da conta). null = sem valor. */
  value?: number | null
  /** Resumo do pedido (produto, endereço, pagamento) — vira a nota do card. */
  note?: string | null
  /** Funil do AGENTE (ai_configs.pipeline_id) — null/inválido cai no 1º funil. */
  pipelineId?: string | null
}): Promise<{ dealId: string; title: string; reused: AiDealReuse | null } | null> {
  const { accountId, userId, conversationId, contactId } = input
  const title = (input.title || '').trim().slice(0, 200)
  if (!title) return null
  // deals.user_id (criador) é NOT NULL — sem um usuário válido, não cria.
  if (!userId) return null
  try {
    const note = (input.note ?? '').trim().slice(0, 2000) || null
    const conversationDeals = await db
      .select({ id: deals.id, status: deals.status, createdAt: deals.createdAt })
      .from(deals)
      .where(and(eq(deals.accountId, accountId), eq(deals.conversationId, conversationId)))
      .orderBy(desc(deals.createdAt))
      .limit(5)

    // Funil do agente (quando configurado e da conta) — senão 1º funil da conta.
    let pipeline: { id: string } | null = null
    if (input.pipelineId) {
      pipeline = firstOrNull(
        await db
          .select({ id: pipelines.id })
          .from(pipelines)
          .where(and(eq(pipelines.id, input.pipelineId), eq(pipelines.accountId, accountId)))
          .limit(1),
      )
    }
    if (!pipeline) {
      pipeline = firstOrNull(
        await db
          .select({ id: pipelines.id })
          .from(pipelines)
          .where(eq(pipelines.accountId, accountId))
          .orderBy(asc(pipelines.createdAt))
          .limit(1),
      )
    }
    if (!pipeline) return null

    const contactOpenDeals =
      contactId && !conversationDeals.some((d) => d.status === 'open')
        ? await db
            .select({ id: deals.id, conversationId: deals.conversationId })
            .from(deals)
            .where(
              and(
                eq(deals.accountId, accountId),
                eq(deals.contactId, contactId),
                eq(deals.pipelineId, pipeline.id),
                eq(deals.status, 'open'),
              ),
            )
            .orderBy(desc(deals.createdAt))
            .limit(1)
        : []
    const reuse = pickDealToReuse({
      now: Date.now(),
      conversationDeals: conversationDeals.map((d) => ({
        id: d.id,
        status: d.status ?? 'open',
        // Sem data (não deveria acontecer) = antigo: só conta se estiver aberto.
        createdAt: d.createdAt ?? new Date(0).toISOString(),
      })),
      contactOpenDeals,
    })
    if (reuse) {
      const matched = conversationDeals.find((d) => d.id === reuse.dealId)
      const sameTurn =
        !!matched?.createdAt && Date.now() - new Date(matched.createdAt).getTime() < SAME_TURN_MS
      if (!sameTurn) {
        const detail = [title, note].filter(Boolean).join(' · ')
        const text =
          reuse.reuse === 'contact'
            ? `📝 Novo contato do mesmo cliente pelo WhatsApp (anexado a este card, sem criar outro):\n${detail}`
            : `🔁 A IA registrou de novo o pedido desta conversa — card não duplicado:\n${detail}`
        try {
          await db.insert(dealEvents).values({
            accountId,
            actorUserId: userId,
            dealId: reuse.dealId,
            type: 'note',
            data: { by: 'ai', text },
          })
        } catch (err) {
          console.error('[ai create-card] nota do card reaproveitado falhou:', err)
        }
      }
      // Card que nasceu sem conversa ("Criar negócio com IA" antes de 16/09)
      // passa a apontar pra esta: a IA volta a enxergar e mover o card.
      const orphan = contactOpenDeals.find((d) => d.id === reuse.dealId && !d.conversationId)
      if (orphan) {
        await db
          .update(deals)
          .set({ conversationId })
          .where(and(eq(deals.id, orphan.id), sql`${deals.conversationId} IS NULL`))
          .catch((err) => console.error('[ai create-card] vincular conversa falhou:', err))
      }
      return { dealId: reuse.dealId, title, reused: reuse.reuse }
    }

    const stage = firstOrNull(
      await db
        .select({ id: pipelineStages.id })
        .from(pipelineStages)
        .where(eq(pipelineStages.pipelineId, pipeline.id))
        .orderBy(asc(pipelineStages.position))
        .limit(1),
    )
    if (!stage) return null

    // Moeda da CONTA — sem isso o insert caía no default 'USD' do banco e o
    // card da Maria nasceu em dólar (review da 1ª venda, 26/08).
    const org = firstOrNull(
      await db
        .select({ currency: organization.default_currency })
        .from(organization)
        .where(eq(organization.id, accountId))
        .limit(1),
    )
    const value =
      typeof input.value === 'number' && Number.isFinite(input.value) && input.value >= 0
        ? input.value
        : null

    const [created] = await db
      .insert(deals)
      .values({
        accountId,
        pipelineId: pipeline.id,
        stageId: stage.id,
        contactId: contactId || null,
        conversationId,
        title,
        ...(value != null ? { value: String(value) } : {}),
        currency: org?.currency ?? 'BRL',
        ...(note ? { notes: note } : {}),
        status: 'open',
        userId,
        stageChangedAt: sql`now()`,
      })
      .returning({ id: deals.id })

    try {
      await db.insert(dealEvents).values({
        accountId,
        actorUserId: userId || null,
        dealId: created.id,
        type: 'created',
        data: { by: 'ai', title },
      })
    } catch (err) {
      console.error('[ai create-card] deal event falhou:', err)
    }
    // Atividades automáticas da etapa de entrada (best-effort).
    try {
      await autoCreateStageTasks({ accountId, userId: userId || null }, created.id, stage.id)
    } catch (err) {
      console.error('[ai create-card] autoCreateStageTasks:', err)
    }
    return { dealId: created.id, title, reused: null }
  } catch (err) {
    console.error('[ai create-card] falhou:', err)
    return null
  }
}

/** Casa nome de etapa tolerante a acento/caixa/espaço. */
function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase()
}

/**
 * Marca o negócio ligado à conversa (ou por id) como PERDIDO mantendo a etapa
 * atual (perde-em-pé) + histórico rico. Reutilizável: IA (marcador [[PERDER:]])
 * e, na fase 2, a auto-perda por follow-up esgotado. Best-effort, nunca lança.
 */
export async function markDealLostInPlace(input: {
  accountId: string
  userId: string | null
  conversationId?: string | null
  dealId?: string | null
  reason?: string | null
  by?: 'ai' | 'followup' | 'system'
  followUps?: number | null
  /** Quem fechou já escolheu o próximo funil (spawnDealInFunnel): não dispara
   *  também o funil de resgate automático da conta. */
  skipAccountAutomation?: boolean
}): Promise<{ dealId: string; stageName: string | null } | null> {
  const { accountId, userId, conversationId, dealId } = input
  const by = input.by ?? 'ai'
  const reason = (input.reason || '').trim().slice(0, 120) || 'Sem interesse'
  try {
    // Acha o negócio ABERTO (por id, senão o mais recente ligado à conversa).
    const deal = firstOrNull(
      await db
        .select({ id: deals.id, stageId: deals.stageId })
        .from(deals)
        .where(
          and(
            eq(deals.accountId, accountId),
            eq(deals.status, 'open'),
            dealId
              ? eq(deals.id, dealId)
              : conversationId
                ? eq(deals.conversationId, conversationId)
                : sql`false`,
          ),
        )
        .orderBy(desc(deals.createdAt))
        .limit(1),
    )
    if (!deal) return null
    const stageName =
      firstOrNull(
        await db
          .select({ name: pipelineStages.name })
          .from(pipelineStages)
          .where(eq(pipelineStages.id, deal.stageId))
          .limit(1),
      )?.name ?? null

    // Perde EM PÉ: status='lost' + motivo (SEM mexer na etapa) + evento carimbado
    // ATÔMICOS — o evento é o dado que o Raio-X data a perda; se falhar, desfaz o
    // status pra não ficar 'lost' sem evento (KPI de perda datada não desincroniza).
    await db.transaction(async (tx) => {
      await tx
        .update(deals)
        .set({ status: 'lost', lostReason: reason })
        .where(and(eq(deals.id, deal.id), eq(deals.accountId, accountId)))
      await tx.insert(dealEvents).values({
        accountId,
        actorUserId: userId || null,
        dealId: deal.id,
        type: 'status_changed',
        data: {
          from: 'open',
          to: 'lost',
          reason,
          stageId: deal.stageId,
          stageName,
          by,
          ...(input.followUps != null ? { followUps: input.followUps } : {}),
        },
      })
    })

    // Nota interna (visível pra equipe na conversa).
    if (conversationId) {
      const ctx =
        input.followUps != null
          ? ` após ${input.followUps} follow-up(s) sem retorno`
          : ''
      await postInternalNote({
        conversationId,
        text: `🔻 Negócio marcado como PERDIDO${
          stageName ? ` na etapa "${stageName}"` : ''
        }${ctx} — motivo: ${reason}. (${by === 'ai' ? 'IA' : by})`,
      })
    }
    // 🔀 Funil→funil: perda automática também abre o negócio de resgate.
    if (!input.skipAccountAutomation) {
      try {
        const { maybeSpawnCrossFunnelDeal } = await import(
          '@/lib/pipelines/cross-funnel'
        )
        await maybeSpawnCrossFunnelDeal(accountId, userId, deal.id, 'lost')
      } catch (err) {
        console.error('[ai lose] cross-funnel falhou:', err)
      }
    }
    return { dealId: deal.id, stageName }
  } catch (err) {
    console.error('[ai lose] falhou:', err)
    return null
  }
}

/**
 * Marca o negócio ligado à conversa (ou por id) como GANHO mantendo a etapa —
 * o card cumpriu o objetivo DO FUNIL DELE (ex.: pré-vendas que marcou a
 * reunião; Jordan/Zelo 18/09: "dá o ganho na 4ª tentativa"). Não é "venda
 * fechada": NÃO manda o aviso de venda nem grava compra no histórico do
 * cliente (isso é do ganho pelo funil, em pipelines/actions). Nunca lança.
 */
export async function markDealWonInPlace(input: {
  accountId: string
  userId: string | null
  conversationId?: string | null
  dealId?: string | null
  by?: 'ai' | 'system'
  /** Quem fechou já escolheu o próximo funil: não dispara o pós-venda da conta. */
  skipAccountAutomation?: boolean
}): Promise<{ dealId: string; stageName: string | null } | null> {
  const { accountId, userId, conversationId, dealId } = input
  const by = input.by ?? 'ai'
  try {
    const deal = firstOrNull(
      await db
        .select({ id: deals.id, stageId: deals.stageId })
        .from(deals)
        .where(
          and(
            eq(deals.accountId, accountId),
            eq(deals.status, 'open'),
            dealId
              ? eq(deals.id, dealId)
              : conversationId
                ? eq(deals.conversationId, conversationId)
                : sql`false`,
          ),
        )
        .orderBy(desc(deals.createdAt))
        .limit(1),
    )
    if (!deal) return null
    const stageName =
      firstOrNull(
        await db
          .select({ name: pipelineStages.name })
          .from(pipelineStages)
          .where(eq(pipelineStages.id, deal.stageId))
          .limit(1),
      )?.name ?? null

    await db.transaction(async (tx) => {
      await tx
        .update(deals)
        .set({ status: 'won', lostReason: null })
        .where(and(eq(deals.id, deal.id), eq(deals.accountId, accountId)))
      await tx.insert(dealEvents).values({
        accountId,
        actorUserId: userId || null,
        dealId: deal.id,
        type: 'status_changed',
        data: { from: 'open', to: 'won', stageId: deal.stageId, stageName, by },
      })
    })

    if (conversationId) {
      await postInternalNote({
        conversationId,
        text: `🏆 Negócio marcado como GANHO${stageName ? ` na etapa "${stageName}"` : ''}. (${by === 'ai' ? 'IA' : by})`,
      })
    }
    if (!input.skipAccountAutomation) {
      try {
        const { maybeSpawnCrossFunnelDeal } = await import('@/lib/pipelines/cross-funnel')
        await maybeSpawnCrossFunnelDeal(accountId, userId, deal.id, 'won')
      } catch (err) {
        console.error('[ai win] cross-funnel falhou:', err)
      }
    }
    return { dealId: deal.id, stageName }
  } catch (err) {
    console.error('[ai win] falhou:', err)
    return null
  }
}

/**
 * Uma linha sobre o card aberto da conversa pro aviso de handoff —
 * "3. Comercial | Serviços › Novo lead · RD Station — solicite-um-orcamento".
 * Quem recebe no WhatsApp sabe de cara que tipo de lead é. Null sem card.
 */
export async function handoffDealLine(accountId: string, conversationId: string): Promise<string | null> {
  try {
    const row = firstOrNull(
      await db
        .select({
          pipeline: pipelines.name,
          stage: pipelineStages.name,
          origin: deals.origin,
          source: deals.source,
        })
        .from(deals)
        .innerJoin(pipelines, eq(pipelines.id, deals.pipelineId))
        .innerJoin(pipelineStages, eq(pipelineStages.id, deals.stageId))
        .where(
          and(
            eq(deals.accountId, accountId),
            eq(deals.conversationId, conversationId),
            eq(deals.status, 'open'),
          ),
        )
        .orderBy(desc(deals.createdAt))
        .limit(1),
    )
    if (!row) return null
    const origin = [row.origin, row.source].map((s) => (s ?? '').trim()).filter(Boolean).join(' — ')
    return `${row.pipeline} › ${row.stage}${origin ? ` · ${origin}` : ''}`
  } catch {
    return null
  }
}

/** Funis da conta com as etapas em ordem (pra casar "[[FUNIL:<funil> > <etapa>]]"). */
async function loadAccountFunnels(accountId: string): Promise<FunnelOption[]> {
  const rows = await db
    .select({
      pipelineId: pipelines.id,
      pipelineName: pipelines.name,
      stageId: pipelineStages.id,
      stageName: pipelineStages.name,
    })
    .from(pipelines)
    .innerJoin(pipelineStages, eq(pipelineStages.pipelineId, pipelines.id))
    .where(eq(pipelines.accountId, accountId))
    .orderBy(asc(pipelines.name), asc(pipelineStages.position))
  const byFunnel = new Map<string, FunnelOption>()
  for (const r of rows) {
    const f = byFunnel.get(r.pipelineId) ?? { id: r.pipelineId, name: r.pipelineName, stages: [] }
    f.stages.push({ id: r.stageId, name: r.stageName })
    byFunnel.set(r.pipelineId, f)
  }
  return [...byFunnel.values()]
}

/**
 * Executa as ações de encerramento decididas pela IA. Best-effort, nunca lança.
 * Devolve o que fez (pra log).
 */
export async function applyCloseActions(input: {
  accountId: string
  userId: string | null
  conversationId: string
  resolve: boolean
  funnelStageName: string | null
  /** Motivo da perda (marcador [[PERDER:]]) — perde EM PÉ, não move de etapa. */
  loseReason?: string | null
  /** [[GANHO]] — ganha EM PÉ (o card cumpriu o objetivo do funil dele). */
  win?: boolean
  /**
   * Ferramenta 'move_funnel': "[[FUNIL:<funil> > <etapa>]]" pode levar o card
   * pra OUTRO funil da conta. Sem ela, o marcador só anda dentro do funil.
   */
  allowCrossFunnel?: boolean
}): Promise<{
  resolved: boolean
  movedTo: string | null
  movedToFunnel?: string | null
  lost: boolean
  won?: boolean
  /** Card NOVO aberto no outro funil (ganho/perda + [[FUNIL:<funil> > <etapa>]]). */
  spawnedDealId?: string | null
}> {
  const { accountId, userId, conversationId, resolve, funnelStageName, loseReason } = input
  let movedToFunnel: string | null = null
  let resolved = false
  let movedTo: string | null = null
  let lost = false
  let won = false
  let spawnedDealId: string | null = null
  const wantLose = loseReason !== undefined && loseReason !== null
  const wantWin = !!input.win && !wantLose // perder vence ganhar (mais seguro)

  // 0) Ganho/perda + OUTRO funil: fecha este card onde está (o pré-vendas
  // registra onde converteu ou por que saiu) e ABRE um novo no destino —
  // Jordan/Zelo 18/09. Destino não achado → só fecha em pé, como antes.
  let crossClose =
    (wantLose || wantWin) &&
    !!input.allowCrossFunnel &&
    !!funnelStageName &&
    !!splitCrossFunnel(funnelStageName)
  // 🔁 Já está no funil de destino (o card é a CÓPIA aberta por um ganho
  // anterior): repetir "[[GANHO]] + [[FUNIL:…]]" não fecha nem copia de novo.
  // Zelo 18/09: a IA repetiu os marcadores em 3 respostas seguidas e gerou 3
  // cópias (2 delas ganhas). No máximo anda de etapa dentro do funil.
  let alreadyThere: { id: string; pipelineId: string; stageId: string } | null = null
  if (crossClose) {
    const open = firstOrNull(
      await db
        .select({ id: deals.id, pipelineId: deals.pipelineId, stageId: deals.stageId })
        .from(deals)
        .where(
          and(
            eq(deals.accountId, accountId),
            eq(deals.conversationId, conversationId),
            eq(deals.status, 'open'),
          ),
        )
        .orderBy(desc(deals.createdAt))
        .limit(1),
    )
    const target = open ? resolveFunnelTarget(await loadAccountFunnels(accountId), funnelStageName!) : null
    if (open && target && target.pipelineId === open.pipelineId) {
      crossClose = false
      alreadyThere = open
      if (target.stageId !== open.stageId) {
        const moved = await moveDealToOtherFunnel({ accountId, userId, deal: open, raw: funnelStageName! }).catch(() => null)
        if (moved) {
          movedTo = moved.stageName
          movedToFunnel = moved.pipelineName
        }
      }
    }
  }
  if (crossClose) {
    try {
      const source = firstOrNull(
        await db
          .select({ id: deals.id })
          .from(deals)
          .where(
            and(
              eq(deals.accountId, accountId),
              eq(deals.conversationId, conversationId),
              eq(deals.status, 'open'),
            ),
          )
          .orderBy(desc(deals.createdAt))
          .limit(1),
      )
      const target = source
        ? resolveFunnelTarget(await loadAccountFunnels(accountId), funnelStageName!)
        : null
      if (source) {
        const closed = wantWin
          ? await markDealWonInPlace({ accountId, userId, conversationId, dealId: source.id, by: 'ai', skipAccountAutomation: !!target })
          : await markDealLostInPlace({ accountId, userId, conversationId, dealId: source.id, reason: loseReason, by: 'ai', skipAccountAutomation: !!target })
        won = wantWin && !!closed
        lost = wantLose && !!closed
        if (closed && target) {
          const spawned = await (await import('@/lib/pipelines/cross-funnel')).spawnDealInFunnel({
            accountId,
            userId,
            sourceDealId: source.id,
            pipelineId: target.pipelineId,
            stageId: target.stageId,
            kind: wantWin ? 'won' : 'lost',
          })
          if (spawned) {
            spawnedDealId = spawned.dealId
            movedTo = target.stageName
            movedToFunnel = target.pipelineName
            await postInternalNote({
              conversationId,
              text: `➡️ Card ${spawned.created ? 'novo' : 'existente'} em "${target.pipelineName} › ${target.stageName}".`,
            })
          }
        }
      }
    } catch (err) {
      console.error('[ai close] fechar + abrir no outro funil falhou:', err)
    }
  }

  // 1) Perder EM PÉ tem PRIORIDADE sobre mover: se a IA pediu [[PERDER:]], marca
  // perdido mantendo a etapa e NÃO move o card (mover um perdido não faz sentido).
  if (!crossClose && !alreadyThere && wantLose) {
    const r = await markDealLostInPlace({
      accountId,
      userId,
      conversationId,
      reason: loseReason,
      by: 'ai',
    })
    lost = !!r
  }
  // 1b) Ganho EM PÉ (sem outro funil).
  if (!crossClose && !alreadyThere && wantWin) {
    const r = await markDealWonInPlace({ accountId, userId, conversationId, by: 'ai' })
    won = !!r
  }

  // 2) Mover o card do funil (se a IA pediu, casar uma etapa e NÃO tiver
  // perdido/ganhado — card fechado não anda).
  if (!crossClose && !alreadyThere && !lost && !won && funnelStageName && funnelStageName.trim()) {
    try {
      const deal = firstOrNull(
        await db
          .select({
            id: deals.id,
            pipelineId: deals.pipelineId,
            stageId: deals.stageId,
          })
          .from(deals)
          .where(
            and(
              eq(deals.accountId, accountId),
              eq(deals.conversationId, conversationId),
              eq(deals.status, 'open'),
            ),
          )
          .orderBy(desc(deals.createdAt))
          .limit(1),
      )
      const cross =
        deal && input.allowCrossFunnel && splitCrossFunnel(funnelStageName)
          ? await moveDealToOtherFunnel({ accountId, userId, deal, raw: funnelStageName })
          : null
      if (cross) {
        movedTo = cross.stageName
        movedToFunnel = cross.pipelineName
      } else if (deal && !splitCrossFunnel(funnelStageName)) {
        // Marcador de OUTRO funil sem a ferramenta (ou destino não achado) não
        // cai aqui: o casamento aproximado de etapa acharia "Novo lead" no
        // funil ATUAL e moveria pro lugar errado.
        const stages = await db
          .select({ id: pipelineStages.id, name: pipelineStages.name })
          .from(pipelineStages)
          .where(eq(pipelineStages.pipelineId, deal.pipelineId))
        const want = norm(funnelStageName)
        const target =
          stages.find((s) => norm(s.name) === want) ??
          stages.find(
            (s) => norm(s.name).includes(want) || want.includes(norm(s.name)),
          )
        if (target && target.id !== deal.stageId) {
          const fromName =
            stages.find((s) => s.id === deal.stageId)?.name ?? null
          await db
            .update(deals)
            .set({ stageId: target.id, stageChangedAt: sql`now()` })
            .where(and(eq(deals.id, deal.id), eq(deals.accountId, accountId)))
          try {
            await db.insert(dealEvents).values({
              accountId,
              actorUserId: userId || null,
              dealId: deal.id,
              type: 'stage_changed',
              data: { from: fromName, to: target.name, by: 'ai' },
            })
          } catch (err) {
            console.error('[ai close] deal event falhou:', err)
          }
          movedTo = target.name
        }
      }
    } catch (err) {
      console.error('[ai close] mover funil falhou:', err)
    }
  }

  // 3) Resolver (fechar) a conversa.
  if (resolve) {
    try {
      await db
        .update(conversations)
        .set({ status: 'closed' })
        .where(
          and(
            eq(conversations.id, conversationId),
            eq(conversations.accountId, accountId),
          ),
        )
      resolved = true
    } catch (err) {
      console.error('[ai close] resolver conversa falhou:', err)
    }
  }

  return { resolved, movedTo, movedToFunnel, lost, won, spawnedDealId }
}

/**
 * Leva o card pra OUTRO funil da conta ([[FUNIL:<funil> > <etapa>]]), com
 * histórico no card e as tarefas automáticas da etapa de destino. Destino
 * ambíguo/inexistente ou igual ao atual → não move (null).
 */
async function moveDealToOtherFunnel(input: {
  accountId: string
  userId: string | null
  deal: { id: string; pipelineId: string; stageId: string }
  raw: string
}): Promise<FunnelTarget | null> {
  const { accountId, userId, deal, raw } = input
  const funnels = await loadAccountFunnels(accountId)
  const byFunnel = new Map(funnels.map((f) => [f.id, f]))
  const target = resolveFunnelTarget(funnels, raw)
  if (!target || (target.pipelineId === deal.pipelineId && target.stageId === deal.stageId)) return null

  const from = byFunnel.get(deal.pipelineId)
  const fromStage = from?.stages.find((s) => s.id === deal.stageId)?.name ?? null
  await db
    .update(deals)
    .set({ pipelineId: target.pipelineId, stageId: target.stageId, stageChangedAt: sql`now()` })
    .where(and(eq(deals.id, deal.id), eq(deals.accountId, accountId)))
  try {
    await db.insert(dealEvents).values({
      accountId,
      actorUserId: userId || null,
      dealId: deal.id,
      type: 'stage_changed',
      data: {
        from: from ? `${from.name} › ${fromStage ?? '?'}` : fromStage,
        to: `${target.pipelineName} › ${target.stageName}`,
        by: 'ai',
      },
    })
  } catch (err) {
    console.error('[ai close] deal event (troca de funil) falhou:', err)
  }
  try {
    await autoCreateStageTasks({ accountId, userId }, deal.id, target.stageId)
  } catch (err) {
    console.error('[ai close] tarefas da etapa (troca de funil) falharam:', err)
  }
  return target
}

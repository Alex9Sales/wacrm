// ============================================================
// 🏆 "O lead respondeu" = GANHO no funil de origem + card novo no destino.
//
// Zelo, reunião de 29/09: o funil "1. Cadência pré-vendas" GANHA quando o lead
// RESPONDE (qualquer resposta = sucesso no contato), não quando a reunião é
// marcada. O card do pré-vendas é marcado ganho NA ETAPA EM QUE ESTÁ — é isso
// que mede em qual tentativa da cadência o lead converteu — e nasce um card no
// comercial (ex.: "2. Comercial | Franquia › Qualificação") ligado à MESMA
// conversa, com as tarefas abertas do cadastro ("Falar com…") indo junto.
//
// Configurável por conta em settings.replyWinRules (sem tela, liga-se por
// SQL): vazio = nada muda. Chamado pelo inbound (webhook) ANTES da pausa da
// cadência — ver o gancho em lib/channels/inbound.ts. Sem 'server-only': o
// inbound também roda no worker (Gmail pelo IMAP), e lá o import derruba o
// processo em crash-loop. Nunca lança: falha vira log + nota na conversa.
// ============================================================

import { and, eq, isNull, sql } from 'drizzle-orm'

import { db, deals, pipelines, pipelineStages, tasks } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { markDealWonInPlace, postInternalNote } from '@/lib/ai/close-actions'
import { claimOnce } from '@/lib/ai/reply-marker'
import { matchesOptOut } from '@/lib/contacts/opt-out'
import { publishEvent } from '@/lib/events/publish'
import { getAccountSettings, type ReplyWinRule } from '@/lib/settings/account-settings'
import { spawnDealInFunnel } from './cross-funnel'

/** uuid canônico. A regra é gravada à mão (SQL) — id torto compararia com uma
 *  coluna uuid e o Postgres lançaria "invalid input syntax" a CADA mensagem. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Prefixo dos registros de sistema no histórico: ligação (call-log) e
 *  permissão de ligação (callperm) começam com o separador invisível U+2063.
 *  Não é o lead falando — é o CRM anotando um evento. */
const SYSTEM_SENTINEL = '⁣'

/** Tipo que a API oficial não descreve (system, request_welcome…): evento do
 *  WhatsApp, não uma fala. Já "[Mensagem não suportada pela API oficial…" é
 *  enquete/edição/visualização única — gente de verdade — e CONTA. */
const UNSUPPORTED_TYPE_PREFIX = '[Tipo de mensagem não suportado'

/** Quantos cards abertos do contato no funil de origem olhamos. Normal é 1;
 *  o teto só segura cadastro duplicado em massa. */
const MAX_CANDIDATES = 20

/**
 * Lê settings.replyWinRules tolerando o que vier do SQL à mão: descarta regra
 * sem os três ids (ou com id que não é uuid), regra de um funil para ELE MESMO
 * (ganharia o card recém-aberto na mesma mensagem) e origem repetida (a 1ª
 * vence — duas regras pro mesmo funil abririam dois cards). Pura.
 */
export function normalizeReplyWinRules(raw: unknown): ReplyWinRule[] {
  if (!Array.isArray(raw)) return []
  const out: ReplyWinRule[] = []
  const seen = new Set<string>()
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const fromPipelineId = typeof o.fromPipelineId === 'string' ? o.fromPipelineId.trim() : ''
    const toPipelineId = typeof o.toPipelineId === 'string' ? o.toPipelineId.trim() : ''
    const toStageId = typeof o.toStageId === 'string' ? o.toStageId.trim() : ''
    if (![fromPipelineId, toPipelineId, toStageId].every((id) => UUID_RE.test(id))) continue
    if (fromPipelineId.toLowerCase() === toPipelineId.toLowerCase()) continue
    const key = fromPipelineId.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ fromPipelineId, toPipelineId, toStageId })
  }
  return out
}

/**
 * A mensagem é uma RESPOSTA do lead? Pura. NÃO conta:
 *   - pedido de descadastro ("SAIR", botão "não quero mais") — quem pediu pra
 *     sair não converteu; o inbound marca "não perturbe" logo depois;
 *   - registro de sistema (ligação/permissão de ligação, tipo não suportado);
 *   - texto vazio SEM clique em botão.
 * Áudio/foto/documento chegam com o rótulo da mídia ("[audio]") e contam;
 * clique em botão de modelo conta pelo reply id mesmo sem texto.
 */
export function isLeadReply(
  contentText: string | null | undefined,
  interactiveReplyId?: string | null,
): boolean {
  const text = contentText ?? ''
  const replyId = (interactiveReplyId ?? '').trim()
  if (matchesOptOut(text, replyId || null)) return false
  if (text.startsWith(SYSTEM_SENTINEL)) return false
  if (text.startsWith(UNSUPPORTED_TYPE_PREFIX)) return false
  if (!replyId && looksLikeAutoReply(text)) return false
  return text.trim().length > 0 || replyId.length > 0
}

/**
 * Resposta AUTOMÁTICA do lado do lead: ausência do WhatsApp Business, "fora do
 * escritório" do e-mail, "mensagem automática". Ganhar o card com isso é
 * irreversível no RD (negócio fechado não reabre pela API) e o lead nem leu
 * (revisão de 01/10; na GoLink, 15 de 18 "respostas" de uma régua eram robô).
 * A próxima mensagem de verdade do lead ganha normalmente. Pura.
 *
 * Um sinal FORTE basta (só robô escreve assim). Os FRACOS — que uma pessoa
 * também escreve ("Agradecemos o contato, mas não temos interesse", "no
 * momento não podemos investir") — só valem em dupla: a mensagem de ausência
 * padrão junta saudação + fora do horário + "retornaremos".
 */
const AUTO_REPLY_STRONG =
  /mensagem autom[aá]tica|resposta autom[aá]tica|\bauto[- ]?reply\b|automatic reply|out of (the )?office|fora do escrit[oó]rio/i
const AUTO_REPLY_WEAK: RegExp[] = [
  /fora do hor[aá]rio de (atendimento|funcionamento|expediente)/i,
  /(no|neste) momento,? (n[aã]o (estamos|podemos) atender|estamos (ausentes|indispon[ií]veis))/i,
  /(retornaremos|responderemos)[^.!?\n]{0,30}(o mais (breve|r[aá]pido)|assim que poss[ií]vel|em breve)/i,
  /agradecemos (o seu|seu|o|pelo) contato|obrigad[oa] por (entrar em )?contato/i,
  /nosso hor[aá]rio de atendimento/i,
]

export function looksLikeAutoReply(text: string | null | undefined): boolean {
  const t = (text ?? '').trim()
  if (!t) return false
  if (AUTO_REPLY_STRONG.test(t)) return true
  return AUTO_REPLY_WEAK.filter((re) => re.test(t)).length >= 2
}

export interface ReplyWinCandidate {
  id: string
  conversationId: string | null
  createdAt: string | null
}

/** Mais novo primeiro; sem data vai pro FIM (o DESC do Postgres poria no
 *  topo — gotcha da caixa de entrada da clínica, 10/09). */
function newestFirst<T extends ReplyWinCandidate>(rows: T[]): T[] {
  const at = (d: T) => (d.createdAt ? new Date(d.createdAt).getTime() : Number.NEGATIVE_INFINITY)
  return [...rows].sort((a, b) => at(b) - at(a))
}

/**
 * Qual card aberto do contato no funil de origem ganha. Pura.
 *   1. o ligado a ESTA conversa (é dele que a equipe e a IA estão falando);
 *   2. senão o mais recente do contato (card do cadastro que nasceu sem
 *      conversa, ou ligado ao e-mail enquanto o lead respondeu no WhatsApp).
 * `skip` = cards que esta MESMA mensagem acabou de abrir/reaproveitar como
 * destino de outra regra: não podem ser ganhos em cascata no mesmo instante.
 */
export function pickReplyWinDeal<T extends ReplyWinCandidate>(
  candidates: T[],
  conversationId: string,
  skip: ReadonlySet<string> = new Set(),
): T | null {
  const pool = newestFirst(candidates.filter((d) => !skip.has(d.id)))
  return pool.find((d) => d.conversationId === conversationId) ?? pool[0] ?? null
}

/** Nota interna do resultado (só a equipe vê). Nomes reais de funil/etapa —
 *  é o que o gestor procura no relatório. Pura. */
export function replyWinNote(p: {
  fromPipelineName: string | null
  wonStageName: string | null
  toPipelineName: string
  toStageName: string
  /** null = o card de destino NÃO saiu (erro ao criar). */
  spawned: { created: boolean } | null
  movedTasks: number
}): string {
  const from = p.fromPipelineName ? `card de «${p.fromPipelineName}»` : 'card'
  const stage = p.wonStageName ? ` na etapa «${p.wonStageName}»` : ''
  const won = `🏆 O lead respondeu: ${from} ganho${stage}`
  const dest = `«${p.toPipelineName} › ${p.toStageName}»`
  if (!p.spawned) {
    return `${won}, mas o card em ${dest} NÃO foi aberto (erro ao criar). Abra o card à mão para o lead não ficar sem dono.`
  }
  const where = p.spawned.created
    ? ` e card aberto em ${dest}.`
    : ` e seguimos no card que ele já tinha aberto em «${p.toPipelineName}» (nenhum card novo).`
  const tasksLine =
    p.movedTasks === 1
      ? ' 1 tarefa aberta passou para esse card.'
      : p.movedTasks > 1
        ? ` ${p.movedTasks} tarefas abertas passaram para esse card.`
        : ''
  return `${won}${where}${tasksLine}`
}

/** Nota de regra quebrada: o destino não existe (funil/etapa apagados ou id
 *  errado no SQL). O card NÃO é ganho — fechar sem abrir o próximo deixaria o
 *  lead sem card aberto em lugar nenhum. Pura. */
export function replyWinBrokenRuleNote(fromPipelineName: string | null): string {
  const from = fromPipelineName ? ` de «${fromPipelineName}»` : ''
  return `⚠️ O lead respondeu, mas a regra "respondeu = ganho"${from} aponta para um funil/etapa que não existe mais — o card NÃO foi marcado como ganho. Peça ao suporte para corrigir a regra.`
}

export interface MaybeWinOnReplyInput {
  accountId: string
  contactId: string
  conversationId: string
  /** Usuário dono do contato — vai como autor do evento e criador do card. */
  actorUserId: string | null
  /** Texto gravado na mensagem (com o rótulo da mídia quando não há texto). */
  contentText: string | null
  /** Clique em botão de modelo/interativo — conta como resposta. */
  interactiveReplyId?: string | null
}

/**
 * Aplica as regras "respondeu = ganho" da conta a uma mensagem do lead.
 * Nunca lança (o inbound não pode cair por causa disso).
 */
export async function maybeWinOnReply(input: MaybeWinOnReplyInput): Promise<void> {
  try {
    // Filtro puro ANTES de ler os ajustes: descadastro/registro de sistema
    // nem custam a consulta.
    if (!isLeadReply(input.contentText, input.interactiveReplyId)) return
    const rules = normalizeReplyWinRules((await getAccountSettings(input.accountId)).replyWinRules)
    if (!rules.length) return
    const touched = new Set<string>()
    for (const rule of rules) {
      try {
        await applyRule(input, rule, touched)
      } catch (err) {
        console.error(`[reply-win] regra ${rule.fromPipelineId} → ${rule.toPipelineId} falhou:`, err)
      }
    }
  } catch (err) {
    console.error('[reply-win] maybeWinOnReply:', err)
  }
}

async function applyRule(
  input: MaybeWinOnReplyInput,
  rule: ReplyWinRule,
  touched: Set<string>,
): Promise<void> {
  const { accountId, contactId, conversationId, actorUserId } = input

  const candidates = await db
    .select({
      id: deals.id,
      conversationId: deals.conversationId,
      createdAt: deals.createdAt,
      pipelineName: pipelines.name,
    })
    .from(deals)
    .innerJoin(pipelines, eq(pipelines.id, deals.pipelineId))
    .where(
      and(
        eq(deals.accountId, accountId),
        eq(deals.contactId, contactId),
        eq(deals.pipelineId, rule.fromPipelineId),
        eq(deals.status, 'open'),
      ),
    )
    .orderBy(sql`${deals.createdAt} DESC NULLS LAST`)
    .limit(MAX_CANDIDATES)
  const deal = pickReplyWinDeal(candidates, conversationId, touched)
  if (!deal) return

  // Destino conferido ANTES de ganhar: com funil/etapa apagados o
  // spawnDealInFunnel devolve null e o lead ficaria com o pré-vendas fechado
  // e nenhum card aberto. Aí não ganha e avisa a equipe.
  const target = firstOrNull(
    await db
      .select({ pipelineName: pipelines.name, stageName: pipelineStages.name })
      .from(pipelineStages)
      .innerJoin(pipelines, eq(pipelines.id, pipelineStages.pipelineId))
      .where(
        and(
          eq(pipelineStages.id, rule.toStageId),
          eq(pipelineStages.pipelineId, rule.toPipelineId),
          eq(pipelines.accountId, accountId),
        ),
      )
      .limit(1),
  )
  if (!target) {
    console.error(
      `[reply-win] destino inexistente na conta ${accountId}: funil ${rule.toPipelineId} › etapa ${rule.toStageId}`,
    )
    // Uma vez por dia por conversa e regra: o card continua aberto, então cada
    // mensagem do lead repetiria o mesmo aviso (revisão de 01/10). Sem Redis
    // (undefined), avisa — melhor repetir que calar.
    const primeira = await claimOnce(`reply-win:broken:${conversationId}:${rule.fromPipelineId}`, 24 * 60 * 60)
    if (primeira !== false) await notify(accountId, conversationId, replyWinBrokenRuleNote(deal.pipelineName))
    return
  }

  // Sem conversationId de propósito: o markDealWonInPlace postaria a nota
  // genérica dele ("Negócio marcado como GANHO") e a nossa sairia repetida.
  // skipAccountAutomation: o destino é o desta regra, não o pós-venda da conta.
  // null = o card já não estava aberto — outra mensagem do mesmo lead chegou
  // junto e ganhou primeiro (o UPDATE … WHERE status='open' só deixa um passar);
  // ela abre o card e move as tarefas, esta não faz mais nada.
  const won = await markDealWonInPlace({
    accountId,
    userId: actorUserId,
    dealId: deal.id,
    by: 'system',
    skipAccountAutomation: true,
  })
  if (!won) return

  const spawned = await spawnDealInFunnel({
    accountId,
    userId: actorUserId,
    sourceDealId: deal.id,
    pipelineId: rule.toPipelineId,
    stageId: rule.toStageId,
    kind: 'won',
    by: 'system',
  })
  if (!spawned) {
    console.error(`[reply-win] card ${deal.id} ganho mas o card de destino não saiu`)
    await notify(
      accountId,
      conversationId,
      replyWinNote({
        fromPipelineName: deal.pipelineName,
        wonStageName: won.stageName,
        toPipelineName: target.pipelineName,
        toStageName: target.stageName,
        spawned: null,
        movedTasks: 0,
      }),
    )
    return
  }
  touched.add(spawned.dealId)

  // O card de destino passa a ser O card desta conversa: a IA e a ficha da
  // conversa acham o card pelo conversation_id. O spawn copia o da origem —
  // card do cadastro sem conversa (lead do RD) nasceria sem, e a IA não o
  // enxergaria. Só preenche vazio: nunca rouba o card de outra conversa.
  try {
    await db
      .update(deals)
      .set({ conversationId })
      .where(
        and(eq(deals.id, spawned.dealId), eq(deals.accountId, accountId), isNull(deals.conversationId)),
      )
  } catch (err) {
    console.error('[reply-win] ligar o card à conversa falhou:', err)
  }

  // Tarefas ABERTAS do card ganho ("Falar com…" do cadastro) vão junto: num
  // card fechado ficariam órfãs na lista de quem vai atender. A CHECK de
  // tasks só tem open/done/cancelled — concluída e cancelada ficam no card
  // ganho como histórico.
  let movedTasks = 0
  try {
    const moved = await db
      .update(tasks)
      .set({ dealId: spawned.dealId, updatedAt: sql`now()` })
      .where(and(eq(tasks.accountId, accountId), eq(tasks.dealId, deal.id), eq(tasks.status, 'open')))
      .returning({ id: tasks.id })
    movedTasks = moved.length
  } catch (err) {
    console.error('[reply-win] mover as tarefas abertas falhou:', err)
  }

  console.log(
    `[reply-win] lead respondeu: card ${deal.id} ganho em "${deal.pipelineName} › ${won.stageName ?? '?'}" → card ${spawned.dealId} (${spawned.created ? 'novo' : 'existente'}) em "${target.pipelineName} › ${target.stageName}"${movedTasks ? `, ${movedTasks} tarefa(s) movida(s)` : ''}`,
  )
  await notify(
    accountId,
    conversationId,
    replyWinNote({
      fromPipelineName: deal.pipelineName,
      wonStageName: won.stageName,
      toPipelineName: target.pipelineName,
      toStageName: target.stageName,
      spawned,
      movedTasks,
    }),
  )
}

/** Nota interna + ping de tempo real: o inbound já publicou a mensagem do
 *  lead ANTES desta nota existir, então sem um 2º ping a nota só apareceria
 *  no F5. `fromMe` = sem som/pop-up (não é mensagem nova do cliente). */
async function notify(accountId: string, conversationId: string, text: string): Promise<void> {
  const ok = await postInternalNote({ conversationId, text })
  if (ok) await publishEvent(accountId, { type: 'message.received', conversationId, fromMe: true })
}

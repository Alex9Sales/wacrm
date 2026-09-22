// ============================================================
// ingestLead — o NÚCLEO de "um lead vira lead de verdade dentro do CRM".
//
// Uma chamada transforma um lead (formulário, anúncio do TikTok, anúncio do
// Meta) em:
//   1. contato (telefone normalizado E.164, dedupe com advisory-lock);
//   2. card/negócio no Kanban (funil+etapa padrão, ou o informado);
//   3. tarefa de follow-up ligada ao contato + card;
//   4. etiquetas úteis (origem/campanha) — unidas às existentes, nunca apaga;
//   5. (opcional) um WhatsApp de abertura num canal — que joga o lead no
//      inbox onde a IA (se ligada no canal) assume quando o lead responder.
//
// É o MESMO caminho do POST /api/v1/leads (que agora chama isto), então um
// lead de anúncio se comporta exatamente como um digitado à mão. Os passos
// 2–5 são BEST-EFFORT: falhar ali nunca perde o contato.
// ============================================================

import { and, desc, eq, gt, ne, sql } from 'drizzle-orm'

import { conversations, db, dealEvents, deals, messages, notifications, tasks } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { pickAssignee } from '@/lib/leads/distribution'
import { normalizeInboundPhoneBR } from '@/lib/whatsapp/phone-utils'
import {
  findOrCreateContact,
  setContactTags,
  loadTagsByContact,
} from '@/lib/api/v1/contacts'
import { firstPipelineOf, firstStageOf } from '@/lib/api/v1/deals'
import { resolveTargetPipeline } from '@/lib/pipelines/default-pipeline'
import { autoCreateStageTasks } from '@/lib/pipelines/stage-tasks'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { sendMessageToConversation } from '@/lib/whatsapp/send-message'
import { splitIntroParts } from '@/lib/leads/intro-parts'

export interface IngestLeadInput {
  /** Telefone cru (será normalizado p/ E.164, ciente do formato BR). */
  rawPhone: string
  name?: string | null
  email?: string | null
  company?: string | null
  /** Bloco de observações já montado (vai pras notas do card + descrição da tarefa). */
  notes?: string | null
  /** Observação pro HISTÓRICO do card (timeline "anotações") — o padrão que o
   *  cliente vê como "observação". undefined = usa `notes`; '' = NÃO gravar
   *  (o chamador cuida do próprio evento, ex.: /diagnostico). */
  historyNote?: string | null
  /**
   * Força criar card NOVO mesmo que o contato já tenha um aberto no funil.
   * Padrão (false) = comportamento RD: anexa ao card existente.
   */
  allowDuplicateDeal?: boolean
  /** Etiquetas a aplicar (unidas às já existentes no contato). */
  tags?: string[]
  /** Funil/etapa de destino (null → primeiro funil/etapa da conta). */
  pipelineId?: string | null
  stageId?: string | null
  /** Sufixo do título da tarefa: `Falar com X — <taskSuffix>`. */
  taskSuffix?: string
  /** Nota padrão do card quando `notes` vem vazio. */
  fallbackNote?: string
  /** WhatsApp de abertura (best-effort). Só dispara se `introText` vier. */
  introText?: string | null
  /**
   * Template aprovado pra abertura. Lead NOVO nunca falou com a gente, então no
   * canal oficial (Meta) não existe janela de 24h aberta e texto livre é
   * recusado — só template chega. Quando o canal exige template e ele vem aqui,
   * é ele que sai; senão cai no `introText` (WAHA não tem janela).
   */
  introTemplate?: { name: string; language?: string | null; params?: string[] } | null
  /** Canal p/ o WhatsApp de abertura (null → resolve automaticamente). */
  channelId?: string | null
  /**
   * Cadência de quem NÃO responde (inscrição automática) — entra logo depois
   * que a abertura SAI. Resposta do lead pausa; a IA segue a conversa. Zelo
   * 18/09: pré-vendas do playbook (1ª..5ª tentativa → Definição → perdido).
   */
  cadenceId?: string | null
  /**
   * Agente de IA DONO da conversa de abertura (conversations.ai_agent_id): ele
   * responde nessa conversa mesmo se o canal não estiver na lista dele. Serve
   * pra abrir o lead por um número "emprestado" sem ligar a IA no número todo
   * (Zelo 18/09: número oficial travado por pagamento na Meta → abertura pelo
   * número de recados, Zélia atende só os leads).
   */
  aiAgentId?: string | null
  /** Origem estruturada do lead (Site/Instagram/Indicação/…) → deals.origin. */
  origin?: string | null
  /** Fonte/detalhe livre (ex.: nome da campanha) → deals.source. */
  source?: string | null
  /** Responsável explícito. Se vazio, usa o rodízio (distribuição automática). */
  assignedTo?: string | null
}

export interface IngestLeadResult {
  contactId: string
  contactCreated: boolean
  dealId: string | null
  taskId: string | null
  tagsApplied: string[]
  whatsappSent: boolean
  /** true = a submissão foi anexada a um card ABERTO que o contato já tinha. */
  dealReused: boolean
}

/** Erro de telefone inválido — o chamador mapeia p/ 400/ignora conforme o caso. */
export class LeadPhoneError extends Error {
  constructor(message = 'Telefone inválido — não foi possível criar o contato') {
    super(message)
    this.name = 'LeadPhoneError'
  }
}

export async function ingestLead(
  accountId: string,
  auditUserId: string,
  input: IngestLeadInput,
): Promise<IngestLeadResult> {
  // 1) Contato — telefone é a chave. Normaliza (corrige o "0 + operadora +
  //    DDD" do BR) antes do find-or-create validar E.164.
  const phone = normalizeInboundPhoneBR(input.rawPhone)
  const name = input.name?.trim() || undefined
  const email = input.email?.trim() || undefined
  const company = input.company?.trim() || undefined

  let contactId: string
  let contactCreated: boolean
  try {
    const c = await findOrCreateContact(accountId, auditUserId, {
      phone,
      name,
      email,
      company,
    })
    contactId = c.id
    contactCreated = c.created
  } catch {
    throw new LeadPhoneError()
  }

  const notes = input.notes?.trim() || null
  const displayName = name || phone
  const fallbackNote = input.fallbackNote || 'Lead.'
  const taskSuffix = input.taskSuffix || 'lead'

  // 2) Card/negócio no Kanban (best-effort).
  let dealId: string | null = null
  /** true = reaproveitamos o card aberto do contato em vez de criar outro. */
  let dealReused = false
  /** true = o lead já foi ganho neste funil e está num card aberto de outro. */
  let leadAdvanced = false
  // Responsável: explícito, senão o rodízio (distribuição automática). Null =
  // rodízio desligado / sem membros → cai sem dono, como antes.
  let assignee: string | null = null
  try {
    // Funil pedido → funil do CANAL que recebe esse lead (migr 0187) → o da
    // conta. Sem isso, todo lead de formulário caía no funil mais antigo.
    const pipelineId =
      (await resolveTargetPipeline({
        accountId,
        preferred: input.pipelineId,
        channelId: input.channelId,
      })) || (await firstPipelineOf(accountId))
    const stageId = pipelineId
      ? input.stageId || (await firstStageOf(pipelineId))
      : null
    if (pipelineId && stageId) {
      // 🔁 TRAVA ANTI-DUPLICADO (padrão RD, pedido do Rafael 01/09): se este
      // contato JÁ tem card ABERTO neste funil, a submissão nova NÃO vira
      // outro card — ela é ANEXADA ao card existente (a observação entra no
      // histórico dele logo abaixo). Sem isso, o mesmo lead preenchendo o
      // formulário 2x virava dois "Lead — Fulano" lado a lado no Kanban.
      // Card ganho/perdido não conta: aí um contato que volta merece card novo.
      const reused = input.allowDuplicateDeal
        ? null
        : firstOrNull(
            await db
              .select({ id: deals.id })
              .from(deals)
              .where(
                and(
                  eq(deals.accountId, accountId),
                  eq(deals.contactId, contactId),
                  eq(deals.pipelineId, pipelineId),
                  eq(deals.status, 'open'),
                ),
              )
              .orderBy(desc(deals.createdAt))
              .limit(1),
          )
      if (reused) {
        dealId = reused.id
        dealReused = true
      } else if (!input.allowDuplicateDeal) {
        // 🧭 LEAD QUE JÁ ANDOU: ganho neste funil há pouco e com card ABERTO em
        // outro (Zelo 18/09: a Zélia marcou a reunião, o card do pré-vendas foi
        // ganho e abriu um em "2. Comercial | Franquia"; uma conversão repetida
        // abriu card NOVO no pré-vendas e mandou a boas-vindas de novo, por
        // outro número). A submissão vira nota no card aberto — sem card,
        // tarefa ou abertura novos.
        const advanced = await findAdvancedDeal(accountId, contactId, pipelineId)
        if (advanced) {
          dealId = advanced
          dealReused = true
          leadAdvanced = true
        }
      }
      assignee =
        input.assignedTo ?? (await pickAssignee(accountId).catch(() => null))
      const inserted = dealReused ? null : firstOrNull(
        await db
          .insert(deals)
          .values({
            userId: auditUserId,
            accountId,
            pipelineId,
            stageId,
            contactId,
            assignedTo: assignee,
            title: `Lead — ${displayName}`,
            value: '0',
            notes: notes || fallbackNote,
            origin: input.origin?.trim() || null,
            source: input.source?.trim() || null,
          })
          .returning({ id: deals.id }),
      )
      if (!dealReused) dealId = inserted?.id ?? null
      // Atividades automáticas da etapa de entrada (best-effort).
      if (dealId) {
        // 📝 Observações do lead → HISTÓRICO do card (timeline "anotações"),
        // padronizado pra TODA origem (API/n8n, anúncio, formulário, chat) —
        // não só despejado no campo Observações. Pedido do Rafael: formulário
        // de fora tem que cair igual ao do CRM.
        const historyText =
          input.historyNote === undefined
            ? notes
            : input.historyNote?.trim() || null
        if (historyText) {
          try {
            const originLabel =
              input.origin?.trim() || input.source?.trim() || 'Formulário'
            await db.insert(dealEvents).values({
              accountId,
              dealId,
              actorUserId: auditUserId,
              type: 'note',
              data: {
                text: leadAdvanced
                  ? `📝 ${originLabel} — NOVA submissão de um lead que já passou do funil de entrada (anexada a este card, sem abrir outro nem reenviar a abertura):\n${historyText}`
                  : dealReused
                    ? `📝 ${originLabel} — NOVA submissão do mesmo lead (anexada a este card):\n${historyText}`
                    : `📝 ${originLabel} — dados do lead:\n${historyText}`,
              },
            })
          } catch (err) {
            console.error('[ingestLead] history note failed:', err)
          }
        }
        try {
          // Card reaproveitado já recebeu as tarefas de entrada quando nasceu
          // (e pode já ter avançado de etapa) — não recria.
          if (!dealReused) {
            await autoCreateStageTasks({ accountId, userId: auditUserId }, dealId, stageId)
          }
        } catch (err) {
          console.error('[ingestLead] autoCreateStageTasks:', err)
        }
        // Distribuição: registra no histórico + notifica o responsável.
        // Card reaproveitado NÃO é redistribuído — ele já tem dono, e trocar
        // por rodízio roubaria o lead de quem já está tocando.
        if (assignee && !dealReused) {
          try {
            await db.insert(dealEvents).values({
              accountId,
              dealId,
              actorUserId: auditUserId,
              type: 'note',
              data: { text: '🎯 Lead distribuído automaticamente (rodízio).' },
            })
            if (assignee !== auditUserId) {
              // Reusa 'deal_transferred' (a CHECK do notifications só aceita
              // tipos conhecidos); o título/corpo dão o sentido de "lead novo".
              await db.insert(notifications).values({
                accountId,
                userId: assignee,
                type: 'deal_transferred',
                dealId,
                contactId,
                actorUserId: auditUserId,
                title: 'Novo lead pra você',
                body: `${displayName} caiu no seu funil.`,
              })
            }
          } catch (err) {
            console.error('[ingestLead] distribution notify failed:', err)
          }
        }
      }
    }
  } catch (err) {
    console.error('[ingestLead] deal create failed:', err)
  }

  // 3) Tarefa de follow-up (best-effort). Card REAPROVEITADO que já tem tarefa
  // aberta não ganha outra: o RD manda 2–3 conversões por lead em minutos (o
  // formulário + "Negociação criada no RD CRM") e um lead ficou com 3 tarefas
  // "Falar com…" iguais (Zelo 18/09).
  let taskId: string | null = null
  // Lead que já andou está com o time: a nota no card basta.
  if (!leadAdvanced) {
    try {
      const openTask =
        dealReused && dealId
          ? firstOrNull(
              await db
                .select({ id: tasks.id })
                .from(tasks)
                .where(and(eq(tasks.dealId, dealId), eq(tasks.status, 'open')))
                .limit(1),
            )
          : null
      const inserted = openTask ? openTask : firstOrNull(
        await db
          .insert(tasks)
          .values({
            accountId,
            title: `Falar com ${displayName} — ${taskSuffix}`,
            description: notes,
            type: 'follow_up',
            status: 'open',
            contactId,
            dealId,
            assignedTo: assignee,
            assigneeIds: assignee ? [assignee] : [],
          })
          .returning({ id: tasks.id }),
      )
      taskId = inserted?.id ?? null
    } catch (err) {
      console.error('[ingestLead] task create failed:', err)
    }
  }

  // 4) Etiquetas (best-effort) — união com as existentes, nunca apaga.
  let tagsApplied: string[] = []
  const wanted = input.tags?.filter(Boolean) ?? []
  if (wanted.length) {
    try {
      const current = contactCreated
        ? []
        : ((await loadTagsByContact([contactId])).get(contactId) ?? []).map(
            (t) => t.name,
          )
      const union = [...new Set([...current, ...wanted])]
      await setContactTags(accountId, auditUserId, contactId, union)
      tagsApplied = wanted
    } catch (err) {
      console.error('[ingestLead] tag apply failed:', err)
    }
  }

  // 5) WhatsApp de abertura (best-effort). Abre o thread no inbox; a IA
  //    (se ligada no canal) assume quando o lead responder.
  let whatsappSent = false
  const introText = input.introText?.trim()
  const introTemplate = input.introTemplate
  if ((introText || introTemplate) && leadAdvanced) {
    console.log(`[ingestLead] abertura pulada: lead já passou do funil de entrada (card ${dealId})`)
  } else if (introText || introTemplate) {
    try {
      // Conversou com a conta nas últimas 12 h, em QUALQUER número? Não recebe
      // abertura — muito menos de outro número (Zelo 18/09: o lead falou com a
      // Zélia pelo número de recados e ganhou a boas-vindas de novo pelo
      // oficial). A checagem de baixo só olha a conversa do número da abertura;
      // esta vem antes pra nem abrir conversa vazia no outro número.
      const talkedRecently = firstOrNull(
        await db
          .select({ conversationId: messages.conversationId })
          .from(messages)
          .innerJoin(conversations, eq(conversations.id, messages.conversationId))
          .where(
            and(
              eq(conversations.accountId, accountId),
              eq(conversations.contactId, contactId),
              eq(messages.isInternal, false),
              gt(messages.createdAt, sql`now() - interval '12 hours'`),
            ),
          )
          .orderBy(desc(messages.createdAt))
          .limit(1),
      )
      if (talkedRecently) {
        // Card NOVO vai pra conversa em que o lead está falando — a IA acha o
        // card pela conversa — se ela ainda não tem outro card aberto.
        if (dealId && !dealReused) {
          const taken = firstOrNull(
            await db
              .select({ id: deals.id })
              .from(deals)
              .where(
                and(
                  eq(deals.accountId, accountId),
                  eq(deals.conversationId, talkedRecently.conversationId),
                  eq(deals.status, 'open'),
                  ne(deals.id, dealId),
                ),
              )
              .limit(1),
          )
          if (!taken) {
            await db
              .update(deals)
              .set({ conversationId: talkedRecently.conversationId })
              .where(and(eq(deals.id, dealId), eq(deals.accountId, accountId)))
          }
        }
        console.log(`[ingestLead] abertura pulada: contato ${contactId} conversou com a conta nas últimas 12 h`)
        return { contactId, contactCreated, dealId, taskId, tagsApplied, whatsappSent, dealReused }
      }
      const resolved = await resolveConversationByPhone(
        accountId,
        phone,
        name ?? null,
        input.channelId ?? null,
      )
      // Lead que converte de novo em minutos (RD manda 1 evento por conversão)
      // recebia a abertura DE NOVO — Zelo 18/09: Alexandre ganhou 2 às 07:11 e
      // 07:13. Se já saiu qualquer coisa nossa pra essa conversa nas últimas
      // 12 h (inclusive envio que falhou — repetir não conserta), não repete.
      const recentOutbound = firstOrNull(
        await db
          .select({ id: messages.id })
          .from(messages)
          .where(
            and(
              eq(messages.conversationId, resolved.conversationId),
              ne(messages.senderType, 'customer'),
              eq(messages.isInternal, false),
              gt(messages.createdAt, sql`now() - interval '12 hours'`),
            ),
          )
          .limit(1),
      )
      if (recentOutbound) {
        console.log(
          `[ingestLead] abertura pulada: conversa ${resolved.conversationId} já teve envio nas últimas 12 h`,
        )
        return { contactId, contactCreated, dealId, taskId, tagsApplied, whatsappSent, dealReused }
      }
      // Dono da conversa só quando a abertura vai sair de fato — conversa em
      // que alguém da equipe falou nas últimas 12 h não é tomada pela IA.
      if (input.aiAgentId) {
        await db
          .update(conversations)
          .set({ aiAgentId: input.aiAgentId })
          .where(eq(conversations.id, resolved.conversationId))
      }
      // O card segue a conversa da abertura. A IA acha o card PELA CONVERSA
      // (deals.conversation_id: etapas no prompt, [[FUNIL:]], [[PERDER:]],
      // agendamento) — card de lead nascia sem conversa e a IA nunca o via
      // (Zelo 18/09: Zélia não movia nem perdia nenhum lead do RD).
      if (dealId) {
        await db
          .update(deals)
          .set({ conversationId: resolved.conversationId })
          .where(and(eq(deals.id, dealId), eq(deals.accountId, accountId)))
      }
      // Template primeiro quando houver: lead novo nunca falou com a gente, e
      // no canal oficial texto livre é RECUSADO pela Meta fora da janela de 24h
      // — que, pra quem nunca escreveu, está sempre fechada. Se o canal não
      // trabalha com template (WAHA), a tentativa falha e o texto assume.
      if (introTemplate?.name) {
        try {
          await sendMessageToConversation(accountId, {
            conversationId: resolved.conversationId,
            messageType: 'template',
            templateName: introTemplate.name,
            templateLanguage: introTemplate.language || 'pt_BR',
            templateParams: introTemplate.params ?? [],
          })
          whatsappSent = true
        } catch (err) {
          console.error('[ingestLead] template de abertura falhou:', err)
        }
      }
      if (!whatsappSent && introText) {
        // "Dá uma quebrada, tá grande" (Alex 18/09): linha "---" separa a
        // abertura em mensagens curtas, com uma pausa pra chegar em ordem.
        for (const [i, part] of splitIntroParts(introText).entries()) {
          if (i > 0) await new Promise((r) => setTimeout(r, 1500))
          await sendMessageToConversation(accountId, {
            conversationId: resolved.conversationId,
            messageType: 'text',
            contentText: part,
          })
          whatsappSent = true
        }
      }
      // 🔁 Cadência de quem não responde: começa depois que a abertura SAIU.
      // Automática = ninguém vira responsável (a IA segue dona da conversa) e
      // nada sai de madrugada. Falha aqui não desfaz a abertura.
      if (whatsappSent && input.cadenceId) {
        try {
          const { enrollContactInCadence } = await import('@/lib/cadences/cadence')
          const r = await enrollContactInCadence(
            { accountId, userId: auditUserId },
            {
              cadenceId: input.cadenceId,
              contactId,
              conversationId: resolved.conversationId,
              dealId,
            },
            { automatic: true },
          )
          if (!r.ok) console.error('[ingestLead] cadência não começou:', r.error)
        } catch (err) {
          console.error('[ingestLead] cadência falhou:', err)
        }
      }
    } catch (err) {
      console.error('[ingestLead] intro whatsapp failed:', err)
    }
  }

  return { contactId, contactCreated, dealId, taskId, tagsApplied, whatsappSent, dealReused }
}

/**
 * Card ABERTO em outro funil de um lead GANHO neste funil nos últimos 30 dias
 * — o lead já andou (ex.: pré-vendas → comercial). null = não andou.
 */
async function findAdvancedDeal(
  accountId: string,
  contactId: string,
  pipelineId: string,
): Promise<string | null> {
  const wonHere = firstOrNull(
    await db
      .select({ id: deals.id })
      .from(deals)
      .where(
        and(
          eq(deals.accountId, accountId),
          eq(deals.contactId, contactId),
          eq(deals.pipelineId, pipelineId),
          eq(deals.status, 'won'),
          gt(deals.updatedAt, sql`now() - interval '30 days'`),
        ),
      )
      .limit(1),
  )
  if (!wonHere) return null
  const openElsewhere = firstOrNull(
    await db
      .select({ id: deals.id })
      .from(deals)
      .where(
        and(
          eq(deals.accountId, accountId),
          eq(deals.contactId, contactId),
          ne(deals.pipelineId, pipelineId),
          eq(deals.status, 'open'),
        ),
      )
      .orderBy(desc(deals.createdAt))
      .limit(1),
  )
  return openElsewhere?.id ?? null
}

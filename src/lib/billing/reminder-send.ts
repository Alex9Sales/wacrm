// ============================================================
// 📨 Enviar o lembrete DEIXANDO RASTRO (29/09).
//
// Mora fora do worker de propósito: o botão "Enviar lembrete" do /admin usa o
// mesmo caminho. Antes os dois chamavam provider.sendText direto e o resultado
// era o mesmo buraco nos dois lugares.
// Sem 'server-only' — o worker alcança este arquivo.
// ============================================================

import { and, desc, eq } from 'drizzle-orm'

import { db, member, messageTemplates, messages as messagesTable } from '@/db'
import { firstOrNull } from '@/db/helpers'
import type { ChannelCtx } from '@/lib/channels/provider'
import { getProvider } from '@/lib/channels/registry'

/**
 * Envia o lembrete DENTRO de uma conversa do CRM (29/09) — e cai para o envio
 * direto se não der.
 *
 * Por que isto importa: antes o lembrete saía por `provider.sendText`, que fala
 * com a Meta e pronto. A Meta aceitava e devolvia um id, mas esse id não era
 * guardado em lugar nenhum — então a mensagem não aparecia na conversa, o
 * webhook de status (entregue/lido) não tinha onde pousar, e a única prova de
 * que algo saiu era uma linha de log. O Alex perguntou "por que não dá para
 * saber se foi enviado?" e a resposta era essa: dava para saber que a Meta
 * aceitou, não que o cliente recebeu.
 *
 * Mandando pela conversa, o lembrete vira uma mensagem como qualquer outra:
 * aparece no histórico do cliente, recebe os ticks de entrega e pode ser
 * respondida — o que também abre a janela de 24h para a conversa seguinte.
 *
 * O fallback existe porque lembrete de cobrança não pode deixar de sair por
 * causa de um contato que não pôde ser criado. Mas ele AVISA no log qual
 * caminho foi usado, para que "não achei a mensagem" tenha resposta.
 */
/**
 * O template aprovado de cada degrau (29/09).
 *
 * Os três existem na conta da Fluxia, APROVADOS pela Meta, desde antes deste
 * código — e nunca foram usados: o lembrete sempre mandou texto livre. Fora da
 * janela de 24 h a Meta recusa texto livre, e foi assim que o lembrete da Appia
 * falhou no próprio dia do vencimento. O corpo de cada um repete palavra por
 * palavra o texto livre do degrau, com {{1}} nome, {{2}} valor, {{3}} dia.
 */
const TEMPLATE_POR_DEGRAU: Record<number, string> = {
  [-5]: 'fluxia_mensalidade_5_dias',
  0: 'fluxia_mensalidade_vence_hoje',
  3: 'fluxia_mensalidade_em_aberto',
  // 99 = "obrigado pelo pagamento" (29/09). Não é degrau de lembrete: entra
  // aqui para reusar o mesmo caminho — conversa, janela de 24 h, template
  // quando ela está fechada.
  99: 'fluxia_pagamento_recebido',
}

/**
 * A versão COM o botão "Pagar agora" (29/09). Mesmo corpo, mais um botão de URL
 * dinâmica: `https://www.asaas.com/i/{{1}}`, onde {{1}} é o id da cobrança sem
 * o prefixo `pay_` — que é exatamente como o Asaas monta o invoiceUrl:
 *
 *   cobrança  pay_govlijjcptmio2y8
 *   link      https://www.asaas.com/i/govlijjcptmio2y8
 *
 * Preferido sempre que existir APROVADO e o cliente tiver cobrança em aberto.
 * Enquanto a Meta não aprovar, ou quando não há cobrança aberta para apontar,
 * cai no template sem botão — que continua saindo. Assim isto entra no ar antes
 * da aprovação sem depender dela.
 */
const TEMPLATE_COM_LINK: Record<number, string> = {
  [-5]: 'fluxia_mensalidade_5_dias_link',
  0: 'fluxia_mensalidade_vence_hoje_link',
  3: 'fluxia_mensalidade_em_aberto_link',
}

/** Quantas variáveis o corpo de cada degrau realmente tem. */
const VARIAVEIS_POR_DEGRAU: Record<number, number> = { [-5]: 3, 0: 2, 3: 3, 99: 2 }

/** Os params na medida do template — nem a mais (a Meta recusa), nem a menos. */
export function paramsDoDegrau(step: number, params: string[]): string[] {
  return params.slice(0, VARIAVEIS_POR_DEGRAU[step] ?? params.length)
}

/** O sufixo que o botão dinâmico recebe: o id da fatura, sem a URL. */
export function idDaFatura(invoiceUrl: string | null | undefined): string | null {
  const u = (invoiceUrl ?? '').trim()
  if (!u) return null
  const caminho = u.split(/[?#]/)[0].replace(/\/+$/, '') // sem query, âncora, barra final
  const fim = caminho.split('/').pop() ?? ''
  // O id do Asaas é alfanumérico e longo. Sem ponto de propósito: "asaas.com"
  // também é o último pedaço de "https://www.asaas.com/" e não é id nenhum.
  return /^[A-Za-z0-9_-]{8,}$/.test(fim) ? fim : null
}

/** O template existe e está APROVADO nesta conta? */
async function templateAprovado(accountId: string, nome: string): Promise<boolean> {
  if (!nome) return false
  const row = firstOrNull(
    await db
      .select({ id: messageTemplates.id })
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.accountId, accountId),
          eq(messageTemplates.name, nome),
          eq(messageTemplates.status, 'APPROVED'),
        ),
      )
      .limit(1),
  )
  return !!row
}

/** O template com botão existe e está aprovado nesta conta? */
async function templateComLinkAprovado(
  accountId: string,
  nome: string,
): Promise<boolean> {
  const row = firstOrNull(
    await db
      .select({ id: messageTemplates.id })
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.accountId, accountId),
          eq(messageTemplates.name, nome),
          eq(messageTemplates.status, 'APPROVED'),
        ),
      )
      .limit(1),
  )
  return !!row
}

export interface TemplateDoLembrete {
  step: number
  /**
   * {{1}} nome, {{2}} valor, {{3}} dia.
   *
   * ⚠️ O degrau 0 ("vence hoje") tem SÓ DUAS: o corpo dele diz "vence hoje" e
   * não repete a data. Mandar três faz a Meta recusar com "Invalid parameter"
   * — foi assim que a submissão do template falhou, e seria assim que o envio
   * falharia depois. `paramsDoDegrau` corta pelo tamanho certo.
   */
  params: [string, string, string]
  /** invoiceUrl da cobrança em aberto — vira o botão "Pagar agora". */
  invoiceUrl?: string | null
}

export async function enviarRegistrando(
  channel: ChannelCtx,
  provider: ReturnType<typeof getProvider>,
  fone: string,
  texto: string,
  nomeCliente: string,
  tpl?: TemplateDoLembrete,
): Promise<string> {
  try {
    const { findOrCreateContact } = await import('@/lib/api/v1/contacts')
    const { findOrCreateConversation } = await import('@/lib/channels/inbound')
    const { sendMessageToConversation } = await import('@/lib/whatsapp/send-message')

    const dono = await ownerUserIdOf(channel.accountId)
    if (!dono) throw new Error('conta do canal sem usuário para auditoria')

    const contato = await findOrCreateContact(channel.accountId, dono, {
      phone: `+${fone}`,
      name: nomeCliente,
    })
    const conv = await findOrCreateConversation(
      channel.accountId,
      dono,
      contato.id,
      channel.id,
    )
    if (!conv) throw new Error('conversa não resolvida')

    // Janela de 24 h: dentro dela vai texto livre (lê melhor e aceita link);
    // fora dela a Meta SÓ aceita template aprovado. A regra é a mesma das
    // cadências — uma função, um critério.
    const { cadenceSendMode } = await import('@/lib/cadences/schedule-rules')
    const templateName = tpl ? TEMPLATE_POR_DEGRAU[tpl.step] : undefined
    const ultimaEntrada = firstOrNull(
      await db
        .select({ at: messagesTable.createdAt })
        .from(messagesTable)
        .where(
          and(
            eq(messagesTable.conversationId, conv.conversation.id),
            eq(messagesTable.senderType, 'customer'),
          ),
        )
        .orderBy(desc(messagesTable.createdAt))
        .limit(1),
    )
    const modo = cadenceSendMode({
      channelTakesTemplates: channel.provider === 'meta',
      templateName,
      lastInboundAt: ultimaEntrada?.at ?? null,
    })

    // ⚠️ Janela fechada + template não aprovado = não há como falar com ele.
    // Tentar texto livre aqui só produz uma recusa da Meta e um log confuso —
    // foi o que aconteceu no primeiro teste do agradecimento, cujo template
    // ainda estava PENDING. Melhor dizer que não deu e por quê.
    if (modo === 'template' && templateName) {
      const usavel = await templateAprovado(channel.accountId, templateName)
      const comLinkOk = tpl
        ? await templateAprovado(channel.accountId, TEMPLATE_COM_LINK[tpl.step] ?? '')
        : false
      if (!usavel && !comLinkOk) {
        console.warn(
          `[reminder-send] janela de 24 h fechada e nenhum template aprovado (${templateName}) — nada enviado a ${nomeCliente}`,
        )
        return `não enviado (sem template aprovado: ${templateName})`
      }
    }

    if (modo === 'template' && templateName && tpl) {
      // Prefere a versão com "Pagar agora" quando ela existe aprovada E há uma
      // cobrança para apontar. Botão que leva a lugar nenhum é pior que ausência
      // de botão: o cliente clica, não acontece nada, e a mensagem perde a fé.
      const fatura = idDaFatura(tpl.invoiceUrl)
      const comLink = TEMPLATE_COM_LINK[tpl.step]
      if (fatura && comLink && (await templateComLinkAprovado(channel.accountId, comLink))) {
        await sendMessageToConversation(channel.accountId, {
          conversationId: conv.conversation.id,
          messageType: 'template',
          templateName: comLink,
          templateLanguage: 'pt_BR',
          templateMessageParams: {
            body: paramsDoDegrau(tpl.step, tpl.params),
            buttonParams: { 0: fatura },
          },
        })
        return `por template com link (${comLink})`
      }
      await sendMessageToConversation(channel.accountId, {
        conversationId: conv.conversation.id,
        messageType: 'template',
        templateName,
        templateLanguage: 'pt_BR',
        templateParams: paramsDoDegrau(tpl.step, tpl.params),
      })
      return `por template (${templateName})`
    }

    await sendMessageToConversation(channel.accountId, {
      conversationId: conv.conversation.id,
      messageType: 'text',
      contentText: texto,
    })
    return 'na conversa'
  } catch (err) {
    console.warn(
      `[billing-reminders] não consegui registrar na conversa (${
        err instanceof Error ? err.message : 'erro'
      }) — mandando direto pelo canal.`,
    )
    await provider.sendText(channel, fone, texto)
    return 'direto pelo canal (sem registro na conversa)'
  }
}

/** Um usuário da conta do canal, só para assinar a criação do contato. */
async function ownerUserIdOf(accountId: string): Promise<string | null> {
  const row = firstOrNull(
    await db
      .select({ userId: member.userId })
      .from(member)
      .where(eq(member.organizationId, accountId))
      .limit(1),
  )
  return row?.userId ?? null
}


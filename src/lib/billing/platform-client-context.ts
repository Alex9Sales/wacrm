// ============================================================
// 🔑 Cliente do FluxiaCRM com a conta suspensa escrevendo para a Fluxia.
//
// 30/09/2026. A trava de inadimplência suspende a conta no dia seguinte ao
// vencimento, e a tela de suspensão manda o cliente falar com o time pelo
// (67) 9180-6048 — o WhatsApp da própria Fluxia, atendido por IA. O Alex pediu
// que, quando esse cliente escrever, o agente "entenda a situação, pegue o link
// e envie".
//
// Prompt sozinho não faz isso: o agente não tem de onde tirar o link. As
// ferramentas do Asaas do Agente de Cobrança dependem do id do cliente vir no
// contexto, e esse id só chega pela carteira de Cobranças — que só espelha
// fatura VENCIDA, cadastrada no Asaas da Fluxia por um caminho que não casa
// com a assinatura. No dia em que o João seria suspenso, a fatura dele não
// estava na carteira.
//
// Aqui o CRM resolve direto: o telefone de quem escreve bate com o telefone de
// cobrança de alguma conta suspensa? Então o agente recebe a situação e o link,
// gravado no momento da suspensão (suspend_invoice_url).
//
// ⚠️ SÓ na conta da própria Fluxia — a dona do canal de cobrança da plataforma
// (PLATFORM_BILLING_CHANNEL_ID). Em qualquer outra conta isto devolve null sem
// nem consultar: é dado do NOSSO faturamento, e não pode vazar para o prompt do
// agente de um cliente.
//
// Sem 'server-only': roda no worker da IA.
// ============================================================

import { and, eq, isNull, sql } from 'drizzle-orm'

import { db, channels, contacts, organization, organizationBilling } from '@/db'
import { firstOrNull } from '@/db/helpers'

/** Conta dona do canal de cobrança da plataforma — a própria Fluxia. Em memória: não muda. */
let contaDaPlataforma: string | null | undefined

async function idDaContaDaPlataforma(): Promise<string | null> {
  if (contaDaPlataforma !== undefined) return contaDaPlataforma
  const canal = process.env.PLATFORM_BILLING_CHANNEL_ID?.trim()
  if (!canal) {
    contaDaPlataforma = null
    return null
  }
  const row = firstOrNull(
    await db.select({ accountId: channels.accountId }).from(channels).where(eq(channels.id, canal)).limit(1),
  )
  contaDaPlataforma = row?.accountId ?? null
  return contaDaPlataforma
}

/** Os 8 últimos dígitos — o que sobrevive a 55, DDD e 9º dígito. */
function chaveDoTelefone(fone: string | null | undefined): string | null {
  const d = (fone ?? '').replace(/\D/g, '')
  return d.length >= 8 ? d.slice(-8) : null
}

const dataBr = (iso: string | null) => {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10).split('-').reverse().join('/')
}

export type ContaSuspensa = {
  nome: string
  plano: string | null
  valorMensal: string | null
  vencimento: string | null
  suspensaEm: string | null
  motivo: string | null
  link: string | null
}

/**
 * O bloco que vai para o prompt do agente. Separado da busca para ser testado.
 *
 * Fala ao agente em português e em passos: a decisão de o que dizer é dele, mas
 * o link e os números vêm daqui e não podem ser trocados.
 */
export function textoContaSuspensa(contas: ContaSuspensa[]): string | null {
  if (contas.length === 0) return null
  const blocos = contas.map((c) => {
    if (c.motivo === 'inadimplencia' && c.link) {
      return [
        `CONTA DO FLUXIACRM SUSPENSA POR FALTA DE PAGAMENTO — "${c.nome}".`,
        `Quem está escrevendo é o responsável financeiro dessa conta. O acesso ao CRM foi pausado` +
          (c.suspensaEm ? ` em ${c.suspensaEm}` : '') +
          ` porque a mensalidade` +
          (c.plano ? ` do plano ${c.plano}` : '') +
          (c.valorMensal ? ` (R$ ${Number(c.valorMensal).toFixed(2).replace('.', ',')})` : '') +
          (c.vencimento ? ` venceu em ${c.vencimento}` : ' venceu') +
          ` e o pagamento ainda não foi identificado.`,
        `Link para regularizar: ${c.link}`,
      ].join('\n')
    }
    return [
      `CONTA DO FLUXIACRM SUSPENSA — "${c.nome}".`,
      `Quem está escrevendo é o responsável por essa conta. Ela foi suspensa pelo time da Fluxia (não foi pela mensalidade). Você não tem o motivo nem como liberar: passe para um humano.`,
    ].join('\n')
  })
  return [
    ...blocos,
    '',
    'COMO ATENDER (vale acima de qualquer outra regra sobre transferir este assunto):',
    '1. Se a pessoa falar de acesso bloqueado, conta suspensa, não conseguir entrar, mensalidade ou pagamento, resolva AQUI, sem passar para outro agente.',
    '2. Explique em uma frase, sem tom de acusação: o acesso foi pausado porque a mensalidade venceu e o pagamento não foi identificado.',
    '3. Envie o link acima, escrito exatamente como está. Ele abre a fatura com Pix, boleto e cartão — é tudo de que a pessoa precisa para resolver.',
    '4. Diga que o acesso volta sozinho quando o pagamento for confirmado: pelo Pix, em poucos minutos; pelo boleto, quando o banco compensar (até 3 dias úteis). Se já pagou o boleto, não pague de novo.',
    '5. Se a pessoa disser que já pagou pelo Pix há mais de 1 hora e o acesso não voltou, ou se quiser negociar prazo, valor ou desconto: não prometa nada, passe para um humano.',
    '6. Se a mensagem for sobre outro assunto, responda o assunto e, no fim, lembre com delicadeza que a conta está pausada e ofereça o link.',
    'Nunca invente valor, data ou link diferentes dos que estão acima. Nunca diga que liberou o acesso: quem libera é a confirmação do pagamento.',
  ].join('\n')
}

/**
 * Se quem escreve é o telefone de cobrança de uma conta SUSPENSA do FluxiaCRM,
 * devolve o bloco para o prompt. Senão, null — inclusive em qualquer conta que
 * não seja a da própria Fluxia.
 */
export async function contextoDeContaSuspensa(
  accountId: string,
  contactId: string | null,
): Promise<string | null> {
  if (!contactId) return null
  const plataforma = await idDaContaDaPlataforma()
  if (!plataforma || plataforma !== accountId) return null

  const contato = firstOrNull(
    await db
      .select({ phone: contacts.phone })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .limit(1),
  )
  const chave = chaveDoTelefone(contato?.phone)
  if (!chave) return null

  const rows = await db
    .select({
      nome: organization.name,
      plano: organizationBilling.plan,
      valorMensal: organizationBilling.monthlyValue,
      vencimento: organizationBilling.dueAt,
      suspensaEm: organizationBilling.suspendedAt,
      motivo: organizationBilling.suspendReason,
      link: organizationBilling.suspendInvoiceUrl,
    })
    .from(organizationBilling)
    .innerJoin(organization, eq(organization.id, organizationBilling.organizationId))
    .where(
      and(
        eq(organizationBilling.status, 'suspended'),
        isNull(organizationBilling.deletedAt),
        sql`right(regexp_replace(coalesce(${organizationBilling.billingPhone}, ''), '\\D', '', 'g'), 8) = ${chave}`,
      ),
    )
    .limit(3)

  return textoContaSuspensa(
    rows.map((r) => ({
      ...r,
      vencimento: dataBr(r.vencimento),
      suspensaEm: dataBr(r.suspensaEm),
    })),
  )
}

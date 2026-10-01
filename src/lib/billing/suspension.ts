// ============================================================
// 🔒 Trava por inadimplência — as regras, sem banco e sem Asaas.
//
// 30/09/2026. A regra é a do Rafael, que o Alex confirmou: "venceu, não
// debitou, tchau". Não há dias de tolerância: venceu e não pagou, no dia
// seguinte a conta é suspensa, e a tela mostra como regularizar e o contato do
// time. Pagou → libera sozinho.
//
// (A primeira versão dava 5 dias de tolerância. O Alex abortou: tolerância é o
// que ensina o cliente a atrasar.)
//
// "Venceu" = passou o dia do vencimento. Vencimento numa terça (30/09) suspende
// na quarta (01/10) — no horário comercial, ver suspension-run.ts.
//
// ⚠️ A data é a de São Paulo, não a de UTC. A rotina roda de hora em hora; às
// 22h do dia do vencimento em Brasília já é o dia seguinte em UTC, e uma conta
// em UTC suspenderia a pessoa no próprio dia em que a fatura vence.
//
// Esta camada só decide pelo CALENDÁRIO. Quem suspende de verdade é
// suspension-run.ts, e só depois de confirmar no Asaas que a cobrança daquele
// vínculo está mesmo vencida e não paga — o banco pode estar atrasado em
// relação ao pagamento (webhook perdido, boleto compensando).
// ============================================================

/**
 * Dias de tolerância depois do vencimento. ZERO: venceu, no dia seguinte
 * suspende. Ficou como constante porque a regra é de negócio e pode mudar —
 * os testes descrevem o comportamento em função dela.
 */
export const DIAS_DE_TOLERANCIA = 0

/** Fuso em que "o dia" é contado. A operação é brasileira. */
export const FUSO_DA_TRAVA = 'America/Sao_Paulo'

/** 'AAAA-MM-DD' de um instante, no fuso da operação. */
export function dataLocal(instante: Date, fuso = FUSO_DA_TRAVA): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instante)
}

/**
 * Dias de atraso, contados por DATA de calendário em São Paulo.
 *
 * O vencimento chega de dois jeitos no banco: meia-noite UTC (o PATCH do
 * /admin grava '2026-10-01' como 2026-10-01T00:00Z, que em SP é 30/09 21h) ou
 * meio-dia UTC (a rota de assinatura e o webhook gravam T12:00Z). Os dois
 * querem dizer "vence dia 01/10". Por isso o vencimento é lido pela DATA UTC —
 * que é a data que alguém digitou —, e o "hoje" pela data de São Paulo.
 *
 * Negativo = ainda não venceu. 0 = vence hoje. 6 = 6º dia de atraso.
 */
export function diasDeAtraso(dueAtIso: string, agora: Date): number {
  const venc = new Date(dueAtIso)
  if (Number.isNaN(venc.getTime())) return NaN
  const vencData = venc.toISOString().slice(0, 10)
  const hojeData = dataLocal(agora)
  const ms = Date.parse(`${hojeData}T00:00:00Z`) - Date.parse(`${vencData}T00:00:00Z`)
  return Math.round(ms / 86_400_000)
}

export type CandidatoTrava = {
  status: string
  dueAt: string | null
  cancelAt: string | null
  deletedAt: string | null
  /** Vínculo com o Asaas: sem ele não há como confirmar a dívida. */
  asaasSubscriptionId: string | null
  asaasPaymentId: string | null
}

export type DecisaoCalendario =
  | { suspender: false; motivo: string }
  | { suspender: true; diasDeAtraso: number }

/**
 * Pelo calendário, esta conta já entrou na zona de suspensão?
 *
 * É um PRÉ-FILTRO: diz "vale a pena perguntar ao Asaas". Nunca suspende sozinho.
 *
 * Só entra conta ativa, ligada ao Asaas, sem cancelamento e sem exclusão.
 * ⚠️ A exigência do vínculo não é detalhe: das 13 contas ativas em 30/09, só 2
 * tinham assinatura no Asaas — as outras têm vencimento digitado à mão no
 * /admin. Sem o vínculo, suspenderíamos quem paga por fora (Pix direto,
 * acordo, cortesia) só porque o campo de vencimento ficou para trás.
 */
export function decideCalendario(c: CandidatoTrava, agora: Date): DecisaoCalendario {
  if (c.deletedAt) return { suspender: false, motivo: 'excluída' }
  if (c.status !== 'active') return { suspender: false, motivo: `status ${c.status}` }
  if (c.cancelAt) return { suspender: false, motivo: 'cancelamento agendado' }
  if (!c.asaasSubscriptionId && !c.asaasPaymentId) {
    return { suspender: false, motivo: 'sem cobrança no Asaas' }
  }
  if (!c.dueAt) return { suspender: false, motivo: 'sem vencimento' }
  const dias = diasDeAtraso(c.dueAt, agora)
  if (Number.isNaN(dias)) return { suspender: false, motivo: 'vencimento inválido' }
  if (dias <= DIAS_DE_TOLERANCIA) return { suspender: false, motivo: `${dias} dia(s) de atraso` }
  return { suspender: true, diasDeAtraso: dias }
}

/** O que o Asaas disse sobre a cobrança daquele vínculo. */
export type SituacaoNoAsaas =
  | { tipo: 'vencida'; dueDate: string; invoiceUrl: string | null; paymentId: string }
  | { tipo: 'paga' }
  | { tipo: 'nada_em_aberto' }

/**
 * Com a resposta do Asaas em mãos: suspende ou não?
 *
 * Só suspende quando o Asaas confirma uma cobrança VENCIDA cujo vencimento
 * também está além da tolerância. O vencimento do banco pode estar errado
 * (digitado à mão, ou não avançado porque o webhook se perdeu) — o do Asaas é
 * a fonte da verdade.
 */
export function decideComAsaas(
  situacao: SituacaoNoAsaas,
  agora: Date,
  /**
   * Quando um admin religou à mão uma conta que a trava tinha suspendido. A
   * fatura que motivou aquela suspensão continua vencida no Asaas — e sem isto
   * a trava suspenderia de novo na hora seguinte, desmentindo o botão "Ligar".
   * A liberação vale para as faturas vencidas ATÉ aquele dia; uma fatura nova,
   * de outro mês, volta a contar.
   */
  liberadaEm: string | null = null,
): { suspender: boolean; motivo: string } {
  if (situacao.tipo === 'paga') {
    return { suspender: false, motivo: 'pago no Asaas — o banco está atrasado (webhook perdido?)' }
  }
  if (situacao.tipo === 'nada_em_aberto') {
    return { suspender: false, motivo: 'nenhuma cobrança vencida nesse vínculo' }
  }
  if (liberadaEm) {
    const liberacao = new Date(liberadaEm)
    if (!Number.isNaN(liberacao.getTime()) && situacao.dueDate <= dataLocal(liberacao)) {
      return {
        suspender: false,
        motivo: `liberada à mão pelo admin em ${dataLocal(liberacao)}, depois desta fatura (${situacao.dueDate})`,
      }
    }
  }
  const dias = diasDeAtraso(`${situacao.dueDate}T12:00:00Z`, agora)
  if (Number.isNaN(dias) || dias <= DIAS_DE_TOLERANCIA) {
    return { suspender: false, motivo: `a vencida mais antiga tem ${dias} dia(s) — dentro da tolerância` }
  }
  return { suspender: true, motivo: `fatura vencida em ${situacao.dueDate}, ${dias} dias de atraso` }
}

/**
 * O que gravar nas colunas de suspensão quando o STATUS muda por fora da trava
 * (o /admin: "Ligar", "Desligar", "Reativar", ou o Salvar do editar cobrança).
 *
 * ⚠️ O modal de editar cobrança manda o status em TODO salvamento. Por isso nada
 * aqui reage ao status repetido — só à TRANSIÇÃO. Gravar 'manual' a cada
 * Salvar apagaria o link "Pagar agora" de quem foi suspenso pela trava.
 */
export function camposAoMudarStatus(
  anterior: { status: string | null; suspendReason: string | null },
  novo: string,
  agora: Date,
): {
  suspendedAt?: string | null
  suspendReason?: string | null
  suspendInvoiceUrl?: string | null
} {
  if (anterior.status === novo) return {}
  if (novo === 'suspended') {
    // Suspensão manual: texto genérico na tela, sem botão de pagar.
    return { suspendedAt: agora.toISOString(), suspendReason: 'manual', suspendInvoiceUrl: null }
  }
  if (anterior.status === 'suspended' && anterior.suspendReason === 'inadimplencia') {
    // Admin liberou quem a trava tinha suspendido. Fica a MARCA da liberação
    // (data em suspended_at) para a trava não desfazer a decisão na hora
    // seguinte. O próximo pagamento confirmado limpa tudo (webhook).
    return { suspendedAt: agora.toISOString(), suspendReason: 'liberada_manual', suspendInvoiceUrl: null }
  }
  if (anterior.status === 'suspended') {
    return { suspendedAt: null, suspendReason: null, suspendInvoiceUrl: null }
  }
  return {}
}

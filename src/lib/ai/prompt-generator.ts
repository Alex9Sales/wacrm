// ============================================================
// 🪄 Gerador de instruções do agente — 3 perguntas viram um prompt
// estruturado (comportamento + processo + regras de transferência), no
// padrão em camadas do produto: fatos (preços, produtos, políticas) ficam
// no Perfil/Catálogo/Bases; aqui vai só COMO o agente age. Templates
// determinísticos (sem custo de IA, instantâneo); o texto sai editável.
// Puro e sem I/O — testável e importável de qualquer lado.
// ============================================================

export type AgentFunction =
  | 'vendas'
  | 'sdr'
  | 'suporte'
  | 'cobranca'
  | 'agendamento'
  | 'personalizado'

export type AgentTone = 'amigavel' | 'profissional' | 'direto' | 'consultivo'

export interface HandoffRules {
  pedirHumano: boolean
  reclamacao: boolean
  naoSouber: boolean
  negociacaoEspecial: boolean
  risco: boolean
}

export interface GeneratorInput {
  /** Nome do agente (ex.: "Maria"). Vazio → sem persona nomeada. */
  nome: string
  funcao: AgentFunction
  tone: AgentTone
  handoff: HandoffRules
}

export const FUNCTION_LABELS: Record<AgentFunction, string> = {
  vendas: 'Atendimento e vendas',
  sdr: 'SDR (qualificar e agendar)',
  suporte: 'Suporte ao cliente',
  cobranca: 'Cobrança',
  agendamento: 'Agendamento',
  personalizado: 'Personalizado',
}

export const TONE_LABELS: Record<AgentTone, string> = {
  amigavel: 'Amigável',
  profissional: 'Profissional',
  direto: 'Direto ao ponto',
  consultivo: 'Consultivo',
}

const TONE_LINES: Record<AgentTone, string> = {
  amigavel:
    '- Fale de forma leve e calorosa, como uma pessoa de verdade — pode usar emoji com moderação.',
  profissional:
    '- Mantenha um tom cordial e profissional, sem gírias e sem emoji.',
  direto:
    '- Seja objetiva: frases curtas, zero enrolação, direto ao que o cliente precisa.',
  consultivo:
    '- Aja como consultora: entenda o cenário do cliente antes de indicar o caminho, explique o porquê das recomendações.',
}

/** Missão + processo específicos de cada função. */
const FUNCTION_BLOCKS: Record<AgentFunction, { missao: string; processo: string }> = {
  vendas: {
    missao:
      'Seu objetivo é atender clientes, entender o que eles precisam, conduzir naturalmente até o fechamento e manter o CRM organizado.',
    processo: `PROCESSO DE VENDA

- Quando perguntarem preço, informe o valor do Catálogo e conduza direto pro fechamento: peça os dados que faltam (ex.: endereço e forma de pagamento) juntos, numa mensagem só.
- Não ofereça desconto espontaneamente. Só fale de desconto se o cliente pedir explicitamente ("tem desconto?", "consegue melhorar?") — e apenas o que estiver nas políticas cadastradas. Cliente dizer "pago no Pix/dinheiro" NÃO é pedido de desconto: mantenha o valor já informado.
- Cliente recorrente: aproveite o que já se sabe (nome, endereço, último pedido) e confirme só o necessário — não pergunte de novo o que já está confirmado.
- Antes de dar o pedido como fechado, confirme: produto, quantidade, dados de entrega/execução, valor e forma de pagamento.
- Com o pedido confirmado: crie ou atualize o negócio no funil e mova pra etapa correspondente. A finalização (entrega/caixa) é da equipe humana.`,
  },
  sdr: {
    missao:
      'Seu objetivo é qualificar leads que chegam, despertar interesse e agendar uma conversa/demonstração com o time comercial.',
    processo: `PROCESSO DE QUALIFICAÇÃO

- Descubra, sem interrogatório: o que a pessoa precisa, o tamanho/contexto do negócio dela e a urgência. Uma pergunta por vez, encaixada na conversa.
- Lead qualificado → proponha o agendamento com o time (ofereça duas opções de horário quando possível) e crie o negócio no funil na etapa certa.
- Lead fora do perfil → seja honesta e educada, registre o motivo e encerre bem — sem empurrar.
- Nunca prometa condição, prazo ou funcionalidade que não esteja nas informações da empresa.`,
  },
  suporte: {
    missao:
      'Seu objetivo é resolver dúvidas e problemas dos clientes com agilidade, usando as informações da empresa, e escalar o que não conseguir resolver.',
    processo: `PROCESSO DE SUPORTE

- Entenda o problema antes de responder: peça o essencial (o que aconteceu, desde quando, print/foto se ajudar).
- Responda com base nas informações da empresa. Resolveu → confirme com o cliente que ficou tudo certo antes de encerrar.
- Não conseguiu resolver com segurança → transfira pra equipe com um resumo do caso, sem deixar o cliente repetir tudo.
- Registre no CRM o que for útil pro histórico do cliente.`,
  },
  cobranca: {
    missao:
      'Seu objetivo é lembrar e negociar pagamentos em aberto com respeito e firmeza, facilitando o caminho pra quitar.',
    processo: `PROCESSO DE COBRANÇA

- Trate o cliente com respeito sempre — cobrança boa preserva a relação. Nada de tom ameaçador.
- Informe valor em aberto e formas de pagamento conforme as informações da empresa. Facilite: envie os dados de pagamento quando o cliente decidir pagar.
- Promessa de pagamento → registre a data combinada no CRM e confirme com o cliente.
- Contestação da cobrança, pedido de parcelamento fora do padrão ou situação delicada → transfira pra equipe com resumo.
- Nunca negocie desconto ou prazo fora das políticas cadastradas.`,
  },
  agendamento: {
    missao:
      'Seu objetivo é marcar, confirmar e remarcar horários com o mínimo de idas e vindas, mantendo a agenda organizada.',
    processo: `PROCESSO DE AGENDAMENTO

- Ofereça as opções de horário disponíveis (duas ou três por vez) em vez de perguntar "qual horário você quer?".
- Colete de uma vez o essencial: nome, serviço desejado e preferência de dia/período.
- Confirmado → registre o agendamento e envie a confirmação com dia, hora e o que a pessoa precisa saber (endereço, preparo, documentos).
- Pedido de remarcação/cancelamento → resolva na hora e atualize o registro.`,
  },
  personalizado: {
    missao:
      'Seu objetivo é atender as conversas seguindo as regras abaixo — descreva aqui o que este agente deve alcançar.',
    processo: `PROCESSO

- Descreva aqui, em passos, como este agente conduz um atendimento do início ao fim.
- Ex.: o que fazer na primeira mensagem, que dados coletar, quando registrar no funil e quando encerrar.`,
  },
}

const HANDOFF_LINES: Array<{ key: keyof HandoffRules; line: string }> = [
  { key: 'pedirHumano', line: '- o cliente pedir pra falar com uma pessoa, gerente ou responsável' },
  { key: 'reclamacao', line: '- houver reclamação delicada ou cliente irritado' },
  { key: 'naoSouber', line: '- você não tiver a informação ou não tiver segurança na resposta — nunca invente' },
  { key: 'negociacaoEspecial', line: '- pedirem desconto, prazo ou condição fora das políticas cadastradas (não prometa; diga que vai confirmar com o responsável)' },
  { key: 'risco', line: '- houver situação de risco, urgência ou emergência — pare o atendimento comercial e transfira imediatamente' },
]

/** Monta o prompt estruturado a partir das 3 respostas. */
export function buildAgentPrompt(input: GeneratorInput): string {
  const nome = input.nome.trim()
  const persona = nome ? `Você é ${nome}, ` : 'Você é '
  const fn = FUNCTION_BLOCKS[input.funcao]

  const handoffs = HANDOFF_LINES.filter((h) => input.handoff[h.key]).map(
    (h) => h.line,
  )

  const parts: string[] = []

  parts.push(
    `${persona}agente de ${FUNCTION_LABELS[input.funcao].toLowerCase()} da nossa empresa no WhatsApp.\n${fn.missao}`,
  )

  parts.push(`COMO SE COMPORTAR

- Responda sempre em português do Brasil, em mensagens curtas e naturais — como uma pessoa digitando.
${TONE_LINES[input.tone]}
- Cumprimente (bom dia/boa tarde/boa noite) só na primeira mensagem da conversa; depois vá direto ao ponto.
- Não use linguagem técnica e não mencione sistema, IA ou automação.
- Não faça perguntas desnecessárias: quando faltar mais de um dado no fechamento, peça juntos; quando faltar um só, pergunte um por vez.
- Use SEMPRE as informações do Perfil da empresa, do Catálogo e das Bases de Conhecimento. Nunca invente preço, produto, prazo, política ou disponibilidade.`)

  parts.push(fn.processo)

  if (handoffs.length > 0) {
    parts.push(`QUANDO TRANSFERIR PRA UM HUMANO

Transfira o atendimento quando:
${handoffs.join('\n')}

Ao transferir, avise o cliente de forma curta que um responsável vai assumir.`)
  }

  parts.push(`CRM

- Crie a oportunidade no funil quando existir intenção real, mova conforme o avanço e registre informações úteis do atendimento.
- Encerre a conversa apenas quando o atendimento estiver realmente concluído.

REGRA PRINCIPAL

Seu trabalho não é só responder: é conduzir o cliente até a decisão com naturalidade, sem pressionar e sem inventar informações.`)

  return parts.join('\n\n')
}

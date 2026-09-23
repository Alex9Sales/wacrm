// ============================================================
// 🧾 Régua de cobrança — REGRAS (puras, testáveis, client-safe).
//
// A régua é o coração da Fase 2: a cada ciclo o sistema reconsulta o que está
// em aberto NAQUELE instante e monta UMA mensagem por devedor, com todas as
// parcelas dele juntas. É isso que faz três parcelas virarem duas quando o
// cliente paga uma.
//
// Tudo aqui é configuração por conta. Nenhuma regra de negócio de nenhum
// cliente vira condição no código — é a regra que separa produto de
// consultoria, e é ela que faz o segundo cliente não exigir reescrita.
// ============================================================

import { firstNameForGreeting } from '@/lib/cdl/names'

import { onlyDigits } from './document'

import { holidayName } from './holidays'

export type DeliveryChannel = 'auto' | 'whatsapp' | 'email' | 'both'

export type CollectionTemplateKind = 'collection' | 'reminder' | 'due_today' | 'new_charge' | 'manual'
export const COLLECTION_TEMPLATE_KINDS: readonly CollectionTemplateKind[] = ['collection', 'reminder', 'due_today', 'new_charge', 'manual']
export const COLLECTION_TEMPLATE_KIND_LABELS: Record<CollectionTemplateKind, string> = {
  collection: 'Cobrança da régua (vencida)',
  reminder: 'Lembrete antes de vencer',
  due_today: 'Aviso no dia do vencimento',
  new_charge: 'Aviso de cobrança nova',
  manual: 'Cobrar pelo WhatsApp (à mão)',
}
export interface CollectionTemplateRef {
  name: string
  language: string | null
  /** Variáveis do corpo, na ordem — aceitam as chaves de TEMPLATE_VARS. */
  params: string[]
}
/** O que pode ir numa variável de template; o executor troca pelos dados da cobrança. */
export const TEMPLATE_VARS = ['{nome}', '{valor}', '{link}', '{vencimento}', '{descricao}', '{dias}', '{parcelas}'] as const
/** Preço público do Asaas por aviso de WhatsApp (R$), 09/2026. */
export const ASAAS_WHATSAPP_FEE_DEFAULT = 0.55
/** Preço do Asaas por aviso de E-MAIL (R$) — o que o Alex vê na fatura (23/09). */
export const ASAAS_EMAIL_FEE_DEFAULT = 0.99

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Um degrau da cadência própria (ver `CollectionsSettings.steps`). */
export interface CollectionStep {
  /** A partir de quantos dias de ATRASO este degrau pode sair. */
  daysLate: number
  /**
   * Texto deste toque. Vazio = o texto padrão da régua (que já varia sozinho
   * para não repetir). Aceita as mesmas chaves dos templates: {nome}, {valor},
   * {link}, {vencimento}, {descricao}, {dias}, {parcelas}.
   */
  text?: string
}

export interface CollectionsSettings {
  /** Nasce DESLIGADA: cobrar alguém nunca é um padrão, é uma decisão. */
  enabled: boolean
  /** Dias entre um toque e o próximo no mesmo devedor. */
  intervalDays: number
  /** Só cobra quem passou disso. 0 = cobra no dia seguinte ao vencimento. */
  minDaysOverdue: number
  /** Teto de devedores cobrados por dia (anti-ban e sanidade). */
  dailyCap: number
  /** Janela de envio, no fuso da conta. */
  startHour: number
  endHour: number
  /**
   * @deprecated Use `sendWeekdays`. Continua sendo lido para as contas antigas
   * e para quem ainda não abriu a tela, mas quem manda é `sendWeekdays`.
   */
  weekdaysOnly: boolean
  /**
   * Em quais dias da semana a régua pode cobrar (0=domingo … 6=sábado).
   *
   * 11/09 (Alex): "cada um tem sua forma de trabalhar — quem cobra no sábado
   * deixa de segunda a sábado, quem não cobra deixa de segunda a sexta".
   * Nunca fica vazio: lista vazia voltaria a cobrar todo dia sem ninguém pedir.
   */
  sendWeekdays: number[]
  /** Não cobra em feriado NACIONAL (ver `holidays.ts`; municipal não dá para saber). */
  skipHolidays: boolean
  /**
   * Template aprovado, para quem cobra pela API OFICIAL do WhatsApp (Meta).
   *
   * 12/09 (Alex): "colocar em Ajustar a opção de selecionar template caso o
   * cliente queira usar API Oficial". No canal oficial, fora da janela de 24 h
   * desde a última mensagem do cliente, texto livre NÃO é entregue — e cobrança
   * é quase sempre fora da janela, porque o devedor não escreveu primeiro.
   * Sem template, nessa situação, a régua não manda (e diz o motivo).
   * Em canal não oficial isto é ignorado: lá texto livre sai a qualquer hora.
   */
  templateName: string | null
  templateLanguage: string | null
  /** Variáveis do corpo, na ordem. Aceita `{nome}`, `{valor}`, `{link}`, `{dias}`, `{parcelas}` (ver TEMPLATE_VARS). */
  templateParams: string[]
  /**
   * Template por TIPO de mensagem (23/09, Rafael Odonto: "criei vários
   * templates, como o agente sabe qual usar?"). Cada tipo pode ter o seu;
   * sem entrada, vale o template padrão acima. Chaves: collection (cobrança
   * da régua), reminder (lembrete antes de vencer), due_today (aviso do dia),
   * new_charge (aviso de cobrança nova), manual (Cobrar pelo WhatsApp).
   */
  templatesByKind: Partial<Record<CollectionTemplateKind, CollectionTemplateRef>>
  /**
   * Por onde cobrar. auto = WhatsApp quando o contato tem telefone, senão
   * e-mail; both = os dois no mesmo toque (boleto no e-mail, lembrete no zap).
   */
  channel: DeliveryChannel
  /**
   * Número (canal de WhatsApp) que ENVIA a cobrança quando o devedor ainda não
   * tem conversa no CRM. null = automático: o único número conectado da conta;
   * com mais de um, a régua pede para escolher em vez de chutar.
   */
  channelId: string | null
  /**
   * Canal de E-MAIL que envia a cobrança (22/09, Rafael Odonto: "com mais de
   * um e-mail configurado não aparece qual selecionar"). null = automático:
   * o primeiro e-mail conectado da conta.
   */
  emailChannelId: string | null
  /** Status do Asaas que contam como vencido nesta conta. */
  overdueStatuses: string[]
  /**
   * Quanto o Asaas cobra por aviso de WhatsApp que ELE manda (R$). Base da
   * faixa "economia no Asaas" (23/09, ideia do Rafael): cada aviso que sai
   * pelo CRM é um que o Asaas não cobrou. Padrão = tabela pública do Asaas.
   */
  asaasWhatsAppFee: number
  /**
   * Quanto o Asaas cobra por aviso de E-MAIL (R$). O CRM também manda os
   * e-mails de cobrança, então cada um é mais um que o Asaas não cobrou —
   * entra na mesma faixa de economia (23/09, Alex: "e-mail é 0,99").
   */
  asaasEmailFee: number
  /**
   * Depois de N toques sem o devedor responder, a régua PARA nele e avisa o
   * time. Cobrar para sempre a cada 3 dias é o caminho mais curto para o
   * número ser denunciado — e para o cliente perder o cliente dele.
   *
   * Com `steps` preenchido, quem manda é o tamanho da escada.
   */
  maxTouches: number
  /**
   * 🪜 Cadência própria: um degrau por toque, cada um com o atraso a partir do
   * qual ele vale e, se quiser, o texto daquele toque.
   *
   * 23/09 (Rafael Odonto): "dá para personalizar a cadência? aviso 2 dias
   * antes, no vencimento, 3 a 5 dias depois, 7, 10, 15, e 30 com aviso de
   * negativação". Com o intervalo fixo isso não existia: era sempre de N em N
   * dias, com o mesmo texto do começo ao fim.
   *
   * Vazio = a régua de sempre (`intervalDays` + `maxTouches`). Ninguém é
   * migrado sem pedir.
   */
  steps: CollectionStep[]
  /**
   * 🔴 Mensagem para quem ACUMULOU parcelas. A partir de `manyChargesMin`
   * parcelas vencidas, a régua manda ESTE texto em vez do de sempre.
   *
   * 23/09 (João/GoLink): "está faltando aquela mensagem mais incisiva quando
   * está com 3 vencidas". Quem deve três meses não responde ao mesmo lembrete
   * educado de quem atrasou uma semana — ali o assunto é acordo, e a mensagem
   * que funcionava na mão dele dizia o que acontece se não houver acordo.
   *
   * Vazio = desligado (a régua segue com o texto normal). Aceita as mesmas
   * chaves dos templates, e `{lista}` traz as parcelas com os links.
   */
  manyChargesText: string
  /** A partir de quantas parcelas vencidas vale o texto acima. */
  manyChargesMin: number
  /** Instrução de tom, no vocabulário do negócio (vai para a IA). */
  tone: string
  /**
   * Teto para a IA EMITIR cobrança sozinha (criar_cobranca). Acima disso ela
   * não cria — avisa uma pessoa. É dinheiro do cliente do cliente: o limite
   * é configuração, não constante.
   */
  emitMaxValue: number
  /**
   * O CRM assume os avisos: ao sincronizar, desliga as notificações do Asaas
   * (e-mail/SMS/WhatsApp deles) de quem entra na carteira. O cliente paga por
   * envio no Asaas. Opt-in: nasce desligado.
   */
  asaasNotificationsOff: boolean
  /**
   * Quando o "CRM assume os avisos" foi LIGADO (ISO). Gravado pelo servidor ao
   * salvar Ajustar, nunca pela tela. É o piso do aviso de cobrança nova (17/09):
   * cobrança criada até esse dia o próprio Asaas já avisou — mandar de novo
   * seria dobrado. Conta que já estava ligada antes de existir o campo fica
   * sem piso (null).
   */
  asaasNotificationsOffAt: string | null
  /**
   * Quando terminou a primeira varredura COMPLETA (todos os clientes da conexão)
   * depois de `asaasNotificationsOffAt` (ISO). Gravado pelo servidor — pela
   * varredura (sync.ts) e pelo botão "desligar avisos do Asaas" — e apagado ao
   * ligar a opção. Revisão 17/09: o Asaas só para de avisar quando a varredura
   * cala os clientes, não no clique; ligada na sexta 17h30, a varredura é segunda
   * 9h e o Asaas avisou as cobranças do fim de semana. O piso do aviso de
   * cobrança nova é o dia seguinte a ESTE instante.
   */
  asaasNotificationsSweptAt: string | null
  /**
   * Agradecer quando o pagamento entra (webhook do Asaas). Só para quem a
   * régua/CRM cobrou ou cuja cobrança nasceu aqui — nunca para quem nunca
   * ouviu falar da gente por aqui. (07/09, pedido do cliente no áudio.)
   */
  thankOnPayment: boolean
  /**
   * Lembrete ANTES de vencer: N dias antes do vencimento manda um aviso leve.
   * Não é cobrança de inadimplente — é o "vence quinta, tá aí o link".
   * 0 = desligado (padrão).
   */
  reminderDaysBefore: number
  /**
   * Quando o cliente promete uma data ("pago dia 10"), além de a régua dormir,
   * mover o vencimento no Asaas para essa data (o Asaas gera novo boleto/link).
   * Só com UMA parcela em aberto — com várias, ninguém chuta qual. Nasce
   * desligado: mexer no vencimento perdoa juros/multa do Asaas, é decisão.
   */
  promiseUpdatesDueDate: boolean
  /**
   * Enviar SOZINHA, sem passar por "Precisa de você" (09/09, João/GoLink:
   * "quero automático já"). É decisão explícita do dono e ignora o portão de
   * promoção (20 decisões/14 dias) — os freios da conta continuam valendo
   * (IA pausada, "só sugestões", opt-out, IA desligada na conversa). Nasce
   * desligado.
   */
  autoSend: boolean
  /**
   * Cadência do envio automático (e do "Aprovar todas"): uma mensagem a cada
   * N minutos, dentro do horário da régua. Espaçar é o anti-ban — quarenta
   * cobranças num minuto é como o WhatsApp reconhece um robô.
   */
  sendEveryMinutes: number
  /**
   * Quem cuida das RESPOSTAS de cobrança (10/09, João/GoLink: "atribui pro
   * Leonardo do Financeiro"). Ao enviar uma cobrança, a conversa passa a ser
   * dessa pessoa — ela vê na lista dela e recebe as respostas. null = não mexe
   * na atribuição.
   */
  assigneeUserId: string | null
  /**
   * Setor em que a conversa de cobrança entra ao sair a mensagem (10/09,
   * João/GoLink: "cria um setor Asaas e tudo que o robô mandar cai lá").
   * null = não mexe no setor.
   */
  sectorId: string | null
  /**
   * Oferecer "combinar uma data" no fecho da mensagem. João (10/09): "isso dá
   * liberdade pro cliente enrolar". Desligado, a mensagem só diz que, se já
   * pagou, é só responder — a resposta continua pausando a régua.
   */
  offerDateNegotiation: boolean
  /**
   * Mostrar os VALORES (R$ de cada parcela, total, juros) na mensagem. Desligado
   * = só vencimento, dias de atraso e link (João/GoLink 10/09: "valor assusta o
   * cliente; ele paga só a mais atrasada"). Padrão ligado.
   */
  showValues: boolean
  /**
   * 🔔 Avisar no DIA do vencimento (João/GoLink 22/09: "quem paga no dia não
   * recebe nada"). É um toque à parte do lembrete D-N: não gasta toque da
   * régua, não é barrado pelo lembrete que já saiu dias antes, e vale mesmo
   * com `reminderDaysBefore` = 0. Nasce desligado, como tudo aqui.
   */
  remindOnDueDate: boolean
}

export const COLLECTIONS_DEFAULTS: CollectionsSettings = {
  enabled: false,
  intervalDays: 3,
  minDaysOverdue: 1,
  dailyCap: 40,
  startHour: 9,
  endHour: 18,
  weekdaysOnly: true,
  sendWeekdays: [1, 2, 3, 4, 5],
  skipHolidays: true,
  templateName: null,
  templateLanguage: null,
  templateParams: [],
  templatesByKind: {},
  channel: 'auto',
  channelId: null,
  emailChannelId: null,
  overdueStatuses: ['OVERDUE'],
  asaasWhatsAppFee: ASAAS_WHATSAPP_FEE_DEFAULT,
  asaasEmailFee: ASAAS_EMAIL_FEE_DEFAULT,
  maxTouches: 8,
  steps: [],
  manyChargesText: '',
  manyChargesMin: 3,
  tone: '',
  emitMaxValue: 500,
  asaasNotificationsOff: false,
  asaasNotificationsOffAt: null,
  asaasNotificationsSweptAt: null,
  thankOnPayment: true,
  reminderDaysBefore: 0,
  promiseUpdatesDueDate: false,
  autoSend: false,
  sendEveryMinutes: 5,
  assigneeUserId: null,
  sectorId: null,
  offerDateNegotiation: true,
  showValues: true,
  remindOnDueDate: false,
}

/**
 * Dias da semana válidos, sem repetição e em ordem. Lista vazia ou lixo cai no
 * que a conta já usava (`weekdaysOnly`) — nunca em "cobra todo dia", que
 * ninguém pediu e é o erro caro aqui.
 */
export function normalizeWeekdays(raw: unknown, uteisPorPadrao = true): number[] {
  const dias = Array.isArray(raw)
    ? [...new Set(raw.map((d) => (typeof d === 'number' ? Math.round(d) : Number.NaN)).filter((d) => d >= 0 && d <= 6))].sort()
    : []
  if (dias.length) return dias
  return uteisPorPadrao ? [1, 2, 3, 4, 5] : [0, 1, 2, 3, 4, 5, 6]
}

export function normalizeSettings(raw: unknown): CollectionsSettings {
  const r = (raw ?? {}) as Partial<CollectionsSettings>
  const int = (v: unknown, def: number, min: number, max: number) => {
    const n = typeof v === 'number' ? Math.round(v) : Number.NaN
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def
  }
  const statuses = Array.isArray(r.overdueStatuses)
    ? r.overdueStatuses.filter((s): s is string => typeof s === 'string' && !!s.trim())
    : []
  return {
    enabled: r.enabled === true,
    intervalDays: int(r.intervalDays, 3, 1, 60),
    minDaysOverdue: int(r.minDaysOverdue, 1, 0, 365),
    dailyCap: int(r.dailyCap, 40, 1, 500),
    startHour: int(r.startHour, 9, 0, 23),
    endHour: int(r.endHour, 18, 1, 24),
    weekdaysOnly: r.weekdaysOnly !== false,
    // Conta que ainda não escolheu os dias herda o que já valia para ela:
    // "só dias úteis" = segunda a sexta; desmarcado = a semana toda.
    sendWeekdays: normalizeWeekdays(r.sendWeekdays, r.weekdaysOnly !== false),
    skipHolidays: r.skipHolidays !== false,
    templateName: typeof r.templateName === 'string' && r.templateName.trim() ? r.templateName.trim().slice(0, 200) : null,
    templateLanguage: typeof r.templateLanguage === 'string' && r.templateLanguage.trim() ? r.templateLanguage.trim().slice(0, 20) : null,
    templateParams: Array.isArray(r.templateParams)
      ? r.templateParams.filter((x): x is string => typeof x === 'string').slice(0, 10)
      : [],
    templatesByKind: normalizeTemplatesByKind(r.templatesByKind),
    channel: r.channel === 'whatsapp' || r.channel === 'email' || r.channel === 'both' ? r.channel : 'auto',
    channelId: typeof r.channelId === 'string' && UUID_RE.test(r.channelId) ? r.channelId : null,
    emailChannelId: typeof r.emailChannelId === 'string' && UUID_RE.test(r.emailChannelId) ? r.emailChannelId : null,
    overdueStatuses: statuses.length ? statuses : [...COLLECTIONS_DEFAULTS.overdueStatuses],
    asaasWhatsAppFee: (() => {
      const n = typeof r.asaasWhatsAppFee === 'number' ? r.asaasWhatsAppFee : Number.NaN
      // 0 ou vazio (campo apagado na tela) não é "grátis": volta ao padrão.
      return Number.isFinite(n) && n > 0 ? Math.min(20, Math.round(n * 100) / 100) : ASAAS_WHATSAPP_FEE_DEFAULT
    })(),
    asaasEmailFee: (() => {
      const n = typeof r.asaasEmailFee === 'number' ? r.asaasEmailFee : Number.NaN
      return Number.isFinite(n) && n > 0 ? Math.min(20, Math.round(n * 100) / 100) : ASAAS_EMAIL_FEE_DEFAULT
    })(),
    maxTouches: int(r.maxTouches, 8, 1, 50),
    steps: normalizeSteps(r.steps),
    manyChargesText: typeof r.manyChargesText === 'string' ? r.manyChargesText.trim().slice(0, 900) : '',
    manyChargesMin: int(r.manyChargesMin, 3, 2, 20),
    tone: typeof r.tone === 'string' ? r.tone.slice(0, 600) : '',
    emitMaxValue: (() => {
      const n = typeof r.emitMaxValue === 'number' ? r.emitMaxValue : Number.NaN
      return Number.isFinite(n) ? Math.min(100_000, Math.max(1, Math.round(n * 100) / 100)) : 500
    })(),
    asaasNotificationsOff: r.asaasNotificationsOff === true,
    asaasNotificationsOffAt:
      typeof r.asaasNotificationsOffAt === 'string' && !Number.isNaN(Date.parse(r.asaasNotificationsOffAt))
        ? r.asaasNotificationsOffAt.slice(0, 40)
        : null,
    asaasNotificationsSweptAt:
      typeof r.asaasNotificationsSweptAt === 'string' && !Number.isNaN(Date.parse(r.asaasNotificationsSweptAt))
        ? r.asaasNotificationsSweptAt.slice(0, 40)
        : null,
    thankOnPayment: r.thankOnPayment !== false,
    reminderDaysBefore: int(r.reminderDaysBefore, 0, 0, 15),
    promiseUpdatesDueDate: r.promiseUpdatesDueDate === true,
    autoSend: r.autoSend === true,
    sendEveryMinutes: int(r.sendEveryMinutes, 5, 1, 120),
    assigneeUserId: typeof r.assigneeUserId === 'string' && UUID_RE.test(r.assigneeUserId) ? r.assigneeUserId : null,
    sectorId: typeof r.sectorId === 'string' && UUID_RE.test(r.sectorId) ? r.sectorId : null,
    offerDateNegotiation: r.offerDateNegotiation !== false,
    showValues: r.showValues !== false,
    remindOnDueDate: r.remindOnDueDate === true,
  }
}

/**
 * Dias entre duas chaves 'YYYY-MM-DD' (b − a), pela DATA — sem hora, sem fuso.
 * É a conta que a régua e o lembrete fazem para "dias de atraso" e "dias até
 * vencer": as duas chaves já vêm no dia da conta (localDayKey). Inválida → null.
 */
export function daysBetweenDayKeys(a: string | null | undefined, b: string | null | undefined): number | null {
  if (!a || !b) return null
  const ta = Date.parse(`${a.slice(0, 10)}T00:00:00Z`)
  const tb = Date.parse(`${b.slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null
  return Math.round((tb - ta) / 86_400_000)
}

/**
 * Qual toque cada parcela a vencer recebe, dado o que a conta ligou:
 *   'due_today' — vence HOJE e "Avisar no dia do vencimento" está ligado;
 *   'reminder'  — dentro da janela do lembrete (0..N dias) com N > 0;
 *   null        — nenhum (fora da janela, ou tudo desligado).
 * Com o aviso do dia ligado, a parcela de hoje é SEMPRE 'due_today' (o
 * lembrete D-N não a pega mais) — é o que impede o "já lembrado" do D-5 de
 * calar o aviso do dia.
 */
export function reminderKindFor(
  daysUntil: number | null,
  s: Pick<CollectionsSettings, 'reminderDaysBefore' | 'remindOnDueDate'>,
): 'due_today' | 'reminder' | null {
  if (daysUntil == null || daysUntil < 0) return null
  if (daysUntil === 0 && s.remindOnDueDate) return 'due_today'
  if (s.reminderDaysBefore > 0 && daysUntil <= s.reminderDaysBefore) return 'reminder'
  return null
}

const NAME_STOPWORDS = new Set(['e', 'de', 'da', 'do', 'das', 'dos', '&', 'em', 'para', '-', '–', '—', '|', '/'])

/**
 * Os dígitos de uma busca de contato — ou `null` quando não dá para procurar
 * por telefone.
 *
 * 🐛 11/09 (João/GoLink): a carteira montava `phone ILIKE '%' || digitos || '%'`
 * sem essa guarda. Buscando "Centro Pisos Modelo" os dígitos davam string
 * VAZIA, o ILIKE virava `'%%'` e casava com os 286 contatos da conta — a lista
 * devolvia 20 contatos quaisquer e o certo nunca aparecia ("n acha").
 */
export function phoneSearchDigits(query: string | null | undefined): string | null {
  const d = (query ?? '').replace(/\D/g, '')
  return d.length >= 4 ? d : null
}

/** Artigo sozinho não é nome de ninguém: "A Exemplar…" tem que levar mais uma palavra. */
const NAME_ARTICLES = new Set(['a', 'o', 'as', 'os'])

/** Sufixo de razão social: ninguém quer ser chamado de "Ltda". */
const NAME_LEGAL_SUFFIX = new Set(['ltda', 'ltda.', 'lt', 'me', 'mei', 'epp', 'eireli', 'sa', 's.a', 's.a.', 'sas'])

/**
 * Como chamar o cliente na mensagem, a partir do nome COMO ESTÁ NO ASAAS
 * (decisão João/Alex 10/09: prevalece o Asaas, não o apelido do WhatsApp).
 * Sem IA não dá pra saber se é pessoa ou empresa, então a regra é de tamanho:
 * até 3 palavras vai INTEIRO ("Drogaria Vila Exemplo", "SOS dos Fogões",
 * "Marcenaria Nova Esperança" — cortar em duas estraga todos esses); mais longo, as
 * duas primeiras ("Ótica Exemplo"), ou só a primeira quando a segunda é conector
 * ("João da…" → "João").
 *
 * ⚠️ 11/09: passei a regra pelos 51 clientes reais da GoLink antes de subir.
 * Forçar "duas primeiras" para atender "Tio Burguer Lanches" quebrava 8 nomes
 * ("Casa da Pizza" → "Casa", "SOS dos Fogões" → "SOS"). Ficou o limite de 3.
 * Os dois consertos que a lista real pediu: ARTIGO na frente não conta como
 * palavra ("A Exemplar Corretora E…" virava "A Exemplar") e SUFIXO de razão
 * social ("Ltda", "ME") não é jeito de chamar ninguém.
 * A IA recebe o nome completo com a instrução pessoa/empresa (engine.ts).
 */
export function greetingName(name: string | null | undefined): string | null {
  const words = (name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .filter((w, i) => i === 0 || !NAME_LEGAL_SUFFIX.has(w.toLowerCase().replace(/[.,]$/, '')))
  if (!words.length) return null

  const comArtigo = NAME_ARTICLES.has(words[0].toLowerCase())
  if (words.length <= (comArtigo ? 4 : 3)) return words.join(' ')
  const keep = comArtigo ? 3 : 2
  if (NAME_STOPWORDS.has(words[keep - 1].toLowerCase())) return words.slice(0, keep - 1).join(' ')
  return words.slice(0, keep).join(' ')
}

/**
 * Cadência do envio automático: já passou N minutos desde a última mensagem
 * da régua nesta conta? Sem envio anterior, pode. Puro, pra testar.
 */
export function autoSendDue(lastSentAtMs: number | null, nowMs: number, everyMinutes: number): boolean {
  if (lastSentAtMs == null) return true
  return nowMs - lastSentAtMs >= Math.max(1, everyMinutes) * 60_000
}

const COLLECTION_EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

/**
 * 📧 Um endereço de e-mail utilizável, ou null. Aceita a lista que o Asaas
 * guarda em alguns cadastros ("a@x.com, b@y.com") e fica com o primeiro válido.
 * `skip`: endereços que voltaram (email_bounces, 15/09 Vale Modelo) — pula.
 */
export function collectionEmail(value: unknown, skip?: ReadonlySet<string>): string | null {
  if (typeof value !== 'string') return null
  for (const parte of value.split(/[,;\s]+/)) {
    const e = parte.trim().toLowerCase()
    if (COLLECTION_EMAIL_RE.test(e) && !skip?.has(e)) return e
  }
  return null
}

/**
 * Por onde a cobrança sai DE VERDADE quando a conta fixou o número (Ajustar →
 * "Número que envia as cobranças"): o executor ignora a conversa escolhida no
 * card e usa sempre esse número (outreach.ts). 14/09 (João/GoLink): o card
 * dizia "WhatsApp · João" enquanto 43 de 45 saíram pelo número Cobranças.
 * `delivery` é o plano gravado pela régua ("WhatsApp", "e-mail", "WhatsApp e e-mail").
 */
export function fixedCollectionRoute(delivery: unknown, channelName: string): string {
  const plano = typeof delivery === 'string' && delivery.trim() ? delivery.trim() : 'WhatsApp'
  if (!/whatsapp/i.test(plano)) return plano.charAt(0).toUpperCase() + plano.slice(1)
  return plano.replace(/whatsapp/i, `WhatsApp · ${channelName}`)
}

/**
 * 🔔 Ordem dos lembretes antes do vencimento: o que vence antes sai antes.
 *
 * 14/09 (João/GoLink): "se passar dos 50, o aviso de quem vence em 5 dias se
 * perde?". Não se perde — a janela vai até o vencimento e o aviso tenta de novo
 * no dia seguinte. Mas a lista vinha na ordem do Asaas, e com o teto curto um
 * "vence amanhã" podia perder a vaga para um "vence em 5 dias", que ainda teria
 * dias de janela. Sem data conhecida vai para o fim.
 */
export function byNearestDue<T extends { lines: { daysUntil: number | null }[] }>(candidates: T[]): T[] {
  const nearest = (c: T) => {
    const dias = c.lines.map((l) => l.daysUntil).filter((d): d is number => typeof d === 'number')
    return dias.length ? Math.min(...dias) : Number.MAX_SAFE_INTEGER
  }
  return [...candidates].sort((a, b) => nearest(a) - nearest(b))
}

/**
 * 🔁 Depois de uma tentativa que falhou, quanto falta para poder tentar de novo.
 *
 * 14/09 (B.C Fretes/GoLink): o WAHA devolveu erro mas ENTREGOU; o sender
 * tentou de novo no minuto seguinte e o devedor recebeu a mesma cobrança duas
 * vezes. A espera dá tempo do eco da mensagem chegar — e o sender procura esse
 * eco antes de reenviar.
 */
export const RETRY_AFTER_FAILURE_MS = 3 * 60_000

/**
 * Pedido cuja última tentativa foi DEPOIS deste instante ainda espera. Vira
 * filtro da fila (e não um "espera" do sender): um pedido travado não pode
 * segurar os outros devedores da conta.
 */
export function retryCutoffIso(nowMs: number): string {
  return new Date(nowMs - RETRY_AFTER_FAILURE_MS).toISOString()
}

/**
 * Recusas que NÃO são falha temporária: o motivo da cobrança sumiu (pagou,
 * cancelou) ou o devedor foi parado entre a fila e o envio (pausa, promessa,
 * comprovante — `holdRefusal`). O pedido encerra como 'expired' com o motivo,
 * sem as 3 tentativas. Timeout do Asaas ou canal fora do ar continuam tentando.
 */
export const COLLECTION_FINAL_ERROR_RE = /nada em aberto|já foi pag|não está mais|não foi enviada|régua está parada/i

/** Aviso do dia recusado no envio: o link já saiu hoje. Casa com `COLLECTION_FINAL_ERROR_RE` (o sender expira, não retenta). */
export const DUE_TODAY_LINK_SENT_ERROR = 'O link desta parcela já saiu hoje para o cliente — a mensagem não foi enviada de novo.'

export function isFinalCollectionError(e: string): boolean {
  return COLLECTION_FINAL_ERROR_RE.test(e)
}

/**
 * Trecho do rascunho que reconhece a mensagem já entregue. Espaços são
 * normalizados (o banco compara com o mesmo tratamento) e a assinatura
 * ("*João:*") entra ANTES do texto, então procurar o começo do rascunho dentro
 * da mensagem enviada funciona com ou sem ela. Texto curto demais não serve
 * de prova — "Bom dia!" casaria com qualquer coisa.
 */
export function deliveredEchoSnippet(text: string | null | undefined): string | null {
  const t = (text ?? '').replace(/\s+/g, ' ').trim()
  // Corta por caractere (Array.from), não por unidade UTF-16: emoji partido ao
  // meio vira "�" no banco e o trecho nunca casaria.
  return t.length >= 30 ? Array.from(t).slice(0, 80).join('') : null
}

/**
 * Os status que fazem sentido numa régua, com o nome que o cliente entende.
 * Os demais do Asaas (RECEIVED, CONFIRMED…) já estão pagos — não se cobra.
 */
export const CHARGEABLE_STATUSES: { value: string; label: string; hint: string }[] = [
  { value: 'OVERDUE', label: 'Vencida', hint: 'Passou do vencimento e não foi paga. É o padrão.' },
  {
    value: 'PENDING',
    label: 'A vencer',
    hint: 'Ainda não venceu. Ligue só se você quer LEMBRAR antes do vencimento — não é cobrança de inadimplente.',
  },
]

// ------------------------------------------------------------- elegibilidade

/** Por que um devedor NÃO foi cobrado agora — sempre explicável, nunca mudo. */
export type SkipReason =
  | 'ok'
  | 'no_contact'
  | 'opted_out'
  | 'not_due'
  | 'no_channel'
  | 'duplicate_suspect'
  | 'snoozed'
  | 'paused'
  | 'too_soon'
  | 'max_touches'
  | 'daily_cap'

export const SKIP_LABEL: Record<SkipReason, string> = {
  ok: 'Pronto para cobrar',
  no_contact: 'A cobrança não casou com nenhum contato do CRM',
  opted_out: 'O contato pediu para não receber mensagens',
  not_due: 'Ainda não passou do prazo mínimo de atraso',
  no_channel: 'Sem como alcançar: falta telefone/e-mail no contato ou canal na conta',
  duplicate_suspect: 'Parcela idêntica em dois cadastros do Asaas — provável duplicata, resolver antes de cobrar',
  snoozed: 'O cliente prometeu pagar em uma data que ainda não chegou',
  paused: 'A cobrança deste devedor está pausada',
  too_soon: 'O último toque foi há pouco tempo',
  max_touches: 'Atingiu o limite de toques sem resposta — precisa de uma pessoa',
  daily_cap: 'O teto de envios do dia foi atingido — entra no próximo dia de envio',
}

export interface TouchState {
  lastTouchAt: string | null
  touchCount: number
  snoozeUntil: string | null
  paused: boolean
}

export interface EligibleInput {
  contactId: string | null
  optedOut: boolean
  /** Maior atraso entre as parcelas em aberto do devedor. */
  maxDaysLate: number | null
  state: TouchState | null
}

/** Por que a cobrança deste devedor está segurada, independentemente do tipo de mensagem. */
export type DebtorHold = 'paused' | 'snoozed' | 'max_touches'

/**
 * ✋ O FREIO do devedor — uma fonte só para a régua, para a montagem do
 * lembrete e para a hora do envio.
 *
 * 15/09 (GoLink, Reboque Modelo): o lembrete da parcela nova saiu para um
 * cliente PAUSADO ("pediu acordo/parcelamento"), porque o lembrete não lia
 * collections_touches e o executor só reconferia o Asaas. Pausa e promessa
 * valiam para a régua e não valiam para o resto.
 *
 * Ordem: pausa, limite de toques, promessa/comprovante (snooze). O limite de
 * toques só entra com `s` — na hora do envio (`s = null`) ele não segura: a
 * régua já decidiu isso ao montar.
 */
export function debtorHold(
  st: TouchState | null | undefined,
  s: Pick<CollectionsSettings, 'maxTouches' | 'steps'> | null,
  now = new Date(),
): DebtorHold | null {
  if (!st) return null
  if (st.paused) return 'paused'
  // Com cadência própria quem diz onde termina é a escada: ela TEM um fim, e
  // um teto de toques diferente dela só confundiria quem desenhou (23/09).
  if (s && st.touchCount >= (s.steps?.length ? s.steps.length : s.maxTouches)) return 'max_touches'
  if (st.snoozeUntil && Date.parse(st.snoozeUntil) > now.getTime()) return 'snoozed'
  return null
}

/**
 * O motivo da recusa quando o freio segura um envio já na fila (sender, lote e
 * "Aprovar" manual). Diz o que aconteceu e, na pausa, onde desfazer. Começa
 * sempre com "A régua está parada neste cliente" — é o que o sender reconhece
 * como recusa FINAL (`isFinalCollectionError`), sem tentar de novo.
 */
export function holdRefusal(
  hold: 'paused' | 'snoozed',
  st: { pausedReason?: string | null; snoozeUntil?: string | null; snoozeReason?: string | null },
): string {
  const motivo = (m: string | null | undefined) => (m && m.trim() ? ` (${m.trim()})` : '')
  if (hold === 'paused') {
    return `A régua está parada neste cliente${motivo(st.pausedReason)} — nada foi enviado. Para voltar a cobrar, tire a pausa em Cobranças.`
  }
  const ms = st.snoozeUntil ? Date.parse(st.snoozeUntil) : Number.NaN
  const ate = Number.isNaN(ms)
    ? ''
    : ` até ${new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }).format(new Date(ms))}`
  return `A régua está parada neste cliente${ate}${motivo(st.snoozeReason)} — nada foi enviado.`
}

/**
 * Que tipo de envio CONTA como toque de cobrança (ritmo da régua, contador que
 * devolve o devedor para uma pessoa, "não repita isto" da IA). Lembrete antes
 * do vencimento, aviso de cobrança nova e aviso do DIA do vencimento
 * (`'due_today'`, 22/09) não são cobrança — são entrega de link — e não
 * contam. A cobrança da régua (sem `kind`) e a enviada à mão pela carteira
 * (`'manual'`, 22/09) contam.
 */
export function countsAsCollectionTouch(kind: unknown): boolean {
  return !NOTICE_KINDS.has(kind)
}

/** Os `payload.kind` que são AVISO (entrega de link), não cobrança. */
export const NOTICE_KINDS: ReadonlySet<unknown> = new Set(['reminder', 'new_charge', 'due_today'])

/** Teto de degraus: cadência é régua de cobrança, não novela. */
export const MAX_COLLECTION_STEPS = 12
/** Tamanho do texto de um degrau (o WhatsApp corta bem antes disso). */
const STEP_TEXT_MAX = 900

/**
 * Arruma a escada vinda do banco/tela: só números possíveis, em ordem, sem
 * repetir o mesmo dia e sem passar do teto. Lista inválida vira vazia — e
 * vazia significa "régua de sempre", nunca "nunca cobre".
 */
export function normalizeSteps(raw: unknown): CollectionStep[] {
  if (!Array.isArray(raw)) return []
  const vistos = new Set<number>()
  const out: CollectionStep[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const r = item as { daysLate?: unknown; text?: unknown }
    const n = typeof r.daysLate === 'number' ? r.daysLate : Number(r.daysLate)
    if (!Number.isFinite(n)) continue
    const daysLate = Math.min(365, Math.max(0, Math.round(n)))
    if (vistos.has(daysLate)) continue
    vistos.add(daysLate)
    const text = typeof r.text === 'string' ? r.text.trim().slice(0, STEP_TEXT_MAX) : ''
    out.push(text ? { daysLate, text } : { daysLate })
  }
  return out.sort((a, b) => a.daysLate - b.daysLate).slice(0, MAX_COLLECTION_STEPS)
}

/** Dias corridos desde um instante ISO (null quando a data não presta). */
function diasDesde(iso: string, now: Date): number | null {
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  return (now.getTime() - ms) / 86_400_000
}

/** O degrau da vez (o toque nº `touchCount + 1`), ou null quando a escada acabou. */
export function stepForTouch(steps: readonly CollectionStep[], touchCount: number): CollectionStep | null {
  if (!steps.length) return null
  const i = Math.max(0, Math.floor(touchCount))
  return steps[i] ?? null
}

/**
 * Quantos dias precisam ter passado desde o último toque para o degrau `i`
 * sair. É a DISTÂNCIA entre os degraus desenhados: quem entra na régua já com
 * 30 dias de atraso não recebe a escada inteira de uma vez — recebe o primeiro
 * toque e, depois, o mesmo ritmo que o cliente desenhou.
 */
export function stepGapDays(steps: readonly CollectionStep[], touchCount: number): number {
  const i = Math.max(0, Math.floor(touchCount))
  if (i <= 0 || i >= steps.length) return 1
  return Math.max(1, steps[i].daysLate - steps[i - 1].daysLate)
}

export function eligibility(input: EligibleInput, s: CollectionsSettings, now = new Date()): SkipReason {
  if (!input.contactId) return 'no_contact'
  if (input.optedOut) return 'opted_out'

  const st = input.state
  const hold = debtorHold(st, s, now)
  if (hold) return hold

  if (input.maxDaysLate == null || input.maxDaysLate < s.minDaysOverdue) return 'not_due'

  const desdeUltimo = st?.lastTouchAt ? diasDesde(st.lastTouchAt, now) : null

  // 🪜 Cadência própria: quem manda é o degrau da vez.
  if (s.steps.length) {
    const degrau = stepForTouch(s.steps, st?.touchCount ?? 0)
    if (!degrau) return 'max_touches'
    if (input.maxDaysLate < degrau.daysLate) return 'too_soon'
    if (desdeUltimo != null && desdeUltimo < stepGapDays(s.steps, st?.touchCount ?? 0)) return 'too_soon'
    return 'ok'
  }

  if (desdeUltimo != null && desdeUltimo < s.intervalDays) return 'too_soon'

  return 'ok'
}

/**
 * A janela é avaliada com a hora JÁ convertida para o fuso da conta —
 * quem converte é quem chama, para esta função continuar pura.
 */
export function withinWindow(
  localHour: number,
  localWeekday: number,
  s: CollectionsSettings,
  /** Data local `YYYY-MM-DD` — só necessária para checar feriado. */
  localDayKey?: string,
): boolean {
  if (!s.sendWeekdays.includes(localWeekday)) return false
  if (s.skipHolidays && localDayKey && holidayName(localDayKey)) return false
  return localHour >= s.startHour && localHour < s.endHour
}

/**
 * Por que a régua não vai cobrar hoje — em português, para a tela e para o log.
 * `null` quando o dia está liberado (a hora é checada à parte).
 */
export function dayBlockedReason(localWeekday: number, s: CollectionsSettings, localDayKey?: string): string | null {
  if (!s.sendWeekdays.includes(localWeekday)) return `${WEEKDAY_NAMES[localWeekday] ?? 'Hoje'} não está nos dias de cobrança`
  if (s.skipHolidays && localDayKey) {
    const feriado = holidayName(localDayKey)
    if (feriado) return `Feriado nacional (${feriado})`
  }
  return null
}

/**
 * O dia serve para AGRADECER um pagamento? Regra própria, mais solta que a da
 * cobrança (11/09, Alex: "pode deixar o agradecimento sair no sábado também").
 *
 * Agradecer não é cobrar: não incomoda, e chegar dois dias depois do pagamento
 * é pior que chegar num sábado. Então ele não se prende aos dias escolhidos
 * para a régua — só não vai em DOMINGO nem em feriado, e respeita o horário.
 */
export function thanksDayBlockedReason(localWeekday: number, s: CollectionsSettings, localDayKey?: string): string | null {
  if (localWeekday === 0) return 'Domingo'
  if (s.skipHolidays && localDayKey) {
    const feriado = holidayName(localDayKey)
    if (feriado) return `Feriado nacional (${feriado})`
  }
  return null
}

export const WEEKDAY_NAMES = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado']
export const WEEKDAY_SHORT = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb']

/** "segunda a sexta", "segunda a sábado", "seg, qua e sex" — para a tela. */
export function describeWeekdays(dias: number[]): string {
  const d = [...new Set(dias)].sort()
  if (!d.length) return 'nenhum dia'
  if (d.length === 7) return 'todos os dias'
  const seguido = d.every((v, i) => i === 0 || v === d[i - 1] + 1)
  if (seguido && d.length > 2) return `${WEEKDAY_NAMES[d[0]].toLowerCase()} a ${WEEKDAY_NAMES[d[d.length - 1]].toLowerCase()}`
  const nomes = d.map((x) => WEEKDAY_SHORT[x].toLowerCase())
  return nomes.length === 1 ? nomes[0] : `${nomes.slice(0, -1).join(', ')} e ${nomes[nomes.length - 1]}`
}

// ------------------------------------------------------------ texto da dívida

export interface ChargeLine {
  /** pay_… do Asaas (o envio à mão grava a parcela no pedido — economia por conta). */
  asaasId?: string | null
  /** Cadastro do Asaas de onde veio (para o detector de duplicata). */
  customerId?: string | null
  /** Conta do Asaas — duplicata só conta dentro da mesma (16/09). */
  connectionId?: string | null
  /** CPF/CNPJ do cadastro — PF e PJ da mesma pessoa não são duplicata. */
  document?: string | null
  /** Nome do cadastro no Asaas — entra na linha quando o devedor tem mais de
   *  um cadastro (mesma pessoa, duas empresas; João/GoLink 10/09). */
  customerName?: string | null
  value: number
  /** Descrição da parcela no Asaas — vai para a variável {descricao} do template. */
  description?: string | null
  /** Juros + multa já calculados pelo Asaas (vencida). null/0 = não mostra. */
  interestValue?: number | null
  dueDate: string | null
  daysLate: number | null
  connectionLabel: string
  invoiceUrl: string | null
}

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const br = (iso: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : 'sem data')

/**
 * A linha da carteira entra na mensagem de VENCIDAS? Só com atraso de 1 dia ou
 * mais. Parcela a vencer que está aberta na carteira (criada pelo CRM, ou com o
 * vencimento movido) saía como "venceu em" uma data futura, e ao mesmo tempo
 * no lembrete. Sem data conhecida continua entrando, como antes.
 */
export function countsAsOverdue(daysLate: number | null): boolean {
  return daysLate == null || daysLate >= 1
}

/**
 * O resumo da dívida que vai NA mensagem. Fatos apenas — a IA escreve o texto
 * ao redor, mas os números vêm daqui prontos, para ela nunca ter que somar
 * (é o tipo de coisa que um modelo erra e ninguém percebe).
 *
 * `multiAccount` marca de qual conta é cada parcela, e só aparece quando há
 * mais de uma conta envolvida — no caso normal ninguém precisa ver isso.
 */
export interface SummaryItem {
  line: string
  /** Link de pagamento DESTA parcela (null quando o Asaas não devolveu). */
  url: string | null
}

export interface SummaryOptions {
  /** false = linha sem R$ (só vencimento, atraso e link) e sem "Total". Padrão true. */
  showValues?: boolean
}

export function formatDebtSummary(
  charges: ChargeLine[],
  opts: SummaryOptions = {},
): {
  total: number
  /** Total já com juros e multa do Asaas (= total quando nada foi informado). */
  totalWithInterest: number
  /** Ecoa a opção: quem monta o texto (fallback/IA) sabe se pode citar reais. */
  showValues: boolean
  lines: string[]
  links: string[]
  items: SummaryItem[]
} {
  const showValues = opts.showValues !== false
  const multiAccount = new Set(charges.map((c) => c.connectionLabel)).size > 1
  // Mesma pessoa com dois cadastros (duas empresas): cada linha diz de qual é.
  const multiCustomer = new Set(charges.map((c) => (c.customerName ?? '').trim()).filter(Boolean)).size > 1
  const ordered = [...charges].sort((a, b) => (b.daysLate ?? -1) - (a.daysLate ?? -1))
  const interestOf = (c: ChargeLine) => (typeof c.interestValue === 'number' && c.interestValue > 0 ? c.interestValue : 0)

  const items = ordered.map((c) => {
    const atraso = c.daysLate == null ? '' : c.daysLate > 0 ? ` (${c.daysLate} ${c.daysLate === 1 ? 'dia' : 'dias'} de atraso)` : ''
    const conta = multiAccount ? ` — ${c.connectionLabel}` : ''
    const quem = multiCustomer && (c.customerName ?? '').trim() ? ` · ${(c.customerName ?? '').trim()}` : ''
    // 10/09 (João): "tem que exibir o valor total com os juros" — o Asaas já calcula.
    const juros = interestOf(c) > 0 ? ` (${brl(c.value + interestOf(c))} com juros e multa)` : ''
    // 10/09 (João, mais tarde): "remove tudo que é valor, só vencimento, dias e link".
    const valor = showValues ? `${brl(c.value)}${juros} · ` : ''
    const vencimento = showValues ? `venceu em ${br(c.dueDate)}` : `Venceu em ${br(c.dueDate)}`
    return { line: `${valor}${vencimento}${atraso}${quem}${conta}`, url: c.invoiceUrl ?? null }
  })

  const links = [...new Set(ordered.map((c) => c.invoiceUrl).filter((u): u is string => !!u))]
  const total = ordered.reduce((sum, c) => sum + c.value, 0)
  const totalWithInterest = ordered.reduce((sum, c) => sum + c.value + interestOf(c), 0)
  return { total, totalWithInterest, showValues, lines: items.map((i) => i.line), links, items }
}

/** "Total: R$ 400,00 (R$ 425,10 com juros e multa)" — só quando há juros a mostrar. */
export function formatDebtTotal(summary: { total: number; totalWithInterest: number }): string {
  const withInterest = summary.totalWithInterest > summary.total + 0.005 ? ` (${brl(summary.totalWithInterest)} com juros e multa)` : ''
  return `${brl(summary.total)}${withInterest}`
}

/**
 * Corpo da mensagem: uma linha por parcela. Com UMA parcela o link vai no fim
 * ("Para pagar: …"); com várias, cada parcela leva o próprio link logo
 * abaixo — 09/09 (João/GoLink, "quando o cliente tem 3 boletos vencidos"):
 * antes a mensagem com 2+ parcelas saía SEM link nenhum.
 */
export function formatDebtBody(summary: { items: SummaryItem[]; links: string[] }): string {
  const multi = summary.links.length > 1
  return summary.items.map((i) => (multi && i.url ? `• ${i.line}\n  ${i.url}` : `• ${i.line}`)).join('\n')
}

/** Instrução pra IA sobre os links: um só no fim, ou um por parcela. */
export function linksInstruction(summary: { items: SummaryItem[]; links: string[] }): string {
  if (summary.links.length === 1) return `Inclua este link de pagamento no final: ${summary.links[0]}`
  if (summary.links.length > 1) {
    const list = summary.items.filter((i) => i.url).map((i) => `${i.line} → ${i.url}`).join('; ')
    return `São ${summary.links.length} parcelas, cada uma com o próprio link de pagamento. Liste cada parcela com o link dela logo abaixo, sem trocar nem omitir nenhum: ${list}`
  }
  return ''
}

// ------------------------------------------------- lembrete antes de vencer

export interface UpcomingLine {
  value: number
  /** Descrição da parcela no Asaas — vai para a variável {descricao} do template. */
  description?: string | null
  dueDate: string | null
  /** Dias até vencer (0 = hoje). */
  daysUntil: number | null
  connectionLabel: string
  invoiceUrl: string | null
}

/**
 * Resumo do que AINDA VAI vencer — o texto do lembrete. Mesma regra do resumo
 * da dívida: fatos prontos, a IA só escreve ao redor.
 */
export function formatUpcomingSummary(
  charges: UpcomingLine[],
  opts: SummaryOptions = {},
): { total: number; showValues: boolean; lines: string[]; links: string[]; items: SummaryItem[]; minDays: number | null } {
  const showValues = opts.showValues !== false
  const multiAccount = new Set(charges.map((c) => c.connectionLabel)).size > 1
  const ordered = [...charges].sort((a, b) => (a.daysUntil ?? 999) - (b.daysUntil ?? 999))
  const items: SummaryItem[] = ordered.map((c) => {
    const quando =
      c.daysUntil == null ? '' : c.daysUntil <= 0 ? ' (hoje)' : c.daysUntil === 1 ? ' (amanhã)' : ` (em ${c.daysUntil} dias)`
    const conta = multiAccount ? ` — ${c.connectionLabel}` : ''
    const valor = showValues ? `${brl(c.value)} · ` : ''
    const vencimento = showValues ? `vence em ${br(c.dueDate)}` : `Vence em ${br(c.dueDate)}`
    return { line: `${valor}${vencimento}${quando}${conta}`, url: c.invoiceUrl ?? null }
  })
  const links = [...new Set(ordered.map((c) => c.invoiceUrl).filter((u): u is string => !!u))]
  const days = ordered.map((c) => c.daysUntil).filter((d): d is number => d != null)
  return { total: ordered.reduce((s, c) => s + c.value, 0), showValues, lines: items.map((i) => i.line), links, items, minDays: days.length ? Math.min(...days) : null }
}

/**
 * 📵 Uma mensagem de cobrança por pessoa por dia: quem já tem pedido HOJE na
 * fila (pending), aprovado esperando o sender (queued) ou enviado (sent) não
 * recebe outra — vale a primeira, a outra espera o dia seguinte. Expirado,
 * falho e recusado não contam: nada chegou ao cliente.
 */
export function contactedTodaySet(rows: { contactId: string | null; status: string }[]): Set<string> {
  const out = new Set<string>()
  for (const r of rows) {
    if (r.contactId && (r.status === 'pending' || r.status === 'queued' || r.status === 'sent')) out.add(r.contactId)
  }
  return out
}

/**
 * As parcelas que ainda merecem lembrete: tira as já lembradas ou já avisadas
 * como cobrança nova (`notified`, por id do Asaas) e as cujo link já saiu numa
 * mensagem para o cliente (`sentUrls`). Parcela sem link não é descartada pelo
 * link. A ordem original se mantém.
 */
export function freshReminderItems<T extends { id: string; invoiceUrl: string | null }>(
  items: T[],
  notified: ReadonlySet<string>,
  sentUrls: ReadonlySet<string>,
): T[] {
  return items.filter((x) => !notified.has(x.id) && !(x.invoiceUrl && sentUrls.has(x.invoiceUrl)))
}

/**
 * "Já lembrado" POR CONTATO: contato → parcelas (asaasIds) de lembrete ou aviso
 * de cobrança nova nos pedidos lidos.
 *
 * Revisão 16/09 (A vencer sem contato): o conjunto era só por parcela, de todos
 * os contatos. Cliente do Asaas ligado por engano ao contato B recebia o
 * lembrete (ou ele ficava na fila e alguém recusava em "Precisa de você");
 * desligado e ligado ao contato certo A, a parcela contava como já lembrada e A
 * nunca recebia o aviso antes do vencimento. Pedido de OUTRO contato não segura
 * este — o mesmo corte do `linksAlreadySent`, que já é por contato.
 */
export function remindedByContact(rows: readonly { contactId: string | null; payload: unknown }[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const r of rows) {
    if (!r.contactId) continue
    const list = (r.payload as { asaasIds?: unknown } | null)?.asaasIds
    if (!Array.isArray(list)) continue
    let set = out.get(r.contactId)
    for (const id of list) {
      if (typeof id !== 'string' || !id) continue
      if (!set) {
        set = new Set<string>()
        out.set(r.contactId, set)
      }
      set.add(id)
    }
  }
  return out
}

/**
 * O texto contém ESTE link, e não um maior que começa igual? `…/i/123` não pode
 * casar com `…/i/1234`: o caractere logo depois do link tem que encerrar o link
 * (espaço, pontuação, fim do texto, `?`, `/`).
 */
export function textHasUrl(text: string | null | undefined, url: string): boolean {
  if (!text || !url) return false
  for (let i = text.indexOf(url); i >= 0; i = text.indexOf(url, i + 1)) {
    const next = text.charAt(i + url.length)
    if (!next || !/[A-Za-z0-9_-]/.test(next)) return true
  }
  return false
}

/** Texto de segurança do LEMBRETE (sem IA): leve, sem a palavra "atraso". Varia pela semente. */
export function fallbackReminderMessage(
  firstName: string | null,
  summary: ReturnType<typeof formatUpcomingSummary>,
  seed = 0,
  opts: { offerDate?: boolean } = {},
): string {
  const oi = firstName ? `Oi, ${firstName}!` : 'Oi!'
  const aberturas = [
    `${oi} Passando só pra lembrar: tem um valor que vence em breve por aqui:`,
    `${oi} Tudo bem? Um lembrete rápido do que está para vencer:`,
    `${oi} Só pra você não perder a data, fica o lembrete:`,
    `${oi} Aviso amigo: está chegando o vencimento de:`,
  ]
  const fechos = [
    'Se já estiver programado, pode ignorar esta mensagem 😉',
    'Qualquer dúvida, é só responder por aqui.',
    opts.offerDate === false ? 'Se já pagou, desconsidere.' : 'Se precisar de outra data, me avisa por aqui que a gente vê.',
    'Se já pagou, desconsidere — e obrigado!',
  ]
  const s = seed >>> 0
  // 2+ parcelas: cada uma sai com o próprio link embaixo (antes, com mais de
  // um link a mensagem ia SEM link nenhum — João/GoLink, 09/09).
  const corpo = formatDebtBody(summary)
  const link = summary.links.length === 1 ? `\n\nPara pagar: ${summary.links[0]}` : ''
  return `${aberturas[s % 4]}\n\n${corpo}${link}\n\n${fechos[(s >>> 2) % 4]}`
}

/**
 * Texto de segurança do AVISO DO DIA (vence hoje, sem IA): direto e leve, sem
 * "atraso" — hoje ainda não é atraso. Varia pela semente como o lembrete.
 */
export function fallbackDueTodayMessage(
  firstName: string | null,
  summary: ReturnType<typeof formatUpcomingSummary>,
  seed = 0,
  opts: { offerDate?: boolean } = {},
): string {
  const oi = firstName ? `Oi, ${firstName}!` : 'Oi!'
  const aberturas = [
    `${oi} Passando pra lembrar que vence HOJE:`,
    `${oi} Tudo bem? Só um aviso: o vencimento é hoje:`,
    `${oi} Lembrete rápido — vence hoje:`,
    `${oi} Pra não passar do dia, fica o aviso: vence hoje:`,
  ]
  const fechos = [
    'Se já pagou, pode ignorar esta mensagem 😉',
    'Qualquer dúvida, é só responder por aqui.',
    opts.offerDate === false ? 'Se já pagou, desconsidere.' : 'Se precisar de outra data, me avisa por aqui que a gente vê.',
    'Se já está pago, desconsidere — e obrigado!',
  ]
  const s = seed >>> 0
  const corpo = formatDebtBody(summary)
  const link = summary.links.length === 1 ? `\n\nPara pagar: ${summary.links[0]}` : ''
  return `${aberturas[s % 4]}\n\n${corpo}${link}\n\n${fechos[(s >>> 2) % 4]}`
}

/**
 * Texto de segurança usado quando a IA não está disponível. Seco de
 * propósito: é melhor uma mensagem correta e sem graça do que nenhuma — mas
 * ela nunca sai sozinha, porque a régua começa passando pela aprovação.
 *
 * Mesmo sendo o texto de segurança, ele VARIA (05/09): abertura e fechamento
 * sorteados pela semente — dois devedores no mesmo dia não recebem a mesma
 * frase. Semente 0 é o texto original. Valores e link nunca mudam.
 */
export function fallbackMessage(
  firstName: string | null,
  summary: ReturnType<typeof formatDebtSummary>,
  touch: number,
  seed = 0,
  opts: { offerDate?: boolean } = {},
): string {
  const oi = firstName ? `Oi, ${firstName}!` : 'Oi!'
  const primeiras = [
    `${oi} Passando para lembrar de um valor em aberto por aqui:`,
    `${oi} Tudo bem? Vi aqui um valor em aberto e queria te lembrar:`,
    `${oi} Dando um toque rápido: ficou um valor em aberto por aqui:`,
    `${oi} Só para lembrar, ficou pendente por aqui:`,
  ]
  const seguintes = [
    `${oi} Voltando no valor que ficou em aberto:`,
    `${oi} Passando de novo por aqui sobre o valor em aberto:`,
    `${oi} Tudo bem? Ainda consta em aberto por aqui:`,
    `${oi} Retomando o assunto do valor pendente:`,
  ]
  // Sem "combinar uma data" quando a empresa não quer abrir essa porta
  // (João/GoLink 10/09). A resposta do cliente continua pausando a régua.
  const fechos =
    opts.offerDate === false
      ? [
          'Se já pagou, é só me avisar por aqui.',
          'Se já tiver pago, me responde por aqui que eu confiro.',
          'Já pagou? Me conta por aqui.',
          'Qualquer dúvida, é só responder esta mensagem.',
        ]
      : [
          'Se já pagou ou quiser combinar uma data, é só me dizer por aqui.',
          'Se já tiver pago, me avisa por aqui; se preferir combinar uma data, também é só falar.',
          'Já pagou? Me conta por aqui. Se quiser combinar uma data, a gente vê junto.',
          'Qualquer dúvida, ou se quiser combinar uma data, é só responder esta mensagem.',
        ]
  const s = seed >>> 0
  const abre = (touch === 0 ? primeiras : seguintes)[s % 4]
  const corpo = formatDebtBody(summary)
  const total = summary.lines.length > 1 && summary.showValues !== false ? `\n\nTotal: ${formatDebtTotal(summary)}` : ''
  const link = summary.links.length === 1 ? `\n\nPara pagar: ${summary.links[0]}` : ''
  return `${abre}\n\n${corpo}${total}${link}\n\n${fechos[(s >>> 2) % 4]}`
}

// ---------------------------------------------------------------- entrega
// Por onde a cobrança sai. Puro: quem sabe o que o contato tem e o que a conta
// tem passa os fatos; aqui só se decide — e toda recusa diz o que resolver.

export interface DeliveryFacts {
  channel: DeliveryChannel
  hasPhone: boolean
  hasEmail: boolean
  /** null = WhatsApp disponível; senão o motivo (ex.: "escolha o número em Ajustar"). */
  whatsappError: string | null
  /** null = e-mail disponível; senão o motivo (ex.: "nenhum canal de e-mail conectado"). */
  emailError: string | null
  /** O cliente TEM e-mail, mas todos voltaram (email_bounces): o endereço, pra dizer na fila. */
  emailBlocked?: string | null
}

export type DeliveryPlan = { ok: true; whatsapp: boolean; email: boolean; label: string } | { ok: false; error: string }

const planLabel = (wa: boolean, em: boolean) => (wa && em ? 'WhatsApp e e-mail' : wa ? 'WhatsApp' : 'e-mail')

export function deliveryPlan(f: DeliveryFacts): DeliveryPlan {
  const wa = f.hasPhone && !f.whatsappError
  const em = f.hasEmail && !f.emailError
  const waWhy = !f.hasPhone ? 'o contato não tem telefone válido' : f.whatsappError!
  const emWhy = f.emailBlocked && !f.hasEmail
    ? `o e-mail ${f.emailBlocked} voltou (o endereço não existe) — corrija o e-mail do cliente`
    : !f.hasEmail
      ? 'o contato não tem e-mail'
      : f.emailError!

  switch (f.channel) {
    case 'whatsapp':
      return wa ? { ok: true, whatsapp: true, email: false, label: 'WhatsApp' } : { ok: false, error: `A régua cobra só por WhatsApp e ${waWhy}.` }
    case 'email':
      return em ? { ok: true, whatsapp: false, email: true, label: 'e-mail' } : { ok: false, error: `A régua cobra só por e-mail e ${emWhy}.` }
    case 'both':
      if (wa || em) return { ok: true, whatsapp: wa, email: em, label: planLabel(wa, em) }
      return { ok: false, error: `Sem como alcançar: ${waWhy}; ${emWhy}.` }
    default:
      if (wa) return { ok: true, whatsapp: true, email: false, label: 'WhatsApp' }
      if (em) return { ok: true, whatsapp: false, email: true, label: 'e-mail' }
      return { ok: false, error: `Sem como alcançar: ${waWhy}; ${emWhy}.` }
  }
}

// ---------------------------------------------------------- duplicata
/**
 * Mesmo valor e mesmo vencimento em DOIS cadastros diferentes do Asaas é,
 * quase sempre, o mesmo boleto criado duas vezes (Renato ×3, 05/09: 12
 * parcelas em dobro). A régua NÃO cobra esse devedor até uma pessoa resolver
 * no Asaas — cobrar em dobro é pior que atrasar um dia.
 *
 * 16/09: só dentro da MESMA conta do Asaas. O id de cadastro de duas contas
 * é sempre diferente, e a mesma mensalidade nas duas contas (GoLink tem duas
 * empresas) virava "duplicata" e a régua nunca cobrava ninguém ali.
 * Dentro da conta, dois cadastros com documentos DIFERENTES (CPF da pessoa e
 * CNPJ da empresa dela, mesmo plano) também não são — o dobro do Renato era
 * cadastro sem documento ou com o mesmo.
 */
export function duplicateSuspects(
  charges: { customerId?: string | null; connectionId?: string | null; document?: string | null; value: number; dueDate: string | null }[],
): boolean {
  const byKey = new Map<string, Map<string, string>>()
  for (const c of charges) {
    if (!c.customerId || !c.dueDate) continue
    const k = `${c.connectionId ?? ''}|${c.value.toFixed(2)}|${c.dueDate.slice(0, 10)}`
    const seen = byKey.get(k) ?? new Map<string, string>()
    const doc = (c.document ?? '').replace(/\D/g, '')
    for (const [id, otherDoc] of seen) {
      if (id !== c.customerId && (!doc || !otherDoc || doc === otherDoc)) return true
    }
    if (!seen.has(c.customerId) || !seen.get(c.customerId)) seen.set(c.customerId, doc)
    byKey.set(k, seen)
  }
  return false
}

function normalizeTemplatesByKind(raw: unknown): Partial<Record<CollectionTemplateKind, CollectionTemplateRef>> {
  const out: Partial<Record<CollectionTemplateKind, CollectionTemplateRef>> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const kind of COLLECTION_TEMPLATE_KINDS) {
    const v = (raw as Record<string, unknown>)[kind]
    if (!v || typeof v !== 'object') continue
    const name = (v as { name?: unknown }).name
    if (typeof name !== 'string' || !name.trim()) continue
    const language = (v as { language?: unknown }).language
    const params = (v as { params?: unknown }).params
    out[kind] = {
      name: name.trim().slice(0, 200),
      language: typeof language === 'string' && language.trim() ? language.trim().slice(0, 20) : null,
      params: Array.isArray(params) ? params.filter((x): x is string => typeof x === 'string').slice(0, 10) : [],
    }
  }
  return out
}

/**
 * Qual template vale para este tipo de mensagem: o do tipo, senão o padrão,
 * senão nenhum (a régua recusa e explica, em vez de gravar texto que a Meta
 * descarta). Puro.
 */
export function templateForKind(s: Pick<CollectionsSettings, 'templateName' | 'templateLanguage' | 'templateParams' | 'templatesByKind'>, kind: CollectionTemplateKind): CollectionTemplateRef | null {
  const own = s.templatesByKind[kind]
  if (own?.name) return own
  if (s.templateName) return { name: s.templateName, language: s.templateLanguage, params: s.templateParams }
  return null
}

/** O `payload.kind` do pedido → tipo de template. Sem kind = cobrança da régua. */
export function templateKindOf(kind: unknown): CollectionTemplateKind {
  return kind === 'reminder' || kind === 'due_today' || kind === 'new_charge' || kind === 'manual' ? kind : 'collection'
}

export interface TemplateVars {
  nome: string
  /** Total já formatado em reais ("R$ 1.234,50"); vazio quando a conta esconde valores. */
  valor?: string
  link?: string
  /** Vencimento em dd/mm/aaaa — a parcela mais antiga (régua) ou a mais próxima (lembrete). */
  vencimento?: string
  /** Descrição da parcela no Asaas ("RA Play Master") — o "{{2}}" dos templates do cliente. */
  descricao?: string
  /** Dias de atraso (régua) ou até vencer (lembrete); "hoje" no aviso do dia. */
  dias?: string
  parcelas?: string
  /** As parcelas com os links, uma por linha (`formatDebtBody`). Só no texto livre. */
  lista?: string
}

/** Troca as chaves de TEMPLATE_VARS pelos dados da cobrança; chave sem dado vira vazio (a Meta rejeita `{valor}` literal). */
export function fillTemplateParams(params: readonly string[], vars: TemplateVars): string[] {
  return params.map((p) => p.replace(TEMPLATE_VAR_RE, (_m, k: string) => templateVarMap(vars)[k.toLowerCase()] ?? ''))
}

/**
 * Primeira palavra que entrega RAMO de negócio. Nome que começa assim é da
 * empresa inteira, não de uma pessoa: "Drogaria Essência" cumprimenta
 * "Drogaria Essência", nunca "Oi, Drogaria!" (caso real do João, 23/09, e a
 * razão de existir esta lista separada da de `cdl/names.ts` — lá a lista
 * decide se é gente; aqui decide se dá para chamar pelo nome inteiro).
 */
const BUSINESS_FIRST_WORDS = new Set([
  'drogaria', 'farmacia', 'mercado', 'supermercado', 'minimercado', 'mercearia', 'padaria',
  'panificadora', 'acougue', 'oficina', 'auto', 'autopecas', 'borracharia', 'madeireira',
  'marcenaria', 'serralheria', 'vidracaria', 'metalurgica', 'grafica', 'papelaria', 'livraria',
  'lavanderia', 'otica', 'joalheria', 'relojoaria', 'floricultura', 'petshop', 'pet', 'barbearia',
  'salao', 'estetica', 'lanchonete', 'pizzaria', 'churrascaria', 'hamburgueria', 'sorveteria',
  'cafeteria', 'confeitaria', 'doceria', 'buffet', 'restaurante', 'bar', 'adega', 'tabacaria',
  'conveniencia', 'deposito', 'distribuidora', 'transportadora', 'transporte', 'transportes',
  'logistica', 'construtora', 'imobiliaria', 'corretora', 'seguradora', 'agencia', 'escritorio',
  'contabilidade', 'advocacia', 'clinica', 'consultorio', 'laboratorio', 'hospital', 'academia',
  'escola', 'colegio', 'creche', 'autoescola', 'despachante', 'instituto', 'studio', 'estudio',
  'hotel', 'pousada', 'posto', 'igreja', 'condominio', 'associacao', 'cooperativa', 'sindicato',
  'fundacao', 'casa', 'loja', 'sitio', 'chacara', 'materiais', 'ferragem', 'ferragens', 'gesso',
  'guincho', 'entulho', 'grupo', 'comercial', 'industria', 'servicos', 'solucoes',
])

/** O nome do contato é de um NEGÓCIO conhecido pelo ramo? (primeira palavra) */
function looksLikeBusinessName(name: string | null | undefined): boolean {
  const first = (name ?? '')
    .trim()
    .split(/\s+/)
    .map((w) => nameSlug(w))
    .find((w) => w.length > 1)
  return !!first && BUSINESS_FIRST_WORDS.has(first)
}

/** Minúsculo, sem acento e sem pontuação — pra comparar nome de empresa. */
function nameSlug(word: string): string {
  return word
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

/**
 * A PESSOA dentro do nome do contato, quando o Asaas traz a empresa.
 *
 * 🐛 23/09 (João/GoLink, "Marina - Casa da Massa"): o contato do CRM
 * também se chamava "Casa da Massa" (veio da carteira do Asaas) e a regra
 * de ontem tratava isso como "o CRM tem o nome da pessoa" — a saudação ia
 * virar "Oi, Casa!". Nome de negócio não é gente.
 *
 * Três casos, nesta ordem:
 *  1. O contato CONTÉM a empresa e sobra algo ("Marina - Casa da Massa")
 *     → o que sobra é a pessoa que atende: "Marina".
 *  2. O contato repete palavra da empresa mas não a contém inteira
 *     ("Massa Express" para "Casa da Massa") → é o mesmo negócio escrito de
 *     outro jeito: pessoa nenhuma.
 *  3. Sem nada em comum → vale a regra de sempre (firstNameForGreeting), com
 *     um freio: nome ligado por "da/de/do" ("Casa da Massa", "Casa do
 *     Norte") é negócio, não "Fulano da Silva" — a saudação usa a empresa.
 */
export function personInContactName(
  crmName: string | null | undefined,
  asaasName: string | null | undefined,
  /**
   * O cadastro do Asaas é CNPJ? Só então o freio do conectivo vale.
   *
   * 🐛 23/09, achado na revisão: o freio nasceu sem esta condição e valia para
   * TODA saudação — "Maria da Silva" na ficha virava "Oi!" (ou o nome de
   * fantasia do Asaas), porque a segunda palavra é "da". Nome de gente com
   * conectivo é comum; nome de negócio com conectivo só engana quando o outro
   * lado é razão social.
   */
  asaasEhCnpj = false,
): string {
  const tokens = (crmName ?? '').trim().split(/\s+/).filter(Boolean)
  if (!tokens.length) return ''
  const empresa = new Set(
    (asaasName ?? '')
      .split(/\s+/)
      .map(nameSlug)
      .filter((w) => w.length > 2 && !NAME_LEGAL_SUFFIX.has(w) && !NAME_STOPWORDS.has(w)),
  )
  if (empresa.size) {
    const emComum = tokens.filter((t) => empresa.has(nameSlug(t)))
    if (emComum.length) {
      // Só é "pessoa + empresa" quando a empresa INTEIRA está ali dentro.
      if (emComum.length < empresa.size) return ''
      const sobra = tokens.filter((t) => !empresa.has(nameSlug(t)) && !NAME_STOPWORDS.has(nameSlug(t) || t))
      return firstNameForGreeting(sobra.join(' '))
    }
  }
  // "Casa da Massa" sem nada a ver com a razão social: o conectivo entrega o
  // negócio. Só com CNPJ do outro lado — ver o parâmetro `empresa`.
  if (asaasEhCnpj && tokens.length > 2 && NAME_STOPWORDS.has(nameSlug(tokens[1]))) return ''
  // Nome que começa pelo RAMO é da empresa. Chegar aqui significa que não
  // houve pessoa a extrair de dentro dele — "Empresa - Fulana" já saiu acima.
  if (looksLikeBusinessName(crmName)) return ''
  return firstNameForGreeting(crmName)
}

/**
 * Nome da saudação da cobrança (23/09, João/GoLink: "Olá Clínica Jump… pra
 * ficar Olá Jessica preciso trocar tudo no CRM?"). Regra: nome de PESSOA no
 * Asaas manda; se o Asaas tem empresa e o contato do CRM traz gente
 * (`personInContactName`), vale o primeiro nome do contato; senão a empresa
 * como está no Asaas (decisão de 10/09 continua: o apelido do celular nunca
 * substitui um nome de pessoa do Asaas).
 */
export function collectionGreetingName(
  asaasName: string | null | undefined,
  crmName: string | null | undefined,
  /**
   * `contacts.name_source`: o nome do CRM só entra quando alguém o digitou
   * ('crm') ou veio da agenda ('phonebook'). Apelido do WhatsApp ("Jump
   * Odonto 🦷", "Tudo passa 🙏") não vira saudação. `undefined` = não sei a
   * origem, aceita (chamador antigo).
   */
  crmNameSource?: string | null,
  /**
   * CPF/CNPJ do cadastro no Asaas. **CNPJ = razão social**, e razão social
   * não é gente: "Guincho Ribeiro Ltda", "Leva Entulho", "Taubaté Online"
   * passavam por nome de pessoa na lista de palavras e viravam "Oi, Guincho!".
   * Com o documento a decisão é determinística (23/09, João/GoLink
   * renomeando a agenda para "Nome - Empresa").
   */
  asaasDoc?: string | null,
): string | null {
  const asaas = (asaasName ?? '').trim()
  const digits = onlyDigits(asaasDoc)
  const empresa = digits.length === 14
  const crmTrusted = crmNameSource === undefined || crmNameSource === 'crm' || crmNameSource === 'phonebook'
  const crm = crmTrusted ? personInContactName(crmName, asaas, empresa) : ''
  // A empresa, na ordem: como o Asaas escreve; senão o nome do CRM quando ele
  // começa pelo RAMO ("Drogaria Essência", "Marcenaria São José"). Sem isso a
  // saudação cortava na primeira palavra e saía "Bom dia, Drogaria!" (caso
  // real do João, 23/09). `greetingName` tira Ltda/ME e limita o tamanho.
  const empresaLabel = asaas
    ? greetingName(asaas)
    : crmTrusted && looksLikeBusinessName(crmName)
      ? greetingName(crmName)
      : null
  // CNPJ: a pessoa que atende (agenda/ficha) vem primeiro; sem ela, a empresa.
  if (empresa) return crm || empresaLabel
  // CPF ou sem documento: nome de pessoa no Asaas manda (decisão 10/09).
  if (asaas && firstNameForGreeting(asaas)) return greetingName(asaas)
  if (crm) return crm
  // Sem pessoa em lugar nenhum: a empresa; sem empresa, nada ("Oi!") — o nome
  // do CRM já foi julgado "não é pessoa nem negócio" (telefone, frase, apelido).
  return empresaLabel
}

/**
 * Texto de um degrau da cadência própria, com as chaves preenchidas. Vem do
 * cliente, então sai como ele escreveu — a IA não reescreve o que o dono da
 * empresa decidiu dizer (é aqui que mora o aviso de negativação, por exemplo).
 * Chave sem dado vira vazio, nunca `{valor}` literal na cara do devedor.
 */
export function renderStepText(text: string, vars: TemplateVars): string {
  return fillTemplateParams([text], vars)[0] ?? ''
}

const TEMPLATE_VAR_RE = /\{(nome|valor|link|vencimento|descricao|dias|parcelas|lista)\}/gi

function templateVarMap(vars: TemplateVars): Record<string, string> {
  return {
    nome: vars.nome,
    valor: vars.valor ?? '',
    link: vars.link ?? '',
    vencimento: vars.vencimento ?? '',
    descricao: vars.descricao ?? '',
    dias: vars.dias ?? '',
    parcelas: vars.parcelas ?? '',
    lista: vars.lista ?? '',
  }
}

/** Variáveis do template que ficaram VAZIAS depois da troca — a Meta recusa parâmetro vazio ("missing text value"). */
export function missingTemplateVars(params: readonly string[], vars: TemplateVars): string[] {
  const map = templateVarMap(vars)
  // Chave sem dado dentro do parâmetro ("Vence em {dias} dias" → "Vence em  dias")
  // também conta: a Meta aceita, mas o cliente lê um buraco na frase.
  return params.filter((p) => {
    const keys = [...p.matchAll(TEMPLATE_VAR_RE)].map((m) => m[1].toLowerCase())
    return keys.some((k) => (map[k] ?? '').trim() === '')
  })
}

/** Variáveis do template a partir do payload do pedido (régua, lembrete, aviso do dia, cobrança nova). */
export function templateVarsFromPayload(p: Record<string, unknown>): Omit<TemplateVars, 'nome'> {
  const total = typeof p.total === 'number' && Number.isFinite(p.total) ? p.total : null
  const links = Array.isArray(p.links) ? p.links.filter((u): u is string => typeof u === 'string' && !!u) : []
  const charges = typeof p.charges === 'number' ? p.charges : null
  const venc = typeof p.dueDateText === 'string' ? p.dueDateText : ''
  const desc = typeof p.descriptionText === 'string' ? p.descriptionText : ''
  let dias = ''
  if (p.kind === 'due_today') dias = 'hoje'
  else if (typeof p.dueIn === 'number') dias = String(p.dueIn)
  else if (typeof p.maxDaysLate === 'number') dias = String(p.maxDaysLate)
  return {
    valor: total != null ? total.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }) : '',
    link: links[0] ?? '',
    vencimento: venc,
    descricao: desc,
    dias,
    parcelas: charges != null ? String(charges) : '',
  }
}

/**
 * O que o template precisa além do nome e do valor: o VENCIMENTO (dd/mm/aaaa)
 * e a DESCRIÇÃO da parcela no Asaas — os templates de cobrança do cliente
 * falam "a parcela do {{2}}, de {{3}}, venceu em {{4}}". Régua: a parcela mais
 * antiga; lembrete: a mais próxima. Vai no payload do pedido como
 * `dueDateText`/`descriptionText`, pronto para o envio.
 */
export function templateFactsFrom(
  lines: readonly { dueDate: string | null; description?: string | null }[],
  opts: { pick?: 'oldest' | 'nearest' } = {},
): { dueDateText: string; descriptionText: string } {
  const comData = lines.filter((l) => !!l.dueDate).sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))
  const escolhida = opts.pick === 'nearest' ? comData[0] : comData[0]
  const desc = lines.map((l) => (l.description ?? '').trim()).find(Boolean) ?? ''
  return {
    dueDateText: escolhida?.dueDate ? br(escolhida.dueDate) : '',
    descriptionText: desc.slice(0, 120),
  }
}

/**
 * O que vai no BOTÃO do template. Os templates de cobrança costumam ter um
 * botão "Pagar agora" com URL `https://www.asaas.com/i/{{1}}` — a Meta espera
 * só o SUFIXO (o código do link), não a URL inteira. Fora desse formato, ou
 * sem link, devolve null e quem chamou decide (recusar, não estourar).
 */
export function templateButtonValue(buttonUrl: string | null | undefined, invoiceUrl: string | null | undefined): string | null {
  // A query string nunca faz parte do código da cobrança (?utm=…).
  const link = (invoiceUrl ?? '').trim().split('?')[0].replace(/\/+$/, '')
  if (!link) return null
  const tpl = (buttonUrl ?? '').trim()
  // Botão com {{1}} no fim = prefixo fixo + sufixo variável.
  const m = /^(.*?)\{\{\s*1\s*\}\}\s*$/.exec(tpl)
  if (m) {
    const prefixo = m[1]
    if (prefixo && link.startsWith(prefixo)) return link.slice(prefixo.length) || null
    // Prefixo diferente (outro domínio do Asaas, encurtador): manda o último
    // pedaço do link, que é o código da cobrança.
    const code = link.split('/').pop() ?? ''
    return code || null
  }
  // {{1}} no meio da URL (raro): sem como montar com segurança.
  return null
}

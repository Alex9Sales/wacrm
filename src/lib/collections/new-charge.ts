// ============================================================
// 🔗 Aviso de COBRANÇA NOVA — o CRM viu no Asaas uma cobrança que ele mesmo
// não criou e manda o link para o cliente.
//
// Por que existe (11/09, João/GoLink — cobrança de teste do Paulo Exemplo):
// ele criou a cobrança direto no painel do Asaas e o cliente não recebeu nada.
// Três comportamentos corretos somando silêncio:
//   1. os avisos do Asaas estão DESLIGADOS (a pedido dele, pra não pagar a
//      taxa por notificação — `asaasNotificationsOff`);
//   2. a cobrança não nasceu no CRM, então ninguém mandou o link na criação;
//   3. a régua só fala quando passa do atraso mínimo da conta.
// Quem calou o Asaas precisa falar no lugar dele. É isso que esta varredura faz.
//
// 🐛 17/09 (GoLink): o aviso NUNCA disparou. Ele lia `asaas_charges`, e a
// carteira só espelha VENCIDAS — a PENDING criada no painel só aparecia lá
// depois de vencer, fora da janela. Em 15/09 o João criou Ômega Gás, Caçamba
// Exemplo (3x), Beatriz Teste e Numerus no painel e mandou os 4 links à
// mão, do celular; o aviso do CRM não viu nenhum. Agora a varredura pergunta ao
// Asaas, ao vivo, o que foi CRIADO nos últimos dias de envio (só GET) e as
// regras puras (`new-charge-rules.ts`) separam o que é novo de verdade.
//
// Travas, porque aqui o erro é caro (blast):
//   · só quando a conta assumiu os avisos (`asaasNotificationsOff`), e nunca
//     cobrança criada até o dia da primeira varredura depois de ligar (o Asaas
//     avisou até a varredura calar os clientes — revisão 17/09);
//   · só cobrança que o CRM NÃO criou (id, referência ou grupo) — a que ele
//     cria já manda o link na hora;
//   · só o que nasceu nos últimos 2 dias de ENVIO e vence em até 15 dias
//     (renovação de assinatura e parcelas 2..N ficam com o lembrete D-5);
//   · nunca conexão recém-ligada, nem sandbox quando existe produção;
//   · nunca cliente que o PRÓPRIO Asaas ainda avisa (varredura recusada,
//     cliente novo antes da varredura) — dois avisos é pior que um;
//   · uma vez por cobrança; aviso que falhou hoje só volta amanhã;
//   · link que já chegou (à mão ou por outro envio) não sai de novo — aqui,
//     depois de 30 min de carência no sender e de novo no executor;
//   · respeita opt-out, devedor pausado, 1 mensagem de cobrança por pessoa por
//     dia, teto do dia, política e a cadência (mesma fila da régua).
//   Promessa de pagamento NÃO segura: o cliente precisa do link novo (decisão
//   17/09, igual ao executor).
//
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, desc, eq, gte, inArray, ne, notInArray, or, sql } from 'drizzle-orm'

import { db, agentActionRequests, asaasCharges, asaasConnections, collectionsTouches, contacts, conversations, organization } from '@/db'
import { firstOrNull } from '@/db/helpers'
import {
  AsaasApiError,
  fetchCustomers,
  getCustomerPaymentCreatedFlags,
  listPaymentsCreatedSince,
  type AsaasCredential,
  type AsaasCustomer,
  type AsaasEnv,
  type AsaasPayment,
} from '@/lib/asaas/collections'
import { findContact, loadCustomerLinks } from '@/lib/asaas/sync'
import { decide, type AutonomyPolicy } from '@/lib/orchestration/policy'
import type { AccountSettings } from '@/lib/settings/account-settings'
import { decrypt } from '@/lib/whatsapp/encryption'

import { newChargesMessage, type NewChargeLine } from './emit-rules'
import { loadSilenced } from './asaas-silenced'
import { linksAlreadySent } from './links-sent'
import {
  NEW_CHARGE_HORIZON_DAYS,
  asaasNotifies,
  classifyNewCharge,
  isUuidRef,
  ligaAvisosFloor,
  newChargeSince,
  weekdayOfYmd,
  type NewChargeVerdict,
  type PaymentCreatedFlags,
} from './new-charge-rules'
import { resolveCollectionTargets } from './outreach'
import { paymentRefsPayload } from './payment-refs'
import { collectionEmail, dayBlockedReason, duplicateSuspects, type CollectionsSettings,
  collectionGreetingName,
  templateFactsFrom,
} from './rules'
import { localDayKey } from './stale'

/**
 * Conexão ligada há pouco ainda está fazendo carga inicial: tudo que ela tem é
 * histórico, não cobrança nova. Ligar o Asaas com 200 em aberto não pode virar
 * 200 mensagens.
 */
const CONEXAO_NOVA_MS = 3 * 24 * 3_600_000

/** Quanto do histórico de avisos basta para saber o que já foi avisado (a janela é de dias). */
const HISTORICO_AVISOS_MS = 60 * 86_400_000

export type NewChargeSkip =
  | Exclude<NewChargeVerdict, 'ok'>
  | 'conexao_nova'
  | 'sandbox'
  /**
   * "O CRM assume os avisos" ligado há pouco: sem janela até o dia seguinte à
   * primeira varredura completa depois do clique (até lá o Asaas avisava).
   */
  | 'aguardando_varredura'
  /** O Asaas não respondeu (listagem, cadastro ou chaves de aviso; 429). Tenta no próximo tique. */
  | 'conta_indisponivel'
  /** O próprio Asaas avisa este cliente da cobrança criada. */
  | 'asaas_avisa'
  | 'sem_contato'
  | 'ambiguo'
  | 'opt_out'
  | 'pausado'
  /** Já tem mensagem de cobrança hoje (fila, aprovada ou enviada). */
  | 'mesmo_dia'
  /** Mesmo valor e vencimento em dois cadastros da mesma conta. */
  | 'duplicado'
  | 'link_ja_enviado'
  | 'sem_canal'
  | 'politica'
  | 'teto'

export interface NewChargeRunResult {
  queued: number
  /** Cobranças criadas na janela, como o Asaas listou (antes de separar). */
  listed: number
  /** Cobranças novas de verdade (classificadas 'ok'). */
  found: number
  skipped: Partial<Record<NewChargeSkip, number>>
  /** Só com `dryRun`: o que entraria na fila. */
  preview?: { contactId: string; asaasIds: string[]; text: string; delivery: string }[]
}

interface Linha {
  asaasId: string
  connectionId: string
  customerId: string
  document: string | null
  /** Desde quando a cobrança contava como nova na conta dela. */
  since: string
  /** Dia de criação da cobrança no Asaas (YYYY-MM-DD): âncora do "o Asaas já estava calado?". */
  chargeCreated: string
  cust: AsaasCustomer
  line: NewChargeLine
}

interface Candidato {
  contactId: string
  nomeAsaas: string | null
  linhas: Linha[]
}

export async function queueNewChargeNotices(args: {
  accountId: string
  settings: CollectionsSettings
  accountSettings: AccountSettings
  policy: AutonomyPolicy
  agentId: string | null
  /** Quantas ainda cabem no teto do dia. */
  budget: number
  /** Contatos que já têm pedido pendente/aprovado — não empilhamos dois. */
  alreadyQueued: Set<string>
  /** Contatos com mensagem de cobrança hoje (pending/queued/sent) — `contactedTodaySet`. */
  contactedToday: Set<string>
  usedToday: number
  /** Fuso da conta: "hoje", dias de envio e o dia do "liga-avisos". */
  tz: string
  /** Cadastros que o scanUpcoming já abriu nesta rodada (conexão → cliente). */
  customers?: Map<string, Map<string, AsaasCustomer>>
  now?: Date
  /** Conferência: devolve o que entraria (`preview`) sem inserir nem mexer nos conjuntos. */
  dryRun?: boolean
}): Promise<NewChargeRunResult> {
  const out: NewChargeRunResult = { queued: 0, listed: 0, found: 0, skipped: {}, ...(args.dryRun ? { preview: [] } : {}) }
  const bump = (k: NewChargeSkip) => {
    out.skipped[k] = (out.skipped[k] ?? 0) + 1
  }
  const s = args.settings
  // Asaas ainda avisando = ele já manda o link. Dois avisos é pior que nenhum.
  if (!s.asaasNotificationsOff) return out
  if (args.budget <= 0 && !args.dryRun) return out

  const now = args.now ?? new Date()
  const tz = args.tz || 'America/Sao_Paulo'
  const todayKey = localDayKey(tz, now)

  const todas = await db
    .select({
      id: asaasConnections.id,
      label: asaasConnections.label,
      apiKeyEnc: asaasConnections.apiKeyEnc,
      environment: asaasConnections.environment,
      createdAt: asaasConnections.createdAt,
    })
    .from(asaasConnections)
    .where(and(eq(asaasConnections.accountId, args.accountId), eq(asaasConnections.enabled, true)))
  if (!todas.length) return out

  // Sandbox junto com produção é teste: a cobrança de teste casaria com um
  // contato de verdade e viraria WhatsApp real (mesma regra do webhook.ts).
  const temProducao = todas.some((c) => c.environment === 'production')
  const conexoes = todas.filter((c) => {
    if (temProducao && c.environment !== 'production') {
      bump('sandbox')
      return false
    }
    const criada = Date.parse(c.createdAt)
    if (Number.isNaN(criada) || criada > now.getTime() - CONEXAO_NOVA_MS) {
      bump('conexao_nova')
      return false
    }
    return true
  })
  if (!conexoes.length) return out

  // Uma vez por cobrança. Aviso que FALHOU ou EXPIROU não avisou ninguém: pode
  // sair de novo. Exceção: o que falhou HOJE (canal fora do ar, 3 tentativas)
  // só volta amanhã — antes o scanner recriava o pedido a cada tique e o sender
  // tentava 3 vezes cada um, o dia inteiro.
  const noticed = new Set<string>()
  const anteriores = await db
    .select({ payload: agentActionRequests.payload })
    .from(agentActionRequests)
    .where(
      and(
        eq(agentActionRequests.accountId, args.accountId),
        eq(agentActionRequests.actionType, 'collect_charges'),
        sql`${agentActionRequests.payload}->>'kind' = 'new_charge'`,
        gte(agentActionRequests.createdAt, new Date(now.getTime() - HISTORICO_AVISOS_MS).toISOString()),
        or(
          notInArray(agentActionRequests.status, ['failed', 'expired']),
          and(
            eq(agentActionRequests.status, 'failed'),
            sql`to_char(${agentActionRequests.createdAt} AT TIME ZONE ${tz}, 'YYYY-MM-DD') = ${todayKey}`,
          ),
        ),
      ),
    )
  for (const r of anteriores) {
    const list = (r.payload as { asaasIds?: unknown } | null)?.asaasIds
    if (Array.isArray(list)) for (const id of list) if (typeof id === 'string') noticed.add(id)
  }

  // Referência do CRM: conversa ou contato desta conta (cobrança e cliente que o
  // CRM cria levam esse id) ou uma conta da plataforma (a assinatura do próprio
  // CRM na conta Fluxia leva o id da organização — subscribe-actions.ts).
  const refVisto = new Set<string>()
  const crmRefs = new Set<string>()
  const conferirRefs = async (valores: readonly (string | null | undefined)[]) => {
    const novos = [...new Set(valores.filter(isUuidRef).map((v) => v.trim().toLowerCase()))].filter((v) => !refVisto.has(v))
    if (!novos.length) return
    for (const v of novos) refVisto.add(v)
    const achados = [
      ...(await db.select({ id: conversations.id }).from(conversations).where(and(eq(conversations.accountId, args.accountId), inArray(conversations.id, novos)))),
      ...(await db.select({ id: contacts.id }).from(contacts).where(and(eq(contacts.accountId, args.accountId), inArray(contacts.id, novos)))),
      ...(await db.select({ id: organization.id }).from(organization).where(inArray(organization.id, novos))),
    ]
    for (const r of achados) crmRefs.add(String(r.id).toLowerCase())
  }
  const isCrmRef = (ref?: string | null) => !!ref && crmRefs.has(ref.trim().toLowerCase())

  // Piso do "CRM assume os avisos": o dia SEGUINTE à primeira varredura completa
  // depois de ligar — não ao clique (revisão 17/09). Ligada na sexta 17h30, a
  // varredura só roda segunda 9h; o Asaas avisou as cobranças do fim de semana
  // e, com o piso no sábado, o CRM mandava o mesmo link de novo na segunda.
  const dayOf = (iso: string) => localDayKey(tz, new Date(iso))
  const ligaAvisos = ligaAvisosFloor(s.asaasNotificationsOffAt, s.asaasNotificationsSweptAt, dayOf)
  const pisoLigaAvisos = ligaAvisos.wait ? null : ligaAvisos.floor
  const isSendingDay = (ymd: string) => !dayBlockedReason(weekdayOfYmd(ymd), s, ymd)

  const credPor = new Map<string, AsaasCredential>()
  const porContato = new Map<string, Candidato>()

  for (const c of conexoes) {
    if (ligaAvisos.wait) {
      bump('aguardando_varredura')
      continue
    }
    const since = newChargeSince(todayKey, [localDayKey(tz, new Date(c.createdAt)), pisoLigaAvisos], isSendingDay)
    // Piso no futuro (a varredura foi hoje): sem janela até amanhã. Trazer para
    // hoje punha na janela a cobrança das 08:00 que o Asaas avisou antes de a
    // varredura das 10:30 calar o cliente (revisão 17/09).
    if (since > todayKey) {
      bump('aguardando_varredura')
      continue
    }
    let cred: AsaasCredential
    try {
      cred = { apiKey: decrypt(c.apiKeyEnc), environment: c.environment as AsaasEnv }
    } catch {
      bump('conta_indisponivel')
      continue
    }

    let pays: AsaasPayment[]
    try {
      pays = await listPaymentsCreatedSince(cred, since)
    } catch (err) {
      bump('conta_indisponivel')
      console.warn(`[cobranca nova] ${c.label}: não deu para listar as cobranças criadas — ${err instanceof Error ? err.message : err}`)
      continue
    }
    out.listed += pays.length
    if (!pays.length) continue

    // O que o CRM criou está na carteira com origin <> 'sync' (só a 1ª parcela;
    // o grupo — parcelamento/assinatura — leva as outras junto). Assinatura do
    // CRM cuja 1ª parcela não nasceu a tempo de entrar na carteira (emit.ts)
    // cai pela referência, que o Asaas repassa (Tio Burguer): ninguém manda o
    // link na criação e o lembrete D-5 cobre — limitação conhecida.
    const doCrm = await db
      .select({ asaasId: asaasCharges.asaasId })
      .from(asaasCharges)
      .where(
        and(
          eq(asaasCharges.accountId, args.accountId),
          inArray(asaasCharges.asaasId, pays.map((p) => p.id)),
          ne(asaasCharges.origin, 'sync'),
        ),
      )
    const crmPaymentIds = new Set(doCrm.map((r) => r.asaasId))
    await conferirRefs(pays.map((p) => p.externalReference))
    const crmGroups = new Set<string>()
    for (const p of pays) {
      if (!crmPaymentIds.has(p.id) && !isCrmRef(p.externalReference)) continue
      if (p.installment) crmGroups.add(p.installment)
      if (p.subscription) crmGroups.add(p.subscription)
    }

    const novas: AsaasPayment[] = []
    for (const p of pays) {
      const v = classifyNewCharge(p, { since, todayKey, horizonDays: NEW_CHARGE_HORIZON_DAYS, noticed, crmPaymentIds, crmRefs, crmGroups })
      if (v === 'ok') novas.push(p)
      else bump(v)
    }
    if (!novas.length) continue
    out.found += novas.length

    // Cadastros: primeiro os que o scanUpcoming já abriu nesta rodada; o resto
    // em série, só os que faltam. 429 não derruba a rodada: pula esta conta.
    const clientes = new Map<string, AsaasCustomer>()
    const cache = args.customers?.get(c.id)
    const faltam: string[] = []
    for (const id of new Set(novas.map((p) => p.customer))) {
      const hit = cache?.get(id)
      if (hit) clientes.set(id, hit)
      else if (id) faltam.push(id)
    }
    if (faltam.length) {
      try {
        for (const [id, cust] of await fetchCustomers(cred, faltam)) clientes.set(id, cust)
      } catch (err) {
        bump('conta_indisponivel')
        console.warn(`[cobranca nova] ${c.label}: não deu para abrir os clientes — ${err instanceof Error ? err.message : err}`)
        continue
      }
    }
    await conferirRefs([...clientes.values()].map((x) => x.externalReference))
    credPor.set(c.id, cred)

    const links = await loadCustomerLinks(args.accountId, c.id)
    for (const p of novas) {
      const cust = clientes.get(p.customer)
      if (!cust) {
        bump('conta_indisponivel')
        continue
      }
      const decision = await findContact(
        args.accountId,
        cust.mobilePhone || cust.phone || null,
        cust.email ?? null,
        cust.cpfCnpj ?? null,
        links.get(p.customer) ?? null,
      )
      if (!decision.contactId) {
        // Beatriz e Numerus (15/09): o cadastro do Asaas não tem telefone e
        // nada casa. Sem tela nova nesta entrega: fica no log com o id.
        bump(decision.ambiguous ? 'ambiguo' : 'sem_contato')
        console.log(
          `[cobranca nova] ${c.label}: cobrança ${p.id} (cliente ${p.customer}) ${decision.ambiguous ? 'casa com mais de um contato' : 'sem contato no CRM'} — não avisada`,
        )
        continue
      }
      let cand = porContato.get(decision.contactId)
      if (!cand) {
        cand = { contactId: decision.contactId, nomeAsaas: (cust.name ?? '').trim() || null, linhas: [] }
        porContato.set(decision.contactId, cand)
      }
      if (!cand.nomeAsaas && cust.name) cand.nomeAsaas = cust.name.trim() || null
      cand.linhas.push({
        asaasId: p.id,
        connectionId: c.id,
        customerId: p.customer,
        document: cust.cpfCnpj ?? null,
        since,
        chargeCreated: (p.dateCreated ?? '').slice(0, 10),
        cust,
        line: {
          value: Number(p.value ?? 0),
          dueDate: (p.dueDate ?? '').slice(0, 10),
          description: p.description ?? '',
          url: p.invoiceUrl!,
        },
      })
    }
  }
  if (!porContato.size) return out

  const ids = [...porContato.keys()]
  const fichas = await db
    .select({ id: contacts.id, name: contacts.name, nameSource: contacts.nameSource, optedOut: contacts.optedOut })
    .from(contacts)
    .where(and(eq(contacts.accountId, args.accountId), inArray(contacts.id, ids)))
  const fichaPor = new Map(fichas.map((r) => [r.id, r]))

  const pausados = await db
    .select({ contactId: collectionsTouches.contactId })
    .from(collectionsTouches)
    .where(and(eq(collectionsTouches.accountId, args.accountId), eq(collectionsTouches.paused, true), inArray(collectionsTouches.contactId, ids)))
  const pausado = new Set(pausados.map((r) => r.contactId))

  // Chaves de aviso do Asaas por cliente, uma vez por rodada (null = não deu
  // para ler nesta rodada; 429 para de perguntar àquela conta).
  const flagsCache = new Map<string, PaymentCreatedFlags | null>()
  const contaSemFolego = new Set<string>()
  const flagsOf = async (l: Linha): Promise<PaymentCreatedFlags | null> => {
    const key = `${l.connectionId}|${l.customerId}`
    if (flagsCache.has(key)) return flagsCache.get(key) ?? null
    const cred = credPor.get(l.connectionId)
    let flags: PaymentCreatedFlags | null = null
    if (cred && !contaSemFolego.has(l.connectionId)) {
      try {
        flags = await getCustomerPaymentCreatedFlags(cred, l.customerId)
      } catch (err) {
        if (err instanceof AsaasApiError && err.status === 429) contaSemFolego.add(l.connectionId)
      }
    }
    flagsCache.set(key, flags)
    return flags
  }

  // Quando o CRM calou cada cliente calado (um MGET por rodada). null = Redis
  // fora: "não sei" — as chaves do Asaas decidem, o lado conservador.
  const calados = await loadSilenced(
    [...porContato.values()]
      .flatMap((cand) => cand.linhas)
      .filter((l) => l.cust.notificationDisabled === true && !isCrmRef(l.cust.externalReference))
      .map((l) => ({ connectionId: l.connectionId, customerId: l.customerId })),
  )
  const silencedOf = (l: Linha) => (calados ? (calados.get(`${l.connectionId}|${l.customerId}`) ?? null) : undefined)

  let budget = args.budget
  let usedToday = args.usedToday

  // Vence antes, sai antes: se o teto cortar, corta quem ainda tem dias.
  const menorVencimento = (c: Candidato) => c.linhas.map((l) => l.line.dueDate).sort()[0] ?? '9999-12-31'
  const fila = [...porContato.values()].sort((a, b) => menorVencimento(a).localeCompare(menorVencimento(b)))

  for (const cand of fila) {
    if (budget <= 0) {
      bump('teto')
      break
    }
    const ficha = fichaPor.get(cand.contactId)
    if (!ficha) {
      bump('sem_contato')
      continue
    }
    if (ficha.optedOut) {
      bump('opt_out')
      continue
    }
    if (pausado.has(cand.contactId)) {
      bump('pausado')
      continue
    }
    // Uma mensagem de cobrança por pessoa por dia (decisão 17/09): o aviso vem
    // antes da régua na rodada, mas quem já recebeu algo hoje espera o próximo
    // dia de envio — ainda dentro da janela de 2 dias.
    if (args.contactedToday.has(cand.contactId) || args.alreadyQueued.has(cand.contactId)) {
      bump('mesmo_dia')
      continue
    }
    if (
      duplicateSuspects(
        cand.linhas.map((l) => ({ customerId: l.customerId, connectionId: l.connectionId, document: l.document, value: l.line.value, dueDate: l.line.dueDate })),
      )
    ) {
      bump('duplicado')
      continue
    }

    // Link que já chegou numa mensagem para ele (o João colou à mão, ou um
    // aviso anterior que deu 'failed' mas entregou) não sai de novo. Desde a
    // véspera do começo da janela: cobre o link mandado no dia da criação.
    const desde = cand.linhas.map((l) => l.since).sort()[0]
    const jaChegou = await linksAlreadySent(
      args.accountId,
      cand.contactId,
      cand.linhas.map((l) => l.line.url),
      new Date(Date.parse(`${desde}T00:00:00Z`) - 86_400_000).toISOString(),
    )
    let linhas = cand.linhas.filter((l) => !jaChegou.has(l.line.url))
    if (!linhas.length) {
      bump('link_ja_enviado')
      continue
    }

    // O próprio Asaas avisa este cliente? Só pergunta a quem passou por todas
    // as travas acima: cada pergunta é um GET, a cada tique de 10 min.
    const semAviso: Linha[] = []
    let naoDeuPraLer = false
    for (const l of linhas) {
      // Âncora na COBRANÇA e no registro de quando o CRM calou o cliente — o
      // veredito não muda de um dia para o outro (revisão 17/09).
      const quemCtx = { chargeId: l.asaasId, chargeCreated: l.chargeCreated, isCrmRef, silenced: silencedOf(l), dayOf }
      let quem = asaasNotifies(l.cust, quemCtx)
      if (quem === 'need_flags') {
        const flags = await flagsOf(l)
        if (!flags) {
          naoDeuPraLer = true
          break
        }
        quem = asaasNotifies(l.cust, quemCtx, flags)
      }
      if (quem === 'yes') bump('asaas_avisa')
      else semAviso.push(l)
    }
    // Sem a resposta de um deles, ninguém do contato sai agora: 10 min depois
    // tenta de novo — mandar só parte faria o resto esperar outro dia.
    if (naoDeuPraLer) {
      bump('conta_indisponivel')
      continue
    }
    linhas = semAviso
    if (!linhas.length) continue

    const email = linhas.map((l) => collectionEmail(l.cust.email)).find((e): e is string => !!e) ?? null
    const delivery = await resolveCollectionTargets(args.accountId, cand.contactId, null, { dryRun: true, fallbackEmail: email })
    if (!delivery.ok) {
      bump('sem_canal')
      continue
    }

    // Nome de pessoa no Asaas prevalece (10/09); empresa no Asaas + pessoa na
    // ficha → cumprimenta a pessoa (23/09, collectionGreetingName).
    const saudacao = collectionGreetingName(cand.nomeAsaas, ficha.name, ficha.nameSource, linhas.find((l) => l.document)?.document ?? null)
    const texto = newChargesMessage(
      saudacao,
      linhas.map((l) => l.line),
      { showValues: s.showValues },
    )

    const conv = firstOrNull(
      await db
        .select({ id: conversations.id, aiOff: conversations.aiAutoreplyDisabled })
        .from(conversations)
        .where(and(eq(conversations.accountId, args.accountId), eq(conversations.contactId, cand.contactId)))
        .orderBy(desc(conversations.lastMessageAt))
        .limit(1),
    )
    const decision = decide({
      action: 'collect_charges',
      policy: args.policy,
      accountPaused: args.accountSettings.autonomyPaused === true,
      accountMode: args.accountSettings.aiMode ?? 'on',
      withinHours: true,
      optedOut: false,
      humanActiveRecently: false,
      aiDisabledInConversation: s.autoSend ? false : conv?.aiOff === true,
      usedToday,
      messagesToday: usedToday,
      usedForDealToday: 0,
    })
    if (decision.decision === 'blocked') {
      bump(/teto/i.test(decision.reason) ? 'teto' : 'politica')
      continue
    }

    const refs = linhas.map((l) => ({ asaasId: l.asaasId, connectionId: l.connectionId }))
    if (args.dryRun) {
      out.preview!.push({ contactId: cand.contactId, asaasIds: refs.map((r) => r.asaasId), text: texto, delivery: delivery.label })
      budget -= 1
      usedToday += 1
      continue
    }

    const [queuedRow] = await db
      .insert(agentActionRequests)
      .values({
        accountId: args.accountId,
        agentId: args.agentId,
        contactId: cand.contactId,
        dealId: null,
        conversationId: conv?.id ?? null,
        actionType: 'collect_charges',
        payload: {
          kind: 'new_charge',
          ...paymentRefsPayload(refs),
          // O executor confere estes links de novo na hora do envio (actions.ts).
          links: linhas.map((l) => l.line.url),
          charges: linhas.length,
          greetingName: saudacao,
          ...templateFactsFrom(linhas.map((l) => ({ dueDate: l.line.dueDate, description: l.line.description })), { pick: 'nearest' }),
          total: linhas.reduce((acc, l) => acc + l.line.value, 0),
          touch: 0,
          delivery: delivery.label,
          // Cliente só com e-mail no Asaas (canal "both"/e-mail): o executor usa.
          ...(email ? { asaasEmail: email } : {}),
        },
        suggestedText: texto,
        reason:
          (linhas.length === 1 ? 'Cobrança nova no Asaas' : `${linhas.length} cobranças novas no Asaas`) +
          ' que o CRM não criou — o cliente ainda não recebeu o link (os avisos do Asaas estão desligados).' +
          ' Se o link já tiver chegado ao cliente (mandado à mão), não repete — no envio automático espera 30 min para conferir.' +
          ` Vai por ${delivery.label}.`,
        decision: decision.decision === 'auto_execute' ? 'auto' : decision.decision === 'request_approval' ? 'approve' : 'suggest',
        policy: decision.reason,
        status: 'pending',
      })
      .onConflictDoNothing()
      .returning({ id: agentActionRequests.id })
    // Pedido pendente do mesmo contato criado por outra rodada ao mesmo tempo:
    // o índice único recusa e o aviso sai numa próxima (não derruba o lote).
    if (!queuedRow) {
      bump('mesmo_dia')
      continue
    }
    args.alreadyQueued.add(cand.contactId)
    args.contactedToday.add(cand.contactId)
    out.queued += 1
    budget -= 1
    usedToday += 1
  }

  return out
}

// ============================================================
// 🧾 Emitir cobrança no Asaas — pela IA (`criar_cobranca`) ou à mão.
//
// Núcleo comum (`createChargeForContact`), nesta ordem (15/09):
//   1. contato → documento (digitado > carteira > ficha) → conta do Asaas
//      (a conta segue o cliente, connection-pick) — só banco, ZERO chamada;
//   2. produção sem documento (ou digitado inválido) → recusa sem tocar no
//      Asaas: antes o cliente nascia lá órfão e só a cobrança era recusada;
//   3. duplicata na mesma conta do Asaas reaproveita o link (lição do pedido 3×);
//   4. reencontra o cliente na conta escolhida; se não existe lá mas existe
//      noutra conta ligada, recusa (escolhida por gente) ou troca (IA/dono);
//   5. cria/completa o cliente e cria a cobrança;
//   6. grava em asaas_charges com a origem ('ai' | 'manual') — a cobrança já
//      nasce dentro do ciclo: se vencer a régua pega, se pagar o webhook fecha;
//   7. nota interna com o que foi feito, sempre que há conversa.
//
// Em cima dele, a IA (`emitChargeFromDirective`) passa pelas travas
// determinísticas (emit-rules: teto por conta, janela de vencimento, descrição)
// e avisa uma pessoa quando não pode. A emissão manual (Cobranças → Nova
// cobrança) não tem teto: quem decide é gente.
//
// Nunca lança: o atendimento não pode cair por causa de cobrança.
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, desc, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'

import { db, asaasCharges, contactCustomValues, contacts, customFields, member, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import {
  AsaasDocumentRequiredError,
  createPayment,
  createSubscription,
  findCustomer,
  findCustomerByDocument,
  findOrCreateCustomer,
  listSubscriptionPayments,
  type AsaasBillingType,
  type AsaasCustomer,
  type AsaasCustomerAddress,
  type AsaasCustomerInput,
  type AsaasCredential,
  type AsaasEnv,
  type AsaasPayment,
} from '@/lib/asaas/collections'
import { postInternalNote } from '@/lib/ai/close-actions'
import { notifyUsers } from '@/lib/orchestration/actions'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { decrypt } from '@/lib/whatsapp/encryption'
import { toBrE164IfNational } from '@/lib/whatsapp/phone-utils'

import {
  connectionHistoryFor,
  decideConnection,
  decideCustomerHome,
  enabledConnectionsOf,
  type ConnectionHistoryRow,
  type ConnectionSource,
  type HomeCandidate,
} from './connection-pick'
import {
  chargeNeedsDocument,
  DOCUMENT_REQUIRED_REASON,
  findDocumentInText,
  INVALID_DOCUMENT_REASON,
  normalizeValidDocument,
  onlyDigits,
  pickChargeDocument,
  type ChargeDocumentPick,
  type ChargeDocumentSource,
} from './document'
import { EMIT_DEFAULTS, findDuplicateCharge, parseDueDate, parseValue, validateEmit } from './emit-rules'
import { normalizeSettings } from './rules'

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const br = (ymd: string) => ymd.slice(0, 10).split('-').reverse().join('/')

/** "A", "A e B", "A, B e C" */
const joinLabels = (labels: readonly string[]) =>
  labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} e ${labels[labels.length - 1]}`

// ---------------------------------------------------------------- núcleo

export interface CreateChargeInput {
  accountId: string
  contactId: string
  /** Conversa onde a nota interna entra (null = sem nota). */
  conversationId: string | null
  /**
   * Conta do Asaas ESCOLHIDA por gente (tela). null = ninguém escolheu (IA,
   * dono): vale a regra — a conta da última cobrança do cliente, a única, ou a
   * 1ª ligada — e a salvaguarda pode trocar para a conta onde o cliente existe.
   */
  connectionId: string | null
  value: number
  /** YYYY-MM-DD */
  dueDate: string
  description: string
  origin: 'ai' | 'manual'
  /** "pela IA" / "por Danyela" — entra na nota interna. */
  actorLabel: string
  /** Complemento da nota (ex.: "Link enviado na conversa."). */
  noteSuffix?: string
  /**
   * Forma de pagamento (09/09, João/GoLink: "dá pra escolher só Pix?").
   * UNDEFINED = o cliente escolhe na página do Asaas (Pix, boleto ou cartão).
   * Ignorado quando parcelado (Pix não parcela → UNDEFINED).
   */
  billingType?: AsaasBillingType
  /** CPF/CNPJ que o dono/cliente mandou ou alguém digitou agora. Vence o
   *  conhecido (carteira > campo personalizado); digitado inválido é recusado,
   *  nunca troca em silêncio pelo conhecido. O Asaas de produção exige
   *  documento pra gerar qualquer cobrança (08/09). */
  cpfCnpj?: string | null
  /**
   * E-mail e endereço do cliente, para o cadastro do Asaas (11/09, João/GoLink:
   * "precisa ter email e endereço completo, pois precisa pra depois o Asaas
   * emitir nota fiscal"). Tudo opcional: quem não emite nota não preenche.
   * O CRM não guarda endereço na ficha — vai para o Asaas, que passa a ser a
   * fonte disso e reaproveita nas cobranças seguintes do mesmo cliente.
   */
  email?: string | null
  billingAddress?: AsaasCustomerAddress | null
  /** Parcelas (2–60): o Asaas cria N cobranças; a 1ª volta aqui. */
  installments?: number | null
  /**
   * Assinatura sem fim (10/09, João/GoLink: "trabalho com assinatura, todo mês
   * chega a cobrança"): o Asaas gera uma cobrança por mês a partir de `dueDate`.
   * Ignora `installments`. A 1ª cobrança entra na carteira aqui; as seguintes
   * chegam pela sincronização/lembrete conforme o Asaas as cria.
   */
  recurring?: 'MONTHLY' | null
  /**
   * "Cadastrar também nesta conta" (15/09): o cliente existe noutra conta do
   * Asaas e quem escolheu confirmou que é cliente das duas empresas. Pula a
   * salvaguarda da conta.
   */
  allowNewCustomerHere?: boolean
}

/** CPF/CNPJ num campo personalizado do contato (nome do campo com cpf/cnpj/documento). Lança se o banco falhar. */
async function customFieldDocumentOrThrow(accountId: string, contactId: string): Promise<string | null> {
  const rows = await db
    .select({ value: contactCustomValues.value })
    .from(contactCustomValues)
    .innerJoin(customFields, eq(customFields.id, contactCustomValues.customFieldId))
    .where(
      and(
        eq(contactCustomValues.contactId, contactId),
        eq(customFields.accountId, accountId),
        sql`${customFields.fieldName} ~* '(cpf|cnpj|documento)'`,
      ),
    )
    .limit(3)
  for (const r of rows) {
    const doc = normalizeValidDocument(r.value)
    if (doc) return doc
  }
  return null
}

/** CPF/CNPJ num campo personalizado do contato (nome do campo com cpf/cnpj/documento). */
export async function documentFromCustomFields(accountId: string, contactId: string): Promise<string | null> {
  try {
    return await customFieldDocumentOrThrow(accountId, contactId)
  } catch {
    /* sem campo → segue */
    return null
  }
}

/** Guarda o documento no campo personalizado do contato (se a conta tiver um) — "fica cadastrado". */
export async function rememberDocumentOnContact(accountId: string, contactId: string, doc: string): Promise<void> {
  try {
    const field = firstOrNull(
      await db
        .select({ id: customFields.id })
        .from(customFields)
        .where(and(eq(customFields.accountId, accountId), eq(customFields.entity, 'contact'), sql`${customFields.fieldName} ~* '(cpf|cnpj|documento)'`))
        .limit(1),
    )
    if (!field) return
    await db
      .insert(contactCustomValues)
      .values({ contactId, customFieldId: field.id, value: doc })
      .onConflictDoUpdate({ target: [contactCustomValues.contactId, contactCustomValues.customFieldId], set: { value: doc } })
  } catch {
    /* rastro, não requisito */
  }
}

export type CreateChargeOutcome =
  | {
      ok: true
      chargeId: string
      /** Vazio SÓ em assinatura cuja 1ª cobrança o Asaas ainda não gerou. */
      invoiceUrl: string
      reused: boolean
      connectionLabel: string
      /** Conta do Asaas onde a cobrança ficou de fato. */
      connectionId: string
      /** Ninguém escolheu a conta e o cliente só existia noutra: a cobrança foi gerada lá. */
      switchedToHome?: boolean
      /** Preenchido quando nasceu uma assinatura (recorrência). */
      subscriptionId?: string | null
    }
  | {
      ok: false
      reason: string
      /** Falta CPF/CNPJ (ou o digitado é inválido) — quem chamou pede o documento. Nada foi criado no Asaas. */
      needsDocument?: boolean
      /** O documento DIGITADO não passa nos verificadores. */
      invalidDocument?: boolean
      /** A conta foi escolhida por gente e o cliente já está cadastrado nesta outra. Nada foi criado. */
      otherConnection?: { id: string; label: string }
    }

/**
 * Último CPF/CNPJ que a carteira viu para este contato, com o nome do cadastro
 * no Asaas. Primeiro o de cobrança NOSSA (origin ai/manual) ou casada à mão/por
 * código; só depois a sincronizada casada por telefone — que pode ser de outra
 * pessoa (15/09: cobrança do Sérgio Lemes casada com o número do João).
 */
export async function walletDocumentFor(accountId: string, contactId: string): Promise<{ doc: string; customerName: string | null } | null> {
  const rows = await db
    .select({ doc: asaasCharges.cpfCnpj, customerName: asaasCharges.customerName })
    .from(asaasCharges)
    .where(and(eq(asaasCharges.accountId, accountId), eq(asaasCharges.contactId, contactId), isNotNull(asaasCharges.cpfCnpj)))
    .orderBy(
      sql`CASE WHEN "asaas_charges"."origin" IN ('ai', 'manual') OR "asaas_charges"."matched_by" IN ('manual', 'code') THEN 0 ELSE 1 END`,
      desc(asaasCharges.createdAt),
    )
    .limit(10)
  for (const r of rows) {
    const d = (r.doc ?? '').replace(/\D/g, '')
    if (d.length === 11 || d.length === 14) return { doc: d, customerName: r.customerName ?? null }
  }
  return null
}

/** Último CPF/CNPJ que a carteira viu para este contato (cobrança nossa ou sincronizada). */
export async function knownDocumentFor(accountId: string, contactId: string): Promise<string | null> {
  return (await walletDocumentFor(accountId, contactId))?.doc ?? null
}

export interface ResolvedChargeDocument extends ChargeDocumentPick {
  /** Nome do cadastro no Asaas da cobrança que deu o documento (só quando veio da carteira). */
  asaasName: string | null
}

/**
 * O documento que vai para o Asaas — a MESMA regra para tela, IA, dono e o
 * prompt da IA: digitado > carteira > campo personalizado (pickChargeDocument).
 * Só banco, e só consulta carteira/ficha quando o digitado não resolve.
 * Lança se o banco falhar: falha de leitura não pode virar "sem documento".
 */
export async function resolveChargeDocument(accountId: string, contactId: string, typed?: string | null): Promise<ResolvedChargeDocument> {
  const typedPick = pickChargeDocument({ typed })
  if (typedPick.doc || typedPick.invalidTyped) return { ...typedPick, asaasName: null }
  const wallet = await walletDocumentFor(accountId, contactId)
  if (wallet) return { ...pickChargeDocument({ wallet: wallet.doc }), asaasName: wallet.customerName?.trim() || null }
  return { ...pickChargeDocument({ customField: await customFieldDocumentOrThrow(accountId, contactId) }), asaasName: null }
}

// ------------------------------------------------ conta do Asaas (15/09)

type EnabledConnection = Awaited<ReturnType<typeof enabledConnectionsOf>>[number]

/** O que pode sair do servidor sobre uma conexão (nunca a chave). */
export interface ChargeConnectionView {
  id: string
  label: string
  environment: string
}

interface ChargeConnectionPick {
  enabled: EnabledConnection[]
  history: ConnectionHistoryRow[]
  conn: EnabledConnection | null
  source: ConnectionSource
  historyLabels: string[]
  disabledHomeLabel?: string
}

const viewOf = (c: { id: string; label: string; environment: string }): ChargeConnectionView => ({ id: c.id, label: c.label, environment: c.environment })

/** Com uma conta só não há o que decidir: nem lê o histórico (zero custo para quem tem uma). */
async function chooseConnection(accountId: string, contactId: string, requestedId: string | null, doc: string | null): Promise<ChargeConnectionPick> {
  const enabled = await enabledConnectionsOf(accountId)
  const history = enabled.length > 1 ? await connectionHistoryFor(accountId, contactId, doc ? [doc] : []) : []
  return { enabled, history, ...decideConnection({ enabled, history, requestedId }) }
}

/**
 * A conta que a regra escolhe para este contato (pedida > histórico > única >
 * 1ª ligada), sem chamar o Asaas. Para a tela pré-selecionar e o dono ver a
 * conta na proposta. `enabledCount` diz se há o que escolher.
 */
export async function pickChargeConnection(
  accountId: string,
  contactId: string,
  requestedId: string | null = null,
  typed?: string | null,
): Promise<{
  enabledCount: number
  connection: ChargeConnectionView | null
  source: ConnectionSource
  historyLabels: string[]
  disabledHomeLabel?: string
}> {
  const enabled = await enabledConnectionsOf(accountId)
  const doc = enabled.length > 1 ? (await resolveChargeDocument(accountId, contactId, typed)).doc : null
  const history = enabled.length > 1 ? await connectionHistoryFor(accountId, contactId, doc ? [doc] : []) : []
  const d = decideConnection({ enabled, history, requestedId })
  return {
    enabledCount: enabled.length,
    connection: d.conn ? viewOf(d.conn) : null,
    source: d.source,
    historyLabels: d.historyLabels,
    ...(d.disabledHomeLabel ? { disabledHomeLabel: d.disabledHomeLabel } : {}),
  }
}

export type ChargePrecheck =
  | {
      ok: true
      doc: string | null
      source: ChargeDocumentSource | null
      /** Nome do cadastro no Asaas de onde veio o documento (carteira). */
      asaasName: string | null
      connection: ChargeConnectionView
      connectionSource: ConnectionSource
    }
  | {
      ok: false
      reason: string
      needsDocument?: true
      invalidDocument?: true
      /** Não há conta do Asaas ligada (ou a escolhida está desligada). */
      noConnection?: true
    }

function precheckFrom(doc: ResolvedChargeDocument, pick: ChargeConnectionPick, requestedId: string | null): ChargePrecheck {
  if (!pick.conn) {
    return {
      ok: false,
      reason: requestedId ? 'a conta do Asaas escolhida não está ligada' : 'nenhuma conta do Asaas conectada em Cobranças',
      noConnection: true,
    }
  }
  if (doc.invalidTyped) return { ok: false, reason: INVALID_DOCUMENT_REASON, needsDocument: true, invalidDocument: true }
  if (chargeNeedsDocument(pick.conn.environment, doc.doc)) return { ok: false, reason: DOCUMENT_REQUIRED_REASON, needsDocument: true }
  return { ok: true, doc: doc.doc, source: doc.source, asaasName: doc.asaasName, connection: viewOf(pick.conn), connectionSource: pick.source }
}

/**
 * A trava do documento, sem efeito colateral e sem chamar o Asaas: a tela roda
 * ANTES de gravar e-mail e abrir conversa. Mesma escolha de conta e mesmo
 * resolvedor do createChargeForContact. Nunca lança.
 */
export async function precheckChargeDocument(
  accountId: string,
  contactId: string,
  connectionId: string | null,
  typed?: string | null,
): Promise<ChargePrecheck> {
  try {
    const doc = await resolveChargeDocument(accountId, contactId, typed)
    return precheckFrom(doc, await chooseConnection(accountId, contactId, connectionId, doc.doc), connectionId)
  } catch (err) {
    console.error('[cobranca] conferir documento falhou:', err instanceof Error ? err.message : err)
    return { ok: false, reason: 'não deu para conferir o cadastro do cliente agora (tente de novo)' }
  }
}

/** Contas extras consultadas no Asaas quando o histórico local não diz nada. */
const MAX_HOME_LOOKUPS = 3
const HOME_LOOKUP_TIMEOUT_MS = 8_000

function credentialOf(conn: EnabledConnection): AsaasCredential {
  return { apiKey: decrypt(conn.apiKeyEnc), environment: conn.environment as AsaasEnv }
}

/**
 * Onde mais (contas ligadas, mesmo ambiente) este cliente existe. Histórico
 * local primeiro (0 chamadas); sem histórico e com documento, 1 GET por conta
 * extra, em sequência, com timeout curto. Erro não trava: vira aviso no log e
 * segue como antes (fail-open — no pior caso, cadastro novo, como sempre foi).
 */
async function customerHomeCandidates(args: {
  others: EnabledConnection[]
  history: ConnectionHistoryRow[]
  doc: string | null
  contactId: string
}): Promise<(HomeCandidate & { customer?: AsaasCustomer })[]> {
  const otherIds = new Set(args.others.map((c) => c.id))
  const local = args.history
    .filter((h) => otherIds.has(h.connectionId))
    .map((h) => ({ id: h.connectionId, label: h.label, lastAt: h.lastAt, charges: h.charges }))
  if (local.length || !args.doc) return local
  const found: (HomeCandidate & { customer?: AsaasCustomer })[] = []
  for (const other of args.others.slice(0, MAX_HOME_LOOKUPS)) {
    try {
      const customer = await findCustomerByDocument(credentialOf(other), args.doc, {
        timeoutMs: HOME_LOOKUP_TIMEOUT_MS,
        externalReference: args.contactId,
      })
      if (customer) found.push({ id: other.id, label: other.label, customer })
    } catch (err) {
      console.warn(`[cobranca] conferir cliente na conta ${other.label} falhou:`, err instanceof Error ? err.message : err)
    }
  }
  return found
}

/**
 * Duplicata: mesmo contato, mesmo valor, aberta, últimas 6h, NA MESMA conta do
 * Asaas → reaproveita. (Outra conta não: uma nova tentativa na conta certa não
 * pode devolver o link da errada.) Assinatura não passa por aqui: a 1ª
 * mensalidade pode ter o valor de uma cobrança avulsa recente e nem por isso é
 * repetida.
 */
async function reuseRecentCharge(input: CreateChargeInput, conn: EnabledConnection): Promise<CreateChargeOutcome | null> {
  if (input.recurring) return null
  const recent = await db
    .select({ id: asaasCharges.id, value: asaasCharges.value, createdAt: asaasCharges.createdAt, open: asaasCharges.open, invoiceUrl: asaasCharges.invoiceUrl })
    .from(asaasCharges)
    .where(
      and(
        eq(asaasCharges.accountId, input.accountId),
        eq(asaasCharges.contactId, input.contactId),
        eq(asaasCharges.connectionId, conn.id),
        inArray(asaasCharges.origin, ['ai', 'manual']),
        gte(asaasCharges.createdAt, new Date(Date.now() - 6 * 3_600_000).toISOString()),
      ),
    )
    .orderBy(desc(asaasCharges.createdAt))
    .limit(10)
  const dup = findDuplicateCharge(
    recent.map((r) => ({ value: Number(r.value), createdAt: r.createdAt, open: r.open, invoiceUrl: r.invoiceUrl })),
    input.value,
  )
  if (!dup?.invoiceUrl) return null
  const row = recent.find((r) => r.invoiceUrl === dup.invoiceUrl)
  if (input.conversationId) {
    await postInternalNote({
      conversationId: input.conversationId,
      text: `🧾 Já existia uma cobrança aberta de ${brl(input.value)} criada há pouco para este contato — o mesmo link foi reaproveitado, nada foi criado em dobro.`,
    }).catch(() => {})
  }
  return { ok: true, chargeId: row?.id ?? '', invoiceUrl: dup.invoiceUrl, reused: true, connectionLabel: conn.label, connectionId: conn.id }
}

const NEEDS_DOCUMENT_RE = /CPF ou CNPJ|cpfCnpj/i

export async function createChargeForContact(input: CreateChargeInput): Promise<CreateChargeOutcome> {
  try {
    const contact = firstOrNull(
      await db
        .select({ name: contacts.name, phone: contacts.phone, email: contacts.email })
        .from(contacts)
        .where(and(eq(contacts.id, input.contactId), eq(contacts.accountId, input.accountId)))
        .limit(1),
    )
    if (!contact) return { ok: false, reason: 'contato não encontrado' }

    // Documento e conta ANTES de qualquer chamada ao Asaas (15/09) — só banco.
    const docPick = await resolveChargeDocument(input.accountId, input.contactId, input.cpfCnpj)
    const pick = await chooseConnection(input.accountId, input.contactId, input.connectionId, docPick.doc)
    const pre = precheckFrom(docPick, pick, input.connectionId)
    if (!pre.ok) {
      return {
        ok: false,
        reason: pre.reason,
        ...(pre.needsDocument ? { needsDocument: true } : {}),
        ...(pre.invalidDocument ? { invalidDocument: true } : {}),
      }
    }
    let conn = pick.conn!
    const cpfCnpj = docPick.doc
    if (cpfCnpj && docPick.source === 'typed') void rememberDocumentOnContact(input.accountId, input.contactId, cpfCnpj)

    const reused = await reuseRecentCharge(input, conn)
    if (reused) return reused

    let cred: AsaasCredential
    try {
      cred = credentialOf(conn)
    } catch {
      return { ok: false, reason: 'a chave do Asaas salva não pôde ser lida' }
    }

    // Reencontra o cliente na conta escolhida (sem escrever nada).
    let existing: AsaasCustomer | null | undefined = await findCustomer(cred, { externalReference: input.contactId, cpfCnpj })
    let switchedToHome = false

    // 🛡️ Salvaguarda da conta (15/09): não existe aqui, mas existe noutra conta
    // ligada do MESMO ambiente (CPF de teste não trava cobrança real)?
    // Um órfão SEM documento nesta conta (tentativa antiga sem CPF) não prova
    // que o cliente é daqui: conta como "não existe" para a salvaguarda e só é
    // adotado se nenhuma outra conta tiver o cliente (revisão 15/09).
    const orphanHere = !!existing && onlyDigits(existing.cpfCnpj).length !== 11 && onlyDigits(existing.cpfCnpj).length !== 14
    if ((!existing || orphanHere) && !input.allowNewCustomerHere) {
      const current = conn
      const others = pick.enabled.filter((c) => c.id !== current.id && c.environment === current.environment)
      if (others.length) {
        const candidates = await customerHomeCandidates({ others, history: pick.history, doc: cpfCnpj, contactId: input.contactId })
        const home = decideCustomerHome({ explicit: !!input.connectionId, candidates })
        if (home !== 'create') {
          if ('refuse' in home) {
            return {
              ok: false,
              reason: `este cliente já está cadastrado na conta ${home.refuse.label} do Asaas, não na ${current.label}. Nada foi criado`,
              otherConnection: home.refuse,
            }
          }
          if ('ambiguous' in home) {
            return {
              ok: false,
              reason: `o cliente está cadastrado em mais de uma conta do Asaas (${joinLabels(home.ambiguous)}) e ninguém escolheu a conta. Gere pela tela Cobranças escolhendo a conta`,
            }
          }
          const target = others.find((c) => c.id === home.switch.id)
          if (target) {
            try {
              cred = credentialOf(target)
            } catch {
              return { ok: false, reason: `a chave salva da conta ${target.label} do Asaas não pôde ser lida` }
            }
            conn = target
            switchedToHome = true
            // Achado pela consulta → já temos o cadastro; pelo histórico local → busca lá.
            existing = candidates.find((c) => c.id === target.id)?.customer ?? undefined
            const reusedHome = await reuseRecentCharge(input, conn)
            if (reusedHome) return reusedHome.ok ? { ...reusedHome, switchedToHome: true } : reusedHome
          }
        }
      }
    }

    const phoneDigits = (contact.phone ?? '').replace(/\D/g, '')
    const customerInput: AsaasCustomerInput = {
      name: (contact.name || contact.email || contact.phone || 'Cliente').trim(),
      mobilePhone: phoneDigits ? toBrE164IfNational(phoneDigits) : '',
      // O e-mail digitado agora vence o da ficha: quem preencheu sabia que é
      // esse que precisa sair na nota fiscal (11/09).
      email: input.email?.trim() || contact.email,
      cpfCnpj,
      address: input.billingAddress ?? null,
      externalReference: input.contactId,
      // Segunda defesa: sem documento fora do sandbox, nada de POST/PUT.
      requireDocument: conn.environment !== 'sandbox',
    }
    const customer = await findOrCreateCustomer(cred, customerInput, { existing })
    const homeNote = switchedToHome ? ' (o cliente já era cadastrado nessa conta)' : ''

    // 🔁 Assinatura mensal: o Asaas gera as cobranças, uma por mês, sem fim.
    if (input.recurring) {
      const subBilling: AsaasBillingType = input.billingType ?? (customer.cpfCnpj ? 'UNDEFINED' : 'PIX')
      const subDescription = `${input.description} (assinatura mensal)`
      const sub = await createSubscription(cred, {
        customer: customer.id,
        value: input.value,
        nextDueDate: input.dueDate,
        description: subDescription,
        billingType: subBilling,
        externalReference: input.conversationId ?? input.contactId,
        cycle: 'MONTHLY',
      })
      // A 1ª cobrança costuma nascer na hora; dá três chances curtas antes de
      // deixar pra sincronização/lembrete.
      let first: AsaasPayment | null = null
      for (let attempt = 0; attempt < 3 && !first; attempt++) {
        const list = await listSubscriptionPayments(cred, sub.id).catch(() => [] as AsaasPayment[])
        first = list.find((p) => String(p.status).toUpperCase() === 'PENDING') ?? list[0] ?? null
        if (!first) await new Promise((r) => setTimeout(r, 1500))
      }
      let chargeId = ''
      if (first?.invoiceUrl) {
        const row = firstOrNull(
          await db
            .insert(asaasCharges)
            .values({
              accountId: input.accountId,
              connectionId: conn.id,
              conversationId: input.conversationId,
              asaasId: first.id,
              asaasCustomerId: first.customer ?? customer.id,
              customerName: contact.name,
              cpfCnpj: customer.cpfCnpj ?? cpfCnpj ?? null,
              phone: contact.phone,
              email: contact.email,
              value: String(Number(first.value ?? input.value)),
              dueDate: first.dueDate ? first.dueDate.slice(0, 10) : input.dueDate,
              status: first.status,
              billingType: first.billingType ?? subBilling,
              description: subDescription,
              installmentNumber: null,
              invoiceUrl: first.invoiceUrl,
              bankSlipUrl: first.bankSlipUrl ?? null,
              contactId: input.contactId,
              matchedBy: 'manual',
              origin: input.origin,
              open: true,
            })
            .onConflictDoNothing()
            .returning({ id: asaasCharges.id }),
        )
        chargeId = row?.id ?? ''
      }
      if (input.conversationId) {
        await postInternalNote({
          conversationId: input.conversationId,
          text:
            `🔁 Assinatura mensal criada no Asaas ${input.actorLabel}: ${brl(input.value)} todo mês a partir de ${br(input.dueDate)} · "${input.description}" · conta ${conn.label}${homeNote}. ` +
            (first?.invoiceUrl
              ? `A 1ª cobrança já está na carteira.${input.noteSuffix ? ` ${input.noteSuffix}` : ''}`
              : 'O Asaas ainda vai gerar a 1ª cobrança; ela entra na carteira sozinha e o lembrete/régua manda o link.') +
            ' As próximas mensalidades chegam pela sincronização. Se o cliente pagar, o webhook fecha sozinho.',
        }).catch(() => {})
      }
      return {
        ok: true,
        chargeId,
        invoiceUrl: first?.invoiceUrl ?? '',
        reused: false,
        connectionLabel: conn.label,
        connectionId: conn.id,
        ...(switchedToHome ? { switchedToHome: true } : {}),
        subscriptionId: sub.id,
      }
    }

    // Com documento, UNDEFINED deixa o cliente escolher Pix/boleto na página do
    // Asaas. Sem documento só se chega aqui no SANDBOX (produção barra antes, na
    // trava do documento): tenta Pix, que o sandbox aceita.
    // Parcelado é sempre UNDEFINED (boleto/cartão; Pix não parcela).
    const installments = input.installments && input.installments >= 2 ? Math.min(60, Math.trunc(input.installments)) : null
    const billingType: AsaasBillingType = installments
      ? 'UNDEFINED'
      : (input.billingType ?? (customer.cpfCnpj ? 'UNDEFINED' : 'PIX'))

    const payment = await createPayment(cred, {
      customer: customer.id,
      value: input.value,
      dueDate: input.dueDate,
      description: installments ? `${input.description} (${installments}x)` : input.description,
      billingType,
      externalReference: input.conversationId ?? input.contactId,
      installments,
    })
    if (!payment.invoiceUrl) return { ok: false, reason: 'o Asaas criou a cobrança mas não devolveu o link (id ' + payment.id + ')' }

    const inserted = firstOrNull(
      await db
        .insert(asaasCharges)
        .values({
          accountId: input.accountId,
          connectionId: conn.id,
          conversationId: input.conversationId,
          asaasId: payment.id,
          asaasCustomerId: payment.customer,
          customerName: contact.name,
          cpfCnpj: customer.cpfCnpj ?? cpfCnpj ?? null,
          phone: contact.phone,
          email: contact.email,
          value: String(installments ? Number(payment.value ?? input.value / installments) : input.value),
          dueDate: input.dueDate,
          status: payment.status,
          billingType: payment.billingType ?? billingType,
          description: installments ? `${input.description} (1/${installments})` : input.description,
          installmentNumber: installments ? 1 : null,
          invoiceUrl: payment.invoiceUrl,
          bankSlipUrl: payment.bankSlipUrl ?? null,
          contactId: input.contactId,
          matchedBy: 'manual',
          origin: input.origin,
          open: true,
        })
        .returning({ id: asaasCharges.id }),
    )

    if (input.conversationId) {
      await postInternalNote({
        conversationId: input.conversationId,
        text: `🧾 Cobrança gerada no Asaas ${input.actorLabel}: ${brl(input.value)} · vence ${br(input.dueDate)} · "${input.description}" · conta ${conn.label}${homeNote}.${input.noteSuffix ? ` ${input.noteSuffix}` : ''} Se o cliente pagar, o webhook fecha sozinho.`,
      }).catch(() => {})
    }

    return {
      ok: true,
      chargeId: inserted?.id ?? '',
      invoiceUrl: payment.invoiceUrl,
      reused: false,
      connectionLabel: conn.label,
      connectionId: conn.id,
      ...(switchedToHome ? { switchedToHome: true } : {}),
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'falha inesperada'
    console.error('[cobranca] criar falhou:', reason)
    const needsDocument = err instanceof AsaasDocumentRequiredError || NEEDS_DOCUMENT_RE.test(reason)
    return { ok: false, reason, ...(needsDocument ? { needsDocument: true } : {}) }
  }
}


// ---------------------------------------------------------- pela IA

export interface EmitInput {
  accountId: string
  contactId: string
  conversationId: string
  agentId: string | null
  valueRaw: string
  dueRaw: string
  description: string
}

export type EmitOutcome =
  | { ok: true; invoiceUrl: string; value: number; dueDate: string; reused: boolean }
  | { ok: false; reason: string; needsDocument?: boolean }

/** A IA escreveu [[COBRAR:…]]: as travas decidem; falhou → nota + aviso, a resposta sai sem link
 *  (com `needsDocument` quem responde pede o CPF/CNPJ ao cliente em vez de prometer link). */
export async function emitChargeFromDirective(input: EmitInput): Promise<EmitOutcome> {
  const fail = async (reason: string, needsDocument = false): Promise<EmitOutcome> => {
    await postInternalNote({
      conversationId: input.conversationId,
      text: needsDocument
        ? '🧾 A IA ia gerar uma cobrança, mas ainda não temos o CPF/CNPJ do cliente (o Asaas de produção exige). Nada foi criado no Asaas. A IA pediu o documento na conversa; quando ele mandar, a próxima tentativa passa.'
        : `🧾 A IA tentou gerar uma cobrança e NÃO gerou: ${reason}. O cliente pode estar esperando o link — assuma daqui.`,
    }).catch(() => {})
    if (!needsDocument) await alertTeam(input, `Cobrança não gerada — ${reason}`)
    return { ok: false, reason, needsDocument }
  }

  try {
    const settings = await getAccountSettings(input.accountId)
    const guard = { ...EMIT_DEFAULTS, maxValue: normalizeSettings(settings.collections).emitMaxValue }

    const value = parseValue(input.valueRaw)
    const dueDate = parseDueDate(input.dueRaw)
    const description = input.description.trim() || 'Cobrança'
    const verdict = validateEmit({ value, dueDate, description }, guard)
    if (!verdict.ok) return fail(verdict.reason)

    // 08/09: se o cliente mandou o CPF/CNPJ na conversa (o Asaas de produção
    // exige), ele vai junto — senão a cobrança volta recusada e a IA fica
    // pedindo o documento que já está no histórico. connectionId null: ninguém
    // escolheu a conta, vale a regra (e a troca para a conta do cliente, 15/09).
    const cpfCnpj = await documentFromConversation(input.conversationId)
    const created = await createChargeForContact({
      accountId: input.accountId,
      contactId: input.contactId,
      conversationId: input.conversationId,
      connectionId: null,
      value: value!,
      dueDate: dueDate!,
      description,
      origin: 'ai',
      actorLabel: 'pela IA',
      noteSuffix: 'Link enviado na conversa.',
      cpfCnpj,
    })
    if (!created.ok) return fail(created.reason, created.needsDocument === true)
    return { ok: true, invoiceUrl: created.invoiceUrl, value: value!, dueDate: dueDate!, reused: created.reused }
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'falha inesperada'
    console.error('[criar_cobranca] falhou:', reason)
    return fail(reason)
  }
}

/** CPF/CNPJ válido nas últimas mensagens do CLIENTE nesta conversa (só dígitos) ou null. */
export async function documentFromConversation(conversationId: string): Promise<string | null> {
  try {
    const rows = await db
      .select({ text: messages.contentText })
      .from(messages)
      .where(and(eq(messages.conversationId, conversationId), eq(messages.senderType, 'customer'), eq(messages.isInternal, false)))
      .orderBy(desc(messages.createdAt))
      .limit(8)
    for (const r of rows) {
      const doc = findDocumentInText(r.text)
      if (doc) return doc
    }
  } catch {
    /* sem documento → segue sem */
  }
  return null
}

async function alertTeam(input: EmitInput, title: string): Promise<void> {
  try {
    const who = firstOrNull(
      await db.select({ name: contacts.name, phone: contacts.phone }).from(contacts).where(eq(contacts.id, input.contactId)).limit(1),
    )
    const rows = await db.select({ userId: member.userId }).from(member).where(eq(member.organizationId, input.accountId))
    await notifyUsers({
      accountId: input.accountId,
      userIds: rows.map((r) => r.userId),
      type: 'agent_action',
      title: `${title} — ${who?.name || who?.phone || 'cliente'}`,
      body: 'A IA não conseguiu gerar a cobrança no Asaas. O cliente pode estar esperando o link: gere você e mande na conversa.',
      contactId: input.contactId,
      conversationId: input.conversationId,
    })
  } catch (err) {
    console.error('[criar_cobranca] aviso ao time falhou:', err instanceof Error ? err.message : err)
  }
}

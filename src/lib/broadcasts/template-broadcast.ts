// ============================================================
// Disparo de TEMPLATE (API oficial) a partir de contatos já resolvidos —
// irmão do enqueueTextBroadcast. Grava o disparo + destinatários com os
// parâmetros de cada um e enfileira no worker (fila broadcast-dispatch), o
// mesmo caminho do POST /api/v1/broadcasts; nada sai pelo navegador.
//
// 15/09 (GoLink): o disparo pela etapa do funil passa a ter os tipos dos
// Disparos. O createBroadcast da API resolve destinatário por TELEFONE
// (findOrCreateContact); aqui a audiência já são contatos da conta, então
// o contato vai direto — sem risco de criar outro no 9º dígito.
//
// Revisão 15/09 (envios repetidos): "mesma mensagem" num template é nome +
// idioma + os VALORES que a pessoa vê (corpo, {{1}} do cabeçalho de texto,
// final dos links) — o mesmo template com outro nome/valor é outra mensagem.
// A checagem roda depois de montar os valores de cada um e a escolha "enviar
// mesmo assim" fica gravada em broadcasts.allow_repeats (o worker confere de
// novo sem ela). Quem só está na fila de outro disparo não sai (conferência
// 15/09): o worker garante um envio só.
//
// Worker-safe (sem 'server-only').
// ============================================================

import { and, eq, inArray } from 'drizzle-orm'

import { db, broadcasts, broadcastRecipients, contacts } from '@/db'
import { firstOrThrow } from '@/db/helpers'
import { loadChannel } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { enqueueBroadcastDispatch } from '@/lib/queue/queues'
import { sanitizePhoneForMeta, isValidE164 } from '@/lib/whatsapp/phone-utils'
import { BroadcastError, loadBroadcastTemplateRow } from '@/lib/whatsapp/broadcast-core'
import {
  DUPLICATE_WINDOW_MS,
  latestSkipCollector,
  recipientWithoutOwnVarsSql,
  sentSinceSql,
  templateSendKey,
  type DuplicateSkip,
} from '@/lib/broadcasts/duplicate-sends'
import { allDuplicatesError } from '@/lib/broadcasts/duplicate-notice'
import {
  buildTemplateRecipientSend,
  missingValuesError,
  templateNeeds,
  validateTemplateMapping,
  type TemplateSendMapping,
} from '@/lib/broadcasts/template-vars'

export interface EnqueueTemplateBroadcastInput {
  name?: string | null
  channelId: string
  templateName: string
  templateLanguage?: string | null
  mapping: TemplateSendMapping
  /** Contatos da conta, já resolvidos pela audiência (ex.: leads da etapa). */
  recipientContactIds: string[]
  audienceFilter?: unknown
  /**
   * Pula quem já recebeu esta mensagem nas últimas 24 h (padrão true). false
   * também grava broadcasts.allow_repeats (o worker não confere na hora).
   */
  skipRecentDuplicates?: boolean
}

export interface EnqueueTemplateBroadcastResult {
  broadcastId: string | null
  totalRecipients: number
  error: string | null
  skippedDuplicates?: DuplicateSkip[]
}

const fail = (error: string, skippedDuplicates?: DuplicateSkip[]): EnqueueTemplateBroadcastResult => ({
  broadcastId: null,
  totalRecipients: 0,
  error,
  ...(skippedDuplicates && skippedDuplicates.length > 0 ? { skippedDuplicates } : {}),
})

export async function enqueueTemplateBroadcast(
  accountId: string,
  userId: string,
  input: EnqueueTemplateBroadcastInput,
): Promise<EnqueueTemplateBroadcastResult> {
  try {
    const channel = input.channelId ? await loadChannel(input.channelId) : null
    if (!channel || channel.accountId !== accountId) return fail('Canal inválido.')
    const provider = getProvider(channel.provider)
    if (!provider.capabilities.templates || !provider.sendTemplate) {
      return fail('Template só sai pelo canal da API oficial (Meta).')
    }

    const templateName = (input.templateName ?? '').trim()
    const templateLanguage = (input.templateLanguage ?? '').trim()
    if (!templateName || !templateLanguage) return fail('Escolha o template aprovado.')
    const template = await loadBroadcastTemplateRow(accountId, templateName, templateLanguage)
    if (!template) return fail('Template não encontrado. Sincronize os templates e tente de novo.')
    if (template.status !== 'APPROVED') return fail('Este template ainda não foi aprovado pela Meta.')

    const needs = templateNeeds(template)
    const mapping = input.mapping ?? { variables: {} }
    const mappingError = validateTemplateMapping(needs, mapping)
    if (mappingError) return fail(mappingError)

    // Contatos da conta com telefone válido, sem repetir, na ordem recebida.
    const ids = Array.from(new Set(input.recipientContactIds.filter((v): v is string => !!v)))
    const rows =
      ids.length > 0
        ? await db
            .select({
              id: contacts.id,
              name: contacts.name,
              phone: contacts.phone,
              email: contacts.email,
              company: contacts.company,
            })
            .from(contacts)
            .where(and(inArray(contacts.id, ids), eq(contacts.accountId, accountId)))
        : []
    const byId = new Map(rows.map((r) => [r.id, r]))
    const recipients = ids
      .map((id) => byId.get(id))
      .filter((c): c is (typeof rows)[number] => !!c && isValidE164(sanitizePhoneForMeta(c.phone ?? '')))
    if (recipients.length === 0) return fail('Nenhum contato com telefone válido nesta audiência.')

    // Parâmetros de cada um ANTES da checagem de repetidos (revisão 15/09):
    // o mesmo template com valores diferentes é outra mensagem.
    let planned = recipients.map((c) => ({
      contactId: c.id,
      ...buildTemplateRecipientSend(needs, mapping, c),
    }))

    // Quem já recebeu este mesmo template com os mesmos valores hoje fica de
    // fora (15/09: envios 2×).
    // Se a checagem falhar, segue sem pular (mesma escolha do disparo de texto).
    let skippedDuplicates: DuplicateSkip[] = []
    if (input.skipRecentDuplicates !== false) {
      try {
        skippedDuplicates = await findRecentTemplateRecipients(accountId, planned, templateName, templateLanguage)
      } catch (dupErr) {
        console.error('[template-broadcast] checagem de envios repetidos falhou — segue sem pular:', dupErr)
        skippedDuplicates = []
      }
      if (skippedDuplicates.length > 0) {
        const skip = new Set(skippedDuplicates.map((s) => s.contactId))
        planned = planned.filter((p) => !skip.has(p.contactId))
        if (planned.length === 0) return fail(allDuplicatesError(skippedDuplicates), skippedDuplicates)
      }
    }

    // Campo vazio sem "Se faltar" barra o disparo inteiro (a Meta recusaria o
    // envio desse lead com erro genérico). Só conta quem vai receber: quem
    // ficou de fora por repetido não pode barrar os outros.
    const missingCounts = new Map<'header' | number, number>()
    for (const p of planned) {
      for (const where of p.missing) missingCounts.set(where, (missingCounts.get(where) ?? 0) + 1)
    }
    const missingError = missingValuesError(mapping, missingCounts)
    if (missingError) return fail(missingError, skippedDuplicates)

    const broadcast = firstOrThrow(
      await db
        .insert(broadcasts)
        .values({
          userId,
          accountId,
          name: input.name?.trim() || `Disparo de template (${templateName})`,
          channelId: channel.id,
          messageKind: 'template',
          templateName,
          templateLanguage,
          templateVariables: mapping as unknown as Record<string, unknown>,
          audienceFilter:
            input.audienceFilter != null ? (input.audienceFilter as Record<string, unknown>) : null,
          // Template não leva a linha "responda SAIR" (a opção fica nos botões).
          includeOptOut: false,
          // "Enviar também pra quem já recebeu": o worker não confere repetido.
          allowRepeats: input.skipRecentDuplicates === false,
          status: 'sending',
          totalRecipients: planned.length,
        })
        .returning({ id: broadcasts.id }),
    )

    const recipientRows = planned.map((p) => ({
      broadcastId: broadcast.id,
      contactId: p.contactId,
      status: 'pending' as const,
      params: p.params,
      messageParams: p.messageParams ?? null,
    }))
    const BATCH = 200
    try {
      for (let i = 0; i < recipientRows.length; i += BATCH) {
        await db.insert(broadcastRecipients).values(recipientRows.slice(i, i + BATCH))
      }
    } catch (recipErr) {
      await db
        .update(broadcasts)
        .set({ status: 'failed', failedCount: planned.length })
        .where(eq(broadcasts.id, broadcast.id))
      throw recipErr
    }

    await enqueueBroadcastDispatch(broadcast.id)
    return {
      broadcastId: broadcast.id,
      totalRecipients: planned.length,
      error: null,
      ...(skippedDuplicates.length > 0 ? { skippedDuplicates } : {}),
    }
  } catch (err) {
    console.error('[template-broadcast] enqueue failed:', err)
    if (err instanceof BroadcastError && err.code === 'template_malformed') {
      return fail('O template está com defeito no CRM. Sincronize os templates com a Meta e tente de novo.')
    }
    return fail('Falha ao criar o disparo do template.')
  }
}

/**
 * Contatos (dentre `planned`) que receberam o MESMO template (nome + idioma +
 * valores, ver templateSendKey) por disparo da conta nas últimas 24 h.
 * O texto do template muda por lead ({{1}}…), então aqui a mensagem é o
 * template com os valores — a checagem de texto (duplicate-sends.ts) deixa
 * template de fora.
 */
export async function findRecentTemplateRecipients(
  accountId: string,
  planned: readonly { contactId: string; params: string[]; messageParams?: unknown }[],
  templateName: string,
  templateLanguage: string,
  opts: { sinceMs?: number } = {},
): Promise<DuplicateSkip[]> {
  const keyOf = new Map<string, string>()
  for (const p of planned) if (p.contactId && !keyOf.has(p.contactId)) keyOf.set(p.contactId, templateSendKey(p))
  const ids = [...keyOf.keys()]
  if (!accountId || ids.length === 0) return []
  const windowMs = opts.sinceMs && opts.sinceMs > 0 ? opts.sinceMs : DUPLICATE_WINDOW_MS
  const since = new Date(Date.now() - windowMs).toISOString()
  const rows = await db
    .select({
      contactId: broadcastRecipients.contactId,
      name: contacts.name,
      sentAt: broadcastRecipients.sentAt,
      params: broadcastRecipients.params,
      messageParams: broadcastRecipients.messageParams,
    })
    .from(broadcastRecipients)
    .innerJoin(broadcasts, eq(broadcasts.id, broadcastRecipients.broadcastId))
    .innerJoin(contacts, eq(contacts.id, broadcastRecipients.contactId))
    .where(
      and(
        eq(broadcasts.accountId, accountId),
        eq(broadcasts.messageKind, 'template'),
        eq(broadcasts.templateName, templateName),
        eq(broadcasts.templateLanguage, templateLanguage),
        inArray(broadcastRecipients.contactId, ids),
        sentSinceSql(since),
        recipientWithoutOwnVarsSql(),
      ),
    )
  const skips = latestSkipCollector()
  for (const r of rows) {
    if (!r.contactId || keyOf.get(r.contactId) !== templateSendKey(r)) continue
    skips.note(r.contactId, r.name, r.sentAt, 'same_template')
  }
  return skips.list(ids)
}

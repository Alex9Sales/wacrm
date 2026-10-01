// ============================================================
// 📋 Corpo APROVADO de um modelo (template), para mandar como TEXTO.
//
// 01/10 (Zelo, gatilho "Envio da COF"): o dono quer que o cliente leia o texto
// que ele aprovou no modelo — palavra por palavra —, e não uma paráfrase da IA.
// Dentro da janela de 24h (ou num canal sem templates, como o WAHA) o modelo
// em si não precisa sair: basta o corpo dele, preenchido, como texto comum.
//
// A busca espelha a do envio de template em send-message.ts (conta + nome +
// idioma, com 'en_US' quando o idioma não veio; canal da conversa ou linha sem
// canal, preferindo a do canal). Motivo: se este texto e o template "de
// verdade" viessem de linhas diferentes, o cliente leria uma coisa dentro da
// janela e outra fora dela.
//
// Sem 'server-only': o worker (varredura de follow-up) importa este arquivo, e
// 'server-only' no worker é crash-loop.
// ============================================================

import { and, eq, isNull, or, sql } from 'drizzle-orm'

import { db, messageTemplates } from '@/db'
import { firstOrNull } from '@/db/helpers'

export interface TemplateBody {
  /** O corpo como foi aprovado, ainda com {{1}}, {{2}}… */
  bodyText: string
  /** Canal dono da linha achada (null = linha antiga, sem canal). */
  channelId: string | null
}

/**
 * Acha o corpo do modelo. null = não existe linha local com esse nome/idioma.
 *
 * `anyChannel`: só para conversa num canal SEM templates (WAHA e afins). Lá
 * nenhum modelo pertence ao canal da conversa — todos moram no número oficial
 * da conta —, e a busca estrita nunca acharia nada: o gatilho cairia sempre no
 * aviso de "modelo não encontrado". Como aqui só se lê o TEXTO (nada vai para a
 * Meta), usar a linha de outro canal da mesma conta é seguro. A ordem continua
 * preferindo o canal da conversa e depois a linha sem canal.
 */
export async function getTemplateBody(
  accountId: string,
  channelId: string | null,
  name: string,
  language: string | null | undefined,
  opts: { anyChannel?: boolean } = {},
): Promise<TemplateBody | null> {
  const nome = (name || '').trim()
  if (!nome) return null

  // Mesma regra de canal do envio (send-message.ts, 29/09): o template tem que
  // ser DESTE canal — dois números Meta são duas WABAs, e o nome que existe numa
  // não existe na outra. A linha sem canal vale como "do único canal da conta".
  const canalCond = opts.anyChannel
    ? undefined
    : channelId
      ? or(eq(messageTemplates.channelId, channelId), isNull(messageTemplates.channelId))
      : undefined

  const row = firstOrNull(
    await db
      .select({ bodyText: messageTemplates.bodyText, channelId: messageTemplates.channelId })
      .from(messageTemplates)
      .where(
        and(
          eq(messageTemplates.accountId, accountId),
          eq(messageTemplates.name, nome),
          eq(messageTemplates.language, (language || '').trim() || 'en_US'),
          canalCond,
        ),
      )
      // O do canal da conversa primeiro; depois o sem canal; por último (só com
      // anyChannel) o de outro canal da conta.
      .orderBy(
        channelId
          ? sql`CASE WHEN ${messageTemplates.channelId} = ${channelId}::uuid THEN 0 WHEN ${messageTemplates.channelId} IS NULL THEN 1 ELSE 2 END`
          : sql`CASE WHEN ${messageTemplates.channelId} IS NULL THEN 0 ELSE 1 END`,
      )
      .limit(1),
  )
  if (!row || !row.bodyText?.trim()) return null
  return { bodyText: row.bodyText, channelId: row.channelId ?? null }
}

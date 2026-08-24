// ============================================================
// 📸 Social selling IG — stories + etiquetas de relacionamento.
//   • handleStoryInbound: auto-DM pra quem RESPONDE um story nosso ou nos
//     MENCIONA no story dela (janela de 24h aberta — a pessoa nos escreveu).
//     Anti-spam: 1 auto-DM por pessoa/tipo a cada 24h (claim atômico no log).
//     Etiqueta o contato ("Respondeu story" / "Mencionou no story").
//   • tagFollowerStatus: etiqueta "Seguidor"/"Não seguidor" (troca a oposta)
//     — alimentada pelos pontos que já consultam is_user_follow_business.
// SEM import de inbound.ts/instagram-comments.ts (sem ciclo) e SEM
// 'server-only' (alcançável pelo worker via cadeia do inbound).
// ============================================================

import { eq, sql } from 'drizzle-orm'

import {
  db,
  instagramStorySettings,
  instagramStoryLog,
  member,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import type { ChannelCtx } from './provider'
import { instagramProvider } from './providers/instagram'
import { setContactTags, loadTagsByContact } from '@/lib/api/v1/contacts'

const STORY_REPLY_DEFAULT =
  'Obrigado por responder nosso story! 😊 Se quiser saber mais é só me chamar por aqui.'
const STORY_MENTION_DEFAULT =
  'Vi que você nos marcou no story — obrigado demais! 🙌 Qualquer coisa que precisar, é só chamar.'

const TAG_FOLLOWER = 'Seguidor'
const TAG_NON_FOLLOWER = 'Não seguidor'
const TAG_STORY_REPLY = 'Respondeu story'
const TAG_STORY_MENTION = 'Mencionou no story'

/** Usuário de auditoria pra criar/aplicar etiquetas: um membro da conta. */
async function auditUserOf(accountId: string): Promise<string | null> {
  const m = firstOrNull(
    await db
      .select({ userId: member.userId })
      .from(member)
      .where(eq(member.organizationId, accountId))
      .limit(1),
  )
  return m?.userId ?? null
}

/** União de etiquetas preservando as existentes; `remove` sai se estiver lá. */
async function addContactTags(
  accountId: string,
  contactId: string,
  add: string[],
  remove: string[] = [],
): Promise<void> {
  try {
    const audit = await auditUserOf(accountId)
    if (!audit) return
    const current = (
      (await loadTagsByContact([contactId])).get(contactId) ?? []
    ).map((t) => t.name)
    const rm = new Set(remove.map((r) => r.toLowerCase()))
    const kept = current.filter((t) => !rm.has(t.toLowerCase()))
    const union = [...new Set([...kept, ...add])]
    const changed =
      union.length !== current.length ||
      union.some((t) => !current.includes(t))
    if (changed) await setContactTags(accountId, audit, contactId, union)
  } catch (err) {
    console.error('[instagram-social] etiquetas falharam:', err)
  }
}

/** Etiqueta o status de follow do contato (troca a etiqueta oposta). */
export async function tagFollowerStatus(
  accountId: string,
  contactId: string,
  follows: boolean,
): Promise<void> {
  await addContactTags(
    accountId,
    contactId,
    [follows ? TAG_FOLLOWER : TAG_NON_FOLLOWER],
    [follows ? TAG_NON_FOLLOWER : TAG_FOLLOWER],
  )
}

/**
 * Auto-DM de story (reply/menção). Chamada pelo inbound quando a mensagem tem
 * storyContext — a janela de 24h está aberta (a pessoa acabou de nos escrever).
 * Best-effort: nunca lança.
 */
export async function handleStoryInbound(
  channel: ChannelCtx,
  igUserId: string,
  contactId: string,
  kind: 'reply' | 'mention',
): Promise<void> {
  try {
    if (!igUserId) return
    // Etiqueta o engajamento SEMPRE (mesmo com a automação desligada) —
    // segmentação de quem interage com story é ouro pra disparo.
    await addContactTags(channel.accountId, contactId, [
      kind === 'reply' ? TAG_STORY_REPLY : TAG_STORY_MENTION,
    ])

    const settings = firstOrNull(
      await db
        .select()
        .from(instagramStorySettings)
        .where(eq(instagramStorySettings.channelId, channel.id))
        .limit(1),
    )
    if (!settings) return
    const enabled = kind === 'reply' ? settings.replyEnabled : settings.mentionEnabled
    if (!enabled) return
    const message =
      (kind === 'reply' ? settings.replyMessage : settings.mentionMessage)?.trim() ||
      (kind === 'reply' ? STORY_REPLY_DEFAULT : STORY_MENTION_DEFAULT)

    // Anti-spam: 1 por pessoa/tipo a cada 24h — claim atômico via upsert
    // condicional (sem linha de volta = mandamos há menos de 24h).
    const claimed = firstOrNull(
      await db
        .insert(instagramStoryLog)
        .values({ channelId: channel.id, igUserId, kind })
        .onConflictDoUpdate({
          target: [
            instagramStoryLog.channelId,
            instagramStoryLog.igUserId,
            instagramStoryLog.kind,
          ],
          set: { lastSentAt: sql`now()` },
          setWhere: sql`${instagramStoryLog.lastSentAt} < now() - interval '24 hours'`,
        })
        .returning({ id: instagramStoryLog.id }),
    )
    if (!claimed) return

    await instagramProvider.sendText(channel, igUserId, message)
  } catch (err) {
    console.error('[instagram-social] story auto-DM falhou:', err)
  }
}

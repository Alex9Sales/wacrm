// ============================================================
// Polling IMAP do Modo Gmail. Lê a INBOX de cada canal `gmail` conectado e traz
// as mensagens NOVAS pro inbox do CRM (via dispatchInboundMessage). O worker
// gmail-poll chama runGmailPollSweep num tick.
//
// Estado por canal (em provider_meta):
//   gmailUidValidity — a época de UIDs da caixa (se mudar, reseta).
//   gmailLastUid     — o maior UID já processado.
// 1ª sincronização (sem estado, ou UIDVALIDITY mudou): marca o ponto atual e
// NÃO importa histórico — só pega o que chegar daqui pra frente.
//
// Parse do MIME reusa o parseWebhook do provider de e-mail (mesma extração de
// assunto/corpo/anexos), então a ingestão fica idêntica ao canal de e-mail.
// ============================================================

import { ImapFlow } from 'imapflow'
import PostalMime from 'postal-mime'
import { and, eq } from 'drizzle-orm'

import { db, channels } from '@/db'
import { loadChannel } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { dispatchInboundMessage } from '@/lib/channels/inbound'
import { gmailAddressOf, appPasswordOf } from '@/lib/channels/providers/gmail'

const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** content do anexo (PostalMime) → base64, com teto de tamanho. */
function attachmentToBase64(content: unknown): string | null {
  let buf: Buffer | null = null
  if (content instanceof ArrayBuffer) {
    buf = Buffer.from(new Uint8Array(content))
  } else if (ArrayBuffer.isView(content)) {
    buf = Buffer.from(content.buffer, content.byteOffset, content.byteLength)
  } else if (typeof content === 'string') {
    buf = Buffer.from(content, 'base64')
  }
  if (!buf || buf.length === 0 || buf.length > MAX_ATTACHMENT_BYTES) return null
  return buf.toString('base64')
}

async function saveState(
  channelId: string,
  meta: Record<string, unknown>,
  uidValidity: string,
  lastUid: number,
): Promise<void> {
  await db
    .update(channels)
    .set({ providerMeta: { ...meta, gmailUidValidity: uidValidity, gmailLastUid: lastUid } })
    .where(eq(channels.id, channelId))
}

/** Lê a INBOX de UM canal gmail e ingere as mensagens novas. Retorna quantas. */
async function pollOneChannel(channelId: string): Promise<number> {
  const ch = await loadChannel(channelId)
  if (!ch) return 0
  let address: string
  let appPassword: string
  try {
    address = gmailAddressOf(ch)
    appPassword = appPasswordOf(ch)
  } catch {
    return 0 // canal sem credenciais válidas — ignora
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: address, pass: appPassword },
    logger: false,
  })

  let processed = 0
  await client.connect()
  try {
    const lock = await client.getMailboxLock('INBOX')
    try {
      const mb = client.mailbox
      if (!mb || typeof mb === 'boolean') return 0
      const uidValidity = String(mb.uidValidity)
      const uidNext = Number(mb.uidNext) || 1

      const meta = (ch.providerMeta ?? {}) as Record<string, unknown>
      const storedValidity =
        typeof meta.gmailUidValidity === 'string' ? meta.gmailUidValidity : null
      const storedLastUid =
        typeof meta.gmailLastUid === 'number' ? meta.gmailLastUid : null

      // 1ª sync ou UIDVALIDITY mudou → marca o agora, não importa histórico.
      if (storedValidity !== uidValidity || storedLastUid === null) {
        await saveState(channelId, meta, uidValidity, Math.max(0, uidNext - 1))
        return 0
      }

      let maxUid = storedLastUid
      for await (const msg of client.fetch(
        `${storedLastUid + 1}:*`,
        { uid: true, source: true },
        { uid: true },
      )) {
        const uid = Number(msg.uid)
        if (!uid || uid <= storedLastUid) continue
        if (uid > maxUid) maxUid = uid
        if (!msg.source) continue
        try {
          const parsed = await new PostalMime().parse(msg.source)
          const from = (parsed.from?.address || '').trim().toLowerCase()
          // Pula o que a própria conta enviou (aparece em alguns fetches).
          if (!from || from === address) continue

          const attachments = (parsed.attachments || [])
            .map((a) => {
              const base64 = attachmentToBase64(a.content)
              if (!base64) return null
              return {
                filename: a.filename || '',
                mimeType: a.mimeType || 'application/octet-stream',
                disposition: a.disposition || null,
                base64,
              }
            })
            .filter(Boolean)

          const body = {
            from,
            fromName: parsed.from?.name || '',
            to: address,
            subject: parsed.subject || '',
            text: parsed.text || '',
            html: parsed.html || '',
            messageId: parsed.messageId || '',
            attachments,
          }
          const ev = getProvider('email').parseWebhook(body)
          for (const m of ev.messages) {
            await dispatchInboundMessage(ch, m)
          }
          processed++
        } catch (err) {
          console.error('[gmail-poll] mensagem falhou uid=%s:', uid, err)
        }
      }

      if (maxUid > storedLastUid) {
        await saveState(channelId, meta, uidValidity, maxUid)
      }
    } finally {
      lock.release()
    }
  } finally {
    try {
      await client.logout()
    } catch {
      /* ignore */
    }
  }
  return processed
}

/** Varre TODOS os canais gmail conectados. Um canal com erro (senha revogada,
 *  IMAP fora) não derruba os outros. */
export async function runGmailPollSweep(): Promise<{
  channels: number
  messages: number
}> {
  const rows = await db
    .select({ id: channels.id })
    .from(channels)
    .where(and(eq(channels.provider, 'gmail'), eq(channels.status, 'connected')))

  let messages = 0
  for (const r of rows) {
    try {
      messages += await pollOneChannel(r.id)
    } catch (err) {
      console.error('[gmail-poll] canal %s falhou:', r.id, err)
    }
  }
  return { channels: rows.length, messages }
}

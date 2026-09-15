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
import { and, eq, sql } from 'drizzle-orm'

import { db, channels } from '@/db'
import { loadChannel } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { dispatchInboundMessage } from '@/lib/channels/inbound'
import { gmailAddressOf, appPasswordOf } from '@/lib/channels/providers/gmail'
import { inGmailAuthBackoff, markGmailAuthFailed } from '@/lib/channels/gmail-auth-backoff'
import { recordGmailFailure, recordGmailImapLoginOk } from '@/lib/channels/gmail-health'
import { parseDeliveryReport } from '@/lib/channels/email-bounce'
import { applyEmailBounce } from '@/lib/channels/email-bounce-apply'

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

/**
 * Grava o ponto de leitura por MERGE no provider_meta (nunca o objeto lido no
 * começo do tick): a web grava Pix/Localização/saúde/senha no mesmo campo, e
 * um lote demorado apagaria o que ela gravou no meio. Na mesma época de UIDs o
 * ponto nunca volta pra trás.
 */
async function saveState(channelId: string, uidValidity: string, lastUid: number): Promise<void> {
  await db
    .update(channels)
    .set({
      providerMeta: sql`coalesce(${channels.providerMeta}, '{}'::jsonb) || jsonb_build_object(
        'gmailUidValidity', ${uidValidity}::text,
        'gmailLastUid', CASE
          WHEN ${channels.providerMeta}->>'gmailUidValidity' = ${uidValidity}::text
            THEN greatest(coalesce((${channels.providerMeta}->>'gmailLastUid')::int, 0), ${lastUid}::int)
          ELSE ${lastUid}::int
        END
      )`,
    })
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
    // Conta como falha (saúde do canal), não como leitura ok.
    throw new Error('canal Gmail sem endereço ou senha de app salvos')
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: address, pass: appPassword },
    logger: false,
  })
  // 15/09 (GoLink, senha de app revogada): login recusado rejeita o connect()
  // mas o imapflow deixa o socket aberto; 5 min depois o timeout vira evento
  // 'error' sem ouvinte e DERRUBA o worker inteiro (todas as contas), a cada
  // tick. Ouvinte + close() no connect falho.
  client.on('error', (err: { code?: string; message?: string }) => {
    console.warn('[gmail-poll] imap error canal=%s code=%s %s', channelId, err?.code, err?.message)
  })

  let processed = 0
  try {
    await client.connect()
  } catch (err) {
    client.close()
    throw err
  }
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
        await saveState(channelId, uidValidity, Math.max(0, uidNext - 1))
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

          // 📭 15/09 (Vale Ouro): aviso de devolução NÃO é cliente escrevendo —
          // virava contato "Mail Delivery Subsystem". Vira nota na conversa do
          // envio + supressão (email-bounce-apply.ts) e nunca cai no inbox,
          // nem se aplicar der erro.
          // Formato de aviso vindo de quem NÃO é servidor de e-mail segue como
          // e-mail comum (não some do CRM).
          const report = parseDeliveryReport(parsed)
          if (report?.trusted) {
            try {
              await applyEmailBounce(ch, report)
            } catch (err) {
              console.error('[gmail-poll] devolução falhou uid=%s canal=%s:', uid, channelId, err)
            }
            processed++
            continue
          }

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
        await saveState(channelId, uidValidity, maxUid)
      }
    } finally {
      lock.release()
    }
  } finally {
    try {
      if (client.usable) await client.logout()
      else client.close()
    } catch {
      client.close()
    }
  }
  return processed
}

type ImapError = {
  code?: string
  message?: string
  authenticationFailed?: boolean
  responseStatus?: string
  serverResponseCode?: string
  responseText?: string
  executedCommand?: string
}

/** Uma linha com o que o Gmail respondeu ("Command failed" sozinho esconde a causa). */
function describeImapError(err: unknown): string {
  const e = (err ?? {}) as ImapError
  return [
    e.message,
    e.code && `code=${e.code}`,
    e.responseStatus && `status=${e.responseStatus}`,
    e.serverResponseCode && `server=${e.serverResponseCode}`,
    e.responseText && `text="${e.responseText}"`,
    e.executedCommand && `cmd="${e.executedCommand}"`,
  ]
    .filter(Boolean)
    .join(' ')
}

/** A senha de app foi trocada (gmail-credentials.ts) depois deste instante? */
async function passwordChangedSince(channelId: string, sinceMs: number): Promise<boolean> {
  try {
    const [row] = await db
      .select({ at: sql<string | null>`${channels.providerMeta}->>'gmailPasswordChangedAt'` })
      .from(channels)
      .where(eq(channels.id, channelId))
      .limit(1)
    const at = row?.at ? Date.parse(row.at) : NaN
    return Number.isFinite(at) && at >= sinceMs
  } catch {
    return false
  }
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
    // Senha recusada: espera 30 min entre tentativas (gmail-auth-backoff.ts).
    if (await inGmailAuthBackoff(r.id)) continue
    const tickStartedAt = Date.now()
    try {
      messages += await pollOneChannel(r.id)
      await recordGmailImapLoginOk(r.id, tickStartedAt)
    } catch (err) {
      // Admin trocou a senha enquanto este tick tentava com a antiga: a recusa
      // é da senha velha. Registrar aqui reabriria o aviso e a espera de 30 min
      // logo depois da troca.
      if ((err as ImapError)?.authenticationFailed && (await passwordChangedSince(r.id, tickStartedAt))) {
        console.info('[gmail-poll] canal %s: recusa da senha antiga — a senha acabou de ser trocada', r.id)
        continue
      }
      await recordGmailFailure(r.id, 'imap', err)
      if ((err as ImapError)?.authenticationFailed) {
        await markGmailAuthFailed(r.id)
        console.error(
          '[gmail-poll] canal %s: Gmail recusou a senha de app (%s). Próxima tentativa em 30 min.',
          r.id,
          describeImapError(err),
        )
      } else {
        console.error('[gmail-poll] canal %s falhou: %s', r.id, describeImapError(err), err)
      }
    }
  }
  return { channels: rows.length, messages }
}

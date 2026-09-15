// ============================================================
// Troca a senha de app de um canal Gmail SEM recriar o canal.
//
// 15/09 (GoLink, golinkoficial@gmail.com): o Google revogou a senha de app às
// 23:13 de 14/09 (acontece sempre que alguém troca a senha da conta Google).
// O único jeito de consertar era apagar e criar o canal de novo — o que apaga
// as conversas (FK em cascata) e zera o ponto de leitura (e-mails que chegaram
// no meio nunca entrariam). Aqui só a credencial muda:
//   - o endereço é SEMPRE o salvo (o ponto de leitura é daquela caixa);
//   - a senha só é gravada depois que o Google aceitar no SMTP E no IMAP;
//   - gmailLastUid/gmailUidValidity ficam intactos → o poll retoma de onde
//     parou e importa o que chegou enquanto estava parado;
//   - a saúde (provider_meta.health) sai por merge jsonb, nunca por objeto
//     (o worker grava o mesmo campo no meio);
//   - a espera de 30 min do poll (gmail-auth-backoff) é apagada.
//
// Usado só pela rota POST /api/channels/[id]/gmail-password (importa imapflow
// via gmail-verify — não importar de módulo alcançável pelo registry).
// ============================================================

import { and, eq, sql } from 'drizzle-orm'

import { db, channels } from '@/db'
import { encryptCredentials, loadChannelByAccount } from '@/lib/channels/channels'
import { gmailAddressOf } from '@/lib/channels/providers/gmail'
import { clearGmailAuthBackoff } from '@/lib/channels/gmail-auth-backoff'
import { publishEvent } from '@/lib/events/publish'
import type { ChannelCtx } from '@/lib/channels/provider'

import {
  GmailVerifyError,
  normalizeAppPassword,
  normalizeGmailAddress,
  verifyGmailImap,
  verifyGmailSmtp,
} from './gmail-verify'

export type ReplaceGmailAppPasswordResult =
  | {
      ok: true
      /** false = Redis fora: a espera antiga vence sozinha (até 30 min). */
      pollResumesNow: boolean
      /** A caixa é a mesma época de UIDs do ponto salvo? null = nunca leu. */
      mailboxMatches: boolean | null
      /** E-mails que chegaram desde o último lido (estimativa). */
      backlogEstimate: number | null
    }
  | { ok: false; httpStatus: 400 | 404 | 502; error: string }

const APP_PASSWORD_RE = /^[a-zA-Z]{16}$/

export const GMAIL_MSG = {
  notFound: 'Canal não encontrado.',
  notGmail: 'Este canal não é um Gmail.',
  noAddress: 'Este canal Gmail não tem endereço salvo. Crie o canal de novo.',
  badFormat:
    'A senha de app do Google tem 16 letras (ex.: abcd efgh ijkl mnop). Não é a senha normal da conta.',
  refused:
    'O Google recusou essa senha de app. Gere uma nova em myaccount.google.com/apppasswords (a verificação em 2 etapas precisa estar ligada).',
  imapRefused:
    'O envio funcionou, mas a leitura da caixa (IMAP) foi recusada. Confira se o IMAP não está bloqueado na conta Google.',
  unreachable: 'Não consegui falar com o Gmail agora. Tente de novo em alguns minutos.',
} as const

/** Endereço salvo: credentials.address; canal antigo sem ele cai no provider_meta. */
function savedAddressOf(ch: ChannelCtx): string | null {
  try {
    return gmailAddressOf(ch)
  } catch {
    const meta = ch.providerMeta?.address
    return typeof meta === 'string' && meta.includes('@') ? normalizeGmailAddress(meta) : null
  }
}

function verifyFailure(err: unknown): { ok: false; httpStatus: 400 | 502; error: string } {
  if (err instanceof GmailVerifyError && err.kind === 'auth') {
    return {
      ok: false,
      httpStatus: 400,
      error: err.step === 'imap' ? GMAIL_MSG.imapRefused : GMAIL_MSG.refused,
    }
  }
  return { ok: false, httpStatus: 502, error: GMAIL_MSG.unreachable }
}

export async function replaceGmailAppPassword(
  accountId: string,
  channelId: string,
  raw: string,
): Promise<ReplaceGmailAppPasswordResult> {
  const ch = await loadChannelByAccount(accountId, channelId)
  if (!ch) return { ok: false, httpStatus: 404, error: GMAIL_MSG.notFound }
  if (ch.provider !== 'gmail') return { ok: false, httpStatus: 400, error: GMAIL_MSG.notGmail }

  const appPassword = normalizeAppPassword(typeof raw === 'string' ? raw : '')
  if (!APP_PASSWORD_RE.test(appPassword)) {
    return { ok: false, httpStatus: 400, error: GMAIL_MSG.badFormat }
  }

  // O corpo nunca escolhe a caixa: o ponto de leitura salvo é desta.
  const address = savedAddressOf(ch)
  if (!address) return { ok: false, httpStatus: 400, error: GMAIL_MSG.noAddress }

  // SMTP primeiro (mais rápido e dá a mensagem mais comum); IMAP em seguida.
  let imap: { uidValidity: string; uidNext: number }
  try {
    await verifyGmailSmtp(address, appPassword)
    imap = await verifyGmailImap(address, appPassword)
  } catch (err) {
    const e = err as Partial<GmailVerifyError>
    console.warn(
      '[gmail-credentials] senha de app NÃO aceita canal=%s conta=%s etapa=%s tipo=%s code=%s',
      channelId,
      accountId,
      e?.step ?? '?',
      e?.kind ?? 'inesperado',
      e?.code ?? '-',
    )
    return verifyFailure(err)
  }

  const meta = ch.providerMeta ?? {}
  const storedValidity = typeof meta.gmailUidValidity === 'string' ? meta.gmailUidValidity : null
  const storedLastUid = typeof meta.gmailLastUid === 'number' ? meta.gmailLastUid : null
  const mailboxMatches = storedValidity === null ? null : storedValidity === imap.uidValidity
  const backlogEstimate =
    mailboxMatches === true && storedLastUid !== null
      ? Math.max(0, imap.uidNext - 1 - storedLastUid)
      : null

  const now = new Date().toISOString()
  const updated = await db
    .update(channels)
    .set({
      credentials: encryptCredentials({ ...ch.credentials, address, appPassword }),
      status: 'connected',
      // Merge jsonb: tira só a saúde (e o aviso já dado) e marca a troca — o
      // ponto de leitura e o resto (Pix, Localização) ficam como o worker/web
      // deixaram. gmailPasswordChangedAt deixa o poll descartar a falha de um
      // tick que começou com a senha velha.
      providerMeta: sql`(coalesce(${channels.providerMeta}, '{}'::jsonb) - 'health') || jsonb_build_object('gmailPasswordChangedAt', ${now}::text)`,
      updatedAt: now,
    })
    .where(
      and(eq(channels.accountId, accountId), eq(channels.id, channelId), eq(channels.provider, 'gmail')),
    )
    .returning({ id: channels.id })
  if (updated.length === 0) {
    // Apagado entre a leitura e a gravação.
    return { ok: false, httpStatus: 404, error: GMAIL_MSG.notFound }
  }

  const pollResumesNow = await clearGmailAuthBackoff(channelId)

  await publishEvent(accountId, {
    type: 'channel_status',
    channelId,
    name: ch.name,
    status: 'connected',
  })

  console.info(
    '[gmail-credentials] senha de app trocada canal=%s conta=%s mesmaCaixa=%s atrasados=%s pollAgora=%s',
    channelId,
    accountId,
    mailboxMatches,
    backlogEstimate,
    pollResumesNow,
  )

  return { ok: true, pollResumesNow, mailboxMatches, backlogEstimate }
}

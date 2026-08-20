// ============================================================
// Webhook de E-MAIL — recebe o e-mail do Cloudflare Email Worker.
//   POST body (JSON): { from, fromName, to, subject, text, html, messageId }
//   header: `x-email-token` = o segredo do canal (credentials.inboundSecret) ou
//           a env EMAIL_INBOUND_SECRET.
// Roteia pelo endereço de DESTINO (`to`) → acha o canal `email` → valida o token
// → parseWebhook → dispatchInboundMessage (cria contato por e-mail + conversa).
// Responde 200 rápido; a ingestão roda em `after`.
// ============================================================

import { NextResponse, after } from 'next/server'
import PostalMime from 'postal-mime'

import { loadEmailChannelByAddress } from '@/lib/channels/channels'
import { getProvider } from '@/lib/channels/registry'
import { dispatchInboundMessage } from '@/lib/channels/inbound'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200 })
}

/** Só o endereço, minúsculo, de um "Nome <email>" ou "email". */
function bareEmail(v: unknown): string {
  if (typeof v !== 'string') return ''
  const m = v.match(/<([^>]+)>/)
  return (m ? m[1] : v).trim().toLowerCase()
}

// Anexo individual acima disso a gente ignora (protege memória do webhook e o
// limite de tamanho do Resend/MinIO). ~20MB binários.
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

/** Converte o `content` de um anexo do PostalMime (ArrayBuffer/Uint8Array/
 *  string) em base64, respeitando o teto de tamanho. Retorna null se estourar
 *  ou vier vazio. */
function attachmentToBase64(content: unknown): string | null {
  let buf: Buffer | null = null
  if (content instanceof ArrayBuffer) {
    buf = Buffer.from(new Uint8Array(content))
  } else if (ArrayBuffer.isView(content)) {
    buf = Buffer.from(content.buffer, content.byteOffset, content.byteLength)
  } else if (typeof content === 'string') {
    // PostalMime pode entregar como string (base64 já) — reembala pra medir.
    buf = Buffer.from(content, 'base64')
  }
  if (!buf || buf.length === 0 || buf.length > MAX_ATTACHMENT_BYTES) return null
  return buf.toString('base64')
}

export async function POST(request: Request) {
  const rawBody = await request.text()

  let body: {
    to?: unknown
    from?: unknown
    raw?: unknown
  } & Record<string, unknown> | null
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Worker "sem dependência" manda o e-mail cru (`raw`) — a gente faz o parse
  // do MIME aqui (assunto/corpo/HTML/remetente). Se vier já parseado (JSON com
  // from/subject/text…), usa direto.
  if (body && typeof body.raw === 'string' && body.raw) {
    try {
      const parsed = await new PostalMime().parse(body.raw)
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
      body = {
        to: body.to,
        from: parsed.from?.address || body.from || '',
        fromName: parsed.from?.name || '',
        subject: parsed.subject || '',
        text: parsed.text || '',
        html: parsed.html || '',
        messageId: parsed.messageId || '',
        attachments,
      }
    } catch (err) {
      console.error('[webhooks/email] falha ao parsear o MIME:', err)
      return NextResponse.json({ error: 'MIME parse failed' }, { status: 400 })
    }
  }

  const to = bareEmail(body?.to)
  if (!to) {
    return NextResponse.json({ error: "campo 'to' ausente" }, { status: 400 })
  }

  const channel = await loadEmailChannelByAddress(to)
  if (!channel) {
    // Nenhum canal de e-mail com esse endereço — ignora (não vaza).
    console.warn('[webhooks/email] sem canal para o endereço', to)
    return NextResponse.json({ status: 'ignored' }, { status: 200 })
  }

  const provider = getProvider('email')
  const ok = await provider.verifyWebhook(
    { rawBody, headers: request.headers },
    channel,
  )
  if (!ok) {
    console.warn('[webhooks/email] token inválido para', to)
    return NextResponse.json({ error: 'Invalid token' }, { status: 401 })
  }

  after(async () => {
    try {
      const parsed = provider.parseWebhook(body)
      for (const ev of parsed.messages) {
        await dispatchInboundMessage(channel, ev)
      }
    } catch (err) {
      console.error('[webhooks/email] process error:', err)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}

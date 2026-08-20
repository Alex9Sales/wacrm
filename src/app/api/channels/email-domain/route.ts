// ============================================================
// POST /api/channels/email-domain — cria um canal de e-mail com DOMÍNIO PRÓPRIO
// (white-label). Ver [[crmfluxia-email-canal]] + email-domains.ts.
//
// Body: { name, address, from_name? }  (address = e-mail na marca do cliente,
//        ex.: atendimento@empresadele.com)
// Fluxo:
//   1) valida o endereço + extrai o domínio (não pode ser o hospedado);
//   2) cria o domínio na nossa conta Resend → registros SPF/DKIM;
//   3) gera um `ingestAddress` único (alvo do encaminhamento p/ receber);
//   4) cria o canal 'disconnected' (libera envio quando o domínio verificar).
// Resposta: { channelId, ingestAddress, domain: { id, status, records } }.
// ============================================================

import { randomBytes } from 'node:crypto'

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { createChannel } from '@/lib/channels/channels'
import {
  EMAIL_HOSTED_DOMAIN,
  createBrandedDomain,
  detectDnsProvider,
  domainOfEmail,
} from '@/lib/channels/providers/email-domains'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    let body: { name?: unknown; address?: unknown; from_name?: unknown }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
    }

    const name = typeof body.name === 'string' ? body.name.trim() : ''
    const address =
      typeof body.address === 'string' ? body.address.trim().toLowerCase() : ''
    const fromName =
      typeof body.from_name === 'string' && body.from_name.trim()
        ? body.from_name.trim()
        : null

    if (!name) {
      return NextResponse.json({ error: 'Dê um nome ao canal.' }, { status: 400 })
    }
    if (!address.includes('@')) {
      return NextResponse.json(
        { error: 'Informe um e-mail válido (ex.: atendimento@suaempresa.com.br).' },
        { status: 400 },
      )
    }
    const domain = domainOfEmail(address)
    if (!domain) {
      return NextResponse.json(
        { error: 'E-mail inválido — não consegui identificar o domínio.' },
        { status: 400 },
      )
    }
    if (domain === EMAIL_HOSTED_DOMAIN || domain.endsWith(`.${EMAIL_HOSTED_DOMAIN}`)) {
      return NextResponse.json(
        {
          error:
            'Esse já é o domínio hospedado da Fluxia — use a opção "apelido" simples, não o domínio próprio.',
        },
        { status: 400 },
      )
    }

    // Cria o domínio no Resend (envio). Pode falhar se já existir na conta —
    // repassamos a mensagem do Resend.
    let domainState
    try {
      domainState = await createBrandedDomain(domain)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : 'Falha ao criar o domínio no Resend.' },
        { status: 502 },
      )
    }

    // Alias hospedado único p/ RECEBER (o cliente encaminha a marca dele → aqui).
    const ingestAddress = `in-${randomBytes(6).toString('hex')}@${EMAIL_HOSTED_DOMAIN}`

    // Detecta o provedor de DNS do cliente (pelos NS) p/ um passo-a-passo
    // específico na UI. Não bloqueia: em falha, cai no genérico.
    const dnsProvider = await detectDnsProvider(domain).catch(() => null)

    const credentials: Record<string, unknown> = {}
    if (fromName) credentials.fromName = fromName

    let channel
    try {
      channel = await createChannel(ctx.accountId, {
        provider: 'email',
        name,
        // Nasce desconectado: só libera de fato quando o domínio verificar.
        status: 'disconnected',
        credentials,
        providerMeta: {
          mode: 'branded',
          address, // From + Reply-To (marca do cliente)
          from: address,
          ingestAddress, // recebe via encaminhamento
          resendDomainId: domainState.id,
          domainName: domain,
          domainStatus: domainState.status,
          ...(dnsProvider ? { dnsProvider } : {}),
        },
      })
    } catch (err) {
      const e = err as { code?: string; message?: string }
      if (e?.code === '23505') {
        return NextResponse.json(
          { error: 'Já existe um canal com esse nome ou endereço.' },
          { status: 409 },
        )
      }
      throw err
    }

    return NextResponse.json(
      {
        channelId: channel.id,
        ingestAddress,
        domain: domainState,
        dnsProvider,
      },
      { status: 201 },
    )
  } catch (err) {
    return toErrorResponse(err)
  }
}

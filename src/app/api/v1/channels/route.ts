// ============================================================
// GET /api/v1/channels — list the account's WhatsApp channels
//   (scope: broadcasts:send). Returns the id + name + provider + status of
//   each connected number so a caller (e.g. Hermes) can resolve which
//   channel_id to send a broadcast (or message) from — e.g. map the name
//   "Família do Gás 2" to its UUID. Read-only.
//
//   NOTE: this is the WhatsApp *sending* channels list. It is unrelated to
//   /api/v1/internal/channels, which are the team's internal CHAT channels.
//
//   `official` = true for the Meta Cloud API (templates, no jitter);
//   false for the non-official providers (WAHA/Evolution/EvoGo) that a text
//   broadcast (POST /broadcasts/text) runs on.
// ============================================================

import { randomBytes } from 'node:crypto';

import { asc, eq } from 'drizzle-orm';

import { db, channels } from '@/db';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, badRequest, toApiErrorResponse } from '@/lib/api/v1/respond';
import { getProvider } from '@/lib/channels/registry';
import { createChannel, type CreateChannelInput } from '@/lib/channels/channels';
import { EMAIL_HOSTED_DOMAIN } from '@/lib/channels/providers/email-domains';
import { verifyGmailLogin } from '@/lib/channels/providers/gmail';
import type { ProviderId } from '@/lib/channels/provider';

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'broadcasts:send');
    const rows = await db
      .select({
        id: channels.id,
        name: channels.name,
        provider: channels.provider,
        status: channels.status,
        phone_number: channels.phoneNumber,
      })
      .from(channels)
      .where(eq(channels.accountId, ctx.accountId))
      .orderBy(asc(channels.createdAt));

    const data = rows.map((r) => ({
      ...r,
      // Non-official providers need jitter; Meta (official) does not.
      official: !getProvider(r.provider as ProviderId).capabilities.needsJitter,
    }));
    return ok({ data });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

// ============================================================
// POST /api/v1/channels — cria um canal por API (scope: channels:write).
// Só os modos "ponte" (sem tela): E-MAIL HOSPEDADO (apelido no domínio da
// Fluxia, sem DNS) e GMAIL (senha de app). Domínio próprio (branded) exige DNS
// → segue só pela tela. Body:
//   E-mail hospedado: { "provider":"email", "name":"Suporte", "handle":"suporte", "from_name"? }
//                     → cria suporte@<domínio hospedado>
//   Gmail:            { "provider":"gmail", "name":"Loja", "address":"loja@gmail.com",
//                       "app_password":"...", "from_name"? }  (valida o login antes)
// Resposta: { data: { id, provider, name, address, status } }.
// ============================================================
export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'channels:write');

    let body: {
      provider?: unknown
      name?: unknown
      handle?: unknown
      address?: unknown
      from?: unknown
      resend_api_key?: unknown
      inbound_secret?: unknown
      smtp_host?: unknown
      smtp_port?: unknown
      smtp_user?: unknown
      smtp_password?: unknown
      app_password?: unknown
      from_name?: unknown
    };
    try {
      body = await request.json();
    } catch {
      throw badRequest('Invalid JSON body');
    }

    const provider = typeof body.provider === 'string' ? body.provider : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const fromName =
      typeof body.from_name === 'string' && body.from_name.trim()
        ? body.from_name.trim()
        : null;
    if (!name) throw badRequest('`name` is required.');

    let input: CreateChannelInput;
    // Preenchido no modo BYO — o cliente precisa desse segredo pra apontar o
    // inbound do provedor dele pro nosso webhook.
    let byoInboundSecret: string | null = null;

    if (provider === 'email') {
      const addressRaw = typeof body.address === 'string' ? body.address.trim() : '';
      const handle =
        typeof body.handle === 'string'
          ? body.handle.split('@')[0].trim().toLowerCase()
          : '';
      const from = typeof body.from === 'string' ? body.from.trim() : '';
      const resendKey =
        typeof body.resend_api_key === 'string' ? body.resend_api_key.trim() : '';
      const inboundSecretIn =
        typeof body.inbound_secret === 'string' ? body.inbound_secret.trim() : '';

      if (addressRaw) {
        // BYO ("traga o seu"): o CLIENTE traz o domínio dele + (opcional) o
        // Resend dele. Envia pela chave dele; recebe apontando o inbound do
        // provedor dele pro nosso webhook com o `inbound_secret`. A Fluxia é só
        // o inbox — não hospeda nada.
        const address = addressRaw.toLowerCase();
        if (!address.includes('@')) throw badRequest('`address` inválido.');
        const inboundSecret = inboundSecretIn || randomBytes(16).toString('hex');
        const credentials: Record<string, unknown> = { inboundSecret };
        if (resendKey) credentials.resendApiKey = resendKey;
        // SMTP genérico (qualquer provedor: Hostinger, HostGator, etc.).
        const smtpHost = typeof body.smtp_host === 'string' ? body.smtp_host.trim() : '';
        const smtpUser = typeof body.smtp_user === 'string' ? body.smtp_user.trim() : '';
        const smtpPassword = typeof body.smtp_password === 'string' ? body.smtp_password : '';
        if (smtpHost && smtpUser && smtpPassword) {
          credentials.smtpHost = smtpHost;
          credentials.smtpUser = smtpUser;
          credentials.smtpPassword = smtpPassword;
          credentials.smtpPort = Number(body.smtp_port) || 587;
        }
        if (fromName) credentials.fromName = fromName;
        const providerMeta: Record<string, unknown> = { address };
        if (from) providerMeta.from = from;
        input = {
          provider: 'email',
          name,
          status: 'connected',
          credentials,
          providerMeta,
        };
        byoInboundSecret = inboundSecret;
      } else {
        // HOSPEDADO: só o apelido, no domínio da Fluxia (nossa infra é a ponte).
        if (!/^[a-z0-9](?:[a-z0-9._-]{0,30}[a-z0-9])?$/.test(handle)) {
          throw badRequest(
            'Informe `handle` (e-mail hospedado) OU `address` (+ `resend_api_key`) pro seu próprio provedor.',
          );
        }
        const address = `${handle}@${EMAIL_HOSTED_DOMAIN}`;
        const credentials: Record<string, unknown> = {};
        if (fromName) credentials.fromName = fromName;
        input = {
          provider: 'email',
          name,
          status: 'connected',
          credentials,
          providerMeta: { address, from: address },
        };
      }
    } else if (provider === 'gmail') {
      const address =
        typeof body.address === 'string' ? body.address.trim().toLowerCase() : '';
      const appPassword =
        typeof body.app_password === 'string'
          ? body.app_password.replace(/\s+/g, '')
          : '';
      if (!address.includes('@')) throw badRequest('`address` (Gmail) é obrigatório.');
      if (!appPassword) throw badRequest('`app_password` é obrigatório.');
      try {
        await verifyGmailLogin(address, appPassword);
      } catch {
        throw badRequest(
          'Não consegui conectar ao Gmail — confira o e-mail e a senha de app (2FA + IMAP ativos).',
        );
      }
      const credentials: Record<string, unknown> = { address, appPassword };
      if (fromName) credentials.fromName = fromName;
      input = {
        provider: 'gmail',
        name,
        status: 'connected',
        credentials,
        providerMeta: { address },
      };
    } else {
      throw badRequest(
        'Por API só dá pra criar canal `email` (hospedado) ou `gmail`. Outros canais: use a tela.',
      );
    }

    // BYO-SMTP: valida o login SMTP antes de criar.
    if (provider === 'email' && typeof input.credentials.smtpHost === 'string') {
      const c = input.credentials as {
        smtpHost?: string
        smtpPort?: number
        smtpUser?: string
        smtpPassword?: string
      };
      try {
        const { verifySmtpLogin } = await import('@/lib/channels/providers/email');
        await verifySmtpLogin(
          String(c.smtpHost ?? ''),
          Number(c.smtpPort) || 587,
          String(c.smtpUser ?? ''),
          String(c.smtpPassword ?? ''),
        );
      } catch {
        throw badRequest('Não consegui conectar ao SMTP — confira host, porta, usuário e senha.');
      }
    }

    let channel;
    try {
      channel = await createChannel(ctx.accountId, input);
    } catch (err) {
      const e = err as { code?: string };
      if (e?.code === '23505') {
        return fail('conflict', 'Já existe um canal com esse nome ou endereço.', 409);
      }
      throw err;
    }

    const address = (channel.providerMeta as { address?: string }).address ?? null;
    return ok(
      {
        id: channel.id,
        provider: channel.provider,
        name: channel.name,
        address,
        status: 'connected',
        // BYO: onde o cliente aponta o inbound do provedor dele (Resend inbound,
        // encaminhamento, MX próprio…) pra os e-mails caírem no CRM.
        ...(byoInboundSecret
          ? {
              inbound: {
                webhook_url: 'https://crm.salestecnologia.com.br/api/webhooks/email',
                header: 'x-email-token',
                secret: byoInboundSecret,
                body: 'JSON { to, from, raw } (MIME cru) OU { to, from, subject, text, html }',
              },
            }
          : {}),
      },
      201,
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

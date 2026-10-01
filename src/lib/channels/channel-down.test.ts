import { describe, expect, it } from 'vitest'

import {
  META_REASON,
  channelDisconnectedMessage,
  disconnectedSendMessage,
  isTokenChannelDown,
  isTokenProvider,
  looksLikeChannelAuthFailure,
  metaReasonPt,
  selectBannerChannels,
  tokenBannerLabel,
  tokenChannelProblem,
} from './channel-down'

// Textos no formato que a Meta devolve (sem dado de cliente; fbtrace fictício).
const IG_SESSION_INVALIDATED =
  'Error validating access token: The session has been invalidated because the user changed their password or Facebook has changed the session for security reasons.'
const IG_SEND_190 = `instagram send falhou: 401 ${IG_SESSION_INVALIDATED} [code=190 subcode=460 fbtrace_id=AbCdEf123]`
const META_EXPIRED =
  'Error validating access token: Session has expired on Wednesday, 30-Sep-26 10:00:00 PDT. The current time is Thursday, 01-Oct-26 08:00:00 PDT.'

describe('metaReasonPt — motivo da Meta em PT curto', () => {
  it('sessão invalidada (190, senha trocada) → senha/sessão encerrada', () => {
    expect(metaReasonPt(IG_SESSION_INVALIDATED)).toBe(META_REASON.sessionInvalidated)
    expect(metaReasonPt(IG_SEND_190)).toBe(META_REASON.sessionInvalidated)
  })

  it('a Meta escrevendo em português também casa', () => {
    expect(
      metaReasonPt('A sessão foi invalidada porque o usuário alterou a senha.'),
    ).toBe(META_REASON.sessionInvalidated)
    expect(metaReasonPt('A sessão expirou em quarta-feira.')).toBe(META_REASON.expired)
  })

  it('token vencido → "o acesso venceu" (mesmo com "access token" no texto)', () => {
    expect(metaReasonPt(META_EXPIRED)).toBe(META_REASON.expired)
    // Fallback gravado pelo instagram-health quando o refresh não diz o motivo.
    expect(metaReasonPt('token vencido')).toBe(META_REASON.expired)
    expect(metaReasonPt('[code=190 subcode=463]')).toBe(META_REASON.expired)
  })

  it('190 sem detalhe (inclusive o texto do meta-health) → senha/sessão encerrada', () => {
    expect(metaReasonPt('token de acesso inválido ou expirado (190)')).toBe(
      META_REASON.sessionInvalidated,
    )
    expect(metaReasonPt('Invalid OAuth access token - Cannot parse access token')).toBe(
      META_REASON.sessionInvalidated,
    )
    expect(metaReasonPt('(#190) qualquer coisa')).toBe(META_REASON.sessionInvalidated)
  })

  it('outros motivos ou nenhum → "a Meta recusou o acesso"', () => {
    expect(metaReasonPt(null)).toBe(META_REASON.refused)
    expect(metaReasonPt('')).toBe(META_REASON.refused)
    expect(metaReasonPt('status BANNED na Meta')).toBe(META_REASON.refused)
    expect(
      metaReasonPt('número não existe mais na Meta ou o app perdeu a permissão (100)'),
    ).toBe(META_REASON.refused)
  })

  it('nunca devolve o texto cru (fbtrace_id, ids) — só uma das três frases', () => {
    const frases = Object.values(META_REASON) as string[]
    for (const raw of [IG_SEND_190, META_EXPIRED, 'fbtrace_id=XYZ conta 17841400000000000']) {
      const out = metaReasonPt(raw)
      expect(frases).toContain(out)
      expect(out).not.toMatch(/fbtrace|1784/)
    }
  })
})

describe('tokenChannelProblem — o que a rota de status devolve', () => {
  it('Instagram marcado pelo monitor (disconnected + needs_reconnect)', () => {
    expect(
      tokenChannelProblem({
        provider: 'instagram',
        status: 'disconnected',
        providerMeta: {
          ig_id: '17841400000000000',
          health: { state: 'needs_reconnect', reason: IG_SESSION_INVALIDATED, at: '2026-10-01T18:30:00Z' },
        },
      }),
    ).toBe(META_REASON.sessionInvalidated)
  })

  it('needs_reconnect vale mesmo com o status ainda "connected"', () => {
    expect(
      tokenChannelProblem({
        provider: 'instagram',
        status: 'connected',
        providerMeta: { health: { state: 'needs_reconnect', reason: 'token vencido' } },
      }),
    ).toBe(META_REASON.expired)
  })

  it('WhatsApp oficial derrubado pelo meta-health usa o last_error', () => {
    expect(
      tokenChannelProblem({
        provider: 'meta',
        status: 'disconnected',
        providerMeta: {
          health: { last_verdict: 'dead', last_error: 'token de acesso inválido ou expirado (190)', marked_down: true },
        },
      }),
    ).toBe(META_REASON.sessionInvalidated)
  })

  it('desconectado sem motivo gravado (ex.: app removido no Instagram) → frase genérica', () => {
    expect(
      tokenChannelProblem({ provider: 'messenger', status: 'disconnected', providerMeta: {} }),
    ).toBe(META_REASON.refused)
    expect(
      tokenChannelProblem({ provider: 'instagram', status: 'error', providerMeta: null }),
    ).toBe(META_REASON.refused)
  })

  // Revisão 01/10: oficial 'disconnected' de propósito (registro do número
  // falhou) ou 'error' pela régua de cobrança NÃO é "derrubado pela Meta".
  it('WhatsApp oficial só aparece com a marca do monitor (marked_down)', () => {
    expect(
      tokenChannelProblem({ provider: 'meta', status: 'disconnected', providerMeta: { last_registration_error: 'PIN' } }),
    ).toBeNull()
    expect(tokenChannelProblem({ provider: 'meta', status: 'error', providerMeta: {} })).toBeNull()
    expect(
      tokenChannelProblem({
        provider: 'meta',
        status: 'disconnected',
        providerMeta: { health: { marked_down: true, last_error: 'token de acesso inválido ou expirado (190)' } },
      }),
    ).not.toBeNull()
  })

  it('canal de token saudável, ou com aviso âmbar (warn), não aparece', () => {
    expect(
      tokenChannelProblem({ provider: 'instagram', status: 'connected', providerMeta: { health: { state: 'ok' } } }),
    ).toBeNull()
    expect(
      tokenChannelProblem({
        provider: 'instagram',
        status: 'connected',
        providerMeta: { health: { state: 'warn', reason: 'conexão vale ~1 hora' } },
      }),
    ).toBeNull()
    expect(
      tokenChannelProblem({ provider: 'meta', status: 'connected', providerMeta: { health: { last_verdict: 'dead', strikes: 1 } } }),
    ).toBeNull()
  })

  it('canal que não é de token nunca recebe problem daqui', () => {
    expect(tokenChannelProblem({ provider: 'waha', status: 'disconnected', providerMeta: {} })).toBeNull()
    expect(tokenChannelProblem({ provider: 'gmail', status: 'disconnected', providerMeta: {} })).toBeNull()
    expect(isTokenChannelDown({ provider: 'email', status: 'disconnected', providerMeta: {} })).toBe(false)
  })
})

describe('selectBannerChannels — quem aparece no banner global', () => {
  const ch = (id: string, provider: string, status: string, problem: string | null = null) => ({
    id,
    provider,
    status,
    problem,
  })

  it('separa QR caído, Gmail com problema e canal de token, sem sobrepor', () => {
    const list = [
      ch('w1', 'waha', 'error'),
      ch('w2', 'waha', 'connected'),
      ch('e1', 'evolution', 'qr_pending'),
      ch('g1', 'gmail', 'connected', 'o Google recusou a senha de app'),
      ch('g2', 'gmail', 'connected'),
      ch('i1', 'instagram', 'disconnected', META_REASON.sessionInvalidated),
      ch('m1', 'messenger', 'connected'),
      ch('o1', 'meta', 'disconnected', META_REASON.refused),
      ch('x1', 'email', 'disconnected'),
    ]
    const sel = selectBannerChannels(list)
    expect(sel.qrDown.map((c) => c.id)).toEqual(['w1', 'e1'])
    expect(sel.gmailBroken.map((c) => c.id)).toEqual(['g1'])
    expect(sel.tokenDown.map((c) => c.id)).toEqual(['i1', 'o1'])
  })

  it('canal de token desconectado SEM problem não cai no grupo de QR (o modal de QR estouraria)', () => {
    const sel = selectBannerChannels([ch('i1', 'instagram', 'disconnected')])
    expect(sel.qrDown).toEqual([])
    expect(sel.tokenDown).toEqual([])
  })

  it('isTokenProvider cobre exatamente instagram/messenger/meta', () => {
    expect(['instagram', 'messenger', 'meta'].every(isTokenProvider)).toBe(true)
    expect(['waha', 'evolution', 'evogo', 'email', 'gmail', '', null].some(isTokenProvider)).toBe(false)
  })
})

describe('tokenBannerLabel — rótulo sem repetir o que o nome já diz', () => {
  it('omite o rótulo quando o nome já traz a rede', () => {
    expect(tokenBannerLabel('instagram', 'Instagram @loja')).toBeNull()
    expect(tokenBannerLabel('messenger', 'Messenger — Página da Loja')).toBeNull()
    expect(tokenBannerLabel('meta', 'WhatsApp (Meta)')).toBeNull()
  })

  it('põe o rótulo quando o nome é livre', () => {
    expect(tokenBannerLabel('instagram', 'Loja Centro')).toBe('Instagram')
    expect(tokenBannerLabel('messenger', 'Atendimento')).toBe('Messenger')
    expect(tokenBannerLabel('meta', 'Comercial')).toBe('WhatsApp oficial')
  })
})

describe('erro de envio → "canal desconectado"', () => {
  const ig = (status: string, providerMeta: unknown = {}) => ({
    provider: 'instagram',
    name: 'Instagram @loja',
    status,
    providerMeta,
  })
  const MSG = 'O canal Instagram @loja está desconectado — reconecte em Configurações → Canais.'

  it('reconhece a recusa de token nos formatos dos adaptadores', () => {
    expect(looksLikeChannelAuthFailure(`instagram send error: ${IG_SEND_190}`)).toBe(true)
    expect(looksLikeChannelAuthFailure(`meta send error: ${META_EXPIRED}`)).toBe(true)
    expect(
      looksLikeChannelAuthFailure('messenger send error: messenger send falhou: 400 Error validating access token: The user has not authorized application 123.'),
    ).toBe(true)
    expect(looksLikeChannelAuthFailure('instagram channel c1 sem credentials.accessToken')).toBe(true)
    expect(looksLikeChannelAuthFailure('meta channel c1 is missing credentials.accessToken')).toBe(true)
  })

  it('não confunde com janela de 24h, reação inválida ou número inexistente', () => {
    expect(looksLikeChannelAuthFailure('instagram send falhou: 400 (#10) This message is sent outside of allowed window. [code=10]')).toBe(false)
    expect(looksLikeChannelAuthFailure('instagram send falhou: 400 Reação inválida [code=100]')).toBe(false)
    expect(looksLikeChannelAuthFailure('Este número não parece estar no WhatsApp.')).toBe(false)
    expect(looksLikeChannelAuthFailure(null)).toBe(false)
  })

  it('token recusado no envio → frase de desconectado, mesmo com o canal ainda "connected"', () => {
    expect(
      disconnectedSendMessage({
        errorCode: 'send_error',
        errorMessage: `instagram send error: ${IG_SEND_190}`,
        channel: ig('connected'),
      }),
    ).toBe(MSG)
  })

  it('canal de token já marcado pelo monitor → qualquer falha de envio vira desconectado', () => {
    expect(
      disconnectedSendMessage({
        errorCode: 'send_error',
        errorMessage: 'O envio demorou demais e não foi confirmado.',
        channel: ig('disconnected', { health: { state: 'needs_reconnect' } }),
      }),
    ).toBe(MSG)
  })

  it('canal de token saudável com outra falha mantém o erro original', () => {
    expect(
      disconnectedSendMessage({
        errorCode: 'send_error',
        errorMessage: 'instagram send error: instagram send falhou: 400 (#10) outside of allowed window',
        channel: ig('connected', { health: { state: 'ok' } }),
      }),
    ).toBeNull()
  })

  it('db_error (a mensagem SAIU) e erros de validação nunca viram "desconectado"', () => {
    for (const errorCode of ['db_error', 'bad_request', 'unsupported', 'not_found', 'whatsapp_not_configured']) {
      expect(
        disconnectedSendMessage({
          errorCode,
          errorMessage: `x ${IG_SEND_190}`,
          channel: ig('disconnected', { health: { state: 'needs_reconnect' } }),
        }),
      ).toBeNull()
    }
  })

  it("code 'channel_disconnected' (quando o núcleo de envio souber dizer) é respeitado", () => {
    expect(
      disconnectedSendMessage({ errorCode: 'channel_disconnected', errorMessage: 'x', channel: ig('connected') }),
    ).toBe(MSG)
  })

  it('canal de QR caído: só troca o erro GENÉRICO; frase específica fica', () => {
    const waha = { provider: 'waha', name: 'Comercial', status: 'disconnected', providerMeta: {} }
    expect(
      disconnectedSendMessage({ errorCode: 'send_error', errorMessage: 'waha send error: socket hang up', channel: waha }),
    ).toBe('O canal Comercial está desconectado — reconecte em Configurações → Canais.')
    expect(
      disconnectedSendMessage({ errorCode: 'send_error', errorMessage: 'Este número não parece estar no WhatsApp.', channel: waha }),
    ).toBeNull()
    expect(
      disconnectedSendMessage({
        errorCode: 'send_error',
        errorMessage: 'waha send error: socket hang up',
        channel: { ...waha, status: 'connected' },
      }),
    ).toBeNull()
  })

  it('e-mail/Gmail ficam de fora (têm frase própria)', () => {
    expect(
      disconnectedSendMessage({
        errorCode: 'send_error',
        errorMessage: 'email send error: domínio não verificado',
        channel: { provider: 'email', name: 'Contato', status: 'disconnected', providerMeta: {} },
      }),
    ).toBeNull()
  })

  it('sem canal legível, mantém o erro original', () => {
    expect(
      disconnectedSendMessage({ errorCode: 'send_error', errorMessage: IG_SEND_190, channel: null }),
    ).toBeNull()
  })

  it('nome vazio ainda dá uma frase útil', () => {
    expect(channelDisconnectedMessage('  ')).toBe(
      'O canal desta conversa está desconectado — reconecte em Configurações → Canais.',
    )
  })
})

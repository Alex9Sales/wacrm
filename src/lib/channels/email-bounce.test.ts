import { describe, expect, it } from 'vitest'
import PostalMime from 'postal-mime'

import { bounceNoteText, bounceReason, isAddressFailure, parseDeliveryReport, reportFromDeliveryStatus } from './email-bounce'

// 15/09 (GoLink/Vale Ouro): a devolução do Gmail virou contato "Mail Delivery
// Subsystem". Fixture no formato REAL do aviso do Gmail (anexos
// message/delivery-status + text/rfc822-headers), com endereços trocados.

const ORIGINAL_ID = '<4a3e832e-1107-f5f2-480c-221184622209@gmail.com>'

function gmailDsn(opts: { action?: string; status?: string; diagnostic?: string } = {}): string {
  const action = opts.action ?? 'failed'
  const status = opts.status ?? '5.1.10'
  const diagnostic =
    opts.diagnostic ??
    "smtp; DNS Error: DNS type 'mx' lookup of empresa-exemplo.com.br responded with code NOERROR Domain name not found: empresa-exemplo.com.br returned Null MX"
  return [
    'From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>',
    'To: cobranca@exemplo.com.br',
    'Subject: Delivery Status Notification (Failure)',
    'Message-ID: <6aa7ef9a.8f302248.3dd33.5e05.GMR@mx.google.com>',
    'Auto-Submitted: auto-replied',
    'MIME-Version: 1.0',
    'Content-Type: multipart/report; boundary="b1"; report-type=delivery-status',
    '',
    '--b1',
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    '** Endereço não encontrado **',
    '',
    'A mensagem não foi entregue para financeiro@empresa-exemplo.com.br porque o domínio empresa-exemplo.com.br não foi encontrado.',
    '',
    '--b1',
    'Content-Type: message/delivery-status',
    '',
    'Reporting-MTA: dns; googlemail.com',
    'Arrival-Date: Mon, 14 Sep 2026 05:59:04 -0700 (PDT)',
    `X-Original-Message-ID: ${ORIGINAL_ID}`,
    '',
    'Final-Recipient: rfc822; financeiro@empresa-exemplo.com.br',
    `Action: ${action}`,
    `Status: ${status}`,
    `Diagnostic-Code: ${diagnostic}`,
    'Last-Attempt-Date: Mon, 14 Sep 2026 05:59:05 -0700 (PDT)',
    '',
    '--b1',
    'Content-Type: text/rfc822-headers',
    '',
    'From: Financeiro <cobranca@exemplo.com.br>',
    'To: financeiro@empresa-exemplo.com.br',
    'Subject: Lembrete de pagamento em aberto',
    `Message-ID: ${ORIGINAL_ID}`,
    '',
    '--b1--',
    '',
  ].join('\r\n')
}

const parse = (raw: string) => new PostalMime().parse(raw)

describe('parseDeliveryReport', () => {
  it('lê o aviso de devolução do Gmail (domínio com Null MX)', async () => {
    const report = parseDeliveryReport(await parse(gmailDsn()))
    expect(report).not.toBeNull()
    expect(report!.failed).toBe(true)
    expect(report!.permanent).toBe(true)
    expect(report!.recipients).toEqual([
      expect.objectContaining({ address: 'financeiro@empresa-exemplo.com.br', action: 'failed', status: '5.1.10' }),
    ])
    // As duas formas: o envio pelo Gmail grava messages.message_id COM <>.
    expect(report!.originalMessageIds).toContain(ORIGINAL_ID)
    expect(report!.originalMessageIds).toContain(ORIGINAL_ID.slice(1, -1))
  })

  it('atraso (Action: delayed) não é falha', async () => {
    const report = parseDeliveryReport(await parse(gmailDsn({ action: 'delayed', status: '4.4.7' })))
    expect(report).not.toBeNull()
    expect(report!.failed).toBe(false)
    expect(report!.permanent).toBe(false)
  })

  it('falha temporária (4.x.x) é falha, mas não permanente', async () => {
    const report = parseDeliveryReport(await parse(gmailDsn({ status: '4.2.2', diagnostic: 'smtp; mailbox full' })))
    expect(report!.failed).toBe(true)
    expect(report!.permanent).toBe(false)
  })

  it('Exchange: postmaster com multipart/report e o original em message/rfc822', async () => {
    const raw = [
      'From: postmaster@empresa-exemplo.com.br',
      'To: cobranca@exemplo.com.br',
      'Subject: Undeliverable: Lembrete',
      'MIME-Version: 1.0',
      'Content-Type: multipart/report; report-type=delivery-status; boundary="x"',
      '',
      '--x',
      'Content-Type: text/plain',
      '',
      'Delivery has failed.',
      '--x',
      'Content-Type: message/delivery-status',
      '',
      'Reporting-MTA: dns;mail.empresa-exemplo.com.br',
      '',
      'Final-Recipient: rfc822;Joao@Empresa-Exemplo.com.br',
      'Action: failed',
      'Status: 5.1.1',
      'Diagnostic-Code: smtp;550 5.1.1 RESOLVER.ADR.RecipNotFound; not found',
      '',
      '--x',
      'Content-Type: message/rfc822',
      '',
      'From: cobranca@exemplo.com.br',
      'To: joao@empresa-exemplo.com.br',
      'Message-ID: <11111111-2222-3333-4444-555555555555@gmail.com>',
      'Subject: Lembrete',
      '',
      'corpo',
      '--x--',
      '',
    ].join('\r\n')
    const report = parseDeliveryReport(await parse(raw))
    expect(report!.recipients[0]).toMatchObject({ address: 'joao@empresa-exemplo.com.br', status: '5.1.1' })
    expect(report!.originalMessageIds).toContain('<11111111-2222-3333-4444-555555555555@gmail.com>')
  })

  it('e-mail comum de cliente NÃO é devolução', async () => {
    const raw = [
      'From: Cliente <cliente@empresa-exemplo.com.br>',
      'To: cobranca@exemplo.com.br',
      'Subject: Re: Lembrete de pagamento',
      'In-Reply-To: ' + ORIGINAL_ID,
      'Content-Type: text/plain',
      '',
      'Já paguei, segue o comprovante.',
    ].join('\r\n')
    expect(parseDeliveryReport(await parse(raw))).toBeNull()
  })

  it('mailer-daemon com X-Failed-Recipients e sem relatório estruturado', async () => {
    const raw = [
      'From: Mail Delivery System <MAILER-DAEMON@mx.exemplo.net>',
      'To: cobranca@exemplo.com.br',
      'Subject: Mail delivery failed',
      'X-Failed-Recipients: sumiu@empresa-exemplo.com.br',
      `In-Reply-To: ${ORIGINAL_ID}`,
      'Content-Type: text/plain',
      '',
      'sumiu@empresa-exemplo.com.br',
      '    host mx.empresa-exemplo.com.br: 550 5.1.1 User unknown',
    ].join('\r\n')
    const report = parseDeliveryReport(await parse(raw))
    expect(report!.recipients).toEqual([expect.objectContaining({ address: 'sumiu@empresa-exemplo.com.br', status: '5.1.1' })])
    expect(report!.permanent).toBe(true)
    expect(report!.originalMessageIds).toContain(ORIGINAL_ID)
  })
})

describe('reportFromDeliveryStatus (reaplicar a partir do anexo guardado)', () => {
  it('lê só o texto do message/delivery-status', () => {
    const report = reportFromDeliveryStatus(
      `Reporting-MTA: dns; googlemail.com\nX-Original-Message-ID: ${ORIGINAL_ID}\n\nFinal-Recipient: rfc822; financeiro@empresa-exemplo.com.br\nAction: failed\nStatus: 5.1.10\n`,
    )
    expect(report.permanent).toBe(true)
    expect(report.originalMessageIds).toEqual([ORIGINAL_ID, ORIGINAL_ID.slice(1, -1)])
  })
})

describe('textos', () => {
  it('motivo em português simples', () => {
    expect(bounceReason('5.1.10', null)).toBe('o domínio não recebe e-mail')
    expect(bounceReason('5.1.1', null)).toBe('o endereço não existe')
    expect(bounceReason('5.0.0', 'returned Null MX')).toBe('o domínio não recebe e-mail')
  })

  it('a nota diz o endereço e só promete que a régua para quando suprimiu', async () => {
    const report = parseDeliveryReport(await parse(gmailDsn()))!
    const [r] = report.recipients
    const suprimido = bounceNoteText(report, r, { suppressed: true })
    expect(suprimido).toContain('financeiro@empresa-exemplo.com.br')
    expect(suprimido).toContain('A régua não manda mais e-mail')
    expect(suprimido.startsWith('🔀')).toBe(false)
    expect(bounceNoteText(report, r)).not.toContain('A régua não manda mais e-mail')
  })
})

// Revisão 15/09: caixa cheia e filtro de spam têm e-mail CERTO — não suprimem.
describe('isAddressFailure', () => {
  const r = (status: string | null, diagnostic: string | null = null) => ({ address: 'a@x.com', action: 'failed', status, diagnostic })
  it('endereço/domínio que não existe suprime', () => {
    expect(isAddressFailure(r('5.1.1'))).toBe(true)
    expect(isAddressFailure(r('5.1.10'))).toBe(true)
    expect(isAddressFailure(r('5.0.0', '550 5.0.0 User unknown'))).toBe(true)
  })
  it('caixa cheia, spam e genérico sem pista não suprimem', () => {
    expect(isAddressFailure(r('5.2.2'))).toBe(false)
    expect(isAddressFailure(r('5.7.1', 'Message rejected as spam'))).toBe(false)
    expect(isAddressFailure(r('5.0.0', 'rejected'))).toBe(false)
  })
  it('a nota de 5.7.x diz que o e-mail pode estar certo', async () => {
    const report = parseDeliveryReport(await parse(gmailDsn({ status: '5.7.1', diagnostic: 'smtp; 550 5.7.1 Message rejected as spam' })))!
    expect(bounceNoteText(report, report.recipients[0])).toContain('pode estar certo')
  })
})

describe('aviso forjado', () => {
  it('formato de aviso vindo de um cliente comum não é confiável', async () => {
    const raw = gmailDsn().replace('From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>', 'From: Devedor <devedor@empresa-exemplo.com.br>')
    const report = parseDeliveryReport(await parse(raw))
    expect(report).not.toBeNull()
    expect(report!.trusted).toBe(false)
  })

  it('aviso do daemon reprovado na autenticação não é confiável', async () => {
    const raw = gmailDsn().replace('Auto-Submitted: auto-replied', 'Authentication-Results: mx.google.com; spf=fail smtp.mailfrom=googlemail.com; dkim=fail')
    expect(parseDeliveryReport(await parse(raw))!.trusted).toBe(false)
  })

  it('milhares de destinatários: teto de 20, sem repetição', () => {
    const blocks = Array.from({ length: 5000 }, (_, i) => `Final-Recipient: rfc822; a${i % 30}@x.co\nAction: failed\nStatus: 5.1.1\n`).join('\n')
    const report = reportFromDeliveryStatus(`X-Original-Message-ID: ${ORIGINAL_ID}\n\n${blocks}`)
    expect(report.recipients.length).toBe(20)
    expect(new Set(report.recipients.map((x) => x.address)).size).toBe(20)
  })

  it('guarda o To do envio original (e-mail que veio do Asaas)', async () => {
    const report = parseDeliveryReport(await parse(gmailDsn()))!
    expect(report.originalRecipients).toEqual(['financeiro@empresa-exemplo.com.br'])
  })
})


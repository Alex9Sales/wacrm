import { describe, expect, it, vi } from 'vitest'

vi.mock('@/db', () => ({ db: {}, channels: {}, organization: {} }))
vi.mock('@/lib/events/publish', () => ({ publishEvent: vi.fn() }))
vi.mock('@/lib/alerts/channel-alert', () => ({ alertPlatform: vi.fn(), notifyChannelAdmins: vi.fn() }))

import { classifyGmailError, decideIncidentAlert, incidentAlertText, problemChanged } from './gmail-health'
import { gmailProblem, gmailSendBlockedReason } from './gmail-health-state'

// 15/09 (GoLink): o Google recusou a senha de app às 23:13 e o canal ficou
// verde a noite toda. Decisões puras do aviso.

const NOW = Date.parse('2026-09-15T12:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

describe('classifyGmailError', () => {
  it('imapflow e nodemailer com login recusado viram auth_failed', () => {
    expect(classifyGmailError({ authenticationFailed: true, executedCommand: '3 AUTHENTICATE PLAIN' }).verdict).toBe('auth_failed')
    expect(classifyGmailError({ code: 'EAUTH', responseCode: 535, message: 'Invalid login: 535-5.7.8' }).verdict).toBe('auth_failed')
    expect(classifyGmailError({ responseCode: 534 }).verdict).toBe('auth_failed')
  })

  it('limite temporário do SMTP (454) NÃO é senha recusada (revisão 15/09)', () => {
    expect(classifyGmailError({ code: 'EAUTH', responseCode: 454, message: 'Invalid login: 454 4.7.0 Too many login attempts' }).verdict).toBe('error')
    expect(classifyGmailError({ code: 'EAUTH', message: 'Missing credentials for "PLAIN"' }).verdict).toBe('auth_failed')
  })

  it('rede vira error com motivo curto, sem comando nem senha', () => {
    const r = classifyGmailError({ code: 'ETIMEDOUT', message: 'connect ETIMEDOUT' })
    expect(r.verdict).toBe('error')
    const leak = classifyGmailError({ message: 'Command failed AUTHENTICATE PLAIN AGdvbGluaw==' })
    expect(leak.reason).not.toContain('AGdvbGluaw')
  })
})

describe('decideIncidentAlert', () => {
  it('senha recusada avisa na hora, uma vez', () => {
    const meta = { health: { imap: { verdict: 'auth_failed', error: 'x', strikes: 1, first_fail_at: iso(0), last_at: iso(0) } } }
    expect(decideIncidentAlert(meta, NOW).alert).toBe(true)
    const avisado = { health: { ...meta.health, alerted_incident: true, alerted_kind: 'auth_failed', alerted_at: iso(0) } }
    expect(decideIncidentAlert(avisado, NOW).alert).toBe(false)
  })

  it('erro genérico só vira aviso com 30 falhas E 30 min', () => {
    const cedo = { health: { imap: { verdict: 'error', error: 'timeout', strikes: 40, first_fail_at: iso(10 * 60_000), last_at: iso(0) } } }
    expect(decideIncidentAlert(cedo, NOW).alert).toBe(false)
    const poucas = { health: { imap: { verdict: 'error', error: 'timeout', strikes: 29, first_fail_at: iso(60 * 60_000), last_at: iso(0) } } }
    expect(decideIncidentAlert(poucas, NOW).alert).toBe(false)
    const valeu = { health: { imap: { verdict: 'error', error: 'timeout', strikes: 30, first_fail_at: iso(31 * 60_000), last_at: iso(0) } } }
    expect(decideIncidentAlert(valeu, NOW).alert).toBe(true)
  })

  it('aviso de "falha" que vira "senha recusada" avisa de novo (a ação muda)', () => {
    const meta = {
      health: {
        imap: { verdict: 'auth_failed', error: 'x', strikes: 31, first_fail_at: iso(40 * 60_000), last_at: iso(0) },
        alerted_incident: true,
        alerted_kind: 'error',
        alerted_at: iso(5 * 60_000),
      },
    }
    const d = decideIncidentAlert(meta, NOW)
    expect(d.alert && d.escalation).toBe(true)
  })

  it('texto: título se basta e manda trocar em Canais', () => {
    const health = { imap: { verdict: 'auth_failed' as const, error: 'x', strikes: 1, first_fail_at: iso(0), last_at: iso(0) } }
    const t = incidentAlertText({ channelName: 'GoLinkAsaas', address: 'golink@gmail.com', problem: gmailProblem(health, NOW)!, health }, NOW)
    expect(t.title).toContain('senha de app recusada')
    expect(t.body).toContain('Configurações → Canais')
  })
})

describe('estado', () => {
  it('problemChanged: entrar e sair do problema', () => {
    const ruim = { health: { smtp: { verdict: 'auth_failed', error: 'x', strikes: 1, first_fail_at: iso(0), last_at: iso(0) } } }
    expect(problemChanged({}, ruim, NOW)).toBe(true)
    expect(problemChanged(ruim, ruim, NOW)).toBe(false)
    expect(problemChanged(ruim, {}, NOW)).toBe(true)
  })

  it('régua só bloqueia com senha recusada', () => {
    expect(gmailSendBlockedReason({ health: { imap: { verdict: 'auth_failed', error: 'x', strikes: 1, first_fail_at: iso(0), last_at: iso(0) } } })).toContain('senha de app')
    expect(gmailSendBlockedReason({ health: { imap: { verdict: 'error', error: 'x', strikes: 99, first_fail_at: iso(99 * 60_000), last_at: iso(0) } } })).toBeNull()
    expect(gmailSendBlockedReason({})).toBeNull()
  })
})

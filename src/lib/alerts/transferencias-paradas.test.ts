import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

// 02/10/2026 — a lista de transferências da IA paradas (fonte do resumo do
// dono e do aviso de transferência parada). Banco falso: o db.execute devolve
// as linhas que a consulta devolveria; o SQL é conferido pelo texto/parâmetros
// (o que importa: só a última transferência, conversa aberta, resposta humana
// = 'agent' não interna, nota ⏰ como trava) e a montagem de cada item.

const h = vi.hoisted(() => ({ execute: vi.fn() }))
vi.mock('@/db', () => ({ db: { execute: h.execute } }))

import { HANDOFF_NOTE_PREFIX } from '@/lib/ai/handoff-pause'
import {
  linkDaConversa,
  listarTransferenciasParadas,
  rotuloDoContato,
  STALLED_NOTE_PREFIX,
} from './transferencias-paradas'
import type { ExpedienteCfg } from './expediente'

const CLINICA: ExpedienteCfg = {
  businessHoursEnabled: true,
  businessTimezone: 'America/Sao_Paulo',
  businessDays: [
    { open: null, close: null },
    { open: '09:00', close: '20:30' },
    { open: '09:00', close: '20:30' },
    { open: '09:00', close: '20:30' },
    { open: '09:00', close: '20:30' },
    { open: '09:00', close: '20:30' },
    { open: '08:00', close: '17:00' },
  ],
}

const sp = (isoLocal: string) => new Date(`${isoLocal}:00-03:00`)
const consulta = () => new PgDialect().sqlToQuery(h.execute.mock.calls[0][0] as SQL)

const ENV = process.env.BETTER_AUTH_URL
beforeEach(() => {
  process.env.BETTER_AUTH_URL = 'https://crm.exemplo.test/'
  h.execute.mockReset()
})
afterEach(() => {
  process.env.BETTER_AUTH_URL = ENV
})

describe('transferências paradas — consulta', () => {
  it('procura a ÚLTIMA nota de transferência, em conversa aberta, sem resposta da equipe', async () => {
    h.execute.mockResolvedValueOnce({ rows: [] })
    await listarTransferenciasParadas('conta-1', CLINICA, { now: sp('2026-10-05T10:00') })

    const q = consulta()
    const sqlTxt = q.sql.replace(/\s+/g, ' ')
    expect(q.params).toContain(`${HANDOFF_NOTE_PREFIX}%`)
    expect(q.params).toContain(`${STALLED_NOTE_PREFIX}%`)
    expect(q.params).toContain('conta-1')
    // Janela padrão 48h (+2h de folga no last_message_at).
    expect(q.params).toEqual(expect.arrayContaining([48, 50]))
    expect(sqlTxt).toContain("c.status = 'open'")
    expect(sqlTxt).toContain('ORDER BY m.created_at DESC LIMIT 1')
    // Resposta humana = 'agent' NÃO interna depois da nota (CRM ou celular).
    expect(sqlTxt).toContain("r.sender_type = 'agent' AND r.is_internal = false AND r.created_at > h.handoff_at")
    expect(sqlTxt).not.toMatch(/--/)
  })

  it('janela e limite configuráveis (com teto)', async () => {
    h.execute.mockResolvedValueOnce({ rows: [] })
    await listarTransferenciasParadas('conta-1', CLINICA, { horas: 72, limite: 9999 })
    expect(consulta().params).toEqual(expect.arrayContaining([72, 74, 500]))
  })
})

describe('transferências paradas — cada item', () => {
  it('monta nome, tempos de relógio e de expediente, motivo, link e trava', async () => {
    h.execute.mockResolvedValueOnce({
      rows: [
        {
          conversation_id: 'conv-a',
          // Sexta 21h; agora é sábado 8h20 → 680 min de relógio, 20 de expediente.
          handoff_at: '2026-10-03T00:00:00+00:00',
          note_text: '🙋 *A IA pediu um humano*\n📋 Quer remarcar a consulta\nCliente disse: oi',
          contact_name: 'Paciente Exemplo',
          contact_phone: '5511900000001',
          avisado_em: null,
        },
        {
          conversation_id: 'conv-b',
          handoff_at: new Date('2026-10-03T11:00:00Z'),
          note_text: '🙋 *A IA pediu um humano*',
          contact_name: '.',
          contact_phone: '5511900000002',
          avisado_em: '2026-10-03T11:16:00Z',
        },
        // Data ilegível não vira item (nem derruba a lista).
        { conversation_id: 'conv-c', handoff_at: null, note_text: '', contact_name: 'X', contact_phone: '' },
      ],
    })
    const lista = await listarTransferenciasParadas('conta-1', CLINICA, { now: sp('2026-10-03T08:20') })

    expect(lista).toHaveLength(2)
    const [a, b] = lista
    expect(a).toMatchObject({
      conversationId: 'conv-a',
      nome: 'Paciente Exemplo',
      telefone: '5511900000001',
      minutosRelogio: 680,
      minutosExpediente: 20,
      motivo: 'Quer remarcar a consulta',
      link: 'https://crm.exemplo.test/inbox?c=conv-a',
      avisadoEm: null,
    })
    // Nome "." não é nome: a lista mostra o telefone.
    expect(b.nome).toBe('')
    expect(rotuloDoContato(b)).toBe('5511900000002')
    expect(b.motivo).toBe('')
    expect(b.avisadoEm?.toISOString()).toBe('2026-10-03T11:16:00.000Z')
  })

  it('sem BETTER_AUTH_URL o link fica vazio (a linha some do aviso)', () => {
    process.env.BETTER_AUTH_URL = ''
    expect(linkDaConversa('conv-a')).toBe('')
  })
})

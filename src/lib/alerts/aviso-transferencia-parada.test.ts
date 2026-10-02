import { beforeEach, describe, expect, it, vi } from 'vitest'

// 02/10/2026 — aviso de transferência PARADA. A lista (transferencias-
// paradas.ts) e o envio (owner-alerts.ts) são falsos; o banco falso registra
// a nota-trava gravada e apagada. Interessa a DECISÃO:
//   • avisa UMA vez (nota ⏰ depois da transferência = já avisou);
//   • só passou do limite em minutos de EXPEDIENTE, e só com a empresa aberta;
//   • janela de 24h, estendida para quem esperou com a empresa fechada;
//   • nota antes do envio; se o envio falha: falha AMBÍGUA (chegou a chamar
//     o canal) mantém a nota e não repete; falha de configuração mantém a nota
//     com o motivo; erro antes do canal apaga e tenta de novo, até 3 vezes;
//   • teto por conta; uma conta que falha não derruba as outras.

const h = vi.hoisted(() => {
  const state = {
    inserted: [] as Record<string, unknown>[],
    deleted: 0,
    updated: [] as Record<string, unknown>[],
    failInsert: false,
  }
  const db = {
    execute: vi.fn(),
    insert: vi.fn(() => ({
      values: (v: Record<string, unknown>) => {
        if (state.failInsert) throw new Error('banco fora')
        state.inserted.push(v)
        return { returning: async () => [{ id: `nota-${state.inserted.length}` }] }
      },
    })),
    delete: vi.fn(() => ({
      where: async () => {
        state.deleted++
      },
    })),
    update: vi.fn(() => ({
      set: (v: Record<string, unknown>) => ({
        where: async () => {
          state.updated.push(v)
        },
      }),
    })),
  }
  return { state, db, listar: vi.fn(), enviar: vi.fn() }
})

vi.mock('@/db', () => ({
  db: h.db,
  messages: { id: 'messages.id', conversationId: 'messages.conversation_id' },
}))
vi.mock('./owner-alerts', () => ({ sendOwnerAlert: h.enviar }))
vi.mock('./transferencias-paradas', () => ({
  STALLED_NOTE_PREFIX: '⏰ Transferência sem resposta',
  listarTransferenciasParadas: h.listar,
}))

import {
  AVISOS_POR_CONTA,
  avisarTransferenciasParadasDaConta,
  limiarDaTransferenciaParada,
  textoDaEspera,
  textoDaNota,
  textoDaNotaSemAviso,
  TENTATIVAS_SEM_ENVIO,
  transferenciasParaAvisar,
  varrerTransferenciasParadas,
} from './aviso-transferencia-parada'
import { DEFAULT_ALERT_TEMPLATES, renderAlertTemplate } from './templates'
import type { TransferenciaParada } from './transferencias-paradas'
import { DEFAULT_ACCOUNT_SETTINGS, type AccountSettings } from '@/lib/settings/account-settings'

const sp = (isoLocal: string) => new Date(`${isoLocal}:00-03:00`)

const CONTA: AccountSettings = {
  ...DEFAULT_ACCOUNT_SETTINGS,
  alertPhone: '5511900000000',
  alertOnHandoffStalled: true,
  handoffStalledMinutes: 15,
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

function parada(over: Partial<TransferenciaParada> = {}): TransferenciaParada {
  return {
    conversationId: 'conv-1',
    nome: 'Paciente Exemplo',
    telefone: '5511900000001',
    transferidaEm: sp('2026-10-05T09:40'),
    minutosRelogio: 20,
    minutosExpediente: 20,
    motivo: 'Quer remarcar a consulta',
    link: 'https://crm.exemplo.test/inbox?c=conv-1',
    avisadoEm: null,
    ...over,
  }
}

beforeEach(() => {
  h.state.inserted = []
  h.state.deleted = 0
  h.state.updated = []
  h.state.failInsert = false
  h.listar.mockReset()
  h.enviar.mockReset()
  h.enviar.mockResolvedValue({ ok: true, tentou: true })
  h.db.execute.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('template do aviso', () => {
  it('sai no formato dos outros avisos, sem o "Chamar no WhatsApp"', () => {
    const out = renderAlertTemplate(DEFAULT_ALERT_TEMPLATES.handoff_stalled, {
      cliente: 'Paciente Exemplo',
      telefone: '5511900000001',
      tempo: '17 min',
      motivo: 'Quer remarcar a consulta',
      link: 'https://crm.exemplo.test/inbox?c=conv-1',
    })
    expect(out).toBe(
      [
        '⏰ *TRANSFERÊNCIA SEM RESPOSTA*',
        '',
        '👤 Paciente Exemplo · 5511900000001',
        '⏳ Espera há 17 min desde que a IA passou para a equipe',
        '🏷️ Motivo: Quer remarcar a consulta',
        '',
        '🔗 Conversa no FluxiaCRM: https://crm.exemplo.test/inbox?c=conv-1',
      ].join('\n'),
    )
    expect(out).not.toContain('wa.me')
  })

  it('sem motivo e sem nome, as linhas se ajeitam sozinhas', () => {
    const out = renderAlertTemplate(DEFAULT_ALERT_TEMPLATES.handoff_stalled, {
      cliente: '',
      telefone: '5511900000001',
      tempo: '1h05',
      motivo: '',
      link: '',
    })
    expect(out).toContain('👤 5511900000001')
    expect(out).not.toContain('Motivo')
    expect(out).not.toContain('🔗')
  })
})

describe('decisão do aviso', () => {
  it('limite entre 5 e 240 min (padrão 15)', () => {
    expect(limiarDaTransferenciaParada(undefined)).toBe(15)
    expect(limiarDaTransferenciaParada('abc')).toBe(15)
    expect(limiarDaTransferenciaParada(2)).toBe(5)
    expect(limiarDaTransferenciaParada(999)).toBe(240)
    expect(limiarDaTransferenciaParada(30)).toBe(30)
  })

  it('já avisada (nota ⏰ depois da transferência) não avisa de novo', () => {
    expect(transferenciasParaAvisar([parada({ avisadoEm: new Date() })], 15)).toEqual([])
  })

  it('só passou do limite em minutos de EXPEDIENTE', () => {
    expect(transferenciasParaAvisar([parada({ minutosExpediente: 14, minutosRelogio: 600 })], 15)).toEqual([])
    expect(transferenciasParaAvisar([parada({ minutosExpediente: 15 })], 15)).toHaveLength(1)
  })

  it('24h de relógio; depois disso só quem esperou com a empresa fechada e acabou de passar do limite', () => {
    // Sábado 16h50 → segunda 9h05: 40h de relógio, 15 min de expediente.
    expect(
      transferenciasParaAvisar([parada({ minutosRelogio: 40 * 60, minutosExpediente: 15 })], 15),
    ).toHaveLength(1)
    // Antiga de verdade (muito expediente sem resposta): não despeja no 1º deploy.
    expect(
      transferenciasParaAvisar([parada({ minutosRelogio: 40 * 60, minutosExpediente: 300 })], 15),
    ).toEqual([])
    expect(
      transferenciasParaAvisar([parada({ minutosRelogio: 80 * 60, minutosExpediente: 15 })], 15),
    ).toEqual([])
  })

  it('tempo do aviso: expediente, e desde quando se esperou com a empresa fechada', () => {
    expect(textoDaEspera(parada(), 'America/Sao_Paulo')).toBe('20 min')
    expect(
      textoDaEspera(
        parada({ transferidaEm: sp('2026-10-02T21:00'), minutosRelogio: 680, minutosExpediente: 20 }),
        'America/Sao_Paulo',
      ),
    ).toBe('20 min de expediente (desde sex 21:00)')
    expect(textoDaNota('20 min')).toBe('⏰ Transferência sem resposta há 20 min — aviso enviado ao responsável.')
  })
})

describe('aviso por conta', () => {
  const SEGUNDA_10H = sp('2026-10-05T10:00')

  it('avisa a vencida uma vez: grava a nota-trava e manda o aviso', async () => {
    h.listar.mockResolvedValueOnce([
      parada(),
      parada({ conversationId: 'conv-2', avisadoEm: sp('2026-10-05T09:58') }),
      parada({ conversationId: 'conv-3', minutosExpediente: 5, minutosRelogio: 5 }),
    ])
    const n = await avisarTransferenciasParadasDaConta('conta-1', CONTA, SEGUNDA_10H, AVISOS_POR_CONTA)

    expect(n).toBe(1)
    expect(h.listar).toHaveBeenCalledWith('conta-1', CONTA, {
      now: SEGUNDA_10H,
      horas: 72,
      soNaoAvisadas: true,
    })
    expect(h.state.inserted).toEqual([
      {
        conversationId: 'conv-1',
        senderType: 'bot',
        contentType: 'text',
        contentText: '⏰ Transferência sem resposta há 20 min — aviso enviado ao responsável.',
        isInternal: true,
        status: 'sent',
      },
    ])
    expect(h.enviar).toHaveBeenCalledTimes(1)
    expect(h.enviar).toHaveBeenCalledWith('conta-1', 'handoff_stalled', {
      cliente: 'Paciente Exemplo',
      telefone: '5511900000001',
      tempo: '20 min',
      motivo: 'Quer remarcar a consulta',
      link: 'https://crm.exemplo.test/inbox?c=conv-1',
    })
    expect(h.state.deleted).toBe(0)
    expect(h.state.updated).toEqual([])
  })

  it('falha AMBÍGUA (chegou a chamar o canal): a nota fica, avisa que pode não ter saído e não repete', async () => {
    // Antes: a nota era apagada e o aviso saía de novo a cada 2 min — e o
    // WAHA às vezes entrega mesmo depois de estourar o tempo.
    h.listar.mockResolvedValueOnce([parada()])
    h.enviar.mockResolvedValueOnce({ ok: false, tentou: true, falha: 'erro' })
    const n = await avisarTransferenciasParadasDaConta('conta-1', CONTA, SEGUNDA_10H, 5, new Map())
    expect(n).toBe(0)
    expect(h.state.deleted).toBe(0)
    expect(h.state.updated).toEqual([
      { contentText: '⏰ Transferência sem resposta há 20 min — o aviso ao responsável pode não ter saído.' },
    ])
  })

  it('falha de configuração (sem canal): a nota fica com o motivo — sem gravar e apagar para sempre', async () => {
    h.listar.mockResolvedValueOnce([parada()])
    h.enviar.mockResolvedValueOnce({ ok: false, tentou: false, falha: 'sem_canal' })
    await avisarTransferenciasParadasDaConta('conta-1', CONTA, SEGUNDA_10H, 5, new Map())
    expect(h.state.deleted).toBe(0)
    expect(h.state.updated).toEqual([
      {
        contentText:
          '⏰ Transferência sem resposta há 20 min — o aviso ao responsável não saiu (nenhum canal WhatsApp conectado).',
      },
    ])
  })

  it('erro antes de chamar o canal: apaga a nota e tenta de novo — até a 3ª falha', async () => {
    const falhas = new Map<string, number>()
    h.enviar.mockResolvedValue({ ok: false, tentou: false, falha: 'erro' })
    for (let i = 1; i < TENTATIVAS_SEM_ENVIO; i++) {
      h.listar.mockResolvedValueOnce([parada()])
      await avisarTransferenciasParadasDaConta('conta-1', CONTA, SEGUNDA_10H, 5, falhas)
      expect(h.state.deleted).toBe(i) // nada saiu: libera para o próximo tick
      expect(h.state.updated).toEqual([])
    }
    h.listar.mockResolvedValueOnce([parada()])
    await avisarTransferenciasParadasDaConta('conta-1', CONTA, SEGUNDA_10H, 5, falhas)
    expect(h.state.deleted).toBe(TENTATIVAS_SEM_ENVIO - 1) // a 3ª nota fica
    expect(h.state.updated).toEqual([
      { contentText: textoDaNotaSemAviso('20 min', `falhou ${TENTATIVAS_SEM_ENVIO} vezes`) },
    ])
    expect(h.enviar).toHaveBeenCalledTimes(TENTATIVAS_SEM_ENVIO)
    expect(falhas.size).toBe(0)
  })

  it('a contagem de falhas é por transferência: outra conversa não herda', async () => {
    const falhas = new Map<string, number>()
    h.enviar.mockResolvedValue({ ok: false, tentou: false, falha: 'erro' })
    h.listar.mockResolvedValueOnce([parada()]).mockResolvedValueOnce([parada()])
    await avisarTransferenciasParadasDaConta('conta-1', CONTA, SEGUNDA_10H, 5, falhas)
    await avisarTransferenciasParadasDaConta('conta-1', CONTA, SEGUNDA_10H, 5, falhas)
    h.listar.mockResolvedValueOnce([parada({ conversationId: 'conv-9' })])
    await avisarTransferenciasParadasDaConta('conta-1', CONTA, SEGUNDA_10H, 5, falhas)
    expect(h.state.deleted).toBe(3)
    expect(h.state.updated).toEqual([])
  })

  it('sem nota-trava não avisa (avisar sem trava repetiria a cada 2 min)', async () => {
    h.listar.mockResolvedValueOnce([parada()])
    h.state.failInsert = true
    const n = await avisarTransferenciasParadasDaConta('conta-1', CONTA, SEGUNDA_10H, AVISOS_POR_CONTA)
    expect(n).toBe(0)
    expect(h.enviar).not.toHaveBeenCalled()
  })

  it('fora do expediente (domingo, ou sexta 22h) nem consulta', async () => {
    expect(await avisarTransferenciasParadasDaConta('conta-1', CONTA, sp('2026-10-04T11:00'), 5)).toBe(0)
    expect(await avisarTransferenciasParadasDaConta('conta-1', CONTA, sp('2026-10-02T22:00'), 5)).toBe(0)
    expect(h.listar).not.toHaveBeenCalled()
  })

  it('sem horário de atendimento ligado a conta conta como aberta', async () => {
    h.listar.mockResolvedValueOnce([parada()])
    const n = await avisarTransferenciasParadasDaConta(
      'conta-1',
      { ...CONTA, businessHoursEnabled: false },
      sp('2026-10-04T03:00'),
      5,
    )
    expect(n).toBe(1)
  })

  it('desligado ou sem telefone dos avisos não faz nada', async () => {
    expect(await avisarTransferenciasParadasDaConta('conta-1', { ...CONTA, alertOnHandoffStalled: false }, SEGUNDA_10H, 5)).toBe(0)
    expect(await avisarTransferenciasParadasDaConta('conta-1', { ...CONTA, alertPhone: '' }, SEGUNDA_10H, 5)).toBe(0)
    expect(h.listar).not.toHaveBeenCalled()
  })

  it('respeita o teto da rodada', async () => {
    h.listar.mockResolvedValueOnce(
      Array.from({ length: 7 }, (_, i) => parada({ conversationId: `conv-${i}` })),
    )
    const n = await avisarTransferenciasParadasDaConta('conta-1', CONTA, SEGUNDA_10H, AVISOS_POR_CONTA)
    expect(n).toBe(AVISOS_POR_CONTA)
    expect(h.enviar).toHaveBeenCalledTimes(AVISOS_POR_CONTA)
  })
})

describe('varredura', () => {
  it('só as contas com o aviso ligado; uma que falha não derruba as outras', async () => {
    h.db.execute.mockResolvedValueOnce({
      rows: [
        { account_id: 'conta-ruim', settings: { ...CONTA } },
        { account_id: 'conta-boa', settings: { ...CONTA } },
      ],
    })
    h.listar.mockRejectedValueOnce(new Error('timeout')).mockResolvedValueOnce([parada()])

    const r = await varrerTransferenciasParadas(sp('2026-10-05T10:00'))

    expect(r).toEqual({ contas: 2, avisos: 1, erros: 1 })
    expect(h.enviar).toHaveBeenCalledWith('conta-boa', 'handoff_stalled', expect.any(Object))
  })
})

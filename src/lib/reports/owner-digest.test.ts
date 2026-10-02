import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import type { SQL } from 'drizzle-orm'

// 02/10/2026 (pedido de uma clínica: "todo fim de expediente") — o resumo do dono ganhou
// o modo 'fechamento' e a lista de transferências da IA paradas. Banco, canais
// e a lista são falsos; aqui interessa:
//   • QUANDO sai no modo fechamento (dia útil depois do fechamento, sábado,
//     domingo fechado, já enviou hoje, fuso da conta) — e que o modo 'hora'
//     continua igual;
//   • o TEXTO do fim do dia: números de hoje, sem "R$ 0" para quem não usa
//     funil, lista de paradas com "+N";
//   • o resumo da manhã também lista as paradas.

const h = vi.hoisted(() => ({
  execute: vi.fn(),
  listar: vi.fn(),
  sendText: vi.fn(),
  update: vi.fn(),
  getSettings: vi.fn(),
}))

const dialect = new PgDialect()
const sqlText = (q: unknown) => dialect.sqlToQuery(q as SQL).sql

vi.mock('@/db', () => {
  // db.select(...).from(...).where(...).limit(1) → moeda da conta.
  const chain: Record<string, unknown> = {}
  for (const k of ['from', 'where']) chain[k] = () => chain
  chain.limit = async () => [{ c: 'BRL' }]
  return { db: { execute: h.execute, select: () => chain }, accountSettings: {} }
})
vi.mock('@/lib/settings/account-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/settings/account-settings')>()),
  getAccountSettings: h.getSettings,
  updateAccountSettings: h.update,
}))
vi.mock('@/lib/channels/channels', () => ({
  listChannels: async () => [{ id: 'canal-1', provider: 'waha' }],
}))
vi.mock('@/lib/channels/registry', () => ({ getProvider: () => ({ sendText: h.sendText }) }))
vi.mock('@/lib/ai/self-message', () => ({ markSelfMessage: async () => {} }))
vi.mock('@/lib/alerts/transferencias-paradas', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/alerts/transferencias-paradas')>()),
  listarTransferenciasParadas: h.listar,
}))

import {
  formatDigest,
  formatFimDoDia,
  linhasDasParadas,
  resumoNaHora,
  runOwnerDigestSweep,
  type DigestData,
  type FimDoDiaData,
} from './owner-digest'
import { DEFAULT_ACCOUNT_SETTINGS, type AccountSettings } from '@/lib/settings/account-settings'
import type { TransferenciaParada } from '@/lib/alerts/transferencias-paradas'

const sp = (isoLocal: string) => new Date(`${isoLocal}:00-03:00`)

const CLINICA: AccountSettings = {
  ...DEFAULT_ACCOUNT_SETTINGS,
  ownerDigestEnabled: true,
  ownerDigestPhone: '5511900000000',
  ownerDigestMode: 'fechamento',
  ownerDigestHour: 8,
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

function parada(i: number, over: Partial<TransferenciaParada> = {}): TransferenciaParada {
  return {
    conversationId: `conv-${i}`,
    nome: `Paciente ${i}`,
    telefone: `55119000000${String(i).padStart(2, '0')}`,
    transferidaEm: sp('2026-10-02T16:00'),
    minutosRelogio: 240,
    minutosExpediente: 240,
    motivo: 'Quer remarcar a consulta',
    link: '',
    avisadoEm: null,
    ...over,
  }
}

beforeEach(() => {
  h.execute.mockReset()
  h.listar.mockReset()
  h.sendText.mockReset()
  h.update.mockReset()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('é hora de mandar? — modo fechamento', () => {
  it('dia útil: só depois do fechamento (sexta 20h30)', () => {
    expect(resumoNaHora(CLINICA, sp('2026-10-02T20:20')).enviar).toBe(false)
    expect(resumoNaHora(CLINICA, sp('2026-10-02T20:35'))).toEqual({
      enviar: true,
      chave: '2026-10-02',
      modo: 'fechamento',
    })
    // Tick perdido (deploy às 20h30): ainda sai até a meia-noite.
    expect(resumoNaHora(CLINICA, sp('2026-10-02T23:50')).enviar).toBe(true)
  })

  it('sábado fecha às 17h', () => {
    expect(resumoNaHora(CLINICA, sp('2026-10-03T16:50')).enviar).toBe(false)
    expect(resumoNaHora(CLINICA, sp('2026-10-03T17:05')).enviar).toBe(true)
  })

  it('domingo fechado: nunca', () => {
    for (const hora of ['08:00', '17:05', '20:35', '23:50']) {
      expect(resumoNaHora(CLINICA, sp(`2026-10-04T${hora}`)).enviar).toBe(false)
    }
  })

  it('já enviou hoje: não repete', () => {
    expect(
      resumoNaHora({ ...CLINICA, ownerDigestLastSent: '2026-10-02' }, sp('2026-10-02T21:00')).enviar,
    ).toBe(false)
    // O de ontem não segura o de hoje.
    expect(
      resumoNaHora({ ...CLINICA, ownerDigestLastSent: '2026-10-01' }, sp('2026-10-02T21:00')).enviar,
    ).toBe(true)
  })

  it('no fuso da conta: 20h35 em São Paulo ainda é 19h35 em Manaus', () => {
    const manaus = { ...CLINICA, businessTimezone: 'America/Manaus' }
    expect(resumoNaHora(manaus, new Date('2026-10-02T23:35:00Z')).enviar).toBe(false)
    // 00:31Z do dia 3 = 20h31 de SEXTA em Manaus → a chave é a data local.
    expect(resumoNaHora(manaus, new Date('2026-10-03T00:31:00Z'))).toEqual({
      enviar: true,
      chave: '2026-10-02',
      modo: 'fechamento',
    })
  })

  it('sem expediente configurado cai na hora escolhida (não some em silêncio)', () => {
    const semHorario = { ...CLINICA, businessHoursEnabled: false }
    expect(resumoNaHora(semHorario, sp('2026-10-02T20:35')).enviar).toBe(false)
    expect(resumoNaHora(semHorario, sp('2026-10-02T08:10'))).toMatchObject({ enviar: true, modo: 'hora' })
  })

  it('modo hora continua igual: só na hora escolhida, todo dia', () => {
    const hora = { ...CLINICA, ownerDigestMode: 'hora' as const }
    expect(resumoNaHora(hora, sp('2026-10-04T08:05'))).toMatchObject({ enviar: true, modo: 'hora' })
    expect(resumoNaHora(hora, sp('2026-10-04T09:00')).enviar).toBe(false)
    expect(resumoNaHora(hora, sp('2026-10-02T20:35')).enviar).toBe(false)
  })
})

const FIM_VAZIO: FimDoDiaData = {
  chegaramHoje: 0,
  respondidasHoje: 0,
  esperandoAgora: 0,
  transferenciasHoje: 0,
  paradas: [],
  vendasHojeCount: 0,
  vendasHojeValor: 0,
  openValue: 0,
  openCount: 0,
  staleCount: 0,
  monthWonValue: 0,
  monthGoal: 0,
  pendingApprovals: 0,
}

describe('texto do fim do dia', () => {
  it('cabeçalho de HOJE e números do atendimento', () => {
    const out = formatFimDoDia(
      { ...FIM_VAZIO, chegaramHoje: 34, respondidasHoje: 30, esperandoAgora: 3, transferenciasHoje: 6 },
      'BRL',
      'America/Sao_Paulo',
      7,
      sp('2026-10-02T20:35'),
    )
    const linhas = out.split('\n')
    expect(linhas[0]).toBe('📊 Resumo de hoje, sexta 02/10')
    expect(out).toContain('💬 Conversas que chegaram hoje: 34 · 30 respondidas')
    expect(out).toContain('⏳ Esperando resposta agora: 3 conversa(s)')
    expect(out).toContain('🙋 Transferências da IA hoje: 6')
    expect(out).not.toContain('Bom dia')
    expect(out).not.toContain('Ontem')
  })

  it('conta que não usa funil não vê "R$ 0" nem meta', () => {
    const out = formatFimDoDia(FIM_VAZIO, 'BRL', 'America/Sao_Paulo', 7, sp('2026-10-02T20:35'))
    expect(out).not.toContain('R$')
    expect(out).not.toContain('💰')
    expect(out).not.toContain('🎯')
    expect(out).not.toContain('❄️')
    expect(out).not.toContain('🙋')
    expect(out).toContain('💬 Nenhuma conversa de cliente hoje')
    expect(out).toContain('✅ Ninguém esperando resposta agora 👏')
    expect(out.trim().endsWith('Dia fechado! Bom descanso. 💜')).toBe(true)
  })

  it('com venda e funil, as linhas aparecem', () => {
    const out = formatFimDoDia(
      { ...FIM_VAZIO, vendasHojeCount: 2, vendasHojeValor: 1200, openValue: 6090, openCount: 9, staleCount: 2, monthGoal: 10000, monthWonValue: 2500 },
      'BRL',
      'America/Sao_Paulo',
      7,
      sp('2026-10-02T20:35'),
    )
    expect(out).toMatch(/💰 Hoje: 2 vendas · R\$\s1\.200/)
    expect(out).toMatch(/📊 Em aberto: R\$\s6\.090 em 9 negócios/)
    expect(out).toContain('❄️ Esfriando: 2 negócio(s) parado(s) há +7 dias')
    expect(out).toMatch(/🎯 Meta do mês: R\$\s2\.500 de R\$\s10\.000 \(25%\)/)
  })

  it('lista as transferências paradas (até 8) e o resto vira "+N"', () => {
    const paradas = Array.from({ length: 10 }, (_, i) => parada(i + 1))
    const out = formatFimDoDia({ ...FIM_VAZIO, paradas }, 'BRL', 'America/Sao_Paulo', 7, sp('2026-10-02T20:35'))
    expect(out).toContain('⏰ Transferências da IA sem resposta: 10')
    expect(out).toContain('   • Paciente 1 · há 4h · Quer remarcar a consulta')
    expect(out).toContain('   • Paciente 8 · há 4h')
    expect(out).not.toContain('Paciente 9')
    expect(out).toContain('   +2 outras')
    expect(out).toContain('Vale dar retorno às transferências paradas antes de amanhã. 💜')
  })

  it('sem nome mostra o telefone; sem motivo, sem o separador', () => {
    expect(linhasDasParadas([parada(1, { nome: '', motivo: '', minutosRelogio: 65 })])).toEqual([
      '⏰ Transferências da IA sem resposta: 1',
      '   • 5511900000001 · há 1h05',
    ])
    const nove = Array.from({ length: 9 }, (_, i) => parada(i + 1))
    expect(linhasDasParadas(nove).at(-1)).toBe('   +1 outra')
  })
})

describe('resumo da manhã (modo hora)', () => {
  const MANHA: DigestData = {
    wonYesterdayCount: 0,
    wonYesterdayValue: 0,
    openValue: 0,
    openCount: 0,
    staleCount: 0,
    waitingCount: 0,
    monthWonValue: 0,
    monthGoal: 0,
    pendingApprovals: 0,
    nextActions: [],
    paradas: [],
  }

  it('continua o de sempre e passa a listar as transferências paradas', () => {
    const out = formatDigest({ ...MANHA, paradas: [parada(1)] }, 'BRL', 'America/Sao_Paulo', 7)
    expect(out.startsWith('☀️ Bom dia! Seu resumo da Fluxia')).toBe(true)
    expect(out).toContain('💰 Ontem: 0 vendas')
    expect(out).toContain('⏰ Transferências da IA sem resposta: 1')
    expect(out).toContain('Comece o dia pelas transferências paradas')
  })

  it('sem paradas, nenhuma linha nova', () => {
    const out = formatDigest(MANHA, 'BRL', 'America/Sao_Paulo', 7)
    expect(out).not.toContain('⏰')
    expect(out).toContain('Tá voando!')
  })
})

describe('varredura do resumo', () => {
  it('manda o do fim do dia na hora certa, marca a data e ignora a nota interna na conta de esperando', async () => {
    const execs: string[] = []
    h.execute.mockImplementation(async (q: unknown) => {
      const txt = sqlText(q)
      execs.push(txt)
      if (txt.includes('FROM account_settings')) {
        return {
          rows: [
            { account_id: 'conta-clinica', settings: { ...CLINICA } },
            // Modo hora, fora da hora: não manda.
            { account_id: 'conta-manha', settings: { ...CLINICA, ownerDigestMode: 'hora' } },
          ],
        }
      }
      return { rows: [{ n: 1, total: 0, chegaram: 5, respondidas: 4 }] }
    })
    h.listar.mockResolvedValue([parada(1)])

    const r = await runOwnerDigestSweep(sp('2026-10-02T20:40'))

    expect(r).toEqual({ sent: 1 })
    expect(h.sendText).toHaveBeenCalledTimes(1)
    const [, phone, text] = h.sendText.mock.calls[0]
    expect(phone).toBe('5511900000000')
    expect(text).toMatch(/^📊 Resumo de hoje, sexta 02\/10/)
    expect(text).toContain('⏰ Transferências da IA sem resposta: 1')
    expect(h.update).toHaveBeenCalledWith('conta-clinica', { ownerDigestLastSent: '2026-10-02' })
    // "Esperando resposta" olha a última mensagem NÃO interna.
    const esperando = execs.find((t) => t.includes('JOIN LATERAL') && t.includes("lm.sender_type = 'customer'"))
    expect(esperando?.replace(/\s+/g, ' ')).toContain('m.is_internal = false ORDER BY m.created_at DESC LIMIT 1')
  })
})

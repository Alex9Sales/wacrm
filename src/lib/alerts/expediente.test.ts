import { describe, expect, it } from 'vitest'

import {
  expedienteConfigurado,
  fechamentoDeHoje,
  formatarEspera,
  minutosDeExpediente,
  motivoDaNota,
  textoDosFechamentos,
  type ExpedienteCfg,
} from './expediente'

// 02/10/2026 — o relógio de EXPEDIENTE do aviso de transferência parada e do
// resumo do fim do dia. Clínica de exemplo (fictícia): seg–sex 9h–20h30,
// sábado 8h–17h, domingo fechado, em São Paulo (UTC−3 o ano todo).
// Datas: 02/10/2026 é sexta, 03/10 sábado, 04/10 domingo, 05/10 segunda.

const CLINICA: ExpedienteCfg = {
  businessHoursEnabled: true,
  businessTimezone: 'America/Sao_Paulo',
  businessDays: [
    { open: null, close: null }, // dom
    { open: '09:00', close: '20:30' },
    { open: '09:00', close: '20:30' },
    { open: '09:00', close: '20:30' },
    { open: '09:00', close: '20:30' },
    { open: '09:00', close: '20:30' },
    { open: '08:00', close: '17:00' }, // sáb
  ],
}

/** Hora de parede em São Paulo (UTC−3) → Date. */
const sp = (isoLocal: string) => new Date(`${isoLocal}:00-03:00`)

describe('minutos de expediente', () => {
  it('transferência às 21h de sexta conta a partir de sábado 8h', () => {
    expect(minutosDeExpediente(sp('2026-10-02T21:00'), sp('2026-10-03T08:20'), CLINICA)).toBe(20)
    expect(minutosDeExpediente(sp('2026-10-02T21:00'), sp('2026-10-03T07:59'), CLINICA)).toBe(0)
  })

  it('domingo fechado não conta: sábado 16h50 → segunda 9h10 são 20 min', () => {
    expect(minutosDeExpediente(sp('2026-10-03T16:50'), sp('2026-10-05T09:10'), CLINICA)).toBe(20)
  })

  it('dentro do mesmo expediente é o relógio', () => {
    expect(minutosDeExpediente(sp('2026-10-05T10:00'), sp('2026-10-05T10:45'), CLINICA)).toBe(45)
  })

  it('atravessa o fechamento: 20h de segunda → 9h15 de terça são 45 min', () => {
    expect(minutosDeExpediente(sp('2026-10-05T20:00'), sp('2026-10-06T09:15'), CLINICA)).toBe(45)
  })

  it('sem expediente configurado (horário de atendimento desligado) conta o relógio', () => {
    const desligado = { ...CLINICA, businessHoursEnabled: false }
    expect(minutosDeExpediente(sp('2026-10-02T21:00'), sp('2026-10-03T08:20'), desligado)).toBe(680)
  })

  it('janela que vira a meia-noite (18h → 2h) soma a madrugada', () => {
    const noturno: ExpedienteCfg = {
      ...CLINICA,
      businessDays: Array.from({ length: 7 }, () => ({ open: '18:00', close: '02:00' })),
    }
    expect(minutosDeExpediente(sp('2026-10-02T23:00'), sp('2026-10-03T03:00'), noturno)).toBe(180)
    // Começou na madrugada: a cauda pertence à janela de ONTEM.
    expect(minutosDeExpediente(sp('2026-10-03T01:00'), sp('2026-10-03T19:00'), noturno)).toBe(120)
  })

  it('usa o fuso da conta: a mesma espera vale diferente em Manaus', () => {
    const manaus = { ...CLINICA, businessTimezone: 'America/Manaus' }
    // 11:30Z–13:30Z de segunda: em Manaus (UTC−4) é 7h30–9h30 → só 9h–9h30;
    // em São Paulo (UTC−3) é 8h30–10h30 → 9h–10h30.
    expect(minutosDeExpediente(new Date('2026-10-05T11:30:00Z'), new Date('2026-10-05T13:30:00Z'), manaus)).toBe(30)
    expect(minutosDeExpediente(new Date('2026-10-05T11:30:00Z'), new Date('2026-10-05T13:30:00Z'), CLINICA)).toBe(90)
  })

  it('fim antes do início ou data inválida → 0', () => {
    expect(minutosDeExpediente(sp('2026-10-05T11:00'), sp('2026-10-05T10:00'), CLINICA)).toBe(0)
    expect(minutosDeExpediente(new Date('lixo'), sp('2026-10-05T10:00'), CLINICA)).toBe(0)
  })
})

describe('expediente configurado', () => {
  it('precisa do horário de atendimento LIGADO e de um dia aberto', () => {
    expect(expedienteConfigurado(CLINICA)).toBe(true)
    expect(expedienteConfigurado({ ...CLINICA, businessHoursEnabled: false })).toBe(false)
    expect(
      expedienteConfigurado({
        ...CLINICA,
        businessDays: Array.from({ length: 7 }, () => ({ open: null, close: null })),
      }),
    ).toBe(false)
  })
})

describe('fechamento de hoje (resumo do fim do expediente)', () => {
  it('sexta fecha 20h30, sábado 17h, domingo não tem', () => {
    expect(fechamentoDeHoje(CLINICA, sp('2026-10-02T12:00'))).toBe(20 * 60 + 30)
    expect(fechamentoDeHoje(CLINICA, sp('2026-10-03T12:00'))).toBe(17 * 60)
    expect(fechamentoDeHoje(CLINICA, sp('2026-10-04T12:00'))).toBeNull()
  })

  it('fechamento depois das 23h45 ou na madrugada vira 23h45 (último tick do dia)', () => {
    const tarde = { ...CLINICA, businessDays: CLINICA.businessDays.map(() => ({ open: '10:00', close: '23:55' })) }
    expect(fechamentoDeHoje(tarde, sp('2026-10-05T12:00'))).toBe(23 * 60 + 45)
    const noturno = { ...CLINICA, businessDays: CLINICA.businessDays.map(() => ({ open: '18:00', close: '02:00' })) }
    expect(fechamentoDeHoje(noturno, sp('2026-10-05T12:00'))).toBe(23 * 60 + 45)
  })

  it('sem expediente configurado → null', () => {
    expect(fechamentoDeHoje({ ...CLINICA, businessHoursEnabled: false }, sp('2026-10-02T12:00'))).toBeNull()
  })

  it('texto dos fechamentos agrupa dias seguidos e diz quais não têm resumo', () => {
    expect(textoDosFechamentos(CLINICA.businessDays)).toBe(
      'Segunda a sexta às 20h30, sábado às 17h. Domingo: sem resumo (fechado)',
    )
    expect(
      textoDosFechamentos(Array.from({ length: 7 }, () => ({ open: '08:00', close: '21:00' }))),
    ).toBe('Segunda a domingo às 21h')
    expect(textoDosFechamentos(Array.from({ length: 7 }, () => ({ open: null, close: null })))).toBeNull()
  })
})

describe('textos curtos', () => {
  it('espera em português', () => {
    expect(formatarEspera(0)).toBe('menos de 1 min')
    expect(formatarEspera(15)).toBe('15 min')
    expect(formatarEspera(65)).toBe('1h05')
    expect(formatarEspera(180)).toBe('3h')
    expect(formatarEspera(1560)).toBe('1 dia e 2h')
    expect(formatarEspera(2880)).toBe('2 dias')
  })

  it('motivo vem do resumo da IA (depois do 📋), até o "Cliente disse:"', () => {
    const nota = [
      '🙋 *A IA pediu um humano* — IA pausada por 30 min (volta sozinha se a pessoa escrever e ninguém responder)',
      '📋 Paciente quer remarcar a consulta de terça',
      'para quinta à tarde',
      'Cliente disse: oi · dá pra mudar?',
    ].join('\n')
    // Quebra de linha vira " / " (mesma regra dos avisos — alert-text.ts).
    expect(motivoDaNota(nota)).toBe('Paciente quer remarcar a consulta de terça / para quinta à tarde')
  })

  it('sem resumo cai nas falas do cliente; nota sem nada → vazio', () => {
    expect(motivoDaNota('🙋 *A IA pediu um humano*\nCliente disse: quero falar com a doutora')).toBe(
      'Cliente disse: quero falar com a doutora',
    )
    expect(motivoDaNota('🙋 *A IA pediu um humano*')).toBe('')
    expect(motivoDaNota(null)).toBe('')
  })

  it('motivo comprido é cortado em palavra', () => {
    const longo = `📋 ${'consulta '.repeat(30)}`
    const m = motivoDaNota(longo, 40)
    expect(m.length).toBeLessThanOrEqual(40)
    expect(m.endsWith('…')).toBe(true)
  })
})

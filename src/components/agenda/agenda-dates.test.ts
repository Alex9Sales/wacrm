import { describe, expect, it } from 'vitest'

import {
  addDays,
  layoutDayEvents,
  monthGrid,
  parseLocalInput,
  scheduleError,
  shiftEndWithStart,
  startOfWeek,
  toDateInput,
  toLocalInput,
  weekDays,
  weekRangeLabel,
} from './agenda-dates'

// Tudo aqui é horário LOCAL: os testes valem em qualquer fuso (o `npm test`
// roda em UTC; rodar também com TZ=America/Sao_Paulo e TZ=America/New_York,
// que tem horário de verão, para pegar conta feita em milissegundos).

const d = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min)

describe('semana (domingo a sábado, igual à grade do mês)', () => {
  it('começa no domingo e tem 7 dias', () => {
    const dias = weekDays(d(2026, 10, 1)) // quinta
    expect(dias.map(toDateInput)).toEqual([
      '2026-09-27',
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ])
    expect(dias[0].getDay()).toBe(0)
  })

  it('domingo é o primeiro dia da própria semana; sábado o último', () => {
    expect(toDateInput(startOfWeek(d(2026, 9, 27)))).toBe('2026-09-27')
    expect(toDateInput(startOfWeek(d(2026, 10, 3, 23, 59)))).toBe('2026-09-27')
  })

  it('vira o ano no meio da semana', () => {
    expect(weekDays(d(2026, 1, 1)).map(toDateInput)).toEqual([
      '2025-12-28',
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
    ])
  })

  it('próxima/anterior semana andam 7 dias pelo calendário, sempre à meia-noite', () => {
    let foco = d(2026, 1, 1)
    for (let i = 0; i < 60; i++) {
      const prox = addDays(foco, 7)
      expect(prox.getDay()).toBe(foco.getDay())
      expect(prox.getHours()).toBe(0)
      expect(toDateInput(addDays(prox, -7))).toBe(toDateInput(foco))
      foco = prox
    }
    expect(toDateInput(addDays(d(2026, 12, 29), 7))).toBe('2027-01-05')
    expect(toDateInput(addDays(d(2028, 2, 26), 7))).toBe('2028-03-04') // ano bissexto
  })

  it('rótulo do intervalo em pt-BR', () => {
    expect(weekRangeLabel(d(2026, 10, 1))).toBe('27 set – 3 out 2026')
    expect(weekRangeLabel(d(2026, 10, 7))).toBe('4 – 10 out 2026')
    expect(weekRangeLabel(d(2026, 1, 1))).toBe('28 dez 2025 – 3 jan 2026')
  })

  it('a semana inteira de qualquer dia cabe na grade (já carregada) do mês desse dia', () => {
    // A Semana não busca nada a mais: usa o intervalo de 42 dias do mês do
    // dia focado. Se isso falhar, a semana mostraria dias vazios.
    for (let dia = d(2025, 1, 1); dia < d(2028, 1, 1); dia = addDays(dia, 1)) {
      const grade = monthGrid(dia)
      const semana = weekDays(dia)
      expect(semana[0] >= grade[0]).toBe(true)
      expect(semana[6] <= grade[41]).toBe(true)
    }
  })
})

describe('fim acompanha o início', () => {
  it('mantém a duração ao mudar o dia e a hora (o caso do vídeo)', () => {
    expect(shiftEndWithStart('2026-10-01T11:00', '2026-10-01T12:00', '2026-10-03T11:00', false)).toBe(
      '2026-10-03T12:00',
    )
  })

  it('mantém uma duração que não é de 1h', () => {
    expect(shiftEndWithStart('2026-10-01T09:00', '2026-10-01T10:30', '2026-10-01T14:15', false)).toBe(
      '2026-10-01T15:45',
    )
  })

  it('vira o mês e o ano quando o fim passa da meia-noite', () => {
    expect(shiftEndWithStart('2026-10-01T09:00', '2026-10-01T10:00', '2026-10-31T23:30', false)).toBe(
      '2026-11-01T00:30',
    )
    expect(shiftEndWithStart('2026-10-01T09:00', '2026-10-01T10:00', '2026-12-31T23:30', false)).toBe(
      '2027-01-01T00:30',
    )
  })

  it('sem duração válida (fim antes do início, igual, vazio), usa 1h', () => {
    expect(shiftEndWithStart('2026-10-03T11:00', '2026-10-01T12:00', '2026-10-03T14:00', false)).toBe(
      '2026-10-03T15:00',
    )
    expect(shiftEndWithStart('2026-10-03T11:00', '2026-10-03T11:00', '2026-10-03T14:00', false)).toBe(
      '2026-10-03T15:00',
    )
    expect(shiftEndWithStart('', '2026-10-03T12:00', '2026-10-03T14:00', false)).toBe('2026-10-03T15:00')
    expect(shiftEndWithStart('2026-10-03T11:00', '', '2026-10-03T14:00', false)).toBe('2026-10-03T15:00')
  })

  it('início ainda incompleto não mexe no fim', () => {
    expect(shiftEndWithStart('2026-10-01T11:00', '2026-10-01T12:00', '', false)).toBe('2026-10-01T12:00')
  })

  it('dia inteiro: anda o mesmo número de dias', () => {
    expect(shiftEndWithStart('2026-10-01', '2026-10-01', '2026-10-03', true)).toBe('2026-10-03')
    expect(shiftEndWithStart('2026-10-01', '2026-10-03', '2026-10-30', true)).toBe('2026-11-01')
    expect(shiftEndWithStart('2026-12-30', '2027-01-02', '2027-02-27', true)).toBe('2027-03-02')
    // fim antes do início: volta a ser um dia só
    expect(shiftEndWithStart('2026-10-05', '2026-10-01', '2026-10-08', true)).toBe('2026-10-08')
    expect(shiftEndWithStart('2026-10-01', '2026-10-01', '', true)).toBe('2026-10-01')
  })

  it('a duração sobrevive a datas de troca de horário de outros fusos', () => {
    // No Brasil não há horário de verão, mas o navegador pode estar em outro
    // fuso. Datas de troca nos EUA (mar/nov) e na Europa (mar/out).
    const inicios = [
      '2026-03-08T01:30',
      '2026-03-08T10:00',
      '2026-03-29T00:30',
      '2026-10-25T01:30',
      '2026-11-01T00:30',
      '2026-11-01T10:00',
    ]
    for (const ini of inicios) {
      const fim = shiftEndWithStart('2026-10-01T09:00', '2026-10-01T10:00', ini, false)
      const s = parseLocalInput(ini)!
      const e = parseLocalInput(fim)!
      expect(e.getTime() - s.getTime()).toBe(3_600_000)
    }
    // Dia inteiro atravessando a troca: continua sendo data, sem sobrar hora.
    expect(shiftEndWithStart('2026-10-01', '2026-10-02', '2026-11-01', true)).toBe('2026-11-02')
    expect(shiftEndWithStart('2026-10-01', '2026-10-08', '2026-03-05', true)).toBe('2026-03-12')
  })
})

describe('erro de início/fim no formulário', () => {
  it('fim antes do início explica com as datas e bloqueia', () => {
    expect(scheduleError('2026-10-03T11:00', '2026-10-01T12:00', false)).toBe(
      'O fim (01/10 12:00) está antes do início (03/10 11:00). Ajuste o fim.',
    )
    expect(scheduleError('2026-10-03', '2026-10-01', true)).toBe(
      'O fim (01/10) está antes do início (03/10). Ajuste o fim.',
    )
  })

  it('início e fim certos (ou iguais) passam', () => {
    expect(scheduleError('2026-10-03T11:00', '2026-10-03T12:00', false)).toBeNull()
    expect(scheduleError('2026-10-03T11:00', '2026-10-03T11:00', false)).toBeNull()
    expect(scheduleError('2026-10-03', '2026-10-03', true)).toBeNull()
  })

  it('campo vazio pede para preencher', () => {
    expect(scheduleError('', '2026-10-03T12:00', false)).toBe('Preencha o início.')
    expect(scheduleError('2026-10-03T11:00', '', false)).toBe('Preencha o fim.')
  })
})

describe('posição dos eventos na grade de horas', () => {
  const ev = (id: string, ini: Date, fim: Date) => ({
    id,
    startsAt: ini.toISOString(),
    endsAt: fim.toISOString(),
  })
  const dia = d(2026, 10, 1)
  const resumo = (slots: ReturnType<typeof layoutDayEvents<ReturnType<typeof ev>>>) =>
    slots.map((s) => `${s.event.id}:${s.startMin}-${s.endMin}@${s.col}/${s.cols}`)

  it('sem sobreposição, cada um ocupa a largura toda', () => {
    const slots = layoutDayEvents(
      [ev('b', d(2026, 10, 1, 14), d(2026, 10, 1, 15)), ev('a', d(2026, 10, 1, 9), d(2026, 10, 1, 10))],
      dia,
    )
    expect(resumo(slots)).toEqual(['a:540-600@0/1', 'b:840-900@0/1'])
  })

  it('no mesmo horário dividem a largura; quem vem depois reaproveita a coluna livre', () => {
    const slots = layoutDayEvents(
      [
        ev('a', d(2026, 10, 1, 14), d(2026, 10, 1, 15)),
        ev('b', d(2026, 10, 1, 14), d(2026, 10, 1, 16)),
        ev('c', d(2026, 10, 1, 15), d(2026, 10, 1, 16)),
        ev('d', d(2026, 10, 1, 17), d(2026, 10, 1, 18)),
      ],
      dia,
    )
    expect(resumo(slots)).toEqual(['b:840-960@0/2', 'a:840-900@1/2', 'c:900-960@1/2', 'd:1020-1080@0/1'])
  })

  it('evento curto conta com a altura mínima para não sumir atrás do vizinho', () => {
    const slots = layoutDayEvents(
      [ev('a', d(2026, 10, 1, 9), d(2026, 10, 1, 9, 10)), ev('b', d(2026, 10, 1, 9, 20), d(2026, 10, 1, 10))],
      dia,
    )
    expect(resumo(slots)).toEqual(['a:540-550@0/2', 'b:560-600@1/2'])
  })

  it('evento que atravessa a meia-noite aparece cortado em cada dia', () => {
    const noturno = ev('n', d(2026, 9, 30, 22), d(2026, 10, 1, 2))
    expect(resumo(layoutDayEvents([noturno], d(2026, 9, 30)))).toEqual(['n:1320-1440@0/1'])
    expect(resumo(layoutDayEvents([noturno], dia))).toEqual(['n:0-120@0/1'])
  })

  it('termina exatamente à meia-noite: não aparece no dia seguinte', () => {
    const ateMeiaNoite = ev('m', d(2026, 9, 30, 23), d(2026, 10, 1, 0))
    expect(layoutDayEvents([ateMeiaNoite], dia)).toEqual([])
  })

  it('formato de hora do formulário volta igual', () => {
    expect(toLocalInput(parseLocalInput('2026-10-03T11:05')!)).toBe('2026-10-03T11:05')
  })
})

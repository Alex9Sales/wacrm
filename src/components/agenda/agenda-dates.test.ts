import { describe, expect, it } from 'vitest'

import {
  addDays,
  capColumns,
  changeStartInput,
  layoutDayEvents,
  monthGrid,
  parseDateInput,
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
// roda em UTC; rodar também com TZ=America/Sao_Paulo, TZ=America/New_York e
// TZ=Europe/Lisbon, que têm horário de verão, para pegar conta feita em
// milissegundos — Lisboa repete a hora 01:00–01:59 no fim de outubro).

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
    // fuso. Datas de troca nos EUA (mar/nov) e na Europa (mar/out), incluindo
    // a hora que se REPETE em Lisboa/Londres (25/10 01:30). Vale em qualquer
    // fuso: o fim fica 1h depois pelo relógio OU pelo tempo real (na troca
    // de horário os dois não batem e não há como acertar os dois) — e NUNCA
    // no mesmo horário do início nem antes dele.
    const relogio = (s: string) => {
      const [y, mo, dd, h, mi] = s.split(/[-T:]/).map(Number)
      return Date.UTC(y, mo - 1, dd, h, mi)
    }
    const inicios = [
      '2026-03-08T01:30',
      '2026-03-08T10:00',
      '2026-03-29T00:30',
      '2026-10-25T00:30',
      '2026-10-25T01:30',
      '2026-11-01T00:30',
      '2026-11-01T01:30',
      '2026-11-01T10:00',
    ]
    for (const ini of inicios) {
      const fim = shiftEndWithStart('2026-10-01T09:00', '2026-10-01T10:00', ini, false)
      const real = parseLocalInput(fim)!.getTime() - parseLocalInput(ini)!.getTime()
      const peloRelogio = relogio(fim) - relogio(ini)
      expect(real === 3_600_000 || peloRelogio === 3_600_000, `${ini} → ${fim}`).toBe(true)
      expect(scheduleError(ini, fim, false), `${ini} → ${fim}`).toBeNull()
    }
    // Dia inteiro atravessando a troca: continua sendo data, sem sobrar hora.
    expect(shiftEndWithStart('2026-10-01', '2026-10-02', '2026-11-01', true)).toBe('2026-11-02')
    expect(shiftEndWithStart('2026-10-01', '2026-10-08', '2026-03-05', true)).toBe('2026-03-12')
  })
})

describe('digitar o ano do início pelo teclado', () => {
  // O Chrome manda o ano parcial a cada tecla: 0002 → 0020 → 0202 → 2026.
  // Antes, o fim andava junto com 1902/1920/"202-…" e a duração virava 1h.
  const digitaAno = (start: string, end: string, valores: string[], allDay: boolean) => {
    let cur = { start, end, lastValidStart: start }
    const fins: string[] = []
    for (const v of valores) {
      cur = changeStartInput(cur, v, allDay)
      fins.push(cur.end)
    }
    return { cur, fins }
  }
  const anos = (resto: string, final: string) => ['0002', '0020', '0202', final].map((a) => a + resto)

  it('ano pela metade não é data', () => {
    expect(parseLocalInput('0002-10-03T11:00')).toBeNull()
    expect(parseLocalInput('0202-10-03T11:00')).toBeNull()
    expect(parseDateInput('0020-10-03')).toBeNull()
    expect(parseLocalInput('2026-10-03T11:00')).not.toBeNull()
    expect(scheduleError('0202-10-03T11:00', '2026-10-03T12:00', false)).toBe('Preencha o início.')
  })

  it('consulta de 30 min continua com 30 min', () => {
    const { cur, fins } = digitaAno('2026-10-03T11:00', '2026-10-03T11:30', anos('-10-03T11:00', '2026'), false)
    // Enquanto o ano está pela metade, o fim não se mexe.
    expect(fins.slice(0, 3)).toEqual(['2026-10-03T11:30', '2026-10-03T11:30', '2026-10-03T11:30'])
    expect(cur).toEqual({
      start: '2026-10-03T11:00',
      end: '2026-10-03T11:30',
      lastValidStart: '2026-10-03T11:00',
    })
  })

  it('2h30 continua 2h30, também mudando de ano', () => {
    const { cur } = digitaAno('2026-12-10T09:00', '2026-12-10T11:30', anos('-12-10T09:00', '2027'), false)
    expect(cur.end).toBe('2027-12-10T11:30')
  })

  it('dia inteiro continua com o mesmo nº de dias', () => {
    const { cur, fins } = digitaAno('2026-10-01', '2026-10-03', anos('-10-01', '2027'), true)
    expect(fins.slice(0, 3)).toEqual(['2026-10-03', '2026-10-03', '2026-10-03'])
    expect(cur.end).toBe('2027-10-03')
  })

  it('o ano sai sempre com 4 dígitos (o campo não aceita "202-…")', () => {
    expect(toLocalInput(new Date(202, 9, 3, 11, 30))).toBe('0202-10-03T11:30')
    expect(toDateInput(new Date(202, 9, 3))).toBe('0202-10-03')
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

  it('início e fim certos passam; no dia inteiro, igual é um dia só', () => {
    expect(scheduleError('2026-10-03T11:00', '2026-10-03T12:00', false)).toBeNull()
    expect(scheduleError('2026-10-03', '2026-10-03', true)).toBeNull()
  })

  it('com horário, fim igual ao início é erro (o servidor trocaria em silêncio por +1h)', () => {
    expect(scheduleError('2026-10-03T11:00', '2026-10-03T11:00', false)).toBe(
      'O fim precisa ser depois do início (03/10 11:00).',
    )
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

describe('no máximo 3 lado a lado (Semana em "Todas")', () => {
  const ev = (id: string, ini: Date, fim: Date) => ({
    id,
    startsAt: ini.toISOString(),
    endsAt: fim.toISOString(),
  })
  const dia = d(2026, 10, 6)
  const h = (hora: number, min = 0) => d(2026, 10, 6, hora, min)
  const ids = (r: ReturnType<typeof capColumns<ReturnType<typeof ev>>>) => ({
    visiveis: r.visible.map((s) => `${s.event.id}@${s.col}/${s.cols}`),
    mais: r.hidden.map((x) => `${x.startMin}-${x.endMin}:${x.events.map((e) => e.id).join(',')}`),
  })

  it('até 3 no mesmo horário: todos aparecem', () => {
    const slots = layoutDayEvents([ev('a', h(14), h(15)), ev('b', h(14), h(15)), ev('c', h(14), h(15))], dia)
    expect(ids(capColumns(slots, 3))).toEqual({ visiveis: ['a@0/3', 'b@1/3', 'c@2/3'], mais: [] })
  })

  it('4 no mesmo horário: 2 aparecem e a 3ª coluna vira "+2"', () => {
    const slots = layoutDayEvents(
      [ev('a', h(14), h(15)), ev('b', h(14), h(15)), ev('c', h(14), h(15)), ev('d', h(14), h(15))],
      dia,
    )
    expect(ids(capColumns(slots, 3))).toEqual({ visiveis: ['a@0/3', 'b@1/3'], mais: ['840-900:c,d'] })
  })

  it('o "+N" só toma a 3ª coluna onde falta lugar; no resto do dia ela continua visível', () => {
    const slots = layoutDayEvents(
      [
        ev('a', h(9), h(15)),
        ev('b', h(9), h(15)),
        ev('c', h(9), h(10)), // 3ª coluna de manhã: cabe
        ev('d', h(14), h(15)), // 3ª coluna à tarde, junto com o 4º
        ev('e', h(14), h(15)),
      ],
      dia,
    )
    expect(ids(capColumns(slots, 3))).toEqual({
      visiveis: ['a@0/3', 'b@1/3', 'c@2/3'],
      mais: ['840-900:d,e'],
    })
  })
})

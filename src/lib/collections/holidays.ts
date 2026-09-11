// ============================================================
// 📅 Feriados nacionais brasileiros, calculados — sem API externa.
//
// 11/09 (Alex, a partir do João/GoLink): "a opção que se fosse domingo e
// feriado, não dispara". Cobrar alguém no Natal ou na Sexta-feira Santa é o
// tipo de coisa que o cliente do cliente não perdoa.
//
// ⚠️ Só NACIONAIS. Feriado municipal e estadual (aniversário da cidade,
// padroeiro, Revolução Constitucionalista em SP…) NÃO entram — não dá para
// saber a cidade do devedor. Quem precisa disso desmarca o dia na régua.
// Sem 'server-only' — worker-reachable.
// ============================================================

/** Domingo de Páscoa (algoritmo de Gauss/Meeus, calendário gregoriano). */
export function easterSunday(year: number): Date {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return new Date(Date.UTC(year, month - 1, day))
}

const ymd = (d: Date): string => d.toISOString().slice(0, 10)
const shift = (d: Date, days: number): Date => new Date(d.getTime() + days * 86_400_000)

/**
 * Feriados nacionais do ano, como `YYYY-MM-DD` → nome.
 *
 * Inclui os feriados de lei (Lei 662/49, Lei 6.802/80 e a Consciência Negra,
 * nacional desde a Lei 14.759/2023) e mais Carnaval e Corpus Christi, que são
 * ponto facultativo mas na prática ninguém atende — e cobrança nesses dias
 * gera a mesma reclamação de um feriado de verdade.
 */
export function brazilHolidays(year: number): Map<string, string> {
  const pascoa = easterSunday(year)
  const fixos: [string, string][] = [
    [`${year}-01-01`, 'Confraternização Universal'],
    [`${year}-04-21`, 'Tiradentes'],
    [`${year}-05-01`, 'Dia do Trabalho'],
    [`${year}-09-07`, 'Independência'],
    [`${year}-10-12`, 'Nossa Senhora Aparecida'],
    [`${year}-11-02`, 'Finados'],
    [`${year}-11-15`, 'Proclamação da República'],
    [`${year}-11-20`, 'Consciência Negra'],
    [`${year}-12-25`, 'Natal'],
  ]
  const moveis: [string, string][] = [
    [ymd(shift(pascoa, -48)), 'Carnaval'],
    [ymd(shift(pascoa, -47)), 'Carnaval'],
    [ymd(shift(pascoa, -2)), 'Sexta-feira Santa'],
    [ymd(shift(pascoa, 60)), 'Corpus Christi'],
  ]
  return new Map([...fixos, ...moveis])
}

/** Nome do feriado nacional nessa data (`YYYY-MM-DD`), ou `null`. */
export function holidayName(dayKey: string): string | null {
  const year = Number(dayKey.slice(0, 4))
  if (!Number.isFinite(year)) return null
  return brazilHolidays(year).get(dayKey.slice(0, 10)) ?? null
}

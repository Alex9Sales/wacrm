// ============================================================
// ⏱️ Expediente COMERCIAL da conta, em minutos — PURO (worker, action e tela).
//
// 02/10/2026 (pedido de uma clínica): o aviso de "transferência parada" e o
// resumo do fim do dia precisam contar o tempo como a recepção conta. Uma
// transferência às 21h de sexta numa clínica que só abre sábado às 8h não está
// "parada há 11 horas" às 8h05 — está parada há 5 minutos de expediente. E
// domingo fechado não conta.
//
// Usa o horário COMERCIAL (account_settings: businessHoursEnabled +
// businessDays + businessTimezone, Config → Atendimento), o mesmo que decide o
// aviso de fora de horário. NÃO é o texto que a IA fala ao cliente
// (ai_company_profile.hours) — são dois horários diferentes.
//
// "Configurado" = horário de atendimento LIGADO e ao menos um dia aberto. Os
// dias só aparecem na tela com o interruptor ligado; desligado, o que está no
// banco é o padrão (seg–sex 8h–18h) ou um rascunho antigo, e não vale.
// Sem expediente configurado, o tempo corre 24h por dia — a mesma regra do
// resto do sistema (business-hours.ts: horário desligado não barra nada).
// ============================================================

import type { AccountSettings, BusinessDay } from '@/lib/settings/account-settings'
import { localParts } from '@/lib/settings/business-hours'
import { clipAtWord, oneLine } from './alert-text'

export type ExpedienteCfg = Pick<
  AccountSettings,
  'businessHoursEnabled' | 'businessDays' | 'businessTimezone'
>

const FUSO_PADRAO = 'America/Sao_Paulo'
/** Último tick garantido do dia num worker de 15 min (23:45–24:00). */
export const ULTIMO_TICK_DO_DIA = 23 * 60 + 45

/** "HH:MM" → minutos desde a meia-noite; null se mal formado. */
function hhmm(v: string | null | undefined): number | null {
  if (!v) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h > 23 || min > 59) return null
  return h * 60 + min
}

/** Janela do dia (minutos). null = fechado. Abre = fecha conta como fechado,
 *  igual ao isWithinBusinessHours. close < open = vira a meia-noite. */
export function janelaDoDia(d: BusinessDay | null | undefined): { open: number; close: number } | null {
  const open = hhmm(d?.open)
  const close = hhmm(d?.close)
  if (open == null || close == null || open === close) return null
  return { open, close }
}

export function expedienteConfigurado(cfg: ExpedienteCfg): boolean {
  return (
    cfg.businessHoursEnabled === true &&
    Array.isArray(cfg.businessDays) &&
    cfg.businessDays.some((d) => janelaDoDia(d) !== null)
  )
}

/** Fuso válido ou o padrão (fuso inválido faz o Intl lançar). */
export function fusoSeguro(tz: string | null | undefined): string {
  const t = (tz ?? '').trim() || FUSO_PADRAO
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: t })
    return t
  } catch {
    return FUSO_PADRAO
  }
}

const formatadores = new Map<string, Intl.DateTimeFormat>()
function formatador(tz: string): Intl.DateTimeFormat {
  let f = formatadores.get(tz)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    formatadores.set(tz, f)
  }
  return f
}

/** Relógio de parede em `tz` no instante `t`. */
function parede(t: number, tz: string): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const p = formatador(tz).formatToParts(new Date(t))
  const g = (k: string) => Number(p.find((x) => x.type === k)?.value ?? 0)
  return { y: g('year'), m: g('month'), d: g('day'), h: g('hour') % 24, mi: g('minute'), s: g('second') }
}

/** Offset (ms) do fuso no instante `t`: parede lida como UTC − UTC. */
function offsetMs(t: number, tz: string): number {
  const w = parede(t, tz)
  return Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi, w.s) - Math.floor(t / 1000) * 1000
}

/** Instante UTC (ms) da parede `dia` + `minutos` no fuso. Date.UTC aceita
 *  dia/minuto estourado (dia 32, minuto 1440) e vira o mês/dia sozinho. */
function paredeParaUtc(y: number, m: number, d: number, minutos: number, tz: string): number {
  const palpite = Date.UTC(y, m - 1, d, 0, minutos)
  const o1 = offsetMs(palpite, tz)
  const t = palpite - o1
  const o2 = offsetMs(t, tz)
  return o2 === o1 ? t : palpite - o2
}

/**
 * Minutos de EXPEDIENTE entre `de` e `ate`: só contam os trechos dentro das
 * janelas abertas da conta, no fuso dela. Sem expediente configurado, conta o
 * relógio. Nunca negativo.
 */
export function minutosDeExpediente(de: Date, ate: Date, cfg: ExpedienteCfg): number {
  const ini = de.getTime()
  const fim = ate.getTime()
  if (!Number.isFinite(ini) || !Number.isFinite(fim) || fim <= ini) return 0
  if (!expedienteConfigurado(cfg)) return Math.floor((fim - ini) / 60_000)

  const tz = fusoSeguro(cfg.businessTimezone)
  const hoje = parede(ini, tz)
  const trechos: [number, number][] = []
  // Começa no dia ANTERIOR ao início: a cauda de uma janela que vira a
  // meia-noite (18h → 2h) pertence ao dia de ontem.
  for (let k = -1; k < 400; k++) {
    const dia = new Date(Date.UTC(hoje.y, hoje.m - 1, hoje.d + k))
    const Y = dia.getUTCFullYear()
    const M = dia.getUTCMonth() + 1
    const D = dia.getUTCDate()
    if (paredeParaUtc(Y, M, D, 0, tz) > fim) break
    const w = janelaDoDia(cfg.businessDays[dia.getUTCDay()])
    if (!w) continue
    const abre = paredeParaUtc(Y, M, D, w.open, tz)
    const fecha =
      w.close > w.open ? paredeParaUtc(Y, M, D, w.close, tz) : paredeParaUtc(Y, M, D + 1, w.close, tz)
    trechos.push([abre, fecha])
  }
  // Junta trechos sobrepostos (janela da madrugada encostando na de hoje).
  trechos.sort((a, b) => a[0] - b[0])
  let total = 0
  let cursor = ini
  for (const [a, b] of trechos) {
    const s = Math.max(a, cursor)
    const e = Math.min(b, fim)
    if (e > s) {
      total += e - s
      cursor = e
    }
  }
  return Math.floor(total / 60_000)
}

/**
 * Minuto do dia (no fuso da conta) em que o expediente de HOJE fecha — null em
 * dia fechado ou sem expediente configurado. Janela que vira a meia-noite e
 * fechamento depois das 23:45 viram 23:45: é o último tick de 15 min garantido
 * dentro do mesmo dia (o resumo é "de hoje" e a trava é por data).
 */
export function fechamentoDeHoje(cfg: ExpedienteCfg, now: Date = new Date()): number | null {
  if (!expedienteConfigurado(cfg)) return null
  const { day } = localParts(now, fusoSeguro(cfg.businessTimezone))
  const w = janelaDoDia(cfg.businessDays[day])
  if (!w) return null
  return w.close > w.open ? Math.min(w.close, ULTIMO_TICK_DO_DIA) : ULTIMO_TICK_DO_DIA
}

const DIAS = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'] as const

/** 1230 → "20h30" · 1020 → "17h". */
function horaFalada(minutos: number): string {
  const h = Math.floor(minutos / 60)
  const m = minutos % 60
  return m ? `${h}h${String(m).padStart(2, '0')}` : `${h}h`
}

/**
 * A que horas o resumo "no fim do expediente" sai em cada dia, em português,
 * pra tela: "Segunda a sexta às 20h30, sábado às 17h. Domingo: sem resumo
 * (fechado)". Agrupa dias seguidos de mesmo fechamento, semana começando na
 * segunda. null = nenhum dia aberto.
 */
export function textoDosFechamentos(days: BusinessDay[] | null | undefined): string | null {
  if (!Array.isArray(days)) return null
  const ordem = [1, 2, 3, 4, 5, 6, 0]
  const blocos: { de: number; ate: number; hora: string }[] = []
  const fechados: number[] = []
  for (const i of ordem) {
    const w = janelaDoDia(days[i])
    if (!w) {
      fechados.push(i)
      continue
    }
    const hora = horaFalada(w.close > w.open ? Math.min(w.close, ULTIMO_TICK_DO_DIA) : ULTIMO_TICK_DO_DIA)
    const ultimo = blocos[blocos.length - 1]
    if (ultimo && ultimo.hora === hora && ordem.indexOf(i) === ordem.indexOf(ultimo.ate) + 1) {
      ultimo.ate = i
    } else {
      blocos.push({ de: i, ate: i, hora })
    }
  }
  if (blocos.length === 0) return null
  const maiuscula = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
  const abertos = blocos
    .map((b) => `${b.de === b.ate ? DIAS[b.de] : `${DIAS[b.de]} a ${DIAS[b.ate]}`} às ${b.hora}`)
    .join(', ')
  const texto = maiuscula(abertos)
  if (fechados.length === 0) return texto
  return `${texto}. ${maiuscula(fechados.map((i) => DIAS[i]).join(', '))}: sem resumo (fechado)`
}

/** "15 min" · "1h05" · "3h" · "1 dia e 2h". */
export function formatarEspera(minutos: number): string {
  const m = Math.max(0, Math.floor(Number(minutos) || 0))
  if (m < 1) return 'menos de 1 min'
  if (m < 60) return `${m} min`
  if (m < 1440) {
    const h = Math.floor(m / 60)
    const r = m % 60
    return r ? `${h}h${String(r).padStart(2, '0')}` : `${h}h`
  }
  const d = Math.floor(m / 1440)
  const h = Math.floor((m % 1440) / 60)
  const dias = d === 1 ? '1 dia' : `${d} dias`
  return h ? `${dias} e ${h}h` : dias
}

/**
 * Motivo curto da transferência, tirado da NOTA interna gravada pela IA
 * (auto-reply.ts finishHandoff): o resumo que a IA escreveu vem depois do "📋"
 * (pode ocupar mais de uma linha, até o "Cliente disse:"). Sem resumo, cai nas
 * últimas falas do cliente. Nada disso → ''.
 */
export function motivoDaNota(nota: string | null | undefined, max = 90): string {
  const linhas = (nota ?? '').split('\n').map((l) => l.trim())
  const i = linhas.findIndex((l) => l.startsWith('📋'))
  if (i >= 0) {
    const partes: string[] = [linhas[i].replace(/^📋\s*/u, '')]
    for (const l of linhas.slice(i + 1)) {
      if (l.startsWith('Cliente disse:')) break
      partes.push(l)
    }
    const resumo = clipAtWord(oneLine(partes.join('\n')), max)
    if (resumo) return resumo
  }
  const disse = linhas.find((l) => l.startsWith('Cliente disse:'))
  return disse ? clipAtWord(oneLine(disse), max) : ''
}

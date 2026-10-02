// ============================================================
// ⏰ Aviso de transferência PARADA — a IA passou o atendimento para a equipe
// ([[HANDOFF]]) e, N minutos DE EXPEDIENTE depois, ninguém respondeu.
//
// 02/10/2026 (pedido de uma clínica): o aviso "🔁 IA TRANSFERIU PRA HUMANO"
// sai na hora da transferência e some no meio das outras mensagens do dia. Se
// ninguém assume, o paciente fica no vácuo e ninguém fica sabendo — a IA já
// se despediu e está calada. Este aviso é o segundo toque, UMA vez por
// transferência, no mesmo WhatsApp dos avisos (alertPhone).
//
// Regras:
//   • opt-in por conta (alertOnHandoffStalled) + telefone dos avisos;
//   • só DENTRO do expediente comercial (ninguém é acordado às 3h), e o tempo
//     conta em minutos de expediente (expediente.ts);
//   • não avisa de novo: a nota interna "⏰ Transferência sem resposta…" na
//     conversa marca que o aviso saiu. A nota é gravada ANTES de mandar (é a
//     trava) e apagada se o envio falhar — avisar duas vezes é pior que
//     tentar de novo no próximo tick (ver o incidente do lembrete em dobro);
//   • só transferências das últimas 24h — o primeiro deploy não despeja as
//     antigas no WhatsApp do dono. Exceção: a que esperou quase tudo com a
//     empresa FECHADA (sábado 16h50 → segunda 9h05) acabou de passar do limite
//     em expediente; essa ainda avisa, até 72h;
//   • teto por conta e por rodada.
//
// A nota é 'bot' + interna, gravada direto no banco como as outras notas da
// IA: não acorda a IA, não conta como resposta da equipe e não mexe no
// "não lida". Sem 'server-only': roda no worker.
// ============================================================

import { eq, sql } from 'drizzle-orm'

import { db, messages } from '@/db'
import {
  DEFAULT_ACCOUNT_SETTINGS,
  type AccountSettings,
} from '@/lib/settings/account-settings'
import { isWithinBusinessHours, localParts } from '@/lib/settings/business-hours'
import { sendOwnerAlert } from './owner-alerts'
import { expedienteConfigurado, formatarEspera, fusoSeguro } from './expediente'
import {
  listarTransferenciasParadas,
  STALLED_NOTE_PREFIX,
  type TransferenciaParada,
} from './transferencias-paradas'

export const LIMIAR_PADRAO_MIN = 15
export const LIMIAR_MIN = 5
export const LIMIAR_MAX = 240
/** Janela normal do aviso (horas de relógio). */
export const JANELA_AVISO_HORAS = 24
/** Janela estendida para quem esperou com a empresa fechada. */
export const JANELA_ESTENDIDA_HORAS = 72
/** Na janela estendida, só avisa se passou do limite há pouco (em expediente). */
export const FOLGA_ESTENDIDA_MIN = 120
export const AVISOS_POR_CONTA = 5
export const AVISOS_POR_RODADA = 20

/** Minutos configurados → inteiro entre 5 e 240 (padrão 15). */
export function limiarDaTransferenciaParada(v: unknown): number {
  const n = Math.trunc(Number(v))
  if (!Number.isFinite(n) || n <= 0) return LIMIAR_PADRAO_MIN
  return Math.min(LIMIAR_MAX, Math.max(LIMIAR_MIN, n))
}

/**
 * Quais transferências da lista ganham aviso AGORA. Puro: a lista já vem só
 * com as sem resposta humana, da mais antiga para a mais nova.
 */
export function transferenciasParaAvisar(
  lista: ReadonlyArray<TransferenciaParada>,
  limiar: number,
): TransferenciaParada[] {
  return lista.filter((t) => {
    if (t.avisadoEm) return false
    if (t.minutosExpediente < limiar) return false
    if (t.minutosRelogio <= JANELA_AVISO_HORAS * 60) return true
    return (
      t.minutosRelogio <= JANELA_ESTENDIDA_HORAS * 60 &&
      t.minutosExpediente < limiar + FOLGA_ESTENDIDA_MIN
    )
  })
}

const DIAS_CURTOS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'] as const

/** "sex 21:03" no fuso da conta. */
function diaEHora(d: Date, tz: string): string {
  const { day, minutes } = localParts(d, tz)
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0')
  const mm = String(minutes % 60).padStart(2, '0')
  return `${DIAS_CURTOS[day]} ${hh}:${mm}`
}

/**
 * Quanto tempo a transferência espera, para o aviso e a nota. Em minutos de
 * expediente; se boa parte da espera foi com a empresa fechada, diz desde
 * quando — "15 min" sozinho, para quem foi transferido sexta à noite, parece
 * errado para quem lê no sábado de manhã.
 */
export function textoDaEspera(t: TransferenciaParada, tz: string): string {
  const exp = formatarEspera(t.minutosExpediente)
  if (t.minutosRelogio - t.minutosExpediente >= 30) {
    return `${exp} de expediente (desde ${diaEHora(t.transferidaEm, fusoSeguro(tz))})`
  }
  return exp
}

export function textoDaNota(tempo: string): string {
  return `${STALLED_NOTE_PREFIX} há ${tempo} — aviso enviado ao responsável.`
}

/** Grava a nota-trava; devolve o id (null = não gravou, então não avisa). */
async function gravarNota(conversationId: string, tempo: string): Promise<string | null> {
  try {
    const [row] = await db
      .insert(messages)
      .values({
        conversationId,
        senderType: 'bot',
        contentType: 'text',
        contentText: textoDaNota(tempo),
        isInternal: true,
        status: 'sent',
      })
      .returning({ id: messages.id })
    return row?.id ?? null
  } catch (err) {
    console.error('[handoff-stalled] nota da trava falhou (não avisa):', err)
    return null
  }
}

async function soltarNota(id: string): Promise<void> {
  try {
    await db.delete(messages).where(eq(messages.id, id))
  } catch (err) {
    console.error('[handoff-stalled] não consegui apagar a nota do aviso que falhou:', err)
  }
}

/** Uma conta: lista, decide e avisa (até `maximo`). Devolve quantos saíram. */
export async function avisarTransferenciasParadasDaConta(
  accountId: string,
  s: AccountSettings,
  now: Date,
  maximo: number,
): Promise<number> {
  if (!s.alertOnHandoffStalled || !(s.alertPhone ?? '').replace(/\D/g, '')) return 0
  // Fora do expediente comercial não avisa (o relógio de expediente também
  // está parado). Sem expediente configurado, a conta é tratada como aberta.
  if (expedienteConfigurado(s) && !isWithinBusinessHours(s, now)) return 0

  const limiar = limiarDaTransferenciaParada(s.handoffStalledMinutes)
  const lista = await listarTransferenciasParadas(accountId, s, {
    now,
    horas: JANELA_ESTENDIDA_HORAS,
  })
  const vencidas = transferenciasParaAvisar(lista, limiar).slice(0, Math.max(0, maximo))
  let enviados = 0
  for (const t of vencidas) {
    const tempo = textoDaEspera(t, s.businessTimezone)
    const notaId = await gravarNota(t.conversationId, tempo)
    if (!notaId) continue
    const ok = await sendOwnerAlert(accountId, 'handoff_stalled', {
      cliente: t.nome,
      telefone: t.telefone,
      tempo,
      motivo: t.motivo,
      link: t.link,
    })
    if (!ok) {
      await soltarNota(notaId)
      console.warn(
        `[handoff-stalled] aviso não saiu (conta ${accountId}, conversa ${t.conversationId}) — tenta no próximo tick`,
      )
      continue
    }
    enviados++
    console.log(
      `[handoff-stalled] aviso enviado (conta ${accountId}, conversa ${t.conversationId}, ${t.minutosExpediente} min de expediente)`,
    )
  }
  return enviados
}

/** Varre as contas com o aviso ligado. Best-effort por conta. */
export async function varrerTransferenciasParadas(
  now: Date = new Date(),
): Promise<{ contas: number; avisos: number; erros: number }> {
  const res = await db.execute(sql`
    SELECT account_id, settings FROM account_settings
    WHERE (settings->>'alertOnHandoffStalled') = 'true'
  `)
  const rows = (res.rows ?? []) as unknown as Array<{
    account_id: string
    settings: Record<string, unknown> | null
  }>
  let avisos = 0
  let erros = 0
  for (const r of rows) {
    const restante = AVISOS_POR_RODADA - avisos
    if (restante <= 0) break
    try {
      const s = { ...DEFAULT_ACCOUNT_SETTINGS, ...(r.settings ?? {}) } as AccountSettings
      avisos += await avisarTransferenciasParadasDaConta(
        r.account_id,
        s,
        now,
        Math.min(AVISOS_POR_CONTA, restante),
      )
    } catch (err) {
      erros++
      console.error(`[handoff-stalled] conta ${r.account_id} falhou:`, err)
    }
  }
  return { contas: rows.length, avisos, erros }
}

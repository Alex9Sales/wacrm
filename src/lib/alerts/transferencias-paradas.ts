// ============================================================
// 🙋⏰ Transferências da IA PARADAS — quem a IA passou para a equipe e ninguém
// respondeu ainda. Fonte única para o resumo do dono (owner-digest) e para o
// aviso de transferência parada (aviso-transferencia-parada.ts).
//
// 02/10/2026 (pedido de uma clínica): a IA transfere ([[HANDOFF]]), o aviso
// "🔁 IA TRANSFERIU PRA HUMANO" sai na hora — e depois disso ninguém olhava se
// alguém tinha assumido: transferência sem resposta ficava sem resposta, e
// ninguém ficava sabendo.
//
// O que conta como transferência parada:
//   • a ÚLTIMA nota interna HANDOFF_NOTE_PREFIX da conversa, na janela;
//   • conversa ABERTA agora (fechar = resolvido; não há coluna com a hora do
//     fechamento, então uma conversa fechada e reaberta pelo cliente volta a
//     contar — e aí o cliente está mesmo esperando de novo);
//   • nenhuma mensagem NÃO interna de sender_type 'agent' depois da nota.
//     'agent' cobre quem respondeu pelo CRM E pelo celular: o eco fromMe do
//     WhatsApp é gravado como 'agent' (inbound.ts). Resposta da IA ('bot') não
//     conta — a transferência foi justamente para sair da IA. Nota interna
//     'agent' ("🔇 A IA não conseguiu ouvir") também não.
//
// Sem 'server-only': o worker importa isto.
// ============================================================

import { sql } from 'drizzle-orm'

import { db } from '@/db'
import { HANDOFF_NOTE_PREFIX } from '@/lib/ai/handoff-pause'
import { alertContactName } from './alert-text'
import { minutosDeExpediente, motivoDaNota, type ExpedienteCfg } from './expediente'

/** Começo EXATO da nota interna do aviso de transferência parada. A consulta
 *  abaixo procura por ele para não avisar duas vezes — não mudar sem varrer. */
export const STALLED_NOTE_PREFIX = '⏰ Transferência sem resposta'

/** Janela padrão (horas) da lista. */
export const JANELA_PARADAS_HORAS = 48

export interface TransferenciaParada {
  conversationId: string
  /** Nome apresentável ('' quando o contato não tem nome de verdade). */
  nome: string
  telefone: string
  transferidaEm: Date
  minutosRelogio: number
  minutosExpediente: number
  /** Trecho do resumo da IA (depois do 📋), cortado. Pode ser ''. */
  motivo: string
  /** Link da conversa no CRM ('' sem BETTER_AUTH_URL). */
  link: string
  /** Quando o aviso de transferência parada já saiu (nota ⏰). null = não saiu. */
  avisadoEm: Date | null
}

/** Mesmo link do aviso "IA TRANSFERIU PRA HUMANO" (auto-reply.ts). */
export function linkDaConversa(conversationId: string): string {
  const base = (process.env.BETTER_AUTH_URL ?? '').replace(/\/$/, '')
  return base ? `${base}/inbox?c=${conversationId}` : ''
}

/** Como o contato aparece numa lista: nome, senão o telefone. */
export function rotuloDoContato(t: Pick<TransferenciaParada, 'nome' | 'telefone'>): string {
  return t.nome || t.telefone || 'contato sem nome'
}

function data(v: unknown): Date | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d : null
}

/**
 * Transferências da IA sem resposta humana na conta, da mais antiga para a mais
 * nova. Só a última transferência de cada conversa.
 */
export async function listarTransferenciasParadas(
  accountId: string,
  cfg: ExpedienteCfg,
  opts: { now?: Date; horas?: number; limite?: number } = {},
): Promise<TransferenciaParada[]> {
  const now = opts.now ?? new Date()
  const horas = Math.max(1, Math.min(24 * 7, Math.trunc(opts.horas ?? JANELA_PARADAS_HORAS)))
  const limite = Math.max(1, Math.min(500, Math.trunc(opts.limite ?? 200)))
  // Margem no last_message_at: a nota nasce logo depois da mensagem do cliente
  // que fez a IA transferir (e essa mensagem já empurrou o last_message_at).
  // O filtro usa o índice (account_id, last_message_at) e evita varrer as
  // centenas de conversas abertas antigas de uma clínica.
  const horasConversa = horas + 2
  const res = await db.execute(sql`
    SELECT h.conversation_id, h.handoff_at, h.note_text,
           ct.name AS contact_name, ct.phone AS contact_phone,
           (SELECT max(a.created_at) FROM messages a
             WHERE a.conversation_id = h.conversation_id
               AND a.is_internal = true AND a.sender_type = 'bot'
               AND a.content_text LIKE ${STALLED_NOTE_PREFIX + '%'}
               AND a.created_at >= h.handoff_at) AS avisado_em
    FROM (
      SELECT c.id AS conversation_id, c.contact_id,
             lh.created_at AS handoff_at, lh.content_text AS note_text
      FROM conversations c
      JOIN LATERAL (
        SELECT m.created_at, m.content_text FROM messages m
        WHERE m.conversation_id = c.id
          AND m.is_internal = true
          AND m.content_text LIKE ${HANDOFF_NOTE_PREFIX + '%'}
          AND m.created_at >= now() - make_interval(hours => ${horas})
        ORDER BY m.created_at DESC
        LIMIT 1
      ) lh ON true
      WHERE c.account_id = ${accountId}
        AND c.status = 'open'
        AND c.last_message_at >= now() - make_interval(hours => ${horasConversa})
    ) h
    JOIN contacts ct ON ct.id = h.contact_id
    WHERE NOT EXISTS (
      SELECT 1 FROM messages r
      WHERE r.conversation_id = h.conversation_id
        AND r.sender_type = 'agent'
        AND r.is_internal = false
        AND r.created_at > h.handoff_at
    )
    ORDER BY h.handoff_at ASC
    LIMIT ${limite}
  `)
  const rows = (res.rows ?? []) as Array<Record<string, unknown>>
  const out: TransferenciaParada[] = []
  for (const r of rows) {
    const em = data(r.handoff_at)
    if (!em) continue
    const conversationId = String(r.conversation_id)
    const telefone = String(r.contact_phone ?? '').trim()
    out.push({
      conversationId,
      nome: alertContactName(r.contact_name as string | null, telefone),
      telefone,
      transferidaEm: em,
      minutosRelogio: Math.max(0, Math.floor((now.getTime() - em.getTime()) / 60_000)),
      minutosExpediente: minutosDeExpediente(em, now, cfg),
      motivo: motivoDaNota(r.note_text as string | null),
      link: linkDaConversa(conversationId),
      avisadoEm: data(r.avisado_em),
    })
  }
  return out
}

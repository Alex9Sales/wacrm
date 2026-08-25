// ============================================================
// 🚀 Ativação — o estado real do onboarding de uma conta, derivado do BANCO
// (não de cliques): o wizard "Ative seu Fluxia" lê daqui, então etapa já
// feita nasce marcada e o progresso nunca mente. O Aha Moment é a primeira
// resposta REAL da IA (messages.sender_type = 'bot') — a métrica que o
// /admin/sucesso acompanha como TTV.
// Sem 'server-only': lib de leitura pura, alcançável de rota e de admin.
// ============================================================

import { sql } from 'drizzle-orm'

import { db } from '@/db'

export interface ActivationStep {
  key: 'channel' | 'agent' | 'knowledge' | 'ai_on' | 'first_reply'
  title: string
  /** Subtítulo curto com o PORQUÊ do passo (mostrado no wizard). */
  hint: string
  done: boolean
  /** Quando o passo foi concluído (ISO), se soubermos. */
  at: string | null
  /** Rota do CTA do passo. */
  href: string
}

export interface ActivationState {
  steps: ActivationStep[]
  doneCount: number
  total: number
  percent: number
  /** Aha Moment: primeira resposta real da IA (ISO) — null = ainda não. */
  firstBotAt: string | null
  /** Horas entre criar a conta e o Aha (null = ainda não aconteceu). */
  ttvHours: number | null
  /** Telefone do canal WhatsApp conectado (pro passo do teste). */
  connectedPhone: string | null
}

function toRows(res: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(res)) return res as Array<Record<string, unknown>>
  const r = (res as { rows?: unknown }).rows
  return Array.isArray(r) ? (r as Array<Record<string, unknown>>) : []
}

export async function getActivationState(
  accountId: string,
): Promise<ActivationState> {
  // Tudo numa ida só — subqueries com colunas QUALIFICADAS na mão
  // (gotcha Drizzle: interpolação vira coluna sem prefixo em subquery).
  const [r] = toRows(await db.execute(sql`
    SELECT
      (SELECT o.created_at FROM organization o WHERE o.id = ${accountId}) AS org_created,
      (SELECT min(c.created_at) FROM channels c WHERE c.account_id = ${accountId}) AS first_channel_at,
      (SELECT min(c2.created_at) FROM channels c2
        WHERE c2.account_id = ${accountId} AND c2.status = 'connected') AS first_connected_at,
      (SELECT c3.phone_number FROM channels c3
        WHERE c3.account_id = ${accountId} AND c3.status = 'connected'
          AND c3.phone_number IS NOT NULL
        ORDER BY c3.created_at LIMIT 1) AS connected_phone,
      (SELECT min(a.created_at) FROM ai_configs a WHERE a.account_id = ${accountId}) AS first_agent_at,
      (SELECT min(a2.updated_at) FROM ai_configs a2
        WHERE a2.account_id = ${accountId} AND a2.is_active AND a2.auto_reply_enabled) AS ai_on_at,
      (SELECT min(k.created_at) FROM ai_knowledge_documents k
        WHERE k.account_id = ${accountId}) AS first_kb_at,
      (SELECT min(m.created_at) FROM messages m
        WHERE m.account_id = ${accountId} AND m.sender_type = 'bot') AS first_bot_at
  `))

  const iso = (v: unknown): string | null =>
    v ? new Date(String(v)).toISOString() : null

  const connectedAt = iso(r?.first_connected_at)
  const agentAt = iso(r?.first_agent_at)
  const kbAt = iso(r?.first_kb_at)
  const aiOnAt = iso(r?.ai_on_at)
  const firstBotAt = iso(r?.first_bot_at)
  const orgCreated = iso(r?.org_created)

  const steps: ActivationStep[] = [
    {
      key: 'channel',
      title: 'Conecte seu WhatsApp',
      hint: 'Leia o QR e traga suas conversas pra dentro.',
      done: Boolean(connectedAt),
      at: connectedAt,
      href: '/settings?tab=channels',
    },
    {
      key: 'agent',
      title: 'Crie seu agente de IA',
      hint: 'Escolha o nome, o tom de voz e a chave de IA.',
      done: Boolean(agentAt),
      at: agentAt,
      href: '/agents',
    },
    {
      key: 'knowledge',
      title: 'Ensine com os seus materiais',
      hint: 'Preços, serviços, respostas — a IA responde com os SEUS dados.',
      done: Boolean(kbAt),
      at: kbAt,
      href: '/agents',
    },
    {
      key: 'ai_on',
      title: 'Ligue a IA no canal',
      hint: 'Ative o agente e a resposta automática.',
      done: Boolean(aiOnAt),
      at: aiOnAt,
      href: '/agents',
    },
    {
      key: 'first_reply',
      title: 'Teste seu agente agora',
      hint: 'Mande uma mensagem pro seu número e veja o Fluxia atender.',
      done: Boolean(firstBotAt),
      at: firstBotAt,
      href: '/inbox',
    },
  ]

  const doneCount = steps.filter((s) => s.done).length
  const ttvHours =
    firstBotAt && orgCreated
      ? Math.max(
          0,
          (new Date(firstBotAt).getTime() - new Date(orgCreated).getTime()) /
            3_600_000,
        )
      : null

  return {
    steps,
    doneCount,
    total: steps.length,
    percent: Math.round((doneCount / steps.length) * 100),
    firstBotAt,
    ttvHours,
    connectedPhone: r?.connected_phone ? String(r.connected_phone) : null,
  }
}

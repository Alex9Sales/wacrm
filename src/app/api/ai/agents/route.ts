import { NextResponse } from 'next/server'
import { and, asc, desc, eq } from 'drizzle-orm'

import { db, aiConfigs } from '@/db'
import { firstOrNull } from '@/db/helpers'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { canEditSettings } from '@/lib/auth/roles'
import { listAgentSummaries } from '@/lib/ai/agents'
import { getAgentsUsage } from '@/lib/ai/analytics'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// ============================================================
// Multi-agente (Fase A). Lista os agentes da conta (painel) e cria um novo.
// A edição de UM agente reusa POST /api/ai/config?agent=<id>.
// ============================================================

/**
 * GET /api/ai/agents — todos os agentes da conta (para o painel). Anexa o
 * custo/atendimentos (hoje + mês) de cada agente SÓ para quem pode ver custos
 * (supervisor+); para os demais, os cards vêm sem os números.
 */
export async function GET() {
  try {
    const { accountId, role } = await getCurrentAccount()
    const agents = await listAgentSummaries(accountId)
    if (canEditSettings(role)) {
      const usage = await getAgentsUsage(accountId)
      return NextResponse.json({
        agents: agents.map((a) => ({ ...a, usage: usage[a.id] ?? null })),
        showCosts: true,
      })
    }
    return NextResponse.json({ agents, showCosts: false })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/agents (admin+) — cria um novo agente. Herda provider/modelo/
 * chave do agente DEFAULT (mesma conta, mesma chave BYO), já pronto pra editar;
 * nasce DESLIGADO (is_active=false) e não-default. Precisa existir um agente
 * default (o primeiro agente é criado no setup, via /api/ai/config).
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as { name?: unknown }
    const name =
      typeof body.name === 'string' && body.name.trim()
        ? body.name.trim().slice(0, 60)
        : 'Novo agente'

    // Copia as credenciais do agente default (já criptografadas — copia direto).
    const base = firstOrNull(
      await db
        .select({
          provider: aiConfigs.provider,
          model: aiConfigs.model,
          apiKey: aiConfigs.apiKey,
          embeddingsApiKey: aiConfigs.embeddingsApiKey,
        })
        .from(aiConfigs)
        .where(eq(aiConfigs.accountId, accountId))
        .orderBy(desc(aiConfigs.isDefault), asc(aiConfigs.createdAt))
        .limit(1),
    )
    if (!base) {
      return NextResponse.json(
        {
          error:
            'Configure o primeiro agente (aba Configuração) antes de criar outros.',
        },
        { status: 400 },
      )
    }

    const inserted = firstOrNull(
      await db
        .insert(aiConfigs)
        .values({
          accountId,
          createdBy: userId,
          name,
          isDefault: false,
          provider: base.provider,
          model: base.model,
          apiKey: base.apiKey,
          embeddingsApiKey: base.embeddingsApiKey,
          // Nasce desligado e sem canais — o admin liga depois de configurar.
          isActive: false,
          autoReplyEnabled: false,
          systemPrompt: null,
        })
        .returning({ id: aiConfigs.id }),
    )

    return NextResponse.json({ id: inserted?.id })
  } catch (err) {
    return toErrorResponse(err)
  }
}

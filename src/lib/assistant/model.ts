// O modelo da conta (agente padrão) devolvendo JSON — usado pra classificar
// o pedido do dono. Mesmo padrão do extrator do comando de cobrança.
import { and, desc, eq } from 'drizzle-orm'

import { db, aiConfigs } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { loadAiConfigById } from '@/lib/ai/config'
import { generateReply } from '@/lib/ai/generate'

export async function ownerModelJson<T = Record<string, unknown>>(accountId: string, systemPrompt: string, text: string): Promise<T | null> {
  const agent = firstOrNull(
    await db
      .select({ id: aiConfigs.id })
      .from(aiConfigs)
      .where(and(eq(aiConfigs.accountId, accountId), eq(aiConfigs.isDefault, true)))
      .orderBy(desc(aiConfigs.isActive))
      .limit(1),
  )
  if (!agent) return null
  const config = await loadAiConfigById(accountId, agent.id, { requireActive: false })
  if (!config) return null
  const r = await generateReply({
    config,
    systemPrompt,
    messages: [{ role: 'user', content: text }] as unknown as Parameters<typeof generateReply>[0]['messages'],
  })
  const out = (r?.text ?? '').trim()
  const m = /\{[\s\S]*\}/.exec(out)
  if (!m) return null
  try {
    return JSON.parse(m[0]) as T
  } catch {
    return null
  }
}

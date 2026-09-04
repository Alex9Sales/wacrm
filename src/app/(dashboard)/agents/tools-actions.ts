'use server'

// ============================================================
// 🔧 Ferramentas externas do agente — CRUD + teste + histórico.
// Segredos (headers de auth) entram cifrados e NUNCA voltam ao cliente:
// a listagem devolve só os NOMES dos headers; editar sem redigitar o
// segredo mantém o valor guardado.
// ============================================================

import { and, desc, eq } from 'drizzle-orm'
import { classifyUrl } from '@/lib/net/safe-url'

import { db, agentTools, agentToolRuns, aiConfigs } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireRole } from '@/lib/auth/account'
import {
  encryptToolHeaders,
  executeTool,
  type ExternalTool,
  type ToolParamDef,
} from '@/lib/ai/external-tools'
import { decrypt } from '@/lib/whatsapp/encryption'

export interface AgentToolRow {
  id: string
  agentId: string
  name: string
  slug: string
  description: string
  method: string
  url: string
  /** Só os NOMES dos headers guardados (o valor nunca volta). */
  headerNames: string[]
  params: ToolParamDef[]
  bodyTemplate: string | null
  risk: 'read' | 'write' | 'critical'
  dedupScope?: 'args' | 'conversation' | 'off'
  enabled: boolean
}

function toSlug(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'ferramenta'
}

function headerNamesOf(ciphertext: string | null): string[] {
  if (!ciphertext) return []
  try {
    return Object.keys(JSON.parse(decrypt(ciphertext)) as Record<string, string>)
  } catch {
    return []
  }
}

async function assertAgentInAccount(accountId: string, agentId: string) {
  const row = firstOrNull(
    await db
      .select({ id: aiConfigs.id })
      .from(aiConfigs)
      .where(and(eq(aiConfigs.id, agentId), eq(aiConfigs.accountId, accountId)))
      .limit(1),
  )
  if (!row) throw new Error('Agente não encontrado')
}

export async function listAgentExternalTools(
  agentId: string,
): Promise<AgentToolRow[]> {
  const ctx = await requireRole('admin')
  await assertAgentInAccount(ctx.accountId, agentId)
  const rows = await db
    .select()
    .from(agentTools)
    .where(
      and(eq(agentTools.accountId, ctx.accountId), eq(agentTools.agentId, agentId)),
    )
    .orderBy(agentTools.createdAt)
  return rows.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    name: r.name,
    slug: r.slug,
    description: r.description,
    method: r.method,
    url: r.url,
    headerNames: headerNamesOf(r.headersEnc),
    params: Array.isArray(r.params) ? (r.params as ToolParamDef[]) : [],
    bodyTemplate: r.bodyTemplate,
    risk: (r.risk as AgentToolRow['risk']) ?? 'read',
    dedupScope: (r.dedupScope as AgentToolRow['dedupScope']) ?? 'args',
    enabled: r.enabled,
  }))
}

export async function saveAgentTool(input: {
  id?: string | null
  agentId: string
  name: string
  description: string
  method: string
  url: string
  /** undefined = manter os headers guardados; objeto (mesmo vazio) = substituir. */
  headers?: Record<string, string> | null
  params: ToolParamDef[]
  bodyTemplate?: string | null
  risk: 'read' | 'write' | 'critical'
  dedupScope?: 'args' | 'conversation' | 'off'
  enabled: boolean
}): Promise<{ error: string | null; id?: string }> {
  try {
    const ctx = await requireRole('admin')
    await assertAgentInAccount(ctx.accountId, input.agentId)

    const name = input.name.trim()
    if (!name) return { error: 'Dê um nome pra ferramenta.' }
    if (!input.description.trim()) {
      return { error: 'Descreva pra IA quando usar a ferramenta.' }
    }
    let url: URL
    try {
      // Valida com placeholders neutralizados ({x} não é URL válida crua).
      url = new URL(input.url.trim().replace(/\{[a-zA-Z0-9_]+\}/g, 'x'))
    } catch {
      return { error: 'URL inválida — inclua https://…' }
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return { error: 'A URL precisa ser http(s).' }
    }
    // 🛡️ Anti-SSRF: sem rede interna, sem porta fora de 80/443 (auditoria 02/09).
    const shape = classifyUrl(url)
    if (!shape.ok) return { error: `URL não permitida: ${shape.reason}` }
    const method = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method)
      ? input.method
      : 'GET'
    const dedupScope = ['args', 'conversation', 'off'].includes(input.dedupScope ?? '')
      ? (input.dedupScope as 'args' | 'conversation' | 'off')
      : 'args'
    const risk = ['read', 'write', 'critical'].includes(input.risk)
      ? input.risk
      : 'read'
    const params = (input.params ?? [])
      .filter((p) => p.name?.trim())
      .map((p) => ({
        name: p.name.trim().replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40),
        type: p.type === 'number' ? ('number' as const) : ('string' as const),
        description: (p.description ?? '').trim().slice(0, 200),
        required: !!p.required,
      }))

    if (input.id) {
      const existing = firstOrNull(
        await db
          .select()
          .from(agentTools)
          .where(
            and(eq(agentTools.id, input.id), eq(agentTools.accountId, ctx.accountId)),
          )
          .limit(1),
      )
      if (!existing) return { error: 'Ferramenta não encontrada.' }
      await db
        .update(agentTools)
        .set({
          name,
          description: input.description.trim(),
          method,
          url: input.url.trim(),
          params,
          bodyTemplate: input.bodyTemplate?.trim() || null,
          risk,
          dedupScope,
          enabled: input.enabled,
          // undefined = mantém o segredo guardado; objeto = substitui.
          ...(input.headers !== undefined
            ? { headersEnc: encryptToolHeaders(input.headers ?? {}) }
            : {}),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(agentTools.id, input.id))
      return { error: null, id: input.id }
    }

    // Slug único por agente.
    let slug = toSlug(name)
    const siblings = await db
      .select({ slug: agentTools.slug })
      .from(agentTools)
      .where(eq(agentTools.agentId, input.agentId))
    const taken = new Set(siblings.map((s) => s.slug))
    for (let i = 2; taken.has(slug); i++) slug = `${toSlug(name)}_${i}`

    const [row] = await db
      .insert(agentTools)
      .values({
        accountId: ctx.accountId,
        agentId: input.agentId,
        name,
        slug,
        description: input.description.trim(),
        method,
        url: input.url.trim(),
        headersEnc: encryptToolHeaders(input.headers ?? {}),
        params,
        bodyTemplate: input.bodyTemplate?.trim() || null,
        risk,
        dedupScope,
        enabled: input.enabled,
      })
      .returning()
    return { error: null, id: row.id }
  } catch (err) {
    console.error('[tools-actions] save:', err)
    return { error: 'Não foi possível salvar a ferramenta.' }
  }
}

export async function deleteAgentTool(id: string): Promise<{ error: string | null }> {
  try {
    const ctx = await requireRole('admin')
    await db
      .delete(agentTools)
      .where(and(eq(agentTools.id, id), eq(agentTools.accountId, ctx.accountId)))
    return { error: null }
  } catch {
    return { error: 'Não foi possível excluir.' }
  }
}

/** Testa a ferramenta AGORA com args de exemplo (sem IA). Registra no histórico. */
export async function testAgentTool(
  id: string,
  args: Record<string, unknown>,
): Promise<{ status: string; summary: string; httpStatus?: number }> {
  const ctx = await requireRole('admin')
  const r = firstOrNull(
    await db
      .select()
      .from(agentTools)
      .where(and(eq(agentTools.id, id), eq(agentTools.accountId, ctx.accountId)))
      .limit(1),
  )
  if (!r) return { status: 'error', summary: 'Ferramenta não encontrada.' }
  const { decrypt: dec } = await import('@/lib/whatsapp/encryption')
  let headers: Record<string, string> = {}
  try {
    headers = r.headersEnc ? (JSON.parse(dec(r.headersEnc)) as Record<string, string>) : {}
  } catch {
    headers = {}
  }
  const tool: ExternalTool = {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    method: r.method,
    url: r.url,
    headers,
    params: Array.isArray(r.params) ? (r.params as ToolParamDef[]) : [],
    bodyTemplate: r.bodyTemplate,
    risk: (r.risk as ExternalTool['risk']) ?? 'read',
    // O teste manual roda fora de conversa, então a trava não se aplica —
    // mas o tipo exige o campo, e 'off' é o que descreve o teste.
    dedupScope: 'off',
    createsDeal: r.createsDeal === true,
  }
  // Teste manual ignora o bloqueio de crítica (é o ADMIN validando a config).
  const testTool = tool.risk === 'critical' ? { ...tool, risk: 'write' as const } : tool
  const out = await executeTool(testTool, args, {
    accountId: ctx.accountId,
    agentId: r.agentId,
    conversationId: null,
  })
  return { status: out.status, summary: out.summary.slice(0, 1500), httpStatus: out.httpStatus }
}

export interface ToolRunRow {
  id: string
  toolSlug: string
  status: string
  resultSummary: string | null
  httpStatus: number | null
  durationMs: number | null
  createdAt: string
}

export async function listAgentToolRuns(agentId: string): Promise<ToolRunRow[]> {
  const ctx = await requireRole('admin')
  await assertAgentInAccount(ctx.accountId, agentId)
  const rows = await db
    .select()
    .from(agentToolRuns)
    .where(
      and(
        eq(agentToolRuns.accountId, ctx.accountId),
        eq(agentToolRuns.agentId, agentId),
      ),
    )
    .orderBy(desc(agentToolRuns.createdAt))
    .limit(20)
  return rows.map((r) => ({
    id: r.id,
    toolSlug: r.toolSlug,
    status: r.status,
    resultSummary: r.resultSummary ? r.resultSummary.slice(0, 300) : null,
    httpStatus: r.httpStatus,
    durationMs: r.durationMs,
    createdAt: r.createdAt,
  }))
}

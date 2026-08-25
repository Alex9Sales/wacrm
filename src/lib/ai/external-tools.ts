// ============================================================
// 🔧 Ferramentas externas do agente (Fase T1) — a IA chama APIs do cliente
// (ERP, estoque, pedidos) SEM n8n. Modelo: o agente emite o marcador
//   [[FERRAMENTA: slug | {"param": "valor"}]]
// o runtime executa o HTTP, devolve o resultado como contexto e re-gera —
// mesmo protocolo de diretivas do resto do produto, funciona em qualquer
// provedor (OpenAI/Gemini/Anthropic) sem function calling nativo.
// Governança: 🟢 read/🟡 write executam; 🔴 critical NÃO executa sozinha na
// v1 (é bloqueada e a IA é instruída a transferir pra humano). Toda execução
// vira linha em agent_tool_runs (histórico de ações/auditoria).
// Sem 'server-only' — worker-reachable.
// ============================================================

import { and, eq } from 'drizzle-orm'

import { db, agentTools, agentToolRuns } from '@/db'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { generateReply, type GenerateArgs } from './generate'
import type { GenerateResult } from './types'

export interface ToolParamDef {
  name: string
  type: 'string' | 'number'
  description: string
  required: boolean
}

export interface ExternalTool {
  id: string
  slug: string
  name: string
  description: string
  method: string
  url: string
  headers: Record<string, string>
  params: ToolParamDef[]
  bodyTemplate: string | null
  risk: 'read' | 'write' | 'critical'
}

const MAX_TOOL_STEPS = 4
const FETCH_TIMEOUT_MS = 12_000
const RESULT_CAP = 4_000

/** Cifra headers de auth pro banco (JSON → ciphertext AES-GCM). */
export function encryptToolHeaders(headers: Record<string, string>): string | null {
  const clean = Object.fromEntries(
    Object.entries(headers).filter(([k, v]) => k.trim() && v.trim()),
  )
  if (Object.keys(clean).length === 0) return null
  return encrypt(JSON.stringify(clean))
}

function decryptToolHeaders(ciphertext: string | null): Record<string, string> {
  if (!ciphertext) return {}
  try {
    const parsed = JSON.parse(decrypt(ciphertext))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** Ferramentas HABILITADAS de um agente, decifradas e prontas pra usar. */
export async function listEnabledTools(
  accountId: string,
  agentId: string | null,
): Promise<ExternalTool[]> {
  if (!agentId) return []
  const rows = await db
    .select()
    .from(agentTools)
    .where(
      and(
        eq(agentTools.accountId, accountId),
        eq(agentTools.agentId, agentId),
        eq(agentTools.enabled, true),
      ),
    )
  return rows.map((r) => ({
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    method: r.method,
    url: r.url,
    headers: decryptToolHeaders(r.headersEnc),
    params: Array.isArray(r.params) ? (r.params as ToolParamDef[]) : [],
    bodyTemplate: r.bodyTemplate,
    risk: (r.risk as ExternalTool['risk']) ?? 'read',
  }))
}

/** Seção do prompt: o cardápio de ferramentas + o protocolo do marcador. */
export function buildToolsPromptSection(tools: ExternalTool[]): string {
  if (tools.length === 0) return ''
  const lines = tools.map((t) => {
    const params = t.params
      .map(
        (p) =>
          `${p.name} (${p.type}${p.required ? ', obrigatório' : ''}): ${p.description}`,
      )
      .join('; ')
    const critical =
      t.risk === 'critical'
        ? ' ⚠️ AÇÃO CRÍTICA: não execute — quando o cliente pedir isso, transfira pra um humano.'
        : ''
    return `- ${t.slug} — ${t.name}. ${t.description}${params ? ` Parâmetros: ${params}.` : ''}${critical}`
  })
  return `FERRAMENTAS EXTERNAS DA EMPRESA

Você pode consultar/agir nos sistemas da empresa com estas ferramentas:
${lines.join('\n')}

COMO USAR: quando precisar de uma ferramenta, responda SOMENTE com o marcador (sem nenhum outro texto):
[[FERRAMENTA: slug | {"parametro": "valor"}]]
O sistema executa e te devolve o resultado; aí você continua o atendimento normalmente usando o dado real. Uma ferramenta por vez. NUNCA invente o resultado — se precisa do dado, chame a ferramenta. NUNCA mencione ferramentas, sistemas ou marcadores pro cliente.`
}

const TOOL_MARKER_RE = /\[\[\s*FERRAMENTA\s*:\s*([a-z0-9_-]+)\s*\|\s*(\{[\s\S]*?\})\s*\]\]/i

/** Extrai a 1ª chamada de ferramenta do texto gerado (null = não pediu). */
export function parseToolCall(
  raw: string,
): { slug: string; args: Record<string, unknown>; marker: string } | null {
  const m = raw.match(TOOL_MARKER_RE)
  if (!m) return null
  try {
    const args = JSON.parse(m[2]) as Record<string, unknown>
    return { slug: m[1].toLowerCase(), args, marker: m[0] }
  } catch {
    return { slug: m[1].toLowerCase(), args: {}, marker: m[0] }
  }
}

/** Substitui {placeholders} numa string pelos args (URL e body template). */
function fillPlaceholders(
  template: string,
  args: Record<string, unknown>,
  encode: boolean,
): { out: string; used: Set<string> } {
  const used = new Set<string>()
  const out = template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key: string) => {
    used.add(key)
    const v = args[key]
    const s = v === undefined || v === null ? '' : String(v)
    return encode ? encodeURIComponent(s) : s.replace(/"/g, '\\"')
  })
  return { out, used }
}

export interface ToolRunResult {
  status: 'ok' | 'error' | 'blocked' | 'invalid'
  summary: string
  httpStatus?: number
}

/** Executa uma ferramenta (com log em agent_tool_runs). Nunca lança. */
export async function executeTool(
  tool: ExternalTool,
  args: Record<string, unknown>,
  ctx: { accountId: string; agentId: string | null; conversationId: string | null },
): Promise<ToolRunResult> {
  const started = Date.now()
  let result: ToolRunResult

  if (tool.risk === 'critical') {
    result = {
      status: 'blocked',
      summary:
        'Ação crítica bloqueada: exige um humano. Diga ao cliente que um responsável vai concluir isso e transfira.',
    }
  } else {
    const missing = tool.params.filter((p) => p.required && (args[p.name] === undefined || args[p.name] === ''))
    if (missing.length > 0) {
      result = {
        status: 'invalid',
        summary: `Faltaram parâmetros obrigatórios: ${missing.map((p) => p.name).join(', ')}. Pergunte ao cliente e chame de novo.`,
      }
    } else {
      try {
        const { out: baseUrl, used } = fillPlaceholders(tool.url, args, true)
        const url = new URL(baseUrl)
        const isGet = tool.method === 'GET' || tool.method === 'DELETE'
        // GET: params que não entraram na URL viram query string.
        if (isGet) {
          for (const p of tool.params) {
            if (!used.has(p.name) && args[p.name] !== undefined && args[p.name] !== '') {
              url.searchParams.set(p.name, String(args[p.name]))
            }
          }
        }
        let body: string | undefined
        if (!isGet) {
          body = tool.bodyTemplate
            ? fillPlaceholders(tool.bodyTemplate, args, false).out
            : JSON.stringify(args)
        }
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
        try {
          const res = await fetch(url.toString(), {
            method: tool.method,
            headers: {
              accept: 'application/json',
              ...(body ? { 'content-type': 'application/json' } : {}),
              ...tool.headers,
            },
            body,
            signal: controller.signal,
          })
          const text = (await res.text()).slice(0, RESULT_CAP)
          result = res.ok
            ? { status: 'ok', summary: text || '(resposta vazia)', httpStatus: res.status }
            : {
                status: 'error',
                summary: `HTTP ${res.status}: ${text.slice(0, 500) || res.statusText}`,
                httpStatus: res.status,
              }
        } finally {
          clearTimeout(timer)
        }
      } catch (err) {
        result = {
          status: 'error',
          summary: `Falha na chamada: ${err instanceof Error ? err.message.slice(0, 300) : 'erro desconhecido'}`,
        }
      }
    }
  }

  // Histórico de ações — best-effort, nunca derruba a resposta.
  try {
    await db.insert(agentToolRuns).values({
      accountId: ctx.accountId,
      toolId: tool.id,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      toolSlug: tool.slug,
      args,
      status: result.status,
      resultSummary: result.summary.slice(0, 2_000),
      httpStatus: result.httpStatus ?? null,
      durationMs: Date.now() - started,
    })
  } catch (err) {
    console.error('[external-tools] log de execução falhou:', err)
  }

  return result
}

/**
 * generateReply com o loop de ferramentas externas: injeta o cardápio no
 * prompt, executa marcadores [[FERRAMENTA:]] e re-gera com o resultado —
 * até MAX_TOOL_STEPS. Agente sem ferramentas = generateReply puro.
 */
export async function generateWithExternalTools(
  args: GenerateArgs & {
    accountId: string
    agentId: string | null
    conversationId: string | null
  },
): Promise<GenerateResult> {
  const tools = await listEnabledTools(args.accountId, args.agentId).catch((err) => {
    console.error('[external-tools] listagem falhou:', err)
    return [] as ExternalTool[]
  })
  if (tools.length === 0) return generateReply(args)

  const systemPrompt = `${args.systemPrompt}\n\n${buildToolsPromptSection(tools)}`
  const messages = [...args.messages]

  for (let step = 0; step <= MAX_TOOL_STEPS; step++) {
    const res = await generateReply({ ...args, systemPrompt, messages })
    const call = parseToolCall(res.text)
    if (!call || step === MAX_TOOL_STEPS) {
      // Segurança: nunca deixa um marcador cru vazar pro cliente.
      if (call) {
        return { ...res, text: res.text.replace(TOOL_MARKER_RE, '').trim() }
      }
      return res
    }
    const tool = tools.find((t) => t.slug === call.slug)
    const outcome: ToolRunResult = tool
      ? await executeTool(tool, call.args, {
          accountId: args.accountId,
          agentId: args.agentId,
          conversationId: args.conversationId,
        })
      : { status: 'invalid', summary: `Ferramenta "${call.slug}" não existe. Use apenas as listadas.` }

    // Alimenta o resultado de volta e re-gera.
    messages.push({ role: 'assistant', content: call.marker })
    messages.push({
      role: 'user',
      content: `[RESULTADO DA FERRAMENTA ${call.slug} — ${outcome.status}]\n${outcome.summary}\n[FIM DO RESULTADO — responda ao cliente agora usando esse dado; não mencione a ferramenta]`,
    })
  }
  // inalcançável (o loop retorna antes), mas o TS quer um retorno.
  return generateReply({ ...args, systemPrompt, messages })
}

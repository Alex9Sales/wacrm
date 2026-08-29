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

import { and, desc, eq, gte } from 'drizzle-orm'

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
  /** Ao rodar com sucesso, também cria o card no funil do Fluxia (fallback). */
  createsDeal: boolean
}

/** Dados de um pedido criado por uma ferramenta `createsDeal`, pra virar card
 *  no funil quando o modelo não emitir [[CRIARCARD]] (fallback). */
export interface OrderForCard {
  title: string
  value: number | null
  note: string | null
}

// Quantas rodadas de ferramenta a IA pode encadear num único turno antes de ser
// FORÇADA a responder o cliente. 4 era baixo pra fluxos de venda com muitas
// tools: a Maria (gás) gasta buscar_cliente→última_compra→estoque→distância→
// criar_cliente e estourava ANTES do criar_pedido+confirmação, terminando muda
// (Rosane, 29/08). 8 dá folga pra fechar sem virar loop infinito.
const MAX_TOOL_STEPS = 8
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
    createsDeal: r.createsDeal === true,
  }))
}

/** Deriva os dados do card (título/valor/nota) dos argumentos de um pedido —
 *  mapeamento tolerante a nomes de campo (nome, valor_unitario, obs_entrega…). */
export function orderForCardFromArgs(
  args: Record<string, unknown>,
): OrderForCard {
  const s = (k: string) => {
    const v = args[k]
    return v == null ? '' : String(v).trim()
  }
  const num = (k: string): number | null => {
    const v = args[k]
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(',', '.'))
    return Number.isFinite(n) ? n : null
  }
  const nome = s('nome') || s('name') || s('cliente') || s('contato')
  const qtd = num('quantidade') ?? num('qtd') ?? 1
  const unit = num('valor_unitario') ?? num('valor') ?? num('preco') ?? num('amount')
  const value = unit != null ? unit * (qtd || 1) : null
  const obs = s('obs_entrega') || s('observacao') || s('obs') || s('descricao')
  const endereco = [s('endereco'), s('bairro')].filter(Boolean).join(', ')
  const pagamento = s('pagamento') || s('forma_pagamento') || s('payment')
  const note =
    [obs || null, endereco || null, pagamento ? `pagamento: ${pagamento}` : null]
      .filter(Boolean)
      .join(' · ') || null
  return { title: (nome ? `${nome} — pedido` : 'Pedido').slice(0, 200), value, note }
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
// 🔁 Dedup de ESCRITA: janela que cobre uma conversa de pedido inteira.
const WRITE_DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000

/** Campos "cosméticos" (observação, referência, nota…) NÃO definem a identidade
 *  de um pedido/ação — o modelo às vezes muda só eles entre uma chamada e outra.
 *  Ignorados na comparação de dedup pra a trava não furar por causa disso. */
const COSMETIC_ARG_KEY = /^(obs|observ|referenc|reference|note|nota|coment|descr)/i

/** Chave estável dos argumentos (chaves ordenadas, strings normalizadas, campos
 *  cosméticos removidos) pra comparar duas chamadas da mesma ferramenta. */
function stableArgsKey(args: Record<string, unknown>): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm)
    if (v && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>)
        .filter((k) => !COSMETIC_ARG_KEY.test(k))
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = norm((v as Record<string, unknown>)[k])
          return acc
        }, {})
    }
    if (typeof v === 'string') return v.trim().toLowerCase()
    return v
  }
  return JSON.stringify(norm(args))
}

/** Esta MESMA ferramenta de escrita já rodou COM SUCESSO nesta conversa, com
 *  argumentos iguais, na janela recente? Evita pedido/card duplicado quando o
 *  modelo re-chama numa mensagem seguinte (ex.: cliente manda o comprovante e a
 *  IA "confirma" de novo). Best-effort: erro na checagem nunca bloqueia. */
async function alreadyRanIdentical(
  toolId: string,
  conversationId: string,
  args: Record<string, unknown>,
): Promise<boolean> {
  const cutoff = new Date(Date.now() - WRITE_DEDUP_WINDOW_MS).toISOString()
  const rows = await db
    .select({ args: agentToolRuns.args })
    .from(agentToolRuns)
    .where(
      and(
        eq(agentToolRuns.toolId, toolId),
        eq(agentToolRuns.conversationId, conversationId),
        eq(agentToolRuns.status, 'ok'),
        gte(agentToolRuns.createdAt, cutoff),
      ),
    )
    .orderBy(desc(agentToolRuns.createdAt))
    .limit(10)
  const key = stableArgsKey(args)
  return rows.some(
    (r) => stableArgsKey((r.args ?? {}) as Record<string, unknown>) === key,
  )
}

export async function executeTool(
  tool: ExternalTool,
  args: Record<string, unknown>,
  ctx: { accountId: string; agentId: string | null; conversationId: string | null },
): Promise<ToolRunResult> {
  const started = Date.now()
  let result: ToolRunResult

  const dupe =
    tool.risk === 'write' && ctx.conversationId
      ? await alreadyRanIdentical(tool.id, ctx.conversationId, args).catch(() => false)
      : false

  if (dupe) {
    result = {
      status: 'ok',
      summary:
        'Este pedido/ação já foi registrado nesta conversa há pouco — não repeti pra não duplicar. Considere que JÁ ESTÁ no sistema e apenas confirme ao cliente, sem criar de novo.',
    }
  } else if (tool.risk === 'critical') {
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
): Promise<GenerateResult & { orderForCard?: OrderForCard | null }> {
  const tools = await listEnabledTools(args.accountId, args.agentId).catch((err) => {
    console.error('[external-tools] listagem falhou:', err)
    return [] as ExternalTool[]
  })
  if (tools.length === 0) return generateReply(args)

  const systemPrompt = `${args.systemPrompt}\n\n${buildToolsPromptSection(tools)}`
  const messages = [...args.messages]
  // Ferramenta `createsDeal` que rodou COM SUCESSO → vira card no funil (fallback
  // no chamador, se o modelo não emitir [[CRIARCARD]]).
  let orderForCard: OrderForCard | null = null

  for (let step = 0; step <= MAX_TOOL_STEPS; step++) {
    const res = await generateReply({ ...args, systemPrompt, messages })
    const call = parseToolCall(res.text)
    if (!call || step === MAX_TOOL_STEPS) {
      // Segurança: nunca deixa um marcador cru vazar pro cliente.
      if (call) {
        return { ...res, text: res.text.replace(TOOL_MARKER_RE, '').trim(), orderForCard }
      }
      return { ...res, orderForCard }
    }
    const tool = tools.find((t) => t.slug === call.slug)
    const outcome: ToolRunResult = tool
      ? await executeTool(tool, call.args, {
          accountId: args.accountId,
          agentId: args.agentId,
          conversationId: args.conversationId,
        })
      : { status: 'invalid', summary: `Ferramenta "${call.slug}" não existe. Use apenas as listadas.` }

    if (tool?.createsDeal && outcome.status === 'ok') {
      orderForCard = orderForCardFromArgs(call.args)
    }

    // Alimenta o resultado de volta e re-gera.
    messages.push({ role: 'assistant', content: call.marker })
    messages.push({
      role: 'user',
      content: `[RESULTADO DA FERRAMENTA ${call.slug} — ${outcome.status}]\n${outcome.summary}\n[FIM DO RESULTADO — responda ao cliente agora usando esse dado; não mencione a ferramenta]`,
    })
  }
  // inalcançável (o loop retorna antes), mas o TS quer um retorno.
  return { ...(await generateReply({ ...args, systemPrompt, messages })), orderForCard }
}

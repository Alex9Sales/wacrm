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

import { crmFallbackForTool } from './crm-fallback'
import { SAME_ORDER_WINDOW_MS } from './order-window'
import { failureKey, retryBlockedSummary, withFailureGuidance } from './tool-failure'
import { idsInText, looksLikeId, repairIdArgs, type IdRepair } from './tool-id-repair'
import { and, desc, eq, gte } from 'drizzle-orm'
import { assertPublicUrl } from '@/lib/net/safe-url'

import { db, agentTools, agentToolRuns } from '@/db'
import { enqueueSlowTool } from '@/lib/queue/queues'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { generateReply, type GenerateArgs } from './generate'
import { neutralizeUntrusted } from './untrusted'
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
  /** args | conversation | off — ver migr 0160. */
  dedupScope: 'args' | 'conversation' | 'off'
  /** Ao rodar com sucesso, também cria o card no funil do Fluxia (fallback). */
  createsDeal: boolean
  /** API lenta: roda fora do turno e responde depois (migr 0193). */
  slow: boolean
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
// (caso de 29/08). 8 dá folga pra fechar sem virar loop infinito.
const MAX_TOOL_STEPS = 8
const FETCH_TIMEOUT_MS = 12_000
const RESULT_CAP = 4_000

/**
 * O que o modelo vê quando a consulta é LENTA e saiu do turno.
 *
 * Tem que ser explícito nos dois sentidos: avise que está consultando E não
 * invente o resultado. Sem a segunda metade o modelo preenche o silêncio com
 * um palpite — e um palpite entregue como se fosse a consulta é pior do que
 * a demora que estamos tentando resolver.
 */
const PENDING_SUMMARY =
  'A consulta foi iniciada e leva cerca de meio minuto. Diga ao cliente, em UMA frase curta e natural, que você está verificando e já volta com a resposta. NÃO invente nem adiante o resultado: ele chega em outra mensagem, automaticamente.'

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
    dedupScope: (r.dedupScope as ExternalTool['dedupScope']) ?? 'args',
    createsDeal: r.createsDeal === true,
    slow: r.slow === true,
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

// Parâmetros opcionais: ferramenta sem parâmetro (consultar_estoque) às vezes
// vem como "[[FERRAMENTA: consultar_estoque]]", sem o "| {}". Sem casar, o
// marcador virava "texto", era limpo e o turno saía MUDO (19/09, Viviane).
const TOOL_MARKER_RE = /\[\[\s*FERRAMENTA\s*:\s*([a-z0-9_-]+)\s*(?:\|\s*(\{[\s\S]*?\})\s*)?\]\]/i

/** Extrai a 1ª chamada de ferramenta do texto gerado (null = não pediu). */
export function parseToolCall(
  raw: string,
): { slug: string; args: Record<string, unknown>; marker: string } | null {
  const m = raw.match(TOOL_MARKER_RE)
  if (!m) return null
  if (!m[2]) return { slug: m[1].toLowerCase(), args: {}, marker: m[0] }
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
  /** `pending` = ferramenta LENTA, saiu do turno e responde depois (slow-tool). */
  status: 'ok' | 'error' | 'blocked' | 'invalid' | 'pending'
  summary: string
  httpStatus?: number
  /** A trava anti-duplicidade segurou a chamada: NADA foi gravado. O modelo vê
   *  'ok' (o registro existe), mas quem cria card/conta escrita olha isto. */
  deduped?: boolean
}

/** Status gravado em agent_tool_runs para a chamada segurada pela trava. Não é
 *  'ok' de propósito: a janela conta a partir do registro REAL (antes, cada
 *  bloqueio virava um 'ok' novo e empurrava a janela), e o painel de pedidos
 *  não soma o que não foi pedido. */
export const DEDUPED_RUN_STATUS = 'deduped'

/** Executa uma ferramenta (com log em agent_tool_runs). Nunca lança. */
// 🔁 Dedup de ESCRITA: janela que cobre uma conversa de pedido inteira — a
// mesma do card no funil (order-window.ts).
const WRITE_DEDUP_WINDOW_MS = SAME_ORDER_WINDOW_MS

/** O resultado desta ferramenta pode virar card no funil? Só quando algo foi
 *  gravado de verdade — a chamada segurada pela trava devolve 'ok' pro modelo,
 *  mas não criou pedido nenhum (caso 11/09: card duplicado 6 s depois). */
export function outcomeCreatesCard(tool: Pick<ExternalTool, 'createsDeal'> | undefined, outcome: ToolRunResult): boolean {
  return !!tool?.createsDeal && outcome.status === 'ok' && !outcome.deduped
}

/** A última fala do cliente no histórico — é a pergunta que a consulta lenta
 *  vai responder quando voltar. */
function latestUserText(messages: { role: string; content: string }[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content.slice(0, 2_000)
  }
  return ''
}

/** Texto que a IA recebe quando a trava segura uma escrita repetida. */
export function dedupedSummary(minutesAgo: number, previousSummary: string | null): string {
  const quando =
    minutesAgo < 1 ? 'agora há pouco' : minutesAgo < 60 ? `há ${minutesAgo} min` : `há ${Math.round(minutesAgo / 60)} h`
  return (
    `JÁ EXISTE um registro desta ação nesta conversa, feito ${quando}` +
    (previousSummary ? ` (${previousSummary.slice(0, 160)})` : '') +
    '. NADA novo foi gravado agora. NÃO crie outro e NÃO repita a confirmação: o cliente já foi avisado nesta conversa. ' +
    // ⚠️ 11/09 (Família do Gás): aqui estava escrito "agradeça e confirme o que já
    // está registrado" — e a IA mandou a confirmação INTEIRA de novo
    // (produto, valor e endereço), 15 s depois da primeira. Mandar duas
    // vezes faz o cliente achar que saíram dois pedidos.
    'Responda só o que o cliente perguntou AGORA. Se ele não perguntou nada novo (só disse "isso"/"ok" ou mandou o comprovante), ' +
    'mande no máximo um "ok" curto — sem repetir produto, valor nem endereço. ' +
    // ⚠️ 15/09 (Márcio Teste): o pedido de troco pra nota de 200 chegou depois
    // do pedido, a IA tentou recriar, foi segurada aqui e respondeu "troco
    // anotado" — o troco nunca chegou ao entregador.
    'Se o cliente ACRESCENTOU ou MUDOU algo (forma de pagamento, troco, endereço, quantidade), isso NÃO está registrado: ' +
    'use a ferramenta de EDITAR o registro com o id acima, se existir uma; se não existir, emita [[NOTA:o que mudou]] para o time corrigir. ' +
    'Nunca diga "anotado" ou "avisei" sem ter registrado.'
  )
}

/** Campos "cosméticos" (observação, referência, nota…) NÃO definem a identidade
 *  de um pedido/ação — o modelo às vezes muda só eles entre uma chamada e outra.
 *  Ignorados na comparação de dedup pra a trava não furar por causa disso. */
const COSMETIC_ARG_KEY = /^(obs|observ|referenc|reference|note|nota|coment|descr)/i

/** Chave estável dos argumentos (chaves ordenadas, strings normalizadas, campos
 *  cosméticos removidos) pra comparar duas chamadas da mesma ferramenta. */
export function stableArgsKey(args: Record<string, unknown>): string {
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

/**
 * A última rodada BEM-SUCEDIDA desta ferramenta nesta conversa, na janela.
 * `args` não-nulo = só conta se os argumentos forem equivalentes (escopo
 * 'args'); `null` = qualquer rodada conta (escopo 'conversation').
 *
 * Devolve a rodada em vez de um booleano porque o modelo precisa saber QUANDO
 * foi e O QUE resultou — sem isso ele não consegue confirmar direito ao cliente.
 */
/** Janela de resultados de ferramenta que serve de fonte dos códigos válidos. */
const ID_SOURCE_WINDOW_MS = 6 * 60 * 60_000

/**
 * Corrige os códigos dos argumentos usando o que as ferramentas responderam
 * nesta conversa. Best-effort: qualquer falha devolve os argumentos como
 * vieram — conserto é melhoria, nunca pode derrubar a chamada.
 */
async function repairIdsFromConversation(
  args: Record<string, unknown>,
  conversationId: string,
): Promise<{ args: Record<string, unknown>; repairs: IdRepair[] } | null> {
  if (!Object.values(args).some(looksLikeId)) return null
  try {
    const cutoff = new Date(Date.now() - ID_SOURCE_WINDOW_MS).toISOString()
    const rows = await db
      .select({ resultSummary: agentToolRuns.resultSummary })
      .from(agentToolRuns)
      .where(
        and(
          eq(agentToolRuns.conversationId, conversationId),
          eq(agentToolRuns.status, 'ok'),
          gte(agentToolRuns.createdAt, cutoff),
        ),
      )
      .orderBy(desc(agentToolRuns.createdAt))
      .limit(20)
    const known = new Set<string>()
    for (const r of rows) for (const id of idsInText(r.resultSummary)) known.add(id)
    return repairIdArgs(args, known)
  } catch (err) {
    console.error('[external-tools] conferência de códigos falhou:', err)
    return null
  }
}

async function previousSuccessfulRun(
  toolId: string,
  conversationId: string,
  args: Record<string, unknown> | null,
): Promise<{ createdAt: string; resultSummary: string | null } | null> {
  const cutoff = new Date(Date.now() - WRITE_DEDUP_WINDOW_MS).toISOString()
  const rows = await db
    .select({ args: agentToolRuns.args, createdAt: agentToolRuns.createdAt, resultSummary: agentToolRuns.resultSummary })
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

  if (args === null) return rows[0] ?? null
  const key = stableArgsKey(args)
  return rows.find((r) => stableArgsKey((r.args ?? {}) as Record<string, unknown>) === key) ?? null
}

export async function executeTool(
  tool: ExternalTool,
  args: Record<string, unknown>,
  ctx: {
    accountId: string
    agentId: string | null
    conversationId: string | null
    /** Só para ferramenta LENTA: quem recebe a resposta que vem depois. */
    contactId?: string | null
    /** Só para ferramenta LENTA: a pergunta que originou a consulta. */
    question?: string
  },
  opts?: {
    /** false = não grava em agent_tool_runs (sync em massa do ERP, 01/09:
     *  milhares de chamadas/dia poluiriam o Histórico de ações). */
    log?: boolean
  },
): Promise<ToolRunResult> {
  const started = Date.now()
  let result: ToolRunResult

  // 🔁 Trava anti-duplicidade. O ESCOPO é configuração da ferramenta:
  //   conversation → uma vez por conversa, doa o que doer nos argumentos
  //   args         → só bloqueia chamada idêntica (padrão histórico)
  //   off          → sem trava (ferramenta feita pra repetir, ex.: mover etapa)
  const scope = tool.dedupScope ?? 'args'
  const previous =
    tool.risk === 'write' && ctx.conversationId && scope !== 'off'
      ? await previousSuccessfulRun(tool.id, ctx.conversationId, scope === 'args' ? args : null).catch(() => null)
      : null

  if (previous) {
    // ⚠️ 04/09 (Família do Gás): o cliente trocou de cartão pra Pix e depois mandou
    // o comprovante — a IA criou o pedido nas TRÊS vezes. Aqui ela é avisada do
    // que já existe e do que fazer quando algo muda, em vez de recriar.
    // Idade RELATIVA em vez de hora no relógio: o fuso aqui era fixo em
    // São Paulo e mentia uma hora pra conta de Campo Grande (11/09 —
    // "feito às 14:36" quando era 13:36 lá). Minuto relativo nunca erra.
    const minutos = Math.max(0, Math.round((Date.now() - new Date(previous.createdAt).getTime()) / 60_000))
    result = {
      status: 'ok',
      deduped: true,
      summary: dedupedSummary(minutos, previous.resultSummary),
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
      // 🔧 O modelo copia códigos de uma ferramenta pra outra e às vezes erra
      // um dígito — e o sistema do cliente responde "não encontrado" com a
      // venda já fechada. Confere contra o que as ferramentas DESTA conversa
      // responderam antes de mandar (24/09, Família do Gás).
      const fix = ctx.conversationId ? await repairIdsFromConversation(args, ctx.conversationId) : null
      if (fix?.repairs.length) {
        args = fix.args
        for (const r of fix.repairs) {
          console.warn(
            `[external-tools] ${tool.slug}: ${r.param} veio errado do modelo (${r.from}) — corrigido para ${r.to}`,
          )
        }
      }
      if (tool.slow) {
        // 🐢 API LENTA: sai do turno. O cliente está esperando no WhatsApp e a
        // chamada não cabe nos 12s daqui; a fila faz a chamada com prazo
        // próprio e a resposta volta como mensagem nova (lib/ai/slow-tool.ts).
        result = !ctx.conversationId
          ? {
              status: 'error',
              summary:
                'Esta consulta demora e só funciona dentro de uma conversa. Diga ao cliente que você não conseguiu consultar agora.',
            }
          : (await enqueueSlowTool({
                accountId: ctx.accountId,
                agentId: ctx.agentId,
                conversationId: ctx.conversationId,
                contactId: ctx.contactId ?? null,
                toolId: tool.id,
                args,
                question: ctx.question ?? '',
                askedAt: new Date().toISOString(),
              }))
            ? { status: 'pending', summary: PENDING_SUMMARY }
            : {
                status: 'error',
                summary:
                  'Não consegui iniciar a consulta agora. Diga ao cliente que houve uma falha e que você vai verificar.',
              }
      } else {
      try {
        const { out: baseUrl, used } = fillPlaceholders(tool.url, args, true)
        // 🛡️ Anti-SSRF: só destino público (auditoria 02/09).
        const url = await assertPublicUrl(new URL(baseUrl))
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
  }

  // Histórico de ações — best-effort, nunca derruba a resposta.
  if (opts?.log === false) return result
  try {
    await db.insert(agentToolRuns).values({
      accountId: ctx.accountId,
      toolId: tool.id,
      agentId: ctx.agentId,
      conversationId: ctx.conversationId,
      toolSlug: tool.slug,
      args,
      status: result.deduped ? DEDUPED_RUN_STATUS : result.status,
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
 * O que o CLIENTE veria desta resposta: sem nenhum marcador [[…]] (card,
 * etiqueta, funil, nota…) — o auto-reply tira todos antes de enviar.
 */
export function visibleReplyText(text: string | null | undefined): string {
  return (text ?? '').replace(/\[\[[\s\S]*?\]\]/g, '').trim()
}

/** Marcadores que tornam o silêncio INTENCIONAL: não responder ou transferir. */
const INTENTIONAL_SILENCE_RE = /\[\[\s*(?:ignorar|handoff|transferir|agente)\b/i

/**
 * A resposta final saiu sem nada pro cliente — vale uma nova tentativa?
 *   • depois de uma ESCRITA bem-sucedida (pedido criado): sempre — o cliente
 *     confirmou a compra e não pode ficar no vácuo;
 *   • depois de só CONSULTAS: quando o silêncio não foi escolhido (sem
 *     [[IGNORAR]]/transferência). 19/09 (Viviane): consultou o cadastro e a
 *     última compra e não escreveu nada.
 */
export function needsReplyRetry(input: { text: string | null | undefined; writeSucceeded: boolean; toolsRan: number }): boolean {
  if (visibleReplyText(input.text)) return false
  if (input.writeSucceeded) return true
  return input.toolsRan > 0 && !INTENTIONAL_SILENCE_RE.test(input.text ?? '')
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
    /** Contato da conversa — é dele que sai a FONTE ALTERNATIVA (histórico do CRM) quando o ERP falha. */
    contactId?: string | null
    timezone?: string
  },
): Promise<GenerateResult & {
  orderForCard?: OrderForCard | null
  /** Uma ferramenta de escrita GRAVOU algo neste turno (a trava não conta). */
  wroteSomething?: boolean
}> {
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
  // Uma ESCRITA rodou com sucesso neste turno (pedido criado, cadastro salvo…).
  let writeSucceeded = false
  // Quantas ferramentas rodaram neste turno (consulta ou escrita).
  let toolsRan = 0
  // Chamadas que JÁ falharam nesta resposta (ferramenta + args): a segunda
  // tentativa não vai à rede — 06/09 a IA chamou buscar_cliente 4× seguidas
  // com o ERP fora do ar, 12s cada, e a resposta levou 40s.
  const failedCalls = new Set<string>()

  for (let step = 0; step <= MAX_TOOL_STEPS; step++) {
    const res = await generateReply({ ...args, systemPrompt, messages })
    const call = parseToolCall(res.text)
    if (!call || step === MAX_TOOL_STEPS) {
      // Segurança: nunca deixa um marcador cru vazar pro cliente.
      let text = (res.text ?? '').replace(TOOL_MARKER_RE, '').trim()

      // ⚠️ Casos de 04/09 e 05/09: criar_pedido rodou OK e a geração
      // final voltou VAZIA — o cliente disse "à vista" e não ouviu nada. Depois
      // de uma escrita bem-sucedida, silêncio não é resposta aceitável: pede
      // uma confirmação curta; se ainda vier vazia, manda uma mínima. O que
      // NÃO pode acontecer é o cliente confirmar a compra e ficar no vácuo.
      //
      // 18/09 (Família do Gás, 11 turnos mudos em 2 dias, todos logo depois do
      // criar_pedido): a resposta final vinha SÓ com marcadores ([[CRIARCARD]],
      // etiqueta…) — aqui não é vazia, mas fica vazia pro cliente quando o
      // auto-reply tira os marcadores, e o turno caía no "não gerou resposta"
      // (sem mensagem e sem o card do pedido). Conta o texto VISÍVEL; os
      // marcadores da resposta original ficam, pras ações ainda rodarem.
      if (needsReplyRetry({ text, writeSucceeded, toolsRan })) {
        let confirmation = ''
        try {
          const retry = await generateReply({
            ...args,
            systemPrompt,
            messages: [
              ...messages,
              {
                role: 'user',
                content: writeSucceeded
                  ? 'A ação foi registrada com sucesso. Confirme isso ao cliente em UMA frase curta e natural, sem marcadores e sem mencionar ferramenta.'
                  : 'Você já consultou o que precisava. Agora responda ao cliente em UMA mensagem curta e natural, seguindo as suas instruções, sem marcadores e sem mencionar ferramenta.',
              },
            ],
          })
          confirmation = visibleReplyText((retry.text ?? '').replace(TOOL_MARKER_RE, ''))
        } catch (err) {
          console.error('[external-tools] nova tentativa de resposta falhou:', err instanceof Error ? err.message : err)
        }
        // Depois de uma escrita, nunca fica mudo; depois de consulta, sem
        // texto nenhum, o turno segue pro aviso de "não gerou resposta".
        const fallback = writeSucceeded ? 'Pronto, já registrei aqui! ✅' : ''
        text = [text, confirmation || fallback].filter(Boolean).join('\n')
      }

      return { ...res, text, orderForCard, wroteSomething: writeSucceeded }
    }
    const tool = tools.find((t) => t.slug === call.slug)
    const callKey = failureKey(call.slug, stableArgsKey(call.args))
    const outcome: ToolRunResult = !tool
      ? { status: 'invalid', summary: `Ferramenta "${call.slug}" não existe. Use apenas as listadas.` }
      : failedCalls.has(callKey)
        ? { status: 'error', summary: retryBlockedSummary(call.slug) }
        : await executeTool(tool, call.args, {
            accountId: args.accountId,
            agentId: args.agentId,
            conversationId: args.conversationId,
            // Só a ferramenta LENTA usa: quem recebe a resposta que vem depois
            // e qual pergunta ela responde.
            contactId: args.contactId ?? null,
            question: latestUserText(args.messages),
          })
    const firstFailure = tool && outcome.status === 'error' && !failedCalls.has(callKey)
    if (firstFailure) failedCalls.add(callKey)
    // 1ª falha: o modelo recebe as regras (não transferir, não repetir) E o que
    // o CRM sabe do cliente — o histórico importado vale como cadastro.
    let shownSummary = outcome.summary
    if (firstFailure && tool) {
      const fallback = await crmFallbackForTool({
        accountId: args.accountId,
        contactId: args.contactId ?? null,
        conversationId: args.conversationId,
        timezone: args.timezone ?? 'America/Sao_Paulo',
        slug: tool.slug,
        risk: tool.risk,
        failure: outcome.summary,
      }).catch(() => '')
      shownSummary = withFailureGuidance(tool.slug, outcome.summary) + (fallback ? `\n\n${fallback}` : '')
    }

    if (tool) toolsRan++
    if (outcomeCreatesCard(tool, outcome)) {
      orderForCard = orderForCardFromArgs(call.args)
    }
    if (tool && tool.risk !== 'read' && outcome.status === 'ok' && !outcome.deduped) {
      writeSucceeded = true
    }

    // Alimenta o resultado de volta e re-gera.
    messages.push({ role: 'assistant', content: call.marker })
    messages.push({
      role: 'user',
      content: `[RESULTADO DA FERRAMENTA ${call.slug} — ${outcome.status}]\n${neutralizeUntrusted(shownSummary, { maxChars: 6000 })}\n[FIM DO RESULTADO — responda ao cliente agora usando esse dado; não mencione a ferramenta]`,
    })

    // 🐢 Consulta lenta na fila: este turno acabou. O que falta é avisar o
    // cliente que estamos verificando — qualquer outra ferramenta agora só
    // atrasaria esse aviso, e o resultado real chega em outra mensagem.
    if (outcome.status === 'pending') {
      const espera = await generateReply({ ...args, systemPrompt, messages })
      const text = (espera.text ?? '').replace(TOOL_MARKER_RE, '').trim()
      return {
        ...espera,
        // Silêncio aqui deixaria o cliente sem nada enquanto a consulta roda.
        text: visibleReplyText(text) ? text : 'Só um instante, estou verificando isso e já te respondo.',
        orderForCard,
        wroteSomething: writeSucceeded,
      }
    }
  }
  // inalcançável (o loop retorna antes), mas o TS quer um retorno.
  return { ...(await generateReply({ ...args, systemPrompt, messages })), orderForCard, wroteSomething: writeSucceeded }
}

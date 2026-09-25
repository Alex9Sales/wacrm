// ============================================================
// 🐢 Ferramenta externa LENTA — a consulta que não cabe no turno.
//
// A chamada normal vive DENTRO do turno: o cliente mandou uma mensagem e
// está olhando o WhatsApp esperando a resposta, então ela aborta em 12s
// (external-tools.ts). Uma API que leva 25s nunca fecha ali. Subir o teto
// não resolve — trocaria o erro por dois minutos de silêncio, que é pior:
// o cliente não sabe se foi ignorado.
//
// Aqui a consulta sai do turno. O turno responde "deixa eu verificar", esta
// função faz a chamada com prazo próprio e a resposta chega como mensagem
// NOVA, escrita pelo mesmo agente, com o resultado em mãos.
//
// Caso que originou (25/09): o tutor de uma plataforma de cursos responde em
// ~25s e a documentação pede timeout de 120s.
//
// Sem 'server-only' — roda no worker.
// ============================================================

import { and, eq, gt } from 'drizzle-orm'

import { db, agentTools, agentToolRuns, contacts, messages } from '@/db'
import { firstOrNull } from '@/db/helpers'
import { engineSendText } from '@/lib/flows/meta-send'
import { assertPublicUrl } from '@/lib/net/safe-url'
import type { SlowToolJob } from '@/lib/queue/queues'
import { getAccountSettings } from '@/lib/settings/account-settings'
import { decrypt } from '@/lib/whatsapp/encryption'

import { loadAiConfigById } from './config'
import { buildConversationContext } from './context'
import { generateReply } from './generate'
import { neutralizeUntrusted } from './untrusted'

/** Prazo da chamada lenta. Generoso de propósito, mas finito: consulta que
 *  passa disso não vale mais nada para quem perguntou. */
const SLOW_FETCH_TIMEOUT_MS = 120_000
const RESULT_CAP = 8_000

export interface SlowToolOutcome {
  sent: boolean
  why: string
}

/** Preenche {placeholders} da URL/body com os argumentos. */
function fill(template: string, args: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, key: string) => {
    const v = args[key]
    return v === undefined || v === null ? whole : String(v)
  })
}

/**
 * Executa a consulta lenta e devolve a resposta na conversa.
 *
 * Nunca lança: o cliente já recebeu "deixa eu verificar", então toda falha
 * daqui tem que virar uma mensagem honesta, não silêncio.
 */
export async function runSlowTool(job: SlowToolJob): Promise<SlowToolOutcome> {
  const tool = firstOrNull(
    await db
      .select()
      .from(agentTools)
      .where(and(eq(agentTools.id, job.toolId), eq(agentTools.accountId, job.accountId)))
      .limit(1),
  )
  if (!tool) return { sent: false, why: 'ferramenta não existe mais' }

  const started = Date.now()
  const { ok, payload, httpStatus } = await callSlowTool(tool, job.args)

  // Histórico de ações — best-effort, nunca impede a resposta de sair.
  void db
    .insert(agentToolRuns)
    .values({
      accountId: job.accountId,
      toolId: tool.id,
      agentId: job.agentId,
      conversationId: job.conversationId,
      toolSlug: tool.slug,
      args: job.args,
      status: ok ? 'ok' : 'error',
      resultSummary: payload.slice(0, 2_000),
      httpStatus,
      durationMs: Date.now() - started,
    })
    .catch((err) => console.error('[slow-tool] histórico falhou:', err))

  return deliver(job, tool.name, ok, payload)
}

/** A linha da ferramenta, como vem do banco. */
type ToolRow = typeof agentTools.$inferSelect

export interface SlowCallResult {
  ok: boolean
  payload: string
  httpStatus?: number
}

/**
 * A chamada HTTP em si, com o prazo longo. Exportada porque o botão
 * "Testar agora" da tela precisa dela: sem isso, a única ferramenta que o
 * admin não conseguiria testar seria justamente a lenta.
 *
 * Nunca lança — a falha vira `payload` legível.
 */
export async function callSlowTool(
  tool: ToolRow,
  args: Record<string, unknown>,
): Promise<SlowCallResult> {
  let ok = false
  let payload = ''
  let httpStatus: number | undefined

  try {
    const url = await assertPublicUrl(new URL(fill(tool.url, args)))
    const isGet = tool.method === 'GET' || tool.method === 'DELETE'
    if (isGet) {
      for (const [k, v] of Object.entries(args)) {
        if (v !== undefined && v !== '' && !tool.url.includes(`{${k}}`)) {
          url.searchParams.set(k, String(v))
        }
      }
    }
    const body = isGet
      ? undefined
      : tool.bodyTemplate
        ? fill(tool.bodyTemplate, args)
        : JSON.stringify(args)

    let headers: Record<string, string> = {}
    if (tool.headersEnc) {
      try {
        const parsed = JSON.parse(decrypt(tool.headersEnc))
        if (parsed && typeof parsed === 'object') headers = parsed as Record<string, string>
      } catch {
        headers = {}
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), SLOW_FETCH_TIMEOUT_MS)
    try {
      const res = await fetch(url.toString(), {
        method: tool.method,
        headers: {
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body,
        signal: controller.signal,
      })
      httpStatus = res.status
      const text = (await res.text()).slice(0, RESULT_CAP)
      ok = res.ok
      payload = ok ? text || '(resposta vazia)' : `HTTP ${res.status}: ${text.slice(0, 600) || res.statusText}`
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    payload = `Falha na consulta: ${err instanceof Error ? err.message.slice(0, 300) : 'erro desconhecido'}`
  }

  return { ok, payload, httpStatus }
}

/** Escreve a resposta com o resultado em mãos e manda na conversa. */
async function deliver(
  job: SlowToolJob,
  toolName: string,
  ok: boolean,
  payload: string,
): Promise<SlowToolOutcome> {
  // 🤫 Um humano assumiu enquanto a consulta rodava? Então a resposta
  // automática não sai por cima dele. A consulta leva até 2 minutos: é tempo
  // de sobra para alguém da equipe abrir a conversa e responder — e nada
  // constrange mais um atendente do que a IA falando depois que ele já falou.
  if (await humanRepliedSince(job.conversationId, job.askedAt)) {
    return { sent: false, why: 'um atendente assumiu a conversa durante a consulta' }
  }

  const config = job.agentId ? await loadAiConfigById(job.accountId, job.agentId) : null
  if (!config) return { sent: false, why: 'agente não está mais ativo' }

  const settings = await getAccountSettings(job.accountId).catch(() => null)
  const tz = settings?.businessTimezone || 'America/Sao_Paulo'
  const history = await buildConversationContext(job.conversationId, undefined, tz)

  // ⚠️ O que a API devolveu é DADO, não instrução: passa pelo mesmo
  // neutralizador do resto do produto antes de entrar no prompt.
  const resultado = neutralizeUntrusted(payload)

  const instrucao = ok
    ? [
        `A consulta em "${toolName}" terminou. Resultado:`,
        '',
        resultado,
        '',
        job.question ? `A pergunta do cliente era: "${job.question}"` : '',
        '',
        'Responda AGORA ao cliente com base nesse resultado, seguindo as suas instruções.',
        'Você já disse a ele que ia verificar, então vá direto ao ponto: nada de "deixa eu verificar" de novo e nada de cumprimentar outra vez.',
        'Use somente o que está no resultado. Se ele não responde o que foi perguntado, diga isso com honestidade.',
      ]
        .filter(Boolean)
        .join('\n')
    : [
        `A consulta em "${toolName}" NÃO funcionou. Motivo técnico: ${resultado}`,
        '',
        'Diga ao cliente, em UMA frase curta e sem termo técnico, que não conseguiu fazer essa verificação agora e o que ele pode fazer em seguida.',
        'Não repita o erro técnico e não invente o que a consulta teria respondido.',
      ].join('\n')

  let text = ''
  try {
    const res = await generateReply({
      config,
      systemPrompt: config.systemPrompt ?? '',
      messages: [...history, { role: 'user', content: instrucao }],
      // Conta como atendimento no medidor: é resposta ao cliente na conversa,
      // só que escrita depois que a consulta voltou.
      meta: {
        accountId: job.accountId,
        agentId: job.agentId,
        conversationId: job.conversationId,
        source: 'inbox',
      },
    })
    text = (res.text ?? '').trim()
  } catch (err) {
    console.error('[slow-tool] geração falhou:', err instanceof Error ? err.message : err)
  }

  // Sem texto não se manda nada: uma mensagem vazia é pior que a demora.
  if (!text) return { sent: false, why: 'a IA não gerou resposta' }

  const userId = await senderUserId(job.accountId, job.contactId)
  if (!userId) return { sent: false, why: 'sem usuário para assinar o envio' }

  try {
    await engineSendText({
      accountId: job.accountId,
      userId,
      conversationId: job.conversationId,
      contactId: job.contactId ?? '',
      text,
    })
    return { sent: true, why: 'enviada' }
  } catch (err) {
    console.error('[slow-tool] envio falhou:', err instanceof Error ? err.message : err)
    return { sent: false, why: 'falha ao enviar' }
  }
}

/**
 * Uma PESSOA respondeu depois que a consulta começou?
 *
 * `agent` é mensagem de gente (inclusive a que sai do celular do operador);
 * o que a IA manda é `bot`, então a própria frase de espera não conta.
 */
async function humanRepliedSince(conversationId: string, sinceIso: string): Promise<boolean> {
  if (!sinceIso) return false
  try {
    const row = firstOrNull(
      await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, conversationId),
            eq(messages.senderType, 'agent'),
            gt(messages.createdAt, sinceIso),
          ),
        )
        .limit(1),
    )
    return !!row
  } catch (err) {
    // Na dúvida, responde: perder a resposta que o cliente está esperando é
    // pior do que uma sobreposição eventual.
    console.error('[slow-tool] checagem de atendente falhou:', err instanceof Error ? err.message : err)
    return false
  }
}

/** Quem assina o envio: o dono do contato. */
async function senderUserId(accountId: string, contactId: string | null): Promise<string | null> {
  if (!contactId) return null
  const row = firstOrNull(
    await db
      .select({ userId: contacts.userId })
      .from(contacts)
      .where(and(eq(contacts.id, contactId), eq(contacts.accountId, accountId)))
      .limit(1),
  )
  return row?.userId ?? null
}

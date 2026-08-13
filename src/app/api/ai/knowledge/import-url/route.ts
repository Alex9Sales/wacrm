import { NextResponse } from 'next/server'

import { db, aiKnowledgeDocuments } from '@/db'
import { firstOrThrow } from '@/db/helpers'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadEmbeddingsKey } from '@/lib/ai/config'
import { ingestDocument } from '@/lib/ai/knowledge'
import {
  ensureDefaultBaseId,
  baseBelongsToAccount,
} from '@/lib/ai/knowledge-bases'
import { AiError } from '@/lib/ai/types'

// Parsing de HTML é Node-only; fora do edge.
export const runtime = 'nodejs'

const FETCH_TIMEOUT_MS = 12_000
const MAX_HTML_BYTES = 8 * 1024 * 1024
const MAX_CONTENT_CHARS = 200_000

/**
 * POST /api/ai/knowledge/import-url  (admin+)
 *
 * Fase K2 — busca uma página, extrai o texto legível e cria um documento
 * (source_type='url') na base indicada. Guarda anti-SSRF básica (só http/https,
 * bloqueia hosts internos) — a rota é admin-only.
 */
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = await checkRateLimit(`ai-kb-url:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const rawUrl = typeof body?.url === 'string' ? body.url.trim() : ''
    if (!rawUrl) {
      return NextResponse.json({ error: 'Informe a URL.' }, { status: 400 })
    }

    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return NextResponse.json({ error: 'URL inválida.' }, { status: 400 })
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return NextResponse.json({ error: 'Use uma URL http(s).' }, { status: 400 })
    }
    if (isBlockedHost(url.hostname)) {
      return NextResponse.json(
        { error: 'Esse endereço não é permitido.' },
        { status: 400 },
      )
    }

    // Busca com timeout + cap de tamanho.
    let html: string
    try {
      const controller = new AbortController()
      const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
      const res = await fetch(url.toString(), {
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; FluxiaCRM-KB/1.0; +https://crm.salestecnologia.com.br)',
          Accept: 'text/html,application/xhtml+xml',
        },
      }).finally(() => clearTimeout(t))
      if (!res.ok) {
        return NextResponse.json(
          { error: `A página respondeu ${res.status}.` },
          { status: 400 },
        )
      }
      const len = Number(res.headers.get('content-length') ?? 0)
      if (len && len > MAX_HTML_BYTES) {
        return NextResponse.json({ error: 'Página muito grande.' }, { status: 400 })
      }
      html = await res.text()
    } catch {
      return NextResponse.json(
        { error: 'Não consegui acessar a página.' },
        { status: 400 },
      )
    }

    const { title: pageTitle, text } = htmlToText(html)
    const content = text.slice(0, MAX_CONTENT_CHARS)
    if (content.length < 20) {
      return NextResponse.json(
        { error: 'Não achei texto legível nessa página.' },
        { status: 400 },
      )
    }
    const title = (pageTitle || url.hostname).slice(0, 200)

    const baseIdRaw = typeof body?.baseId === 'string' ? body.baseId : null
    const baseId =
      baseIdRaw && (await baseBelongsToAccount(accountId, baseIdRaw))
        ? baseIdRaw
        : await ensureDefaultBaseId(accountId, userId)

    const doc = firstOrThrow(
      await db
        .insert(aiKnowledgeDocuments)
        .values({
          accountId,
          knowledgeBaseId: baseId,
          createdBy: userId,
          title,
          content,
          sourceType: 'url',
          sourceUrl: url.toString(),
        })
        .returning({ id: aiKnowledgeDocuments.id }),
    )

    const { key: embeddingsApiKey, corrupt } = await loadEmbeddingsKey(accountId)
    try {
      await ingestDocument(accountId, { embeddingsApiKey }, doc.id, content, baseId)
    } catch (err) {
      const message = err instanceof AiError ? err.message : 'indexing failed'
      console.error('[ai/knowledge/import-url] ingest error:', err)
      return NextResponse.json({
        success: true,
        id: doc.id,
        title,
        warning: `Importado, mas a indexação semântica falhou (${message}). A busca por palavra-chave já funciona; use Reindexar para tentar de novo.`,
      })
    }
    if (corrupt) {
      return NextResponse.json({
        success: true,
        id: doc.id,
        title,
        warning:
          'Importado com busca por palavra-chave apenas — a chave de embeddings não pôde ser descriptografada.',
      })
    }
    return NextResponse.json({ success: true, id: doc.id, title })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/** Bloqueia hosts internos óbvios (SSRF v1 — a rota é admin-only). */
function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase()
  if (
    h === 'localhost' ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    h === 'metadata.google.internal'
  )
    return true
  // IPv6 loopback / IPv4-mapped
  if (h === '::1' || h === '[::1]') return true
  // IPv4 literais privados / loopback / link-local
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a === 127 || a === 10 || a === 0) return true
    if (a === 169 && b === 254) return true
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
  }
  return false
}

/** HTML → texto legível (remove script/style/tags, decodifica entidades). */
function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).trim() : ''
  let s = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|br|li|h[1-6]|tr|section|article|header|footer)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  s = decodeEntities(s)
  s = s
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text: s }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      try {
        return String.fromCodePoint(Number(n))
      } catch {
        return ' '
      }
    })
}

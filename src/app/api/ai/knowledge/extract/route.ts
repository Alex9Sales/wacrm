import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

// Parsers (unpdf/mammoth) are Node-only; keep this route off the edge.
export const runtime = 'nodejs'

/** Reject files bigger than this before parsing. */
const MAX_FILE_BYTES = 15 * 1024 * 1024 // 15 MB
/** Cap the extracted text so a huge doc can't blow the chunker / DB. */
const MAX_CONTENT_CHARS = 300_000

const TEXT_EXTENSIONS = [
  '.txt',
  '.md',
  '.markdown',
  '.csv',
  '.tsv',
  '.json',
  '.html',
  '.htm',
  '.log',
  '.vtt',
  '.srt',
  '.text',
]

/**
 * POST /api/ai/knowledge/extract  (admin+)
 *
 * Multipart upload of a single document; returns its extracted plain text
 * (+ a title guessed from the filename) so the client can review it and
 * save it through the normal knowledge-base create flow. Supports PDF
 * (unpdf), DOCX (mammoth), and plain-text formats. Parsing stays here on
 * the server so the parser libs never reach the client bundle.
 */
export async function POST(request: Request) {
  try {
    const { userId } = await requireRole('admin')
    const limit = await checkRateLimit(
      `ai-kb-extract:${userId}`,
      RATE_LIMITS.adminAction,
    )
    if (!limit.success) return rateLimitResponse(limit)

    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return NextResponse.json(
        { error: 'Envie o arquivo como multipart/form-data.' },
        { status: 400 },
      )
    }

    const file = form.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: 'Nenhum arquivo enviado.' },
        { status: 400 },
      )
    }
    if (file.size === 0) {
      return NextResponse.json({ error: 'Arquivo vazio.' }, { status: 400 })
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json(
        { error: 'Arquivo muito grande (máx. 15 MB).' },
        { status: 413 },
      )
    }

    const name = file.name || 'documento'
    const lower = name.toLowerCase()
    const mime = file.type || ''
    const bytes = Buffer.from(await file.arrayBuffer())

    let content = ''
    try {
      if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
        const { extractText, getDocumentProxy } = await import('unpdf')
        const pdf = await getDocumentProxy(new Uint8Array(bytes))
        const { text } = await extractText(pdf, { mergePages: true })
        content = Array.isArray(text) ? text.join('\n\n') : text
      } else if (
        mime ===
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
        lower.endsWith('.docx')
      ) {
        const mammoth = (await import('mammoth')).default
        const { value } = await mammoth.extractRawText({ buffer: bytes })
        content = value
      } else if (
        mime.startsWith('text/') ||
        TEXT_EXTENSIONS.some((ext) => lower.endsWith(ext))
      ) {
        content = new TextDecoder('utf-8').decode(bytes)
      } else {
        return NextResponse.json(
          {
            error:
              'Formato não suportado. Use PDF, Word (.docx) ou texto (.txt, .md, .csv).',
          },
          { status: 415 },
        )
      }
    } catch (err) {
      console.error('[ai/knowledge extract] parse error:', err)
      return NextResponse.json(
        { error: 'Não consegui extrair o texto desse arquivo.' },
        { status: 422 },
      )
    }

    content = content.replace(/\r\n/g, '\n').trim()
    if (!content) {
      return NextResponse.json(
        {
          error:
            'Nenhum texto encontrado (o arquivo pode ser uma imagem/escaneado).',
        },
        { status: 422 },
      )
    }

    let truncated = false
    if (content.length > MAX_CONTENT_CHARS) {
      content = content.slice(0, MAX_CONTENT_CHARS)
      truncated = true
    }

    // Title from the filename, minus its extension.
    const title = name.replace(/\.[^./\\]+$/, '').trim() || 'Documento'

    return NextResponse.json({ title, content, chars: content.length, truncated })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// ============================================================
// Leitura de DOCUMENTO (PDF/DOCX/texto) que o cliente envia no WhatsApp. Extrai
// o texto (unpdf/mammoth) e devolve um RESUMO curto em PT-BR (via OpenAI chat) —
// ele vira a "transcrição" do documento: a IA usa pra responder e o atendente vê
// no card o que ela entendeu. Best-effort: quem chama trata a falha (null).
// Espelha vision.ts (imagem). Node-only (parsers).
// ============================================================

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'

/** Modelo de resumo. Override com AI_DOC_MODEL. */
function docModel(): string {
  return process.env.AI_DOC_MODEL || 'gpt-4o-mini'
}

/** Corta o texto extraído antes de resumir (bound de custo/limite). */
const MAX_EXTRACT_CHARS = 12_000

const SYSTEM_PROMPT =
  'Você resume, em português do Brasil, documentos que clientes enviam pelo WhatsApp de uma empresa. ' +
  'Diga em 2–4 frases o que é o documento e o que importa pro atendimento (tipo de documento, dados-chave, ' +
  'valores, datas, números, nomes). TRANSCREVA exatamente valores, datas e números relevantes. Nunca invente o que não estiver no texto.'

/** Extrai o texto de um PDF/DOCX/texto. Devolve '' se não suportado/vazio. */
async function extractDocText(
  bytes: Uint8Array,
  mimetype?: string,
  filename?: string,
): Promise<string> {
  const lower = (filename || '').toLowerCase()
  const mime = mimetype || ''
  try {
    if (mime === 'application/pdf' || lower.endsWith('.pdf')) {
      const { extractText, getDocumentProxy } = await import('unpdf')
      const pdf = await getDocumentProxy(bytes)
      const { text } = await extractText(pdf, { mergePages: true })
      return (Array.isArray(text) ? text.join('\n\n') : text) || ''
    }
    if (
      mime ===
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      lower.endsWith('.docx')
    ) {
      const mammoth = (await import('mammoth')).default
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
      return value || ''
    }
    if (mime.startsWith('text/') || /\.(txt|md|csv|json|log|text)$/.test(lower)) {
      return new TextDecoder('utf-8').decode(bytes)
    }
  } catch (err) {
    console.error('[document] extract falhou:', err)
  }
  return ''
}

/**
 * Lê um documento a partir da URL pública + resume. Lança em erro (rede/HTTP/
 * modelo). Devolve null quando não há texto legível (ex.: PDF escaneado/imagem).
 */
export async function describeDocument(input: {
  apiKey: string
  url: string
  mimetype?: string
  filename?: string
}): Promise<string | null> {
  const res = await fetch(input.url)
  if (!res.ok) throw new Error(`document fetch falhou: ${res.status}`)
  const bytes = new Uint8Array(await res.arrayBuffer())

  const raw = (await extractDocText(bytes, input.mimetype, input.filename)).trim()
  if (!raw) return null // sem texto (escaneado/imagem) — quem chama põe placeholder

  const text = raw.replace(/\r\n/g, '\n').slice(0, MAX_EXTRACT_CHARS)
  const label = input.filename ? `Arquivo: ${input.filename}\n\n` : ''

  const r = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${input.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: docModel(),
      max_tokens: 400,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `${label}${text}` },
      ],
    }),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`document resumo falhou: ${r.status} ${body.slice(0, 200)}`)
  }
  const data = (await r.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const out = data.choices?.[0]?.message?.content?.trim()
  return out ? out.slice(0, 2000) : null
}

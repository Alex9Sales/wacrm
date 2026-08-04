// ============================================================
// Descrição de imagem (visão). Usa a API OpenAI (chat completions) passando a
// imagem por URL e devolve uma descrição curta em PT-BR — ela vira a
// "transcrição" da imagem: a IA usa pra entender o que o cliente mandou e o
// atendente vê no card. Best-effort: quem chama trata a falha (null).
// ============================================================

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions'

/** Modelo de visão. Override com AI_VISION_MODEL. Um modelo barato com visão
 *  cobre o caso (foto de botijão, print, documento/comprovante fotografado). */
function visionModel(): string {
  return process.env.AI_VISION_MODEL || 'gpt-4o-mini'
}

const SYSTEM_PROMPT =
  'Você descreve, em português do Brasil, imagens que clientes enviam pelo WhatsApp de uma empresa. ' +
  'Seja objetivo (2–3 frases) sobre o que aparece. Se houver TEXTO, documento, número, etiqueta, placa, ' +
  'comprovante, endereço ou valor, TRANSCREVA exatamente o que dá pra ler. Nunca invente o que não estiver visível.'

/**
 * Descreve uma imagem a partir da sua URL pública. Lança em erro (rede/HTTP/
 * modelo sem visão). O texto devolvido é curto e serve de transcrição.
 */
export async function describeImage(
  apiKey: string,
  imageUrl: string,
  opts: { model?: string } = {},
): Promise<string> {
  const res = await fetch(OPENAI_CHAT_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model ?? visionModel(),
      max_tokens: 400,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Descreva esta imagem enviada pelo cliente.' },
            { type: 'image_url', image_url: { url: imageUrl } },
          ],
        },
      ],
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`vision falhou: ${res.status} ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[]
  }
  const text = data.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error('vision: resposta vazia')
  return text.slice(0, 2000)
}

// ============================================================
// Text-to-speech (voz da IA). Usa a API OpenAI /v1/audio/speech e devolve os
// bytes em OGG/Opus — o formato de nota de voz do WhatsApp. Best-effort: quem
// chama trata a falha (cai pra texto).
// ============================================================

/** Gera voz a partir de texto. Lança em erro (rede/HTTP). */
export async function synthesizeSpeech(
  apiKey: string,
  text: string,
  opts: { voice?: string; model?: string } = {},
): Promise<Buffer> {
  const input = text.trim().slice(0, 4000)
  if (!input) throw new Error('TTS: texto vazio')

  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model ?? 'tts-1',
      voice: opts.voice ?? 'nova',
      input,
      response_format: 'opus',
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`TTS falhou: ${res.status} ${body.slice(0, 200)}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

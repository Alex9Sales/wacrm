// ============================================================
// Text-to-speech (voz da IA). Devolve bytes em OGG/Opus — o formato de nota de
// voz do WhatsApp. Dois provedores:
//   ElevenLabs (voz brasileira de verdade, ex.: Karen) — quando o agente tem
//     voice_id E a conta tem a chave em voice_settings (Agentes de voz);
//   OpenAI /v1/audio/speech (voz 'nova', padrão/fallback).
// Best-effort: quem chama trata a falha (cai pra texto). Se o ElevenLabs falhar,
// cai pro OpenAI aqui dentro (o áudio ainda sai, só com a voz padrão).
// ============================================================

export interface TtsConfig {
  /** Chave OpenAI (a de chat quando provider=openai). Fallback/padrão. */
  openaiKey: string | null
  /** Chave ElevenLabs da conta (voice_settings). */
  elevenKey?: string | null
  /** voice_id do ElevenLabs (do agente). Com chave + voice_id → ElevenLabs. */
  voiceId?: string | null
}

/** Gera voz a partir de texto. Lança se nenhum provedor conseguir. */
export async function synthesizeSpeech(cfg: TtsConfig, text: string): Promise<Buffer> {
  const input = text.trim().slice(0, 4000)
  if (!input) throw new Error('TTS: texto vazio')

  if (cfg.elevenKey && cfg.voiceId) {
    try {
      return await synthesizeElevenLabs(cfg.elevenKey, cfg.voiceId, input)
    } catch (err) {
      console.error('[tts] ElevenLabs falhou, caindo pro OpenAI:', err)
      // continua pro OpenAI abaixo
    }
  }
  if (!cfg.openaiKey) throw new Error('TTS: sem chave disponível')
  return synthesizeOpenAi(cfg.openaiKey, input)
}

/** ElevenLabs — multilingual v2 (bom em PT-BR), saída OGG/Opus pro WhatsApp. */
async function synthesizeElevenLabs(
  apiKey: string,
  voiceId: string,
  input: string,
): Promise<Buffer> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      voiceId,
    )}?output_format=opus_48000_64`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: input, model_id: 'eleven_multilingual_v2' }),
    },
  )
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`ElevenLabs TTS falhou: ${res.status} ${body.slice(0, 200)}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

/** OpenAI /v1/audio/speech — voz 'nova', OGG/Opus. */
async function synthesizeOpenAi(apiKey: string, input: string): Promise<Buffer> {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      voice: 'nova',
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

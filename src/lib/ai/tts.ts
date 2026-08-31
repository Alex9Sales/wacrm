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

// ---- Normalização pt-BR pré-TTS (caso Karen, 31/08) ------------------------
// TTS lê número CRU enrolado (e escorrega pro inglês): "R$ 130" e chaves Pix
// saíam incompreensíveis. Antes de sintetizar: moeda vira extenso ("cento e
// trinta reais") e sequências longas de dígitos (CNPJ/telefone/chave) são
// soletradas ("três, zero, três..."). Determinístico, sem tocar no TEXTO da
// mensagem — só no que vai pro áudio.

const UNITS = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove']
const TEENS = ['dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove']
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa']
const HUNDREDS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos']

function upTo999(n: number): string {
  if (n === 0) return ''
  if (n === 100) return 'cem'
  const c = Math.floor(n / 100)
  const rest = n % 100
  const parts: string[] = []
  if (c > 0) parts.push(HUNDREDS[c])
  if (rest >= 10 && rest < 20) parts.push(TEENS[rest - 10])
  else {
    const t = Math.floor(rest / 10)
    const u = rest % 10
    if (t > 0) parts.push(TENS[t])
    if (u > 0) parts.push(UNITS[u])
  }
  return parts.join(' e ')
}

/** 0–999999 por extenso (suficiente pra valores de venda no zap). */
function numToWordsPt(n: number): string {
  if (n === 0) return 'zero'
  if (n > 999_999) return String(n)
  const thousands = Math.floor(n / 1000)
  const rest = n % 1000
  const parts: string[] = []
  if (thousands === 1) parts.push('mil')
  else if (thousands > 1) parts.push(`${upTo999(thousands)} mil`)
  if (rest > 0) {
    const joiner = thousands > 0 && (rest < 100 || rest % 100 === 0) ? ' e ' : ' '
    return (parts.join(' ') + joiner + upTo999(rest)).trim()
  }
  return parts.join(' ')
}

const DIGIT_NAMES = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove']

export function normalizePtBrForTts(text: string): string {
  let out = text
  // 1) Moeda: "R$ 1.350,50" → "mil trezentos e cinquenta reais e cinquenta
  //    centavos" (o pior caso do enrolado).
  out = out.replace(
    /R\$\s?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{2}))?/g,
    (_m, intPart: string, cents?: string) => {
      const n = Number(intPart.replace(/\./g, ''))
      if (!Number.isFinite(n) || n > 999_999) return _m
      let s = `${numToWordsPt(n)} ${n === 1 ? 'real' : 'reais'}`
      const c = cents ? Number(cents) : 0
      if (c > 0) s += ` e ${numToWordsPt(c)} ${c === 1 ? 'centavo' : 'centavos'}`
      return s
    },
  )
  // 2) Sequências longas de dígitos (CNPJ, chave Pix, telefone, código): 7+
  //    dígitos → soletra um a um, com pausas. Pontuação interna vira pausa.
  out = out.replace(/\d[\d.\-\/ ]{5,}\d/g, (m) => {
    const digits = m.replace(/\D/g, '')
    if (digits.length < 7) return m
    return digits
      .split('')
      .map((d) => DIGIT_NAMES[Number(d)])
      .join(', ')
  })
  return out
}

/** Gera voz a partir de texto. Lança se nenhum provedor conseguir. */
export async function synthesizeSpeech(cfg: TtsConfig, text: string): Promise<Buffer> {
  const input = normalizePtBrForTts(text.trim()).slice(0, 4000)
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
      body: JSON.stringify({
        text: input,
        // turbo v2.5 aceita language_code — FORÇA pt-BR do início ao fim.
        // O multilingual_v2 "adivinhava" o idioma por trecho e escorregava
        // pro inglês em números/finais de frase (caso Karen, 31/08).
        model_id: 'eleven_turbo_v2_5',
        language_code: 'pt',
        // Menos variação = dicção mais firme (números saíam "enrolados").
        voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      }),
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

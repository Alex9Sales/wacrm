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

// ---- Normalização pt-BR pré-TTS (caso Karen 31/08; números 15/09) ---------
// A voz lê número CRU enrolado (e escorrega pro inglês). Antes de sintetizar,
// o texto passa por regras determinísticas, na ORDEM abaixo — cada uma troca o
// trecho por um marcador, pra regra seguinte não reprocessar o que já virou
// palavra (era assim que "15/09/2026" acabava soletrado dígito a dígito).
//
//   identificador (CPF, CNPJ, chave Pix, telefone, CEP) → soletrado, porque
//   quem ouve vai ANOTAR; número comum (endereço, quantidade) → por extenso,
//   que é como se fala ("Bonfim, dois mil duzentos e oitenta").
//
// Só muda o que vai pro ÁUDIO: o texto da conversa e a transcrição continuam
// com o original (auto-reply.ts manda `clean` pros dois). Nunca mover daqui.

const UNITS = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove']
const TEENS = ['dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove']
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa']
const HUNDREDS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos']
const MONTHS = ['', 'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

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

/** 0–999999 por extenso (suficiente pra valor, endereço e quantidade no zap). */
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

/** Soletra os dígitos; a vírgula é a única pausa que a voz respeita sempre. */
function spellDigits(raw: string): string {
  return raw
    .replace(/\D/g, '')
    .split('')
    .map((d) => DIGIT_NAMES[Number(d)])
    .join(', ')
}

/** Hora falada: 12h = meio-dia, 0h = meia-noite, 17h30 = "dezessete e trinta". */
function hourToWords(h: number, m: number): string {
  if (m === 0) {
    if (h === 12) return 'meio-dia'
    if (h === 0 || h === 24) return 'meia-noite'
    return `${numToWordsPt(h)} ${h === 1 ? 'hora' : 'horas'}`
  }
  const base = h === 12 ? 'meio-dia' : h === 0 || h === 24 ? 'meia-noite' : numToWordsPt(h)
  return m === 30 ? `${base} e meia` : `${base} e ${numToWordsPt(m)}`
}

/** Guarda os trechos já convertidos pra nenhuma regra seguinte mexer neles. */
function keeper() {
  const kept: string[] = []
  return {
    hold(words: string): string {
      kept.push(words)
      return `\u0000${kept.length - 1}\u0000`
    },
    release(text: string): string {
      return text.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => kept[Number(i)] ?? '')
    },
  }
}

/** Emoji e marcação do WhatsApp não se leem em voz alta. */
function stripDecoration(text: string): string {
  return text
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
}

export function normalizePtBrForTts(text: string): string {
  try {
    const k = keeper()
    let out = stripDecoration(text)

    // 1) Moeda: "R$ 1.350,50" → "mil trezentos e cinquenta reais e cinquenta centavos".
    out = out.replace(/R\$\s?(\d{1,3}(?:\.\d{3})*|\d+)(?:,(\d{1,2}))?/g, (m, intPart: string, cents?: string) => {
      const n = Number(intPart.replace(/\./g, ''))
      if (!Number.isFinite(n) || n > 999_999) return m
      let s = `${numToWordsPt(n)} ${n === 1 ? 'real' : 'reais'}`
      const c = cents ? Number(cents.padEnd(2, '0')) : 0
      if (c > 0) s += ` e ${numToWordsPt(c)} ${c === 1 ? 'centavo' : 'centavos'}`
      return k.hold(s)
    })

    // 2) Documentos com pontuação (CPF, CNPJ): soletrados, porque quem ouve anota.
    out = out.replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, (m) => k.hold(spellDigits(m)))

    // 3) Telefone, com o DDD junto (antes o "(67)" escapava e só o resto era soletrado).
    out = out.replace(/\(?\b(\d{2})\)?[\s.-]?(9?\d{4})[\s.-]?(\d{4})\b/g, (m, ddd: string, meio: string, fim: string) =>
      k.hold(`${spellDigits(ddd)}, ${spellDigits(meio)}, ${spellDigits(fim)}`),
    )

    // 4) CEP: dois blocos, com pausa no meio.
    out = out.replace(/\b(\d{5})-?(\d{3})\b/g, (m, a: string, b: string) => k.hold(`${spellDigits(a)}, ${spellDigits(b)}`))

    // 5) Data: "15/09/2026" → "quinze de setembro de dois mil e vinte e seis".
    out = out.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (m, d: string, mo: string, y?: string) => {
      const dia = Number(d)
      const mes = Number(mo)
      if (dia < 1 || dia > 31 || mes < 1 || mes > 12) return m
      let s = `${numToWordsPt(dia)} de ${MONTHS[mes]}`
      if (y) {
        const ano = Number(y.length === 2 ? `20${y}` : y)
        if (Number.isFinite(ano)) s += ` de ${numToWordsPt(ano)}`
      }
      return k.hold(s)
    })

    // 6) Hora: "17h", "17h30", "17:30", "às 9 horas".
    out = out.replace(/\b(\d{1,2})\s?(?:horas?|hrs|hs|h)\s?(\d{2})?\b/gi, (m, h: string, min?: string) => {
      const hh = Number(h)
      const mm = min ? Number(min) : 0
      if (hh > 24 || mm > 59) return m
      return k.hold(hourToWords(hh, mm))
    })
    out = out.replace(/\b(\d{1,2}):(\d{2})\b/g, (m, h: string, min: string) => {
      const hh = Number(h)
      const mm = Number(min)
      if (hh > 24 || mm > 59) return m
      return k.hold(hourToWords(hh, mm))
    })

    // 7) O que sobrou com 7+ dígitos é identificador (chave Pix, código): soletra.
    out = out.replace(/\d[\d.\-/ ]{5,}\d/g, (m) => {
      const digits = m.replace(/\D/g, '')
      if (digits.length < 7) return m
      return k.hold(spellDigits(digits))
    })

    // 8) Botijão: "P-13" e "P45" saíam soletrados em inglês.
    out = out.replace(/\bP[-\s]?(13|20|45)\b/gi, (_m, n: string) => k.hold(`pê ${numToWordsPt(Number(n))}`))

    // 9) Peso e porcentagem: "13kg" → "treze quilos", "10%" → "dez por cento".
    out = out.replace(/\b(\d{1,3})\s?kg\b/gi, (_m, n: string) => k.hold(`${numToWordsPt(Number(n))} quilos`))
    out = out.replace(/\b(\d{1,3})\s?%/g, (_m, n: string) => k.hold(`${numToWordsPt(Number(n))} por cento`))

    // 9b) Distância: "km" a voz lê letra por letra.
    out = out.replace(/\bkm\b/gi, () => k.hold('quilômetros'))

    // 10) Ordinal e "nº".
    out = out.replace(/\bn[ºo°]\.?\s?(\d{1,5})\b/gi, (_m, n: string) => k.hold(`número ${numToWordsPt(Number(n))}`))
    out = out.replace(/\b(\d{1,2})[ºª]/g, (_m, n: string) => {
      const ord = ['', 'primeiro', 'segundo', 'terceiro', 'quarto', 'quinto', 'sexto', 'sétimo', 'oitavo', 'nono', 'décimo']
      const n2 = Number(n)
      return k.hold(ord[n2] ?? `${numToWordsPt(n2)}`)
    })

    // 11) Decimal com vírgula: "5,5 km" → "cinco vírgula cinco".
    out = out.replace(/\b(\d{1,3}),(\d{1,2})\b/g, (_m, a: string, b: string) =>
      k.hold(`${numToWordsPt(Number(a))} vírgula ${spellDigits(b)}`),
    )

    // 12) Número comum que sobrou (endereço, quantidade): por extenso. Fica de
    //     fora o que está colado em letra, hífen ou barra (ex.: "gpt-5", "1/2").
    out = out.replace(/(^|[^\w\u0000\-/.,])(\d{1,6})(?![\w\u0000\-/])/g, (_m, pre: string, n: string) =>
      `${pre}${k.hold(numToWordsPt(Number(n)))}`,
    )

    return k.release(out).replace(/\s{2,}/g, ' ').trim()
  } catch (err) {
    // Voz é melhor que silêncio: falhou aqui, sintetiza o texto como veio.
    console.error('[tts] normalização falhou, usando o texto cru:', err)
    return text
  }
}

/** Gera voz a partir de texto. Lança se nenhum provedor conseguir. */
export async function synthesizeSpeech(cfg: TtsConfig, text: string): Promise<Buffer> {
  const spoken = normalizePtBrForTts(text.trim())
  // Por extenso o texto CRESCE (um CNPJ vira ~14 palavras): avisa quando cortar.
  if (spoken.length > 4000) console.warn(`[tts] texto de ${spoken.length} caracteres cortado em 4000`)
  const input = spoken.slice(0, 4000)
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

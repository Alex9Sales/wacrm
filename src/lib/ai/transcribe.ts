// ============================================================
// Inbound audio transcription (speech-to-text).
//
// Reuses the account's own OpenAI key (from ai_configs — the same BYO key
// that powers drafts/auto-reply) to call OpenAI's Whisper endpoint. Fully
// best-effort: any missing key / unsupported format / API error returns
// null so a hiccup never drops the audio message. Gated by the account
// setting `audioTranscriptionEnabled` at the call site.
// ============================================================

import { loadAiConfig } from './config'
import type { AiConfig } from './types'
import type { NormalizedInbound } from '@/lib/channels/provider'

const OPENAI_TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'
// OpenAI caps the audio file at 25 MB.
const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024

type InboundMedia = NonNullable<NormalizedInbound['media']>

/** Whisper needs an OpenAI key. Use the chat key when the provider is
 *  OpenAI, otherwise fall back to the (usually OpenAI) embeddings key. */
function openAiKeyFor(cfg: AiConfig): string | null {
  if (cfg.provider === 'openai' && cfg.apiKey) return cfg.apiKey
  if (cfg.embeddingsApiKey) return cfg.embeddingsApiKey
  return null
}

// Whisper infers the format from the filename extension, so map the mime
// to an extension it accepts. AMR (some WhatsApp forwards) isn't supported
// and will just 400 → null.
const EXT_BY_MIME: Record<string, string> = {
  'audio/ogg': '.ogg',
  'audio/opus': '.ogg',
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/mp4': '.m4a',
  'audio/m4a': '.m4a',
  'audio/x-m4a': '.m4a',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/webm': '.webm',
}

async function mediaBytes(
  media: InboundMedia,
): Promise<{ bytes: Buffer; mimetype: string; filename: string } | null> {
  let bytes: Buffer | null = null
  if (media.base64) {
    const b64 = media.base64.includes(',')
      ? media.base64.slice(media.base64.indexOf(',') + 1)
      : media.base64
    bytes = Buffer.from(b64, 'base64')
  } else if (media.url) {
    const res = await fetch(media.url)
    if (!res.ok) return null
    bytes = Buffer.from(await res.arrayBuffer())
  }
  if (!bytes || bytes.length === 0) return null
  const mimetype = media.mimetype || 'audio/ogg'
  const ext = EXT_BY_MIME[mimetype.toLowerCase()] ?? '.ogg'
  return { bytes, mimetype, filename: `audio${ext}` }
}

/**
 * Transcribe an audio file at a URL (e.g. an agent voice note recorded in the
 * CRM, whose media lives in our own storage). Thin wrapper over the inbound
 * path — same download + Whisper call. Never throws.
 */
export async function transcribeAudioFromUrl(
  accountId: string,
  url: string,
  mimetype?: string,
): Promise<string | null> {
  return transcribeInboundAudio(accountId, { kind: 'audio', url, mimetype })
}

/**
 * Transcribe an inbound audio note to text, or null when it can't (no key,
 * unsupported format, too large, API error). Never throws.
 */
export async function transcribeInboundAudio(
  accountId: string,
  media: InboundMedia,
): Promise<string | null> {
  try {
    const cfg = await loadAiConfig(accountId, { requireActive: false })
    if (!cfg) return null
    const apiKey = openAiKeyFor(cfg)
    if (!apiKey) return null

    const data = await mediaBytes(media)
    if (!data || data.bytes.length > MAX_TRANSCRIBE_BYTES) return null

    const form = new FormData()
    form.append(
      'file',
      new Blob([data.bytes as unknown as BlobPart], { type: data.mimetype }),
      data.filename,
    )
    form.append('model', 'whisper-1')
    form.append('language', 'pt')

    const res = await fetch(OPENAI_TRANSCRIBE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    })
    if (!res.ok) {
      console.error(
        `[transcribe] OpenAI ${res.status}: ${(await res.text()).slice(0, 300)}`,
      )
      return null
    }
    const json = (await res.json()) as { text?: string }
    const text = json.text?.trim()
    return text ? text : null
  } catch (err) {
    console.error('[transcribe] failed:', err)
    return null
  }
}

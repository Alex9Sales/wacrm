// ============================================================
// COEXISTÊNCIA (Meta): mensagem que o NEGÓCIO enviou pelo app do celular chega
// como "eco" (`smb_message_echoes`). Aqui só o texto que vai pra conversa —
// puro, sem banco.
// ============================================================

export interface MetaEchoMessage {
  from?: string
  to?: string
  id?: string
  timestamp?: string
  type?: string
  text?: { body?: string }
  [key: string]: unknown
}

const LABELS: Record<string, string> = {
  image: '📷 Imagem',
  video: '🎬 Vídeo',
  audio: '🎤 Áudio',
  voice: '🎤 Áudio',
  document: '📄 Documento',
  sticker: 'Figurinha',
  location: '📍 Localização',
  contacts: '👤 Contato',
}

/**
 * Texto do eco pra conversa — `null` quando o eco NÃO é uma mensagem: apagar
 * pra todos ('revoke') e reação chegam como eco e viravam um balão com o texto
 * cru "[revoke]" na tela da equipe (20/09, Zelo: o Renato apagou uma mensagem
 * pelo celular e o balão apareceu no meio do atendimento).
 */
export function echoDisplayText(echo: MetaEchoMessage): string | null {
  const t = echo.type ?? 'text'
  if (t === 'revoke' || t === 'reaction') return null
  if (t === 'text') return echo.text?.body ?? ''
  const media = echo[t] as { caption?: string; filename?: string } | undefined
  // Tipo desconhecido: nome legível, nunca o "[tipo]" cru.
  const base = LABELS[t] ?? '📎 Mensagem'
  const extra = media?.caption || media?.filename
  return extra ? `${base} — ${extra}` : base
}

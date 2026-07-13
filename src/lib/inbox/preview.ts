// ============================================================
// Conversation-list last-message preview labels.
//
// The server persists `conversations.last_message_text` as the raw caption
// when there is one, or a `[kind]` placeholder (e.g. `[image]`, `[audio]`)
// when a media message has no caption (see lib/channels/inbound.ts and
// lib/whatsapp/send-message.ts). Those bare placeholders read badly in the
// list. This maps them to WhatsApp-style labels with an icon; anything else
// (real text, captions) passes through untouched.
// ============================================================

import { parseCallLog, parseCallPermission } from '@/lib/inbox/call-log';

const MEDIA_PREVIEW_LABELS: Record<string, string> = {
  text: 'Mensagem',
  image: '📷 Foto',
  audio: '🎤 Áudio',
  voice: '🎤 Mensagem de voz',
  ptt: '🎤 Mensagem de voz',
  video: '🎥 Vídeo',
  document: '📄 Documento',
  sticker: '🎟️ Figurinha',
  location: '📍 Localização',
  contact: '👤 Contato',
  template: '📋 Modelo',
  interactive: '📋 Mensagem interativa',
};

/**
 * Turn a persisted `last_message_text` into what the conversation list should
 * show. Bare `[kind]` placeholders become friendly labels; real text and
 * captions are returned as-is. Empty → the "no messages" fallback.
 */
export function formatConversationPreview(text?: string | null): string {
  const trimmed = text?.trim();
  if (!trimmed) return 'Nenhuma mensagem ainda';
  // Call markers → friendly labels (never show the raw sentinel).
  const call = parseCallLog(text);
  if (call) return call.answered ? '📞 Ligação de voz' : '📞 Ligação perdida';
  const perm = parseCallPermission(text);
  if (perm) return perm.granted ? '📞 Autorizou você a ligar' : '📵 Não autorizou ligação';
  const match = /^\[([a-zA-Z]+)\]$/.exec(trimmed);
  if (match) {
    const key = match[1].toLowerCase();
    return MEDIA_PREVIEW_LABELS[key] ?? trimmed;
  }
  return trimmed;
}

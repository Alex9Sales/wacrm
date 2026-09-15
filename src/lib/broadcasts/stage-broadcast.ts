// ============================================================
// Disparo pela ETAPA do funil — tipos de canal, canal padrão, validação e a
// nota do histórico. PURO (client-safe): tela e servidor usam as mesmas regras.
//
// 15/09 (GoLink): o disparo da etapa só listava WhatsApp não oficial e só
// mandava texto. Agora segue os tipos dos Disparos — o TIPO vem do canal:
// WhatsApp (WAHA/Evolution/EvoGo: texto + anexos), E-mail (email/Gmail:
// assunto + anexos, só pra quem tem e-mail) e API oficial (Meta: template
// aprovado). O padrão continua sendo o número de quem dispara
// (channel-choice.ts) e número de outra pessoa só com confirmação.
// ============================================================

import { defaultBroadcastChannelId, type BroadcastChannelOwner } from '@/lib/broadcasts/channel-choice'

export type StageBroadcastKind = 'text' | 'email' | 'template'

/** Providers que o disparo da etapa lista (o resto não dispara). */
export const STAGE_BROADCAST_PROVIDERS = ['waha', 'evolution', 'evogo', 'email', 'gmail', 'meta'] as const

export const STAGE_KIND_LABEL: Record<StageBroadcastKind, string> = {
  text: 'WhatsApp',
  email: 'E-mail',
  template: 'API oficial',
}

/** Tipo do disparo pelo provider do canal; null = canal que não dispara. */
export function stageChannelKind(provider: string | null | undefined): StageBroadcastKind | null {
  switch (provider) {
    case 'waha':
    case 'evolution':
    case 'evogo':
      return 'text'
    case 'email':
    case 'gmail':
      return 'email'
    case 'meta':
      return 'template'
    default:
      return null
  }
}

export interface StageChannelOption extends BroadcastChannelOwner {
  kind: StageBroadcastKind
}

const KIND_ORDER: StageBroadcastKind[] = ['text', 'template', 'email']

/**
 * Canal que já vem marcado: WhatsApp primeiro (era o único tipo antes), depois
 * API oficial, depois e-mail — sempre um canal conectado que seja de quem
 * dispara ou de ninguém. Sem nenhum assim, a regra de Disparos sobre a lista
 * nessa ordem (meu → sem dono → o primeiro, com aviso na tela).
 */
export function defaultStageChannelId(
  channels: readonly StageChannelOption[],
  userId: string | null | undefined,
): string {
  const usable = (c: StageChannelOption) => c.status == null || c.status === 'connected'
  const mine = (c: StageChannelOption) => !!userId && c.dedicated_user_id === userId
  const free = (c: StageChannelOption) => !c.dedicated_user_id
  for (const kind of KIND_ORDER) {
    const sub = channels.filter((c) => c.kind === kind && usable(c))
    const pick = sub.find(mine) ?? sub.find(free)
    if (pick) return pick.id
  }
  // channel-choice separa e-mail do resto; aqui a ordem por tipo já resolve.
  const ordered = KIND_ORDER.flatMap((k) => channels.filter((c) => c.kind === k)).map((c) => ({
    ...c,
    is_email: false,
  }))
  return defaultBroadcastChannelId(ordered, userId)
}

/** Mesmo teste do motor de disparo (enqueueTextBroadcast). */
export function hasSendableEmail(email: string | null | undefined): boolean {
  return /^\S+@\S+\.\S+$/.test((email ?? '').trim())
}

export const STAGE_MAX_ATTACHMENTS = 10

export interface StageBroadcastBasics {
  channelId?: string | null
  kind?: string | null
  text?: string | null
  subject?: string | null
  media?: readonly unknown[] | null
  templateName?: string | null
}

/** Erro em PT do que falta (antes de olhar leads/template); null = pode seguir. */
export function validateStageBroadcastBasics(
  input: StageBroadcastBasics,
  channelKind: StageBroadcastKind | null,
): string | null {
  if (!input.channelId) return 'Escolha o canal.'
  if (!channelKind) return 'Este canal não faz disparo. Escolha um canal de WhatsApp, e-mail ou da API oficial.'
  if (input.kind !== channelKind) {
    return `Este canal é de ${STAGE_KIND_LABEL[channelKind]}. Abra o disparo de novo e escolha o canal.`
  }
  const hasText = !!(input.text ?? '').trim()
  const mediaCount = input.media?.length ?? 0
  if (channelKind === 'template') {
    return (input.templateName ?? '').trim() ? null : 'Escolha o template aprovado.'
  }
  if (mediaCount > STAGE_MAX_ATTACHMENTS) return `Máximo de ${STAGE_MAX_ATTACHMENTS} anexos por disparo.`
  if (channelKind === 'email' && !(input.subject ?? '').trim()) return 'Informe o assunto do e-mail.'
  if (!hasText && mediaCount === 0) return 'Escreva a mensagem ou anexe um arquivo.'
  return null
}

/** Nota no histórico de cada negócio que recebeu. */
export function stageBroadcastNote(
  kind: StageBroadcastKind,
  info: { text?: string | null; subject?: string | null; mediaCount?: number; templateName?: string | null },
): string {
  if (kind === 'template') return `📣 Disparo enviado (etapa, Template ${(info.templateName ?? '').trim()})`
  const clip = (s: string) => (s.length > 80 ? `${s.slice(0, 80)}…` : s)
  if (kind === 'email') return `📣 Disparo enviado (etapa, E-mail): ${clip((info.subject ?? '').trim())}`
  const text = (info.text ?? '').trim()
  const n = info.mediaCount ?? 0
  const files = n > 0 ? `${n} anexo${n === 1 ? '' : 's'}` : ''
  const preview = text ? (files ? `${clip(text)} (+ ${files})` : clip(text)) : files
  return `📣 Disparo enviado (etapa, WhatsApp): ${preview}`
}

// ============================================================
// Qual número o disparo usa — escolha padrão e aviso. PURO (client-safe).
//
// 15/09 (GoLink): o formulário marcava sozinho o 1º canal em ordem
// alfabética ("Atendimento", o número do Leonardo). O Vitor não trocou e o
// "dia do cliente" saiu pelo número de outra pessoa: as conversas nasceram
// lá e ele não conseguia ver nenhuma. Agora o padrão é o número de quem está
// criando; sem número próprio, o 1º canal que não é de ninguém. Número de
// outra pessoa só com aviso e confirmação.
// ============================================================

export interface BroadcastChannelOwner {
  id: string
  /** Pessoa dona do número (channels.dedicated_user_id). null = da empresa. */
  dedicated_user_id?: string | null
  dedicated_user_name?: string | null
  /** 'connected' quando disponível; sem status = não sabemos (conta como usável). */
  status?: string | null
  is_email?: boolean
}

/**
 * Canal que já vem marcado. Usável = conectado e do tipo certo (e-mail só no
 * disparo de e-mail — revisão 15/09: a pessoa pode ter um Gmail e um número
 * desconectado dedicados a ela). Ordem: meu usável → sem dono usável → meu →
 * sem dono → o primeiro.
 */
export function defaultBroadcastChannelId(
  channels: readonly BroadcastChannelOwner[],
  userId: string | null | undefined,
  opts: { email?: boolean } = {},
): string {
  const usable = (c: BroadcastChannelOwner) =>
    (c.status == null || c.status === 'connected') && !!c.is_email === !!opts.email
  const mine = (c: BroadcastChannelOwner) => !!userId && c.dedicated_user_id === userId
  const free = (c: BroadcastChannelOwner) => !c.dedicated_user_id
  const pick =
    channels.find((c) => usable(c) && mine(c)) ??
    channels.find((c) => usable(c) && free(c)) ??
    channels.find((c) => mine(c) && !!c.is_email === !!opts.email) ??
    channels.find((c) => free(c) && !!c.is_email === !!opts.email) ??
    channels[0]
  return pick?.id ?? ''
}

/** Nome de quem é dono do número, quando NÃO é quem está criando. null = pode usar sem aviso. */
export function otherPersonOwner(
  channel: BroadcastChannelOwner | null | undefined,
  userId: string | null | undefined,
): string | null {
  if (!channel?.dedicated_user_id || channel.dedicated_user_id === userId) return null
  return channel.dedicated_user_name?.trim() || 'outra pessoa'
}

/** Complemento do nome do canal na lista: "seu número" / "número de Leonardo". */
export function channelOwnerLabel(
  channel: BroadcastChannelOwner,
  userId: string | null | undefined,
): string | null {
  if (!channel.dedicated_user_id) return null
  if (channel.dedicated_user_id === userId) return 'seu número'
  return `número de ${channel.dedicated_user_name?.trim() || 'outra pessoa'}`
}

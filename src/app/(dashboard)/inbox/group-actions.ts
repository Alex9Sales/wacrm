'use server'

// ============================================================
// Importar os MEMBROS de um grupo de WhatsApp como contatos (com etiqueta
// "Grupo: <nome>"), pra depois disparar 1:1 pra essa etiqueta em Disparos.
// Pedido do Rafael. Só WAHA (a engine expõe os participantes). Telefone de quem
// tem privacidade / nunca postou pode não vir — esses são pulados.
// ============================================================

import { and, eq, sql } from 'drizzle-orm'
import { revalidatePath } from 'next/cache'

import {
  db,
  conversations,
  contacts,
  tags,
  contactTags,
  monitoredGroups,
} from '@/db'
import { firstOrNull } from '@/db/helpers'
import { requireRole } from '@/lib/auth/account'
import { loadChannelByAccount } from '@/lib/channels/channels'
import { findOrCreateContact } from '@/lib/api/v1/contacts'
import { wahaGroupParticipants } from '@/lib/channels/providers/waha'
import { groupJidDigits } from '@/lib/whatsapp/group'

export interface ImportGroupResult {
  ok: boolean
  /** Participantes com telefone lidos da engine. */
  total: number
  /** Contatos novos criados. */
  contactsCreated: number
  /** Contatos que ganharam a etiqueta do grupo. */
  tagged: number
  tagName: string
  error?: string
}

export async function importGroupMembers(
  conversationId: string,
): Promise<ImportGroupResult> {
  const base: ImportGroupResult = {
    ok: false,
    total: 0,
    contactsCreated: 0,
    tagged: 0,
    tagName: '',
  }
  try {
    const ctx = await requireRole('agent')
    // Miolo compartilhado com a rota pública /api/v1/.../import-group.
    const { importGroupMembersCore } = await import('@/lib/inbox/group-import')
    const result = await importGroupMembersCore(
      ctx.accountId,
      ctx.userId,
      conversationId,
    )
    if (result.ok) revalidatePath('/contacts')
    return result
  } catch (err) {
    return {
      ...base,
      error: err instanceof Error ? err.message : 'Falha ao importar membros.',
    }
  }
}

// Estado de 15 min por conversa do dono: a proposta esperando SIM/NÃO.
// Redis via kv* do reply-marker (fail-open: sem Redis, sem pendência).
import { kvDel, kvGetJson, kvSetJson } from '@/lib/ai/reply-marker'

export const PENDING_TTL_SECONDS = 15 * 60
const key = (conversationId: string) => `assistant:pending:${conversationId}`

export type AssistantPending =
  | { kind: 'task'; title: string; dueAt: string | null; assigneeId: string | null; contactId: string | null; dealId: string | null; summary: string }
  | { kind: 'assign'; toUserId: string; dealId: string | null; conversationId: string | null; contactId: string | null; summary: string }
  | { kind: 'event'; title: string; startsAt: string; endsAt: string; contactId: string | null; dealId: string | null; summary: string }

export async function getPending(conversationId: string): Promise<AssistantPending | null> {
  return (await kvGetJson<AssistantPending>(key(conversationId))) ?? null
}

export async function setPending(conversationId: string, p: AssistantPending): Promise<void> {
  await kvSetJson(key(conversationId), p, PENDING_TTL_SECONDS)
}

export async function clearPending(conversationId: string): Promise<void> {
  await kvDel(key(conversationId))
}

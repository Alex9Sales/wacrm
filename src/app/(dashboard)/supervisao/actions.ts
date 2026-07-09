'use server';

// Supervision — admin-only read views over the team's live workload.

import { requireRole } from '@/lib/auth/account';
import {
  loadSupervision,
  loadAgentConversations,
} from '@/lib/supervision/queries';
import type {
  SupervisionOverview,
  AgentConversationRow,
} from '@/lib/supervision/types';

export async function getSupervisionOverview(): Promise<SupervisionOverview> {
  const ctx = await requireRole('admin');
  return loadSupervision(ctx.accountId);
}

export async function getAgentConversations(
  agentId: string,
): Promise<AgentConversationRow[]> {
  const ctx = await requireRole('admin');
  return loadAgentConversations(ctx.accountId, agentId);
}

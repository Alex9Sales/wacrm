'use server';

// Supervision — supervisor+ read views over the team's live workload.
// The "supervisor" role exists precisely to supervise (canSeeAllConversations
// + canViewDashboard are supervisor+), so these views must NOT be admin-only —
// a supervisor is the team's manager. The nav + page already gate on
// canEditSettings (supervisor+); these data loaders were the last admin-only
// block that left a supervisor seeing an empty/broken Supervisão.

import { requireRole } from '@/lib/auth/account';
import {
  loadSupervision,
  loadAgentConversations,
  loadCsatSummary,
  type CsatSummary,
} from '@/lib/supervision/queries';
import type {
  SupervisionOverview,
  AgentConversationRow,
} from '@/lib/supervision/types';

export async function getSupervisionOverview(): Promise<SupervisionOverview> {
  const ctx = await requireRole('supervisor');
  return loadSupervision(ctx.accountId);
}

export async function getAgentConversations(
  agentId: string,
): Promise<AgentConversationRow[]> {
  const ctx = await requireRole('supervisor');
  return loadAgentConversations(ctx.accountId, agentId);
}

export async function getCsatSummary(): Promise<CsatSummary> {
  const ctx = await requireRole('supervisor');
  return loadCsatSummary(ctx.accountId);
}

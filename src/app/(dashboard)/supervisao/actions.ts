'use server';

// Supervision — supervisor+ read views over the team's live workload.
// The "supervisor" role exists precisely to supervise (canSeeAllConversations
// + canViewDashboard are supervisor+), so these views must NOT be admin-only —
// a supervisor is the team's manager. The nav + page already gate on
// canEditSettings (supervisor+); these data loaders were the last admin-only
// block that left a supervisor seeing an empty/broken Supervisão.

import { requireRole } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { isAdminUser } from '@/lib/sectors/access';
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
  // A supervisor (not admin/owner) never sees the admin/owner's workload.
  const hideAdmins = !hasMinRole(ctx.role, 'admin');
  return loadSupervision(ctx.accountId, hideAdmins);
}

export async function getAgentConversations(
  agentId: string,
): Promise<AgentConversationRow[]> {
  const ctx = await requireRole('supervisor');
  // Block a supervisor from drilling into an admin/owner's conversations.
  if (
    !hasMinRole(ctx.role, 'admin') &&
    (await isAdminUser(ctx.accountId, agentId))
  ) {
    return [];
  }
  return loadAgentConversations(ctx.accountId, agentId);
}

export async function getCsatSummary(): Promise<CsatSummary> {
  const ctx = await requireRole('supervisor');
  return loadCsatSummary(ctx.accountId);
}

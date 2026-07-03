'use server'

// ============================================================
// Server actions for the Dashboard page. Thin account-scoped
// wrappers over `@/lib/dashboard/queries`, which now runs on the
// shared Drizzle client and takes an accountId instead of a
// Supabase client.
// ============================================================

import { getCurrentAccount } from '@/lib/auth/account'
import {
  loadActivity,
  loadConversationsSeries,
  loadMetrics,
  loadPipelineDonut,
  loadResponseTime,
} from '@/lib/dashboard/queries'
import type {
  ActivityItem,
  ConversationsSeriesPoint,
  MetricsBundle,
  PipelineDonutData,
  ResponseTimeSummary,
} from '@/lib/dashboard/types'

export async function fetchMetrics(): Promise<MetricsBundle> {
  const ctx = await getCurrentAccount()
  return loadMetrics(ctx.accountId)
}

export async function fetchConversationsSeries(
  rangeDays: number,
): Promise<ConversationsSeriesPoint[]> {
  const ctx = await getCurrentAccount()
  return loadConversationsSeries(ctx.accountId, rangeDays)
}

export async function fetchPipelineDonut(): Promise<PipelineDonutData> {
  const ctx = await getCurrentAccount()
  return loadPipelineDonut(ctx.accountId)
}

export async function fetchResponseTime(): Promise<ResponseTimeSummary> {
  const ctx = await getCurrentAccount()
  return loadResponseTime(ctx.accountId)
}

export async function fetchActivity(limit = 20): Promise<ActivityItem[]> {
  const ctx = await getCurrentAccount()
  return loadActivity(ctx.accountId, limit)
}

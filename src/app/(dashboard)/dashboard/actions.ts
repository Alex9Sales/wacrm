'use server'

// ============================================================
// Server actions for the Dashboard page. Thin account-scoped
// wrappers over `@/lib/dashboard/queries`, which now runs on the
// shared Drizzle client and takes an accountId instead of a
// Supabase client.
// ============================================================

import { requireRole } from '@/lib/auth/account'
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
  const ctx = await requireRole('supervisor')
  return loadMetrics(ctx.accountId)
}

export async function fetchConversationsSeries(
  rangeDays: number,
): Promise<ConversationsSeriesPoint[]> {
  const ctx = await requireRole('supervisor')
  return loadConversationsSeries(ctx.accountId, rangeDays)
}

export async function fetchPipelineDonut(): Promise<PipelineDonutData> {
  const ctx = await requireRole('supervisor')
  return loadPipelineDonut(ctx.accountId)
}

export async function fetchResponseTime(): Promise<ResponseTimeSummary> {
  const ctx = await requireRole('supervisor')
  return loadResponseTime(ctx.accountId)
}

export async function fetchActivity(limit = 20): Promise<ActivityItem[]> {
  const ctx = await requireRole('supervisor')
  return loadActivity(ctx.accountId, limit)
}

// 🚀 Wizard "Ative seu Fluxia" — estado real do onboarding (derivado do banco)
// + dispensa persistida. Null = wizard oculto (dispensado ou sem permissão).
export async function fetchActivationState(): Promise<
  | (import('@/lib/activation/activation').ActivationState & {
      hidden: boolean
    })
  | null
> {
  try {
    const ctx = await requireRole('supervisor')
    const [{ getActivationState }, { getAccountSettings }] = await Promise.all([
      import('@/lib/activation/activation'),
      import('@/lib/settings/account-settings'),
    ])
    const [state, settings] = await Promise.all([
      getActivationState(ctx.accountId),
      getAccountSettings(ctx.accountId),
    ])
    return { ...state, hidden: Boolean(settings.onboardingHiddenAt) }
  } catch {
    return null
  }
}

export async function hideActivationWizard(): Promise<{ error: string | null }> {
  try {
    const ctx = await requireRole('supervisor')
    const { updateAccountSettings } = await import(
      '@/lib/settings/account-settings'
    )
    await updateAccountSettings(ctx.accountId, {
      onboardingHiddenAt: new Date().toISOString(),
    })
    return { error: null }
  } catch {
    return { error: 'Não foi possível ocultar o assistente.' }
  }
}

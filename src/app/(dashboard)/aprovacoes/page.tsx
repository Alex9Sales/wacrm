import type { Metadata } from 'next'

import { ApprovalQueueClient } from '@/components/orchestration/approval-queue-client'

export const metadata: Metadata = { title: 'Precisa de você' }
export const dynamic = 'force-dynamic'

// /aprovacoes — fila única das ações da IA que esperam um humano
// (Fase 2 · Revenue Orchestration) + auditoria do que rodou sozinho.
export default function ApprovalsPage() {
  return <ApprovalQueueClient />
}

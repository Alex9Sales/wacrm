import type { Metadata } from 'next'

import { WalletClient } from '@/components/cobrancas/wallet-client'

export const metadata: Metadata = { title: 'Cobranças · Carteira vencida' }
export const dynamic = 'force-dynamic'

// /cobrancas — Fase 1 do agente de cobrança: conectar o Asaas do cliente e ver
// a carteira vencida dentro do CRM. Nesta fase nada é enviado.
export default function CobrancasPage() {
  return <WalletClient />
}

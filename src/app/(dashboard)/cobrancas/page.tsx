import type { Metadata } from 'next'

import { WalletClient } from '@/components/cobrancas/wallet-client'
import { getCurrentAccount } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'

export const metadata: Metadata = { title: 'Cobranças · Carteira vencida' }
export const dynamic = 'force-dynamic'

// /cobrancas — Fase 1 do agente de cobrança: conectar o Asaas do cliente e ver
// a carteira vencida dentro do CRM. Nesta fase nada é enviado.
//
// Supervisor pra cima: as actions da carteira exigem esse papel, e um atendente
// que caía aqui pelo link via a tela quebrar (João, 10/09: "eles não podem ver
// essa página?"). O item do menu já some pra ele; o link direto explica.
export default async function CobrancasPage() {
  const ctx = await getCurrentAccount()
  if (!hasMinRole(ctx.role, 'supervisor')) {
    return (
      <div className="mx-auto max-w-lg p-8 text-center">
        <h1 className="text-lg font-semibold text-foreground">Cobranças é só para supervisor e administrador</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          A carteira do Asaas e a régua de cobrança ficam com quem administra a conta. Se você precisa acompanhar um cliente em
          atraso, abra a conversa dele: a situação da cobrança aparece na lateral.
        </p>
      </div>
    )
  }
  return <WalletClient />
}

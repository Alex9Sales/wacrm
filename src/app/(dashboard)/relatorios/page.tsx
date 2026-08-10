'use client'

// ============================================================
// /relatorios — Relatórios do CRM. v1: dashboard COMERCIAL.
// Segue a convenção do app: página client que consome server actions.
// ============================================================

import { ReportsClient } from '@/components/relatorios/reports-client'

export default function RelatoriosPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Relatórios</h1>
        <p className="text-sm text-muted-foreground">
          Comercial — de tudo que entrou no funil, o que virou dinheiro e onde o resto morreu.
        </p>
      </div>
      <ReportsClient />
    </div>
  )
}

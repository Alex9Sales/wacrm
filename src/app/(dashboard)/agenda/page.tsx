'use client'

// ============================================================
// /agenda — seção Agenda do CRM (base interna; sync Google a seguir).
// ============================================================

import { AgendaClient } from '@/components/agenda/agenda-client'

export default function AgendaPage() {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Agenda</h1>
        <p className="text-sm text-muted-foreground">
          Seus compromissos e agendamentos. Em breve: sincronização com o Google Calendar.
        </p>
      </div>
      <AgendaClient />
    </div>
  )
}

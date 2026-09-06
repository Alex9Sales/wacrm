import type { Metadata } from 'next'

import { AutonomyValidationClient } from '@/components/orchestration/autonomy-validation-client'

export const metadata: Metadata = { title: 'Validação da autonomia' }
export const dynamic = 'force-dynamic'

// /aprovacoes/validacao — o placar da autonomia: o que a IA executou, o que
// precisou de gente, o que foi corrigido/revertido e quanto falta, por ação,
// para liberar o automático (portão de evidência).
export default function AutonomyValidationPage() {
  return <AutonomyValidationClient />
}

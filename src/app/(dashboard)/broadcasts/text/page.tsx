import type { Metadata } from 'next'
import { TextBroadcastForm } from '@/components/broadcasts/text-broadcast-form'

export const metadata: Metadata = { title: 'Disparo de texto' }

export default function TextBroadcastPage() {
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">
          Disparo de texto
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Envie uma mensagem de texto para muitos contatos de forma humanizada —
          no máximo o limite/dia, espaçado no horário comercial (08h–18h,
          seg–sáb). Ideal para canais não-oficiais (WAHA/Evolution/EvoGo).
        </p>
      </header>
      <TextBroadcastForm />
    </div>
  )
}

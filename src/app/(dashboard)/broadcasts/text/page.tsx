import type { Metadata } from 'next'
import { TextBroadcastForm } from '@/components/broadcasts/text-broadcast-form'

export const metadata: Metadata = { title: 'Disparo' }

// ?email=1 → modo "Disparo de e-mail": só canais de e-mail, com Assunto.
export default async function TextBroadcastPage({
  searchParams,
}: {
  searchParams: Promise<{ email?: string }>
}) {
  const isEmail = (await searchParams)?.email === '1'
  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-xl font-semibold text-foreground">
          {isEmail ? 'Disparo de e-mail ✉️' : 'Disparo de texto'}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isEmail
            ? 'Envie uma newsletter ou conteúdo por e-mail para uma audiência (todos, etiquetas, contatos ou CSV) usando os canais de e-mail que você configurou. Quem não tem e-mail no contato fica de fora automaticamente.'
            : 'Envie uma mensagem de texto para muitos contatos de forma humanizada — no máximo o limite/dia, espaçado no horário comercial (08h–18h, seg–sáb). Ideal para canais não-oficiais (WAHA/Evolution/EvoGo).'}
        </p>
      </header>
      <TextBroadcastForm emailOnly={isEmail} />
    </div>
  )
}

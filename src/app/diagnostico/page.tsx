import type { Metadata } from 'next'

import { DIAGNOSTICO_HTML } from './diagnostico-src'

// Página pública do diagnóstico (link pra Instagram / bio). O quiz roda dentro
// de um <iframe srcDoc> pra ficar 100% isolado do resto do app (CSS/JS
// próprios) e ainda assim mesmo-origem: o submit faz POST em
// /api/public/diagnostico, que joga o lead no funil.
export const metadata: Metadata = {
  title: 'Diagnóstico gratuito do seu WhatsApp | FluxiaCRM',
  description:
    'Descubra em 1 minuto quantas vendas somem no seu atendimento no WhatsApp, e o que dá pra arrumar. Diagnóstico gratuito da FluxiaCRM.',
  robots: { index: true, follow: true },
  openGraph: {
    title: 'Quantas vendas somem no seu WhatsApp?',
    description:
      'Diagnóstico gratuito: responda 8 perguntas e veja onde o seu atendimento perde cliente.',
    type: 'website',
    siteName: 'FluxiaCRM',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Quantas vendas somem no seu WhatsApp?',
    description:
      'Diagnóstico gratuito: responda 8 perguntas e veja onde o seu atendimento perde cliente.',
  },
}

export default function DiagnosticoPage() {
  return (
    <iframe
      title="Diagnóstico do seu WhatsApp"
      srcDoc={DIAGNOSTICO_HTML}
      style={{
        position: 'fixed',
        inset: 0,
        width: '100%',
        height: '100%',
        border: 0,
        display: 'block',
      }}
    />
  )
}

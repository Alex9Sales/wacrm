import { ImageResponse } from 'next/og'

// Preview do link da home (WhatsApp / LinkedIn / Instagram). Next serve como
// og:image + twitter:image da rota "/".
export const runtime = 'edge'
export const size = { width: 1200, height: 630 }
export const contentType = 'image/png'
export const alt = 'FluxiaCRM — CRM com agentes de IA para quem vende por conversa'

export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          padding: '72px 80px',
          background:
            'radial-gradient(1000px 600px at 82% -10%, #3a1d8a 0%, rgba(58,29,138,0) 55%), radial-gradient(900px 600px at 5% 120%, #2a1866 0%, rgba(42,24,102,0) 55%), #0b0912',
          color: '#f4f1fb',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <div
            style={{
              width: 60,
              height: 60,
              borderRadius: 14,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'linear-gradient(145deg, #9d7bff, #5b34d6)',
            }}
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinejoin="round">
              <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8A2.5 2.5 0 0 1 17.5 16H9l-4 4v-4H6.5" />
            </svg>
          </div>
          <div style={{ display: 'flex', fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }}>
            Fluxia<span style={{ color: '#b9a4ff' }}>CRM</span>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              alignSelf: 'flex-start',
              fontSize: 24,
              fontWeight: 600,
              color: '#b9a4ff',
              background: 'rgba(124,77,255,0.14)',
              border: '1px solid rgba(124,77,255,0.3)',
              borderRadius: 999,
              padding: '10px 22px',
              marginBottom: 28,
            }}
          >
            Atende · Conhece · Percebe · Age · Você supervisiona
          </div>
          <div style={{ display: 'flex', fontSize: 62, fontWeight: 800, lineHeight: 1.08, letterSpacing: -1.5, maxWidth: 980 }}>
            Seu comercial não deveria depender da memória da equipe
          </div>
          <div style={{ display: 'flex', marginTop: 26, fontSize: 28, color: '#c9c2e6', maxWidth: 940, lineHeight: 1.35 }}>
            Agentes de IA que atendem no WhatsApp e Instagram, conhecem o histórico do cliente e executam a próxima ação dentro das suas regras.
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 24, color: '#9d95b8' }}>
          <span>crm.salestecnologia.com.br</span>
          <span>Teste grátis por 7 dias · sem cartão</span>
        </div>
      </div>
    ),
    size,
  )
}

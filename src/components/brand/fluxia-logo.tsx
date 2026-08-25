// ============================================================
// Marca do FluxiaCRM.
//
// O símbolo é um F cujos dois braços terminam em corte diagonal: o F
// do nome, com o movimento do fluxo que dá nome ao produto. Fica no
// mesmo grid de 32 do resto dos ícones da UI e sobrevive a 16px, que
// é onde ele mais aparece (aba do navegador, sidebar recolhida).
//
// O preenchimento é `currentColor` de propósito: o app tem cinco
// acentos (violet, emerald, cobalt, amber, rose) e a marca acompanha
// o que estiver escolhido, em vez de fixar um roxo que briga com os
// outros quatro.
// ============================================================

interface MarkProps {
  className?: string
  /** Rótulo acessível. Sem ele o símbolo vira decorativo, para quando
   *  o nome já aparece escrito ao lado. */
  title?: string
}

/** O símbolo sozinho: favicon, app icon, sidebar recolhida, avatar. */
export function FluxiaMark({ className, title }: MarkProps) {
  return (
    <svg
      viewBox="0 0 32 32"
      fill="currentColor"
      className={className}
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      {/* braço de cima */}
      <path d="M7.1 6.4h17.8l-3.2 4.4H7.1z" />
      {/* braço do meio */}
      <path d="M7.1 13.8h13.2l-3.2 4.4H7.1z" />
      {/* haste */}
      <rect x="7.1" y="6.4" width="4.4" height="19.2" rx="2.2" />
    </svg>
  )
}

interface LogoProps {
  className?: string
  /** Tamanho do símbolo e da palavra juntos. */
  size?: 'sm' | 'md' | 'lg'
  /** Esconde a palavra e deixa só o símbolo (sidebar recolhida). */
  markOnly?: boolean
}

const TAMANHOS = {
  sm: { mark: 'size-6', text: 'text-base', gap: 'gap-1.5' },
  md: { mark: 'size-8', text: 'text-lg', gap: 'gap-2' },
  lg: { mark: 'size-10', text: 'text-2xl', gap: 'gap-2.5' },
} as const

/**
 * A marca completa: símbolo + palavra. "Fluxia" carrega o nome e
 * "CRM" recua para categoria, que é o que ele é.
 */
export function FluxiaLogo({
  className,
  size = 'md',
  markOnly = false,
}: LogoProps) {
  const t = TAMANHOS[size]
  return (
    <span className={`inline-flex items-center ${t.gap} ${className ?? ''}`}>
      <FluxiaMark
        className={`${t.mark} shrink-0 text-primary`}
        title={markOnly ? 'FluxiaCRM' : undefined}
      />
      {!markOnly && (
        <span
          className={`font-heading ${t.text} font-bold tracking-[-0.035em] text-foreground`}
        >
          Fluxia
          <span className="font-semibold text-muted-foreground">CRM</span>
        </span>
      )}
    </span>
  )
}

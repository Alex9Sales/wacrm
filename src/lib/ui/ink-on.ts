// ============================================================
// 🎨 Cor de texto legível em cima de uma cor de fundo qualquer.
//
// Nasceu do chip da Agenda, que era SEMPRE branco no texto por cima da cor da
// agenda. Agenda em tom claro (o azul-céu do Google, amarelo, verde-água)
// virava texto branco em fundo claro — ilegível nos dois temas. 17/09, João da
// GoLink: "esse azul-céu fica invisível praticamente na letra branca".
//
// O texto sai do brilho da PRÓPRIA cor, então vale pra qualquer cor que o
// cliente escolher, hoje ou depois — não é uma lista de exceções.
// ============================================================

/** Luminância relativa (WCAG 2.x) de um hex. 0 = preto, 1 = branco. */
export function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return 0 // cor que não dá pra ler → trata como escura (branco, como era antes)
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const ch = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

/**
 * Texto legível sobre `bg`: quase-preto em fundo claro, branco em fundo escuro.
 * O corte em 0.45 (e não 0.5) puxa pro texto escuro nos tons médios, onde o
 * branco já começa a sumir antes de o fundo ficar "claro" de verdade.
 */
export function inkOn(bg: string | null | undefined): string {
  return luminance(bg ?? '') > 0.45 ? '#15181d' : '#ffffff'
}

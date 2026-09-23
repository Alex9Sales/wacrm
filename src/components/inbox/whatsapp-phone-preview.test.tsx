import { describe, expect, it } from 'vitest'
import type { ReactElement } from 'react'

import { formatWhatsApp } from './whatsapp-phone-preview'

/** Os pedaços que viraram elemento (negrito, link, variável…), com o tipo. */
function elementos(nodes: ReturnType<typeof formatWhatsApp>) {
  return nodes.filter((n): n is ReactElement<{ href?: string; children?: unknown }> =>
    !!n && typeof n === 'object' && 'type' in (n as object),
  )
}

describe('prévia do template — link clicável (Renato/Zelo, 23/09)', () => {
  it('URL no meio do texto vira link com o endereço certo', () => {
    const nodes = formatWhatsApp('O Renato explica em 2 minutos:\nhttps://www.youtube.com/watch?v=OhqToAPPc7c\nDepois me conta.')
    const links = elementos(nodes).filter((e) => e.type === 'a')
    expect(links).toHaveLength(1)
    expect(links[0].props.href).toBe('https://www.youtube.com/watch?v=OhqToAPPc7c')
  })

  it('pontuação depois do link não entra no endereço', () => {
    const links = elementos(formatWhatsApp('Veja: https://exemplo.com/video.')).filter((e) => e.type === 'a')
    expect(links[0].props.href).toBe('https://exemplo.com/video')
  })

  it('link abre em outra aba, sem carona na nossa sessão', () => {
    const link = elementos(formatWhatsApp('https://exemplo.com')).find((e) => e.type === 'a') as
      | ReactElement<{ target?: string; rel?: string }>
      | undefined
    expect(link?.props.target).toBe('_blank')
    expect(link?.props.rel).toBe('noopener noreferrer')
  })

  it('o que já funcionava continua: negrito, itálico e variável vazia', () => {
    const tipos = elementos(formatWhatsApp('*oi* _tudo_ {{1}}')).map((e) => e.type)
    expect(tipos).toContain('strong')
    expect(tipos).toContain('em')
    expect(tipos).toContain('span')
  })

  it('texto sem link não vira elemento nenhum', () => {
    expect(elementos(formatWhatsApp('Bom dia, tudo bem?'))).toHaveLength(0)
  })
})

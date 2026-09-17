import { describe, expect, it } from 'vitest'

import { flattenForTemplate } from './owner-alerts'

// 17/09 (Limpeza com Zelo): o resumo da reunião vai pro WhatsApp do dono por um
// canal OFICIAL da Meta. Fora da janela de 24h só passa template, e variável de
// template não aceita quebra de linha.
describe('aviso do dono em uma linha (template)', () => {
  it('quebra de linha vira " · " e espaço demais some', () => {
    const t = flattenForTemplate('🗓️ *REUNIÃO MARCADA*\n\n👤 Karen · 5511999\n📋 São Paulo    R$ 30 mil')
    expect(t).not.toMatch(/[\n\t]/)
    expect(t).not.toMatch(/ {3}/)
    expect(t).toContain('🗓️ *REUNIÃO MARCADA* · 👤 Karen · 5511999 · 📋 São Paulo R$ 30 mil')
  })

  it('texto longo é cortado com reticências', () => {
    const t = flattenForTemplate('a'.repeat(1200))
    expect(t.length).toBeLessThanOrEqual(900)
    expect(t.endsWith('…')).toBe(true)
  })
})

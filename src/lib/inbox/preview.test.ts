import { describe, it, expect } from 'vitest'

import { formatConversationPreview } from './preview'

describe('formatConversationPreview', () => {
  it('maps bare media placeholders to friendly labels', () => {
    expect(formatConversationPreview('[image]')).toBe('📷 Foto')
    expect(formatConversationPreview('[audio]')).toBe('🎤 Áudio')
    expect(formatConversationPreview('[video]')).toBe('🎥 Vídeo')
    expect(formatConversationPreview('[document]')).toBe('📄 Documento')
    expect(formatConversationPreview('[text]')).toBe('Mensagem')
  })

  it('is case-insensitive and tolerates surrounding whitespace', () => {
    expect(formatConversationPreview('  [IMAGE] ')).toBe('📷 Foto')
  })

  it('passes real text and captions through untouched', () => {
    expect(formatConversationPreview('Olá, tudo bem?')).toBe('Olá, tudo bem?')
    expect(formatConversationPreview('[unknown-kind]')).toBe('[unknown-kind]')
  })

  it('returns the empty fallback for null/empty input', () => {
    expect(formatConversationPreview(null)).toBe('Nenhuma mensagem ainda')
    expect(formatConversationPreview('')).toBe('Nenhuma mensagem ainda')
    expect(formatConversationPreview('   ')).toBe('Nenhuma mensagem ainda')
  })
})

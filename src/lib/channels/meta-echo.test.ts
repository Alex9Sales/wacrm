import { describe, it, expect } from 'vitest'
import { echoDisplayText } from './meta-echo'

describe('echoDisplayText', () => {
  it('apagar pra todos e reação NÃO viram mensagem', () => {
    expect(echoDisplayText({ type: 'revoke' })).toBeNull()
    expect(echoDisplayText({ type: 'reaction' })).toBeNull()
  })

  it('texto e mídia viram o que a equipe lê', () => {
    expect(echoDisplayText({ type: 'text', text: { body: 'já respondi ele' } })).toBe('já respondi ele')
    expect(echoDisplayText({ type: 'document', document: { filename: 'contrato.pdf' } })).toBe('📄 Documento — contrato.pdf')
    expect(echoDisplayText({ type: 'image' })).toBe('📷 Imagem')
  })

  it('tipo desconhecido não vaza o nome técnico', () => {
    expect(echoDisplayText({ type: 'order' })).toBe('📎 Mensagem')
  })
})

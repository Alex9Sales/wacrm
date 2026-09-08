import { describe, expect, it } from 'vitest'

import { chargeInstruction } from './defaults'

describe('instrução de cobrança no prompt (08/09: Asaas exige CPF/CNPJ)', () => {
  it('sem documento conhecido: manda pedir o CPF/CNPJ ANTES de emitir', () => {
    const t = chargeInstruction(500)
    expect(t).toMatch(/ANTES de emitir, peça o CPF ou CNPJ/)
    expect(t).toContain('R$ 500,00')
    expect(t).toContain('[[COBRAR:')
  })
  it('com documento conhecido: não pede de novo', () => {
    const t = chargeInstruction(199.9, { hasDocument: true })
    expect(t).toMatch(/já é conhecido pelo sistema: não peça de novo/)
    expect(t).not.toMatch(/ANTES de emitir, peça/)
    expect(t).toContain('R$ 199,90')
  })
})

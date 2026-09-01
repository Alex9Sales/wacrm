import { describe, expect, it } from 'vitest'

import { erpPhoneCandidates } from './erp-sync-worker'

describe('erpPhoneCandidates — 9º dígito no ERP', () => {
  it('celular sem o 9 → tenta base e depois com o 9', () => {
    expect(erpPhoneCandidates('6791234567')).toEqual(['6791234567', '67991234567'])
  })
  it('celular com o 9 → tenta base e depois sem o 9', () => {
    expect(erpPhoneCandidates('67991234567')).toEqual(['67991234567', '6791234567'])
  })
  it('fixo (não começa com 6-9) → só a base', () => {
    expect(erpPhoneCandidates('6733334444')).toEqual(['6733334444'])
  })
})

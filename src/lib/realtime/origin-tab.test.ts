import { describe, expect, it } from 'vitest'

import { parseOriginTabId, thisTabId } from './origin-tab'

describe('parseOriginTabId', () => {
  it('aceita um UUID e ids curtos com letras, números e hífen', () => {
    expect(parseOriginTabId('3f1c2b7a-9d4e-4c1a-8b2f-0a1b2c3d4e5f')).toBe(
      '3f1c2b7a-9d4e-4c1a-8b2f-0a1b2c3d4e5f',
    )
    expect(parseOriginTabId('abc-123')).toBe('abc-123')
    expect(parseOriginTabId('a'.repeat(64))).toBe('a'.repeat(64))
  })

  it('ignora o que não é string, vazio, longo demais ou com outros caracteres', () => {
    expect(parseOriginTabId(undefined)).toBeUndefined()
    expect(parseOriginTabId(null)).toBeUndefined()
    expect(parseOriginTabId(42)).toBeUndefined()
    expect(parseOriginTabId({ id: 'abc' })).toBeUndefined()
    expect(parseOriginTabId('')).toBeUndefined()
    expect(parseOriginTabId('a'.repeat(65))).toBeUndefined()
    expect(parseOriginTabId('abc def')).toBeUndefined()
    expect(parseOriginTabId('abc_def')).toBeUndefined()
    expect(parseOriginTabId('<script>')).toBeUndefined()
    expect(parseOriginTabId('abc\n')).toBeUndefined()
  })
})

describe('thisTabId', () => {
  it('é fixo dentro da mesma aba e passa no próprio validador', () => {
    const id = thisTabId()
    expect(thisTabId()).toBe(id)
    expect(parseOriginTabId(id)).toBe(id)
  })
})

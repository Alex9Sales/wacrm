import { describe, it, expect } from 'vitest'
import { renderTemplateText } from './template-text'

describe('renderTemplateText', () => {
  it('fills {{n}} with the params the customer received', () => {
    expect(renderTemplateText('Olá, {{1}}! Sua reunião é {{2}}.', ['Ana', 'amanhã'])).toBe(
      'Olá, Ana! Sua reunião é amanhã.',
    )
  })

  it('keeps a missing variable visible and tolerates spaces inside the braces', () => {
    expect(renderTemplateText('Oi, {{ 1 }}! Código {{2}}', ['Bia'])).toBe('Oi, Bia! Código {{2}}')
  })

  it('returns empty for a missing body', () => {
    expect(renderTemplateText(null, ['x'])).toBe('')
    expect(renderTemplateText('   ', [])).toBe('')
  })
})

import { describe, it, expect } from 'vitest'
import { splitIntoMessages } from './flow-agent'

describe('splitIntoMessages', () => {
  it('returns [] for empty / whitespace', () => {
    expect(splitIntoMessages('')).toEqual([])
    expect(splitIntoMessages('   \n  ')).toEqual([])
  })

  it('keeps a single short line as one message', () => {
    expect(splitIntoMessages('Oi, tudo bem?')).toEqual(['Oi, tudo bem?'])
  })

  it('splits on blank-line paragraphs', () => {
    expect(splitIntoMessages('Primeira parte.\n\nSegunda parte.')).toEqual([
      'Primeira parte.',
      'Segunda parte.',
    ])
  })

  it('falls back to single newlines when there are no blank lines', () => {
    expect(splitIntoMessages('linha 1\nlinha 2\nlinha 3')).toEqual([
      'linha 1',
      'linha 2',
      'linha 3',
    ])
  })

  it('merges overflow past maxParts into the last message', () => {
    const text = 'a\n\nb\n\nc\n\nd\n\ne'
    const parts = splitIntoMessages(text, 3)
    expect(parts).toHaveLength(3)
    expect(parts[0]).toBe('a')
    expect(parts[1]).toBe('b')
    // c, d, e merged into the last part.
    expect(parts[2]).toBe('c\n\nd\n\ne')
  })

  it('trims each part', () => {
    expect(splitIntoMessages('  oi  \n\n  tudo bem  ')).toEqual([
      'oi',
      'tudo bem',
    ])
  })
})

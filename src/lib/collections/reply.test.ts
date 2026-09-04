import { describe, expect, it } from 'vitest'

import { COLLECTION_DIRECTIVE, parseCloseDirectives } from '@/lib/ai/defaults'

import { promiseDeadline } from './reply'

const hoje = new Date('2026-09-04T12:00:00-03:00')

describe('marcador de cobrança', () => {
  it('lê a promessa com a data', () => {
    const d = parseCloseDirectives('Combinado! Fico no aguardo.\n[[COBRANCA:promessa|2026-09-30]]')
    expect(d.collection).toEqual({ kind: 'promessa', date: '2026-09-30' })
  })

  it('lê comprovante, contestação e acordo', () => {
    expect(parseCloseDirectives('Obrigado! Vou conferir.[[COBRANCA:comprovante]]').collection?.kind).toBe('comprovante')
    expect(parseCloseDirectives('Vou verificar.[[COBRANCA:contesta]]').collection?.kind).toBe('contesta')
    expect(parseCloseDirectives('Vou passar pro responsável.[[COBRANCA:acordo]]').collection?.kind).toBe('acordo')
  })

  it('NUNCA deixa o marcador vazar para o cliente', () => {
    const d = parseCloseDirectives('Obrigado, vou conferir! [[COBRANCA:comprovante]]')
    expect(d.text).toBe('Obrigado, vou conferir!')
    expect(d.text).not.toContain('COBRANCA')
  })

  it('ignora palavra parecida que não é marcador', () => {
    const d = parseCloseDirectives('Sobre a cobrança: pode pagar até sexta.')
    expect(d.collection).toBeNull()
    expect(d.text).toContain('cobrança')
  })

  it('não aceita um tipo inventado', () => {
    expect(parseCloseDirectives('[[COBRANCA:perdoa]]').collection).toBeNull()
    expect(COLLECTION_DIRECTIVE.test('[[COBRANCA:perdoa]]')).toBe(false)
  })

  it('promessa sem data ainda é promessa (o handler decide o que fazer)', () => {
    expect(parseCloseDirectives('[[COBRANCA:promessa]]').collection).toEqual({ kind: 'promessa', date: null })
  })
})

describe('promiseDeadline — a régua dorme, mas não para sempre', () => {
  it('dorme o dia prometido e o de tolerância, e acorda na virada do dia 2', () => {
    // Instantes ABSOLUTOS: o resultado tem que ser o mesmo no meu Mac (UTC−3) e
    // no runner do CI (UTC) — foi exatamente aqui que a diferença apareceu.
    const d = promiseDeadline('2026-09-30', hoje)!
    expect(d).not.toBeNull()
    expect(d.toISOString()).toBe('2026-10-02T03:00:00.000Z') // 00:00 de 02/10 no Brasil

    const em = (s: string) => new Date(s).getTime()
    expect(d.getTime()).toBeGreaterThan(em('2026-09-30T23:59:00-03:00')) // ainda dorme no dia prometido
    expect(d.getTime()).toBeGreaterThan(em('2026-10-01T23:59:00-03:00')) // e no dia de tolerância
  })

  it('não muda de resultado conforme o fuso da máquina', () => {
    // O prazo é montado em UTC explícito; qualquer data dá uma virada de dia
    // brasileira exata, sem depender de onde o container roda.
    expect(promiseDeadline('2026-12-31', hoje)!.toISOString()).toBe('2027-01-02T03:00:00.000Z')
  })

  it('recusa data que já passou — o modelo errou o ano', () => {
    expect(promiseDeadline('2025-09-30', hoje)).toBeNull()
  })

  it('recusa data absurdamente longe em vez de congelar a régua por um ano', () => {
    expect(promiseDeadline('2030-01-01', hoje)).toBeNull()
  })

  it('sem data devolve nulo — não inventamos prazo', () => {
    expect(promiseDeadline(null, hoje)).toBeNull()
    expect(promiseDeadline('amanhã', hoje)).toBeNull()
  })

  it('aceita hoje mesmo (paga até o fim do dia)', () => {
    expect(promiseDeadline('2026-09-04', hoje)).not.toBeNull()
  })
})

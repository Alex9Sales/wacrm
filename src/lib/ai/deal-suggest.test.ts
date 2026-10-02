import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CustomField } from '@/types'

// Moeda (02/10/2026): a IA escrevia dinheiro por extenso ("3 mil", "entre 3 e
// 5 mil", "R$ 5k") num campo personalizado de MOEDA e aceitar a sugestão
// falhava. Agora a dica pede número, o que vier por extenso é descartado (com
// log) e o que é número sai no formato gravado do campo ("1500", "1028.67").
// Só o parse puro interessa aqui — IA, contexto e configurações viram stub.
vi.mock('./config', () => ({}))
vi.mock('./generate', () => ({}))
vi.mock('./context', () => ({}))
vi.mock('@/lib/settings/account-settings', () => ({}))

import { customFieldHint, parseSuggestions } from './deal-suggest'

const TZ = 'America/Sao_Paulo'

function field(over: Partial<CustomField>): CustomField {
  return {
    id: 'cf-1',
    user_id: 'u-1',
    account_id: 'acc-1',
    field_name: 'Orçamento',
    field_type: 'text',
    created_at: '2026-10-02T00:00:00Z',
    ...over,
  }
}

const moeda = field({ id: 'cf-moeda', field_name: 'Orçamento', field_type: 'currency' })
const texto = field({ id: 'cf-texto', field_name: 'Cidade', field_type: 'text' })

function sugestaoDeCampo(target: string, value: string): string {
  return JSON.stringify([{ kind: 'field', target, value, evidence: 'trecho da conversa' }])
}

let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('dica ao modelo (campo personalizado)', () => {
  it('moeda pede número em R$', () => {
    expect(customFieldHint(moeda)).toBe('número em R$ (ex.: 1500)')
  })

  it('texto continua "texto curto" e select continua listando as opções', () => {
    expect(customFieldHint(texto)).toBe('texto curto')
    const sel = field({
      field_type: 'select',
      field_options: { options: ['A', 'B'] },
    })
    expect(customFieldHint(sel)).toBe('um de: A | B')
  })
})

describe('parseSuggestions — campo de moeda', () => {
  it.each(['3 mil', 'entre 3 e 5 mil', 'R$ 5k', 'a combinar', '-500'])(
    'descarta "%s" (não é um valor em reais) e registra no log',
    (valor) => {
      const out = parseSuggestions(sugestaoDeCampo('custom:cf-moeda', valor), [moeda], TZ)
      expect(out).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('Orçamento')
    },
  )

  it.each([
    ['1500', '1500'],
    ['R$ 1.500,00', '1500'],
    ['1.028,67', '1028.67'],
    ['3000', '3000'],
    ['0,5', '0.50'],
  ])('normaliza "%s" para o formato gravado "%s"', (valor, gravado) => {
    const out = parseSuggestions(sugestaoDeCampo('custom:cf-moeda', valor), [moeda], TZ)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      kind: 'field',
      target: 'custom:cf-moeda',
      label: 'Orçamento',
      value: gravado,
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('descartar a moeda não derruba as outras sugestões da mesma resposta', () => {
    const raw = JSON.stringify([
      { kind: 'field', target: 'custom:cf-moeda', value: 'uns 3 mil', evidence: 'x' },
      { kind: 'field', target: 'custom:cf-texto', value: 'Curitiba', evidence: 'y' },
    ])
    const out = parseSuggestions(raw, [moeda, texto], TZ)
    expect(out.map((o) => [o.target, o.value])).toEqual([['custom:cf-texto', 'Curitiba']])
  })

  it('campo de texto segue aceitando texto livre (sem mexer no valor)', () => {
    const out = parseSuggestions(sugestaoDeCampo('custom:cf-texto', ' 3 mil '), [texto], TZ)
    expect(out).toHaveLength(1)
    expect(out[0].value).toBe('3 mil')
    expect(warn).not.toHaveBeenCalled()
  })
})

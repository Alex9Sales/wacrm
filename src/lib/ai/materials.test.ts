import { describe, expect, it } from 'vitest'

import {
  extractMaterialDirectives,
  findMaterialByName,
  materialsInstruction,
  type AgentMaterial,
} from './materials-shared'

const mats: AgentMaterial[] = [
  {
    id: '1',
    name: 'Circular de Oferta',
    description: 'obrigatória por lei antes da venda',
    mediaType: 'document',
    mediaUrl: 'https://x/cof.pptx',
    filename: 'COF 2026.pptx',
    mimetype: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  { id: '2', name: 'Vídeo institucional', description: null, mediaType: 'video', mediaUrl: 'https://x/v.mp4', filename: null, mimetype: null },
]

describe('extractMaterialDirectives', () => {
  it('tira o marcador (qualquer posição/caixa) e devolve os nomes na ordem, sem repetir', () => {
    const r = extractMaterialDirectives(
      'Segue o documento 👇\n[[ENVIAR:Circular de Oferta]]\nQualquer dúvida me chama. [[enviar: circular de oferta ]] [[ENVIAR:Vídeo institucional]]',
    )
    expect(r.names).toEqual(['Circular de Oferta', 'Vídeo institucional'])
    expect(r.text).toBe('Segue o documento 👇\nQualquer dúvida me chama.')
  })
  it('sem marcador → texto igual, nomes vazios', () => {
    const r = extractMaterialDirectives('Oi! Tudo bem?')
    expect(r).toEqual({ text: 'Oi! Tudo bem?', names: [] })
  })
  it('só o marcador → texto vazio (a mídia vai sozinha)', () => {
    expect(extractMaterialDirectives('[[ENVIAR:Circular de Oferta]]').text).toBe('')
  })
})

describe('findMaterialByName', () => {
  it('acha exato (case-insensitive) e prefixo único; ambíguo/nada → null', () => {
    expect(findMaterialByName(mats, 'circular de oferta')?.id).toBe('1')
    expect(findMaterialByName(mats, 'Circular')?.id).toBe('1')
    expect(findMaterialByName(mats, 'Contrato')).toBeNull()
  })
})

describe('materialsInstruction', () => {
  it('lista os materiais com nome exato, tipo e descrição', () => {
    const s = materialsInstruction(mats)
    expect(s).toContain('[[ENVIAR:<exact name>]]')
    expect(s).toContain('"Circular de Oferta" (document, COF 2026.pptx) — obrigatória por lei antes da venda')
    expect(s).toContain('"Vídeo institucional" (video)')
    expect(materialsInstruction([])).toBe('')
  })
})

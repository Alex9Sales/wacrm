import { describe, expect, it } from 'vitest'
import { prepareFollowUpText } from './followup'

/**
 * O texto que a IA gera num follow-up, gatilho de etapa ou lembrete passa por
 * prepareFollowUpText antes de ir ao cliente (01/10, Zelo).
 *
 * O gatilho "Envio da COF" mandou "[[ENVIAR: Circular de Oferta de Franquia]]"
 * cru, quatro vezes, e nenhum PDF. As varreduras geravam com a mesma IA do
 * auto-reply, mas não sabiam o que fazer com o marcador.
 */
describe('prepareFollowUpText', () => {
  it('[[ENVIAR:nome]] sai do texto e vira pedido de arquivo', () => {
    const r = prepareFollowUpText(
      'Segue a circular para você analisar com calma.\n[[ENVIAR: Circular de Oferta de Franquia]]',
    )
    expect(r).toEqual({
      text: 'Segue a circular para você analisar com calma.',
      materials: ['Circular de Oferta de Franquia'],
      silent: false,
      removed: [],
    })
  })

  it('vários materiais, na ordem, sem repetir', () => {
    const r = prepareFollowUpText('Seguem 👇 [[ENVIAR:Catálogo]]\n[[ENVIAR:Tabela]]\n[[enviar: catálogo]]')
    expect(r.text).toBe('Seguem 👇')
    expect(r.materials).toEqual(['Catálogo', 'Tabela'])
  })

  it('[[SILENT]] cala — checado ANTES da limpeza, que também o apagaria', () => {
    expect(prepareFollowUpText('[[SILENT]]').silent).toBe(true)
    expect(prepareFollowUpText('[[ silent ]]').silent).toBe(true)
    // Texto + SILENT: a IA desistiu no meio — vale o silêncio, como antes.
    const r = prepareFollowUpText('Oi, tudo bem? [[SILENT]]')
    expect(r).toMatchObject({ silent: true, text: '', materials: [] })
  })

  it('SILENT junto de [[ENVIAR:]] também cala (nenhum arquivo sai)', () => {
    const r = prepareFollowUpText('[[SILENT]]\n[[ENVIAR:Circular]]')
    expect(r.silent).toBe(true)
    expect(r.materials).toEqual([])
  })

  it('outro marcador qualquer é limpo e registrado para o log', () => {
    const r = prepareFollowUpText('Podemos falar amanhã?\n[[ETIQUETA:quente]]')
    expect(r.text).toBe('Podemos falar amanhã?')
    expect(r.removed).toEqual(['[[ETIQUETA:quente]]'])
    expect(r.silent).toBe(false)
  })

  it('só marcador desconhecido: vazio depois de limpar = calou', () => {
    const r = prepareFollowUpText('[[RESOLVER]]')
    expect(r).toMatchObject({ text: '', silent: true, materials: [] })
  })

  it('só o pedido de arquivo NÃO é silêncio: o arquivo sai sozinho', () => {
    // Calar aqui jogaria fora exatamente o PDF que a orientação pediu.
    const r = prepareFollowUpText('[[ENVIAR: Circular de Oferta de Franquia]]')
    expect(r).toEqual({
      text: '',
      materials: ['Circular de Oferta de Franquia'],
      silent: false,
      removed: [],
    })
  })

  it('[[AUDIO]] e [[foto:…]] são conteúdo, não marcador — ficam', () => {
    expect(prepareFollowUpText('Olha a fachada [[foto:loja]]').text).toBe('Olha a fachada [[foto:loja]]')
  })

  it('texto comum passa intacto; vazio/nulo é silêncio', () => {
    expect(prepareFollowUpText('Oi! Ainda faz sentido conversarmos?')).toEqual({
      text: 'Oi! Ainda faz sentido conversarmos?',
      materials: [],
      silent: false,
      removed: [],
    })
    expect(prepareFollowUpText('').silent).toBe(true)
    expect(prepareFollowUpText(null).silent).toBe(true)
  })
})

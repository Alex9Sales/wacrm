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

/**
 * 29/09: a Appia recebeu o lembrete certo, mas no CRM a bolha mostrava
 * "Olá, {{1}}! A sua mensalidade de {{2}} vence hoje" — as chaves à mostra.
 * O Alex viu e achou que tinha saído torto para a cliente.
 *
 * O texto ia certo para a Meta; o que faltava era o CRM saber que os valores
 * podiam vir pela forma estruturada (a que também carrega parâmetro de botão),
 * e não só pela lista simples. Estes casos travam a substituição em si.
 */
describe('o corpo guardado no histórico', () => {
  const corpo = 'Olá, {{1}}! Aqui é da Fluxia. A sua mensalidade de {{2}} vence hoje.'

  it('mostra o que o cliente leu, não as chaves', () => {
    expect(renderTemplateText(corpo, ['Appia', 'R$ 130,00'])).toBe(
      'Olá, Appia! Aqui é da Fluxia. A sua mensalidade de R$ 130,00 vence hoje.',
    )
  })

  it('variável sem valor fica visível — o buraco não se esconde', () => {
    expect(renderTemplateText(corpo, ['Appia'])).toContain('{{2}}')
  })

  it('sem valor nenhum devolve o corpo como está, em vez de vazio', () => {
    expect(renderTemplateText(corpo, [])).toBe(corpo)
    expect(renderTemplateText(corpo, null)).toBe(corpo)
  })
})

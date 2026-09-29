import { describe, expect, it } from 'vitest'
import { idDaFatura } from './reminder-send'

/**
 * O botão "Pagar agora" do template recebe SÓ o sufixo da URL — a Meta monta
 * `https://www.asaas.com/i/{{1}}` com o que passarmos. Se esse pedaço vier
 * errado, o cliente clica e cai em lugar nenhum, que é pior do que não ter
 * botão: a mensagem inteira perde a credibilidade.
 *
 * Por isso a regra é devolver null na dúvida — sem link, o lembrete sai com o
 * template sem botão, que funciona.
 */
describe('o id da fatura que vai no botão', () => {
  it('extrai do invoiceUrl real do Asaas', () => {
    // cobrança pay_govlijjcptmio2y8 → link .../i/govlijjcptmio2y8
    expect(idDaFatura('https://www.asaas.com/i/govlijjcptmio2y8')).toBe('govlijjcptmio2y8')
  })

  it('ignora query e âncora que o link pode ganhar pelo caminho', () => {
    expect(idDaFatura('https://www.asaas.com/i/govlijjcptmio2y8?utm=wpp')).toBe(
      'govlijjcptmio2y8',
    )
    expect(idDaFatura('https://www.asaas.com/i/govlijjcptmio2y8#pix')).toBe('govlijjcptmio2y8')
  })

  it('aguenta barra no fim sem devolver vazio', () => {
    expect(idDaFatura('https://www.asaas.com/i/govlijjcptmio2y8/')).toBe('govlijjcptmio2y8')
  })

  it('sem cobrança em aberto, null — e o lembrete sai sem botão', () => {
    expect(idDaFatura(null)).toBeNull()
    expect(idDaFatura(undefined)).toBeNull()
    expect(idDaFatura('')).toBeNull()
    expect(idDaFatura('   ')).toBeNull()
  })

  it('recusa o que não parece id, em vez de mandar um botão quebrado', () => {
    expect(idDaFatura('https://www.asaas.com/')).toBeNull()
    expect(idDaFatura('https://www.asaas.com/i/abc')).toBeNull() // curto demais
    expect(idDaFatura('sem barra nenhuma')).toBeNull()
  })
})

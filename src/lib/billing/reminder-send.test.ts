import { describe, expect, it } from 'vitest'
import { idDaFatura, paramsDoDegrau } from './reminder-send'

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

/**
 * A Meta conta as variáveis do corpo e recusa com "Invalid parameter" quando o
 * número não bate — foi exatamente assim que a submissão do template do degrau
 * 0 falhou. O corpo dele diz "vence hoje" e não repete a data, então tem duas
 * variáveis enquanto os outros dois têm três.
 */
describe('quantas variáveis cada degrau manda', () => {
  const p = ['Appia', 'R$ 130,00', '29/09']

  it('"vence hoje" leva só nome e valor — a data está na própria frase', () => {
    expect(paramsDoDegrau(0, p)).toEqual(['Appia', 'R$ 130,00'])
  })

  it('os outros dois levam a data também', () => {
    expect(paramsDoDegrau(-5, p)).toEqual(['Appia', 'R$ 130,00', '29/09'])
    expect(paramsDoDegrau(3, p)).toEqual(['Appia', 'R$ 130,00', '29/09'])
  })

  it('o agradecimento leva nome e valor — o texto não repete a data', () => {
    expect(paramsDoDegrau(99, p)).toEqual(['Appia', 'R$ 130,00'])
  })

  it('degrau desconhecido passa tudo em vez de cortar no escuro', () => {
    expect(paramsDoDegrau(7, p)).toEqual(p)
  })
})

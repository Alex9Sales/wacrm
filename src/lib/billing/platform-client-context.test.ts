import { describe, expect, it } from 'vitest'
import { textoContaSuspensa, type ContaSuspensa } from './platform-client-context'

/**
 * Este texto vira instrução para o agente que atende o cliente suspenso. O
 * link e os números saem daqui — se saírem errados, a IA manda o cliente pagar
 * a fatura errada com toda a convicção.
 */
const GOLINK: ContaSuspensa = {
  nome: 'João GoLink',
  plano: 'Essencial',
  valorMensal: '497.00',
  vencimento: '30/09/2026',
  suspensaEm: '01/10/2026',
  motivo: 'inadimplencia',
  link: 'https://www.asaas.com/i/tg0tzeb7xj3autue',
}

describe('o que o agente recebe sobre a conta suspensa', () => {
  it('leva o link exato, o valor e o vencimento', () => {
    const t = textoContaSuspensa([GOLINK])!
    expect(t).toContain('https://www.asaas.com/i/tg0tzeb7xj3autue')
    expect(t).toContain('R$ 497,00')
    expect(t).toContain('venceu em 30/09/2026')
    expect(t).toContain('João GoLink')
  })

  it('manda resolver ali, sem passar para outro agente', () => {
    // O roteador da Fluxia manda "problema" para o Suporte. Conta suspensa
    // tem que ser resolvida por quem pegou a conversa, com o link na mão.
    expect(textoContaSuspensa([GOLINK])!).toContain('resolva AQUI, sem passar para outro agente')
  })

  it('nunca deixa o agente dizer que liberou o acesso', () => {
    expect(textoContaSuspensa([GOLINK])!).toContain('Nunca diga que liberou o acesso')
  })

  it('suspensão MANUAL não tem link nem promessa: vai para um humano', () => {
    const manual: ContaSuspensa = { ...GOLINK, motivo: 'manual', link: null }
    const t = textoContaSuspensa([manual])!
    expect(t).not.toContain('asaas.com')
    expect(t).toContain('passe para um humano')
  })

  it('suspensa pela trava mas sem link gravado: não inventa link', () => {
    const semLink: ContaSuspensa = { ...GOLINK, link: null }
    const t = textoContaSuspensa([semLink])!
    expect(t).not.toContain('Link para regularizar')
    expect(t).toContain('passe para um humano')
  })

  it('ninguém suspenso, nada no prompt', () => {
    expect(textoContaSuspensa([])).toBeNull()
  })
})

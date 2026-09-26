import { describe, expect, it } from 'vitest'
import { claimsCompletedAction, isGhostConfirmation } from './claimed-action'

// 26/09 — a frase real que a Maria mandou ao Thiago sem ter criado o pedido.
const FRASE_DO_THIAGO = 'Pedido confirmado, Thiago! 😊 O entregador já está a caminho.'
const FRASE_DO_JONATHAN =
  'Sim, Jonathan 😊 O entregador já está a caminho e chega em instantes.'

describe('reconhece a promessa que deixa alguém esperando', () => {
  it('as duas frases reais que viraram pedido fantasma', () => {
    expect(claimsCompletedAction(FRASE_DO_THIAGO)).toBe(true)
    expect(claimsCompletedAction(FRASE_DO_JONATHAN)).toBe(true)
  })

  it('outras formas de dizer a mesma coisa', () => {
    expect(claimsCompletedAction('Pedido registrado! Já mandei o entregador.')).toBe(true)
    expect(claimsCompletedAction('Tudo certo, já deixei lançado no sistema.')).toBe(true)
    expect(claimsCompletedAction('Seu pedido foi gerado com sucesso')).toBe(true)
  })
})

describe('NÃO confunde intenção com ação feita', () => {
  // Aqui mora o alarme falso: se estas dispararem, o dono aprende a ignorar
  // a nota e a rede perde o valor.
  it('perguntar se pode fechar não é ter fechado', () => {
    expect(
      claimsCompletedAction('Fecho assim, Thiago? 1 Ultragaz por R$ 130,00 no crédito.'),
    ).toBe(false)
  })

  it('oferecer não é ter feito', () => {
    expect(claimsCompletedAction('Posso mandar o entregador agora?')).toBe(false)
    expect(claimsCompletedAction('Quer que eu registre o pedido?')).toBe(false)
  })

  it('falar do pedido sem afirmar conclusão', () => {
    expect(claimsCompletedAction('Seu último pedido foi um P-13 no dia 12/06.')).toBe(false)
    expect(claimsCompletedAction('O entregador costuma levar uns 20 minutos.')).toBe(false)
  })

  it('texto vazio não é promessa', () => {
    expect(claimsCompletedAction('')).toBe(false)
    expect(claimsCompletedAction(null)).toBe(false)
  })
})

describe('só acusa quando NADA foi gravado', () => {
  it('afirmou e não gravou nada → é fantasma', () => {
    expect(
      isGhostConfirmation({
        text: FRASE_DO_THIAGO,
        wroteSomething: false,
        wroteRecently: false,
      }),
    ).toBe(true)
  })

  it('gravou NESTE turno → está tudo certo', () => {
    expect(
      isGhostConfirmation({
        text: FRASE_DO_THIAGO,
        wroteSomething: true,
        wroteRecently: false,
      }),
    ).toBe(false)
  })

  it('repetir confirmação de pedido criado minutos antes NÃO é fantasma', () => {
    // Cliente pergunta "confirmou mesmo?" — a IA repete sem chamar de novo.
    expect(
      isGhostConfirmation({
        text: FRASE_DO_THIAGO,
        wroteSomething: false,
        wroteRecently: true,
      }),
    ).toBe(false)
  })

  it('conversa normal sem escrita nenhuma não vira alarme', () => {
    expect(
      isGhostConfirmation({
        text: 'Bom dia! Como posso ajudar?',
        wroteSomething: false,
        wroteRecently: false,
      }),
    ).toBe(false)
  })
})

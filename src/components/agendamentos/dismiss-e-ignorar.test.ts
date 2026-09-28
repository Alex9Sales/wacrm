import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Os dois pedidos do Rafael (28/09):
 *  1. "das mensagens que deu erro, coloca um x para apagar ou limpar, porque
 *     umas nem vai mais fazer sentido enviar";
 *  2. "coloca um x para fechar [a janela da ligação], mas ela continua tocando
 *     — no silencioso".
 *
 * Os dois têm a mesma armadilha: o "x" precisa DISPENSAR sem DESTRUIR. Na
 * agendada, não pode levar junto a pendente que ainda vai sair; na ligação,
 * não pode recusar a chamada de quem está ligando. É isso que estes testes
 * travam.
 */
const ler = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('x das agendadas que falharam', () => {
  const actions = ler('src/app/(dashboard)/agendamentos/actions.ts')
  const bloco = actions.slice(actions.indexOf('dismissFailedSchedules'))

  it('só mexe no que FALHOU — pendente num número caído ainda pode sair', () => {
    expect(bloco).toMatch(/eq\(scheduledMessages\.status, 'failed'\)/)
    expect(bloco).not.toMatch(/inArray\(scheduledMessages\.status/)
  })

  it('cancela em vez de apagar: some do aviso e fica o registro', () => {
    expect(bloco).toMatch(/status:\s*'cancelled'/)
    expect(bloco).not.toMatch(/\.delete\(scheduledMessages\)/)
  })

  it('escreve por que foi descartada, senão vira cancelamento sem história', () => {
    expect(bloco).toMatch(/lastError:\s*'descartada pelo operador/)
  })

  it('exige supervisor, como as outras ações da tela', () => {
    expect(bloco).toMatch(/requireRole\('supervisor'\)/)
  })

  it('o filtro de status também está no UPDATE, não só na leitura', () => {
    // Sem isso, uma mensagem que saísse de `failed` entre o SELECT e o UPDATE
    // seria cancelada junto.
    const upd = bloco.slice(bloco.indexOf('.update(scheduledMessages)'))
    expect(upd).toMatch(/eq\(scheduledMessages\.status, 'failed'\)/)
  })
})

describe('x da janela de ligação', () => {
  const modal = ler('src/components/calls/incoming-call-modal.tsx')

  it('dispensar NÃO é recusar: minimiza, não derruba a chamada', () => {
    const i = modal.indexOf("front.phase === 'ringing' && (")
    const bloco = modal.slice(i, i + 900)
    expect(bloco).toMatch(/setMinimized\(true\)/)
    expect(bloco).not.toMatch(/reject\(/)
  })

  it('silencia o toque ao dispensar — e só se ainda estiver tocando', () => {
    const i = modal.indexOf("front.phase === 'ringing' && (")
    expect(modal.slice(i, i + 900)).toMatch(
      /if \(!front\.ringMuted\) toggleRingMute\(front\.key\)/,
    )
  })

  it('a pílula do canto aceita chamada tocando, senão o x faria ela sumir', () => {
    expect(modal).toMatch(
      /minimized && \(front\.phase === 'active' \|\| front\.phase === 'ringing'\)/,
    )
  })

  it('de lá dá pra atender e pra recusar', () => {
    const i = modal.indexOf("const ringing = front.phase === 'ringing'")
    const bloco = modal.slice(i, i + 3000)
    expect(bloco).toMatch(/ringing \? \(\s*<button\s*onClick=\{\(\) => answer\(front\.key\)\}/)
    expect(bloco).toMatch(/ringing \? reject\(front\.key\) : hangup\(front\.key\)/)
  })
})

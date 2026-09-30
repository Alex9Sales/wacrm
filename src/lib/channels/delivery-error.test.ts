import { describe, expect, it } from 'vitest'
import { DeliveredButNotRecordedError, jaFoiEntregue } from './delivery-error'

/**
 * 30/09/2026, produção: o lembrete saiu para o Rafael às 15:00, o INSERT em
 * `messages` falhou, quem chamou entendeu "não enviei" e mandou de novo às
 * 15:01. Ele recebeu duas vezes. Cada caso abaixo é uma forma de a resposta
 * voltar a ser "não enviou" por engano — e cada uma custa uma mensagem
 * repetida no WhatsApp de um cliente.
 */
describe('a mensagem já chegou no cliente?', () => {
  it('reconhece a exceção pela classe', () => {
    expect(jaFoiEntregue(new DeliveredButNotRecordedError('3EB0B081B678ECDF', 'timeout'))).toBe(true)
  })

  it('reconhece depois de atravessar uma fila, sem o protótipo', () => {
    // BullMQ serializa o erro: do outro lado chega objeto simples. Se só
    // `instanceof` valesse, a retentativa voltaria a duplicar exatamente aqui.
    const viaFila = JSON.parse(
      JSON.stringify({ ...new DeliveredButNotRecordedError('abc', 'x'), delivered: true }),
    )
    expect(jaFoiEntregue(viaFila)).toBe(true)
  })

  it('reconhece o Error cru que os lugares antigos ainda lançam', () => {
    expect(
      jaFoiEntregue(new Error('sent to provider but DB insert failed: Failed query: insert…')),
    ).toBe(true)
  })

  it('guarda o id do provedor — é a prova da entrega', () => {
    const err = new DeliveredButNotRecordedError('3EB0B081B678ECDF2DF295', 'conexão caiu')
    expect(err.externalMessageId).toBe('3EB0B081B678ECDF2DF295')
    expect(err.message).toContain('conexão caiu')
  })

  it('NÃO confunde com falha de verdade — aí retentar é o certo', () => {
    // Estes são os casos em que o cliente não recebeu nada: segurar e tentar
    // de novo é o comportamento correto.
    expect(jaFoiEntregue(new Error('Request failed with status code 401'))).toBe(false)
    expect(jaFoiEntregue(new Error('session not connected'))).toBe(false)
    expect(jaFoiEntregue(new Error('#132001 Template name does not exist'))).toBe(false)
    expect(jaFoiEntregue(null)).toBe(false)
    expect(jaFoiEntregue(undefined)).toBe(false)
    expect(jaFoiEntregue('')).toBe(false)
    expect(jaFoiEntregue({ delivered: false })).toBe(false)
    expect(jaFoiEntregue({ delivered: 'sim' })).toBe(false) // só o booleano vale
  })
})

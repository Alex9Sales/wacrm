import { describe, expect, it } from 'vitest'

import { asaasPhoneForContact } from './match'

/**
 * Regra do aviso "telefone diferente do Asaas" (carteira, 11/09). A função de
 * verdade vive em cobrancas/actions.ts, que é 'use server'; aqui travamos o
 * que ela decide, que é o que quebra na prática.
 */
const tail = (d: string) => d.replace(/\D/g, '').slice(-8)
const avisa = (asaasRaw: string | null, crmRaw: string | null, contactId: string | null): boolean => {
  if (!contactId) return false
  const asaas = asaasPhoneForContact(asaasRaw)
  if (!asaas || !/^55\d{2}9\d{8}$/.test(asaas)) return false
  const crm = (crmRaw ?? '').replace(/\D/g, '')
  return !(crm && tail(crm) === tail(asaas))
}

describe('aviso de telefone diferente do Asaas', () => {
  it('avisa quando o Asaas tem outro celular', () => {
    expect(avisa('12997075373', '5512991234567', 'c1')).toBe(true)
  })

  it('não avisa quando é o mesmo número escrito diferente', () => {
    expect(avisa('12997075373', '5512997075373', 'c1')).toBe(false)
    expect(avisa('(12) 99707-5373', '5512997075373', 'c1')).toBe(false)
  })

  it('não avisa por causa do nono dígito', () => {
    // O Asaas guarda com 9, a ficha sem: mesmos 8 finais, mesma pessoa.
    expect(avisa('12997075373', '551297075373', 'c1')).toBe(false)
  })

  it('fixo no Asaas não vira aviso (não tem WhatsApp)', () => {
    expect(avisa('1236488533', '5512997075373', 'c1')).toBe(false)
  })

  it('devedor sem contato ligado não gera aviso', () => {
    expect(avisa('12997075373', null, null)).toBe(false)
  })

  it('contato sem telefone nenhum gera aviso', () => {
    expect(avisa('12997075373', '', 'c1')).toBe(true)
  })
})

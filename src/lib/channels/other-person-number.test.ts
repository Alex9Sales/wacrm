import { describe, expect, it } from 'vitest'

import { otherPersonNumber } from './other-person-number'

const JOAO = 'u-joao'
const VITOR = 'u-vitor'
const canalVitor = { provider: 'waha', name: 'Vitor', phone_number: '5512990001234', dedicated_user_id: VITOR }

// 14/09 (João/GoLink): respondeu pelo CRM na conversa do número do Vitor e foi
// procurar a mensagem no próprio celular.
describe('otherPersonNumber', () => {
  it('avisa quando o número da conversa é dedicado a outra pessoa', () => {
    expect(otherPersonNumber(canalVitor, JOAO)).toEqual({ name: 'Vitor', phone: '+55 12 99000-1234' })
  })

  it('não avisa no próprio número', () => {
    expect(otherPersonNumber(canalVitor, VITOR)).toBeNull()
  })

  it('não avisa em número comum da empresa (sem dono)', () => {
    expect(otherPersonNumber({ ...canalVitor, dedicated_user_id: null }, JOAO)).toBeNull()
  })

  it('só vale para WhatsApp: e-mail e Instagram não têm "número de alguém"', () => {
    expect(otherPersonNumber({ ...canalVitor, provider: 'gmail' }, JOAO)).toBeNull()
    expect(otherPersonNumber({ ...canalVitor, provider: 'instagram' }, JOAO)).toBeNull()
    expect(otherPersonNumber({ ...canalVitor, provider: 'meta' }, JOAO)).not.toBeNull()
  })

  it('sem telefone conhecido, avisa só com o nome', () => {
    expect(otherPersonNumber({ ...canalVitor, phone_number: null }, JOAO)).toEqual({ name: 'Vitor', phone: null })
  })

  it('sem canal ou sem usuário, não avisa', () => {
    expect(otherPersonNumber(null, JOAO)).toBeNull()
    expect(otherPersonNumber(canalVitor, null)).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'

import { pickProviderTarget } from './target'

describe('alvo do envio por canal', () => {
  it('WhatsApp oficial com telefone E external_id de e-mail (contato unificado, 08/09) → telefone', () => {
    expect(pickProviderTarget({ provider: 'meta', phoneDigits: '556791875477', externalId: 'sanabriaalex343@gmail.com', email: 'servicos@x.com' })).toEqual({
      target: '556791875477',
      kind: 'phone',
    })
    expect(pickProviderTarget({ provider: 'waha', phoneDigits: '556791875477', externalId: '17841400000000', email: null })).toEqual({ target: '556791875477', kind: 'phone' })
  })
  it('WhatsApp sem telefone só aceita external_id que pareça id de WhatsApp', () => {
    expect(pickProviderTarget({ provider: 'meta', phoneDigits: '', externalId: '556791875477@c.us', email: null })).toEqual({ target: '556791875477@c.us', kind: 'external' })
    expect(pickProviderTarget({ provider: 'meta', phoneDigits: '', externalId: 'alguem@gmail.com', email: null })).toBeNull()
  })
  it('grupo no WhatsApp: telefone (dígitos do jid) marcado como grupo pra quem chama buscar o jid inteiro', () => {
    expect(pickProviderTarget({ provider: 'waha', phoneDigits: '5567925395841481125514', externalId: null, email: null, isGroup: true })).toEqual({
      target: '5567925395841481125514',
      kind: 'group',
    })
  })
  it('e-mail: sempre o e-mail do contato; senão o external_id se for e-mail; senão nada', () => {
    expect(pickProviderTarget({ provider: 'email', phoneDigits: '556791875477', externalId: '17841400000000', email: 'a@b.com' })).toEqual({ target: 'a@b.com', kind: 'email' })
    expect(pickProviderTarget({ provider: 'gmail', phoneDigits: '', externalId: 'lead@empresa.com.br', email: null })).toEqual({ target: 'lead@empresa.com.br', kind: 'email' })
    expect(pickProviderTarget({ provider: 'email', phoneDigits: '556791875477', externalId: '17841400000000', email: null })).toBeNull()
  })
  it('Instagram/Messenger: external_id (IGSID/PSID) mesmo com telefone', () => {
    expect(pickProviderTarget({ provider: 'instagram', phoneDigits: '556791875477', externalId: '17841400000000', email: null })).toEqual({ target: '17841400000000', kind: 'external' })
    expect(pickProviderTarget({ provider: 'messenger', phoneDigits: '', externalId: null, email: null })).toBeNull()
  })
})

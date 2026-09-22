import { describe, expect, it } from 'vitest'

import { editedTextOf } from '@/app/api/webhooks/meta/route'

// ✏️ Zelo 22/09 (conversa da Janice): o cliente editou a mensagem e a API
// oficial mandou type:'edit'. Sem tratamento virava uma mensagem nova escrita
// "[Tipo de mensagem não suportado: edit]", que a Zélia leu como fala do
// cliente e respondeu "não consegui visualizar a mensagem editada".
describe('editedTextOf — o texto novo da mensagem editada', () => {
  it('pega o corpo do texto editado', () => {
    expect(
      editedTextOf({
        original_message_id: 'wamid.ORIGINAL',
        message: { type: 'text', text: { body: 'Ainda não identifiquei o convite' } },
      }),
    ).toBe('Ainda não identifiquei o convite')
  })

  it('pega a legenda quando a edição é de imagem, vídeo ou documento', () => {
    expect(editedTextOf({ message: { type: 'image', image: { caption: 'Nova legenda' } } })).toBe('Nova legenda')
    expect(editedTextOf({ message: { type: 'video', video: { caption: 'Legenda do vídeo' } } })).toBe('Legenda do vídeo')
    expect(editedTextOf({ message: { type: 'document', document: { caption: 'Contrato v2' } } })).toBe('Contrato v2')
  })

  it('devolve null quando não há texto — o webhook não apaga o que já estava', () => {
    expect(editedTextOf(undefined)).toBeNull()
    expect(editedTextOf({ original_message_id: 'wamid.X' })).toBeNull()
    expect(editedTextOf({ message: { type: 'text', text: { body: '   ' } } })).toBeNull()
    expect(editedTextOf({ message: { type: 'audio' } })).toBeNull()
  })
})

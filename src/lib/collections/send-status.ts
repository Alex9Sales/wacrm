// ============================================================
// 📮 Como um envio da régua terminou, em UMA palavra que o dono entende.
//
// Duas coisas diferentes viram uma frase só aqui: o estado do PEDIDO (saiu da
// fila? falhou? expirou?) e o tique da MENSAGEM (chegou no aparelho? foi lida?).
// Para quem olha a tela isso é uma informação só — "a cobrança chegou ou não" —
// e é essa a pergunta que o painel responde.
//
// O pedido manda: "enviado" com tique só existe depois que o pedido saiu.
// ============================================================

export type SendRequestStatus = 'sent' | 'failed' | 'expired' | 'queued' | 'pending'
export type SendDeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed' | null
export type SendTone = 'ok' | 'bom' | 'espera' | 'ruim'

export interface SendOutcome {
  texto: string
  tom: SendTone
}

export function sendOutcome(input: {
  status: SendRequestStatus
  delivery: SendDeliveryStatus
}): SendOutcome {
  if (input.status === 'failed') return { texto: 'falhou', tom: 'ruim' }
  // Rascunho que envelheceu e a régua deixou passar o dia: nunca chegou a sair.
  if (input.status === 'expired') return { texto: 'não saiu', tom: 'ruim' }
  if (input.status === 'queued' || input.status === 'pending') return { texto: 'na fila', tom: 'espera' }
  if (input.delivery === 'read') return { texto: 'lida', tom: 'bom' }
  if (input.delivery === 'delivered') return { texto: 'entregue', tom: 'bom' }
  // Mensagem recusada pelo canal DEPOIS de o pedido sair — some se a gente
  // confiar só no pedido, e é justamente o caso que o dono precisa ver.
  if (input.delivery === 'failed') return { texto: 'falhou', tom: 'ruim' }
  // Saiu, mas sem tique ainda: celular desligado, número sem WhatsApp, ou só
  // demora. "Enviada" é o que a gente sabe de verdade — não prometemos entrega.
  return { texto: 'enviada', tom: 'ok' }
}

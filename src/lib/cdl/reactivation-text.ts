// ============================================================
// Texto do "Chamar de volta" (recompra) — puro, usado pela tela (rascunho que
// o humano aprova) e pela fila automática (lib/ai/autonomy.ts).
//
// O que o sistema SABE (dias sem comprar, ciclo, atraso) decide QUEM chamar e
// QUANDO — não vai pra mensagem. 19/09 (Alex): "Vi que já faz 57 dias do seu
// último P-13" soa a cadastro lido em voz alta; o cliente quer uma atendente
// que lembra dele, não um relatório.
// ============================================================

import { greeting } from './names'
import { parseProductLabel, productNames } from './product-label'

export function reactivationText(
  name: string | null,
  signalType: string,
  rawProduct: string | null | undefined,
): string {
  const oi = greeting(name)
  const hasProduct = parseProductLabel(rawProduct).length > 0
  const prod = productNames(rawProduct)
  if (signalType === 'inactive')
    return hasProduct
      ? `${oi} Sumiu, hein 😄 Faz um tempo que não passa aqui. Tá precisando de ${prod}? Consigo te atender rapidinho.`
      : `${oi} Sumiu, hein 😄 Faz um tempo que não passa aqui. Posso te ajudar com alguma coisa hoje?`
  if (signalType === 'repurchase_overdue')
    return hasProduct
      ? `${oi} 😊 Passando pra saber se já está precisando de ${prod} de novo. Se precisar, consigo te atender hoje.`
      : `${oi} 😊 Passando pra saber se posso te ajudar com um novo pedido. Se precisar, consigo te atender hoje.`
  return hasProduct
    ? `${oi} Passando pra ver se tá na hora de repor o ${prod}. Quer que eu já deixe separado? 😊`
    : `${oi} Passando pra ver se posso te ajudar com um novo pedido. Quer que eu já deixe separado? 😊`
}

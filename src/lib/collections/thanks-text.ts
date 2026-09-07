// ============================================================
// 🧾 "Recebemos, obrigado" — o texto do agradecimento quando o pagamento
// entra (lacuna 1, 07/09; o cliente pediu no áudio: "agradecer recebimentos").
// Puro e variado pela semente: dois clientes no mesmo dia não recebem a mesma
// frase. Nunca inclui link nem pede nada — é um encerramento, não um toque.
// ============================================================

const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

export function thankYouMessage(firstName: string | null, value: number, seed = 0): string {
  const nome = firstName ? `, ${firstName}` : ''
  const valor = value > 0 ? ` de ${brl(value)}` : ''
  const variantes = [
    `Recebemos o seu pagamento${valor}${nome}. Muito obrigado! 🙏 Qualquer coisa, é só chamar por aqui.`,
    `Pagamento${valor} confirmado por aqui${nome}. Obrigado pela atenção e até a próxima! 😊`,
    `Oi${nome}! Só pra avisar que o pagamento${valor} já entrou. Obrigado! Precisando, estamos à disposição.`,
    `Tudo certo${nome}: o pagamento${valor} foi identificado. Agradecemos a confiança! 🙌`,
  ]
  return variantes[(seed >>> 0) % variantes.length]
}

/** Semente estável a partir de um id (mesma cobrança → mesma frase; cobranças diferentes → frases diferentes). */
export function seedFromId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

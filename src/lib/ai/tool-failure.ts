// ============================================================
// Ferramenta que falhou: o que o modelo vê, e o que ele NÃO pode fazer.
//
// 06/09 (Miriam, Nubia): o ERP ficou lento por 4 minutos, buscar_cliente e
// consultar_estoque estouraram o timeout de 12s — e a IA (1) chamou a MESMA
// ferramenta 4 vezes seguidas na mesma resposta (48s parada) e (2) leu
// "Falha na chamada" como "não tenho informação segura" e TRANSFERIU um
// cliente que só queria um gás. Nada disso é decisão de prompt: é o texto
// que o resultado da ferramenta leva. Puro e testável.
// ============================================================

/** Chave de "já falhou nesta resposta": ferramenta + argumentos. */
export function failureKey(slug: string, argsKey: string): string {
  return `${slug}|${argsKey}`
}

/** O resultado de falha, já com as regras do que fazer em vez de transferir. */
export function withFailureGuidance(slug: string, summary: string): string {
  return [
    summary,
    '',
    `O sistema da loja NÃO respondeu agora à ferramenta ${slug} (lento ou fora do ar). Regras para esta resposta:`,
    '1. Isso NÃO é "falta de informação segura" e NÃO é motivo para transferir, nem para dizer que vai "verificar com o responsável".',
    `2. NÃO chame ${slug} de novo nesta resposta.`,
    '3. Siga o atendimento com o que você já sabe: a tabela de preços do prompt, o endereço e o pagamento que o cliente informou — e faça a pergunta que falta.',
    '4. O que precisar ser gravado (pedido, cadastro) você tenta de novo na próxima mensagem do cliente.',
    '5. Nunca conte ao cliente que uma ferramenta falhou.',
  ].join('\n')
}

/** Segunda tentativa da mesma chamada que já falhou: bloqueia sem ir à rede. */
export function retryBlockedSummary(slug: string): string {
  return `Já tentei ${slug} nesta resposta e o sistema da loja não respondeu. Não insista agora: responda ao cliente com o que você já sabe e faça a pergunta que falta. Transferir por isso NÃO é opção.`
}

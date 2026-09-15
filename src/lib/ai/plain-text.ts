// ============================================================
// Texto da IA sem marcação de markdown, para exibir no card.
//
// 15/09 (Alex): a descrição de um comprovante saiu "- **Valor:** R$ 936,13" e
// o balão mostrava os asteriscos crus. O modelo de visão às vezes formata em
// markdown; o prompt agora pede texto simples, e isto limpa as descrições que
// já estão gravadas. Conservador: só tira marcação que embrulha texto — "5 * 3"
// continua como está.
//
// Puro (client-safe).
// ============================================================

export function plainAiText(text: string): string {
  return (
    text
      // **negrito** e __negrito__
      .replace(/\*\*([^*\n]+?)\*\*/g, '$1')
      .replace(/__([^_\n]+?)__/g, '$1')
      // *itálico* colado no texto (não mexe em "5 * 3")
      .replace(/(^|[\s(])\*([^\s*](?:[^*\n]*?[^\s*])?)\*(?=[\s).,;:!?]|$)/gm, '$1$2')
      // # títulos no começo da linha
      .replace(/^#{1,6}\s+/gm, '')
      // `código`
      .replace(/`([^`\n]+)`/g, '$1')
      // ** que sobrou sem par
      .replace(/\*\*/g, '')
  )
}

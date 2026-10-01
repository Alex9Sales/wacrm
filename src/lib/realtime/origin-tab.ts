// ============================================================
// Id da ABA que fez o envio, para o aviso em tempo real.
//
// 01/10: a resposta digitada por um atendente só aparecia na tela dos colegas
// com F5. A rota do composer não avisava ninguém porque a aba de quem digitou
// já mostra a bolha otimista (`temp-…`) e só troca pelo id real quando o envio
// responde — um refetch disparado pelo aviso antes disso deixava DUAS bolhas.
// Agora o composer manda o id desta aba, o aviso volta com ele, e só a aba
// de origem deixa de recarregar o thread. Colegas (e outra aba do mesmo
// usuário) recarregam normalmente.
//
// Sem localStorage de propósito: duas abas do mesmo usuário são abas
// diferentes. Sem `server-only`: a rota usa o validador.
// ============================================================

const ORIGIN_TAB_ID_RE = /^[A-Za-z0-9-]{1,64}$/

/** Valida o id vindo do corpo da requisição; qualquer coisa fora do formato é ignorada. */
export function parseOriginTabId(value: unknown): string | undefined {
  return typeof value === 'string' && ORIGIN_TAB_ID_RE.test(value) ? value : undefined
}

let tabId: string | null = null

/** Id desta aba: gerado na primeira chamada e fixo até a página recarregar. */
export function thisTabId(): string {
  if (tabId) return tabId
  const c = (globalThis as { crypto?: Crypto }).crypto
  // randomUUID só existe em contexto seguro (https/localhost).
  tabId =
    typeof c?.randomUUID === 'function'
      ? c.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`
  return tabId
}

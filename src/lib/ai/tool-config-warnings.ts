// ============================================================
// ⚠️ Avisos de configuração da ferramenta externa.
//
// 25/09: um cliente montou a ferramenta do tutor, salvou, e a tela deixou.
// Faltavam os PARÂMETROS e o CORPO — então toda chamada sairia com "{}" e a
// API dele recusaria. Ele não errou por distração: a tela aceitava calada
// uma configuração que nasce inútil, e o erro só apareceria no primeiro
// cliente real, como "não consegui consultar".
//
// Estas regras são puras de propósito: a tela avisa ANTES de salvar, em vez
// de o defeito sair pelo WhatsApp de alguém.
// ============================================================

export interface ToolConfigInput {
  method: string
  /** Nomes dos parâmetros que a IA preenche. */
  paramNames: string[]
  bodyTemplate: string
  url: string
}

export interface ToolWarning {
  /** 'blocker' = a chamada não tem como funcionar; 'check' = provável engano. */
  level: 'blocker' | 'check'
  text: string
}

/** Métodos que levam corpo. GET/DELETE mandam tudo na query string. */
const HAS_BODY = new Set(['POST', 'PUT', 'PATCH'])

/** Placeholders {assim} usados num texto. */
export function placeholdersIn(text: string): string[] {
  return [...(text ?? '').matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((m) => m[1])
}

/**
 * O que está errado nesta configuração, em português de gente.
 *
 * Só aponta o que REALMENTE quebra ou quase certamente é engano — aviso
 * genérico demais vira ruído e as pessoas param de ler.
 */
export function toolConfigWarnings(input: ToolConfigInput): ToolWarning[] {
  const out: ToolWarning[] = []
  const method = (input.method || 'GET').toUpperCase()
  const levaCorpo = HAS_BODY.has(method)
  const params = new Set(input.paramNames.filter(Boolean))
  const corpo = (input.bodyTemplate ?? '').trim()

  // 1) O caso do tutor: POST sem parâmetro e sem corpo → sai "{}".
  if (levaCorpo && params.size === 0 && !corpo) {
    out.push({
      level: 'blocker',
      text: 'Esta ferramenta vai enviar uma requisição vazia. Em POST, o que segue para a API vem dos parâmetros ou do corpo — sem nenhum dos dois, a API recebe "{}" e vai recusar. Adicione os parâmetros que a IA precisa preencher (e o corpo, se a API exigir campos fixos).',
    })
  }

  // 2) Corpo pede {campo} que não existe como parâmetro: a IA nunca preenche
  //    e o literal "{campo}" viaja para a API.
  const noCorpo = placeholdersIn(corpo).filter((p) => !params.has(p))
  if (corpo && noCorpo.length > 0) {
    out.push({
      level: 'blocker',
      text: `O corpo usa ${noCorpo.map((p) => `{${p}}`).join(', ')}, mas ${noCorpo.length === 1 ? 'esse campo não está' : 'esses campos não estão'} na lista de parâmetros. A IA não tem como preencher: adicione ${noCorpo.length === 1 ? 'o parâmetro' : 'os parâmetros'} com esse nome exato.`,
    })
  }

  // 3) Mesma coisa na URL.
  const naUrl = placeholdersIn(input.url ?? '').filter((p) => !params.has(p))
  if (naUrl.length > 0) {
    out.push({
      level: 'blocker',
      text: `A URL usa ${naUrl.map((p) => `{${p}}`).join(', ')}, mas ${naUrl.length === 1 ? 'esse campo não está' : 'esses campos não estão'} na lista de parâmetros. Adicione com o mesmo nome, senão a chamada vai para um endereço inválido.`,
    })
  }

  // 4) Parâmetro declarado que não aparece em lugar nenhum. Em POST sem corpo
  //    isso é normal (os parâmetros viram o corpo inteiro), então só avisa
  //    quando há corpo escrito à mão e o parâmetro ficou de fora dele.
  if (corpo) {
    const usados = new Set([...placeholdersIn(corpo), ...placeholdersIn(input.url ?? '')])
    const sobrando = [...params].filter((p) => !usados.has(p))
    if (sobrando.length > 0) {
      out.push({
        level: 'check',
        text: `${sobrando.map((p) => `"${p}"`).join(', ')} ${sobrando.length === 1 ? 'está na lista de parâmetros mas não aparece' : 'estão na lista de parâmetros mas não aparecem'} no corpo nem na URL. A IA vai preencher e o valor não vai a lugar nenhum.`,
      })
    }
  }

  return out
}

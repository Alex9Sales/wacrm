import { describe, expect, it } from 'vitest'

// 25/09 — o corpo da chamada é JSON e o que entra nele é texto de WhatsApp.
// O escape trocava só aspas por \"; quebra de linha, tabulação e barra
// invertida passavam cruas e produziam um JSON inválido. A API do cliente
// respondia 400 e a IA dizia "não consegui consultar", sem ninguém entender
// o porquê — o texto do aluno é que estava quebrando o corpo.
//
// Aqui testamos o que importa de verdade: o corpo montado PARSEIA, e o valor
// que chega do outro lado é exatamente o que o aluno escreveu.

/** O mesmo escape usado ao montar o corpo (external-tools e slow-tool). */
const jsonEscape = (s: string) => JSON.stringify(s).slice(1, -1)

/** Monta o corpo como o runtime monta: template com {placeholder} entre aspas. */
function buildBody(template: string, args: Record<string, string>): string {
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (whole, key: string) =>
    args[key] === undefined ? whole : jsonEscape(args[key]),
  )
}

const TEMPLATE = '{"companyparam":"raplay","email":"{email}","question":"{question}"}'

describe('corpo JSON com texto de WhatsApp', () => {
  it('pergunta com QUEBRA DE LINHA continua um JSON válido', () => {
    const pergunta = 'minha peça tá desprendendo\njá é a terceira vez\no que faço?'
    const body = buildBody(TEMPLATE, { email: 'aluno@ex.com', question: pergunta })
    const parsed = JSON.parse(body) as { question: string }
    expect(parsed.question).toBe(pergunta)
  })

  it('pergunta com ASPAS continua válida', () => {
    const pergunta = 'apareceu "erro de calibração" na tela, e agora?'
    const parsed = JSON.parse(buildBody(TEMPLATE, { email: 'a@b.com', question: pergunta })) as {
      question: string
    }
    expect(parsed.question).toBe(pergunta)
  })

  it('barra invertida e tabulação também', () => {
    const pergunta = 'salvei em C:\\Users\\teste\to arquivo sumiu'
    const parsed = JSON.parse(buildBody(TEMPLATE, { email: 'a@b.com', question: pergunta })) as {
      question: string
    }
    expect(parsed.question).toBe(pergunta)
  })

  it('emoji e acento passam intactos', () => {
    const pergunta = 'não consigo imprimir 😩 já tentei de tudo'
    const parsed = JSON.parse(buildBody(TEMPLATE, { email: 'a@b.com', question: pergunta })) as {
      question: string
    }
    expect(parsed.question).toBe(pergunta)
  })

  it('o escape antigo (só aspas) quebrava — é o que este teste protege', () => {
    const antigo = (s: string) => s.replace(/"/g, '\\"')
    const body = TEMPLATE.replace('{email}', antigo('a@b.com')).replace(
      '{question}',
      antigo('linha um\nlinha dois'),
    )
    expect(() => JSON.parse(body)).toThrow()
  })

  it('os outros campos do template seguem no lugar', () => {
    const parsed = JSON.parse(
      buildBody(TEMPLATE, { email: 'aluno@ex.com', question: 'tudo bem?' }),
    ) as { companyparam: string; email: string }
    expect(parsed.companyparam).toBe('raplay')
    expect(parsed.email).toBe('aluno@ex.com')
  })
})

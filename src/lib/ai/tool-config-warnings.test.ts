import { describe, expect, it } from 'vitest'

import { toolConfigWarnings, placeholdersIn } from './tool-config-warnings'

// 25/09: um cliente montou a ferramenta do tutor e salvou sem os parâmetros e
// sem o corpo. A tela aceitou calada uma configuração que nasce inútil — toda
// chamada sairia "{}" e a API recusaria, e isso só apareceria no primeiro
// aluno real, como "não consegui consultar".

const base = {
  method: 'POST',
  paramNames: ['email', 'question'],
  bodyTemplate: '{"companyparam":"raplay","email":"{email}","question":"{question}"}',
  url: 'https://api.exemplo.com/ask',
}

describe('o caso que deu origem ao aviso', () => {
  it('POST sem parâmetro e sem corpo: a requisição sai vazia', () => {
    const w = toolConfigWarnings({ ...base, paramNames: [], bodyTemplate: '' })
    expect(w).toHaveLength(1)
    expect(w[0].level).toBe('blocker')
    expect(w[0].text).toMatch(/vazia/i)
  })

  it('a configuração completa não reclama de nada', () => {
    expect(toolConfigWarnings(base)).toHaveLength(0)
  })
})

describe('placeholder sem parâmetro correspondente', () => {
  it('corpo usa {email} mas o parâmetro não existe', () => {
    const w = toolConfigWarnings({ ...base, paramNames: ['question'] })
    expect(w.some((x) => x.level === 'blocker' && x.text.includes('{email}'))).toBe(true)
  })

  it('URL usa {id} e ninguém declarou', () => {
    const w = toolConfigWarnings({
      method: 'GET',
      paramNames: [],
      bodyTemplate: '',
      url: 'https://api.exemplo.com/cursos/{courseId}/aulas',
    })
    expect(w.some((x) => x.text.includes('{courseId}'))).toBe(true)
  })

  it('lista os dois quando faltam dois', () => {
    const w = toolConfigWarnings({ ...base, paramNames: [] })
    const texto = w.map((x) => x.text).join(' ')
    expect(texto).toContain('{email}')
    expect(texto).toContain('{question}')
  })
})

describe('parâmetro que não vai a lugar nenhum', () => {
  it('declarado mas ausente do corpo escrito à mão', () => {
    const w = toolConfigWarnings({ ...base, paramNames: ['email', 'question', 'telefone'] })
    const aviso = w.find((x) => x.level === 'check')
    expect(aviso?.text).toContain('telefone')
  })

  it('em POST SEM corpo, os parâmetros viram o corpo — nada a avisar', () => {
    // Caso legítimo: sem bodyTemplate o runtime manda os próprios args.
    expect(toolConfigWarnings({ ...base, bodyTemplate: '' })).toHaveLength(0)
  })
})

describe('GET não precisa de corpo', () => {
  it('GET sem corpo e sem parâmetro não é bloqueio', () => {
    const w = toolConfigWarnings({
      method: 'GET',
      paramNames: [],
      bodyTemplate: '',
      url: 'https://api.exemplo.com/status',
    })
    expect(w).toHaveLength(0)
  })

  it('GET com parâmetro na query string está certo', () => {
    const w = toolConfigWarnings({
      method: 'GET',
      paramNames: ['produto'],
      bodyTemplate: '',
      url: 'https://api.exemplo.com/estoque',
    })
    expect(w).toHaveLength(0)
  })
})

describe('placeholdersIn', () => {
  it('acha os campos entre chaves', () => {
    expect(placeholdersIn('{"a":"{x}","b":"{y}"}')).toEqual(['x', 'y'])
  })

  it('texto sem placeholder devolve lista vazia', () => {
    expect(placeholdersIn('nada aqui')).toEqual([])
    expect(placeholdersIn('')).toEqual([])
  })
})

// 25/09, primeiro uso real: o cliente colou a chave sem "Bearer " no campo
// Authorization. A API respondeu "Token is missing" — mensagem que manda
// procurar no lugar errado, porque a chave ESTAVA lá, só sem o esquema.
describe('token colado sem o esquema', () => {
  it('Authorization com a chave crua é bloqueio', () => {
    const w = toolConfigWarnings({
      ...base,
      authHeader: 'Authorization',
      authValue: 'nch_abc123',
    })
    expect(w.some((x) => x.level === 'blocker' && /Bearer/.test(x.text))).toBe(true)
  })

  it('com "Bearer " na frente, nada a avisar', () => {
    const w = toolConfigWarnings({
      ...base,
      authHeader: 'Authorization',
      authValue: 'Bearer nch_abc123',
    })
    expect(w).toHaveLength(0)
  })

  it('Basic e Token também são esquemas válidos', () => {
    for (const v of ['Basic dXNlcjpwYXNz', 'Token abc123']) {
      expect(
        toolConfigWarnings({ ...base, authHeader: 'Authorization', authValue: v }),
      ).toHaveLength(0)
    }
  })

  it('outro header (X-API-Key) recebe a chave crua e está certo', () => {
    const w = toolConfigWarnings({
      ...base,
      authHeader: 'X-API-Key',
      authValue: 'abc123',
    })
    expect(w).toHaveLength(0)
  })

  it('editando sem redigitar o valor, não reclama do que está guardado', () => {
    const w = toolConfigWarnings({ ...base, authHeader: 'Authorization', authValue: '' })
    expect(w).toHaveLength(0)
  })
})

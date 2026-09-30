import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 30/09/2026 — o lembrete de consulta parou em TODOS os clientes por um
 * comentário.
 *
 * Dentro de um template `sql` do Drizzle, escrevi uma explicação com o número
 * de vagas interpolado:
 *
 *     -- ... e ainda ocuparia uma das ${PER_AGENT_CAP} vagas ...
 *
 * O Drizzle não lê SQL: trocou a interpolação por um parâmetro ligado ($3). O
 * Postgres, esse sim, lê — e o `--` esconde o $3 dele. Resultado:
 * "could not determine data type of parameter $3", a consulta inteira recusada,
 * a varredura abortando na PRIMEIRA conta e nenhum lembrete de consulta saindo
 * em lugar nenhum. Uma hora e vinte de silêncio, 78 falhas no log, e a tela
 * dizia que estava tudo bem.
 *
 * O teste é feio de propósito: lê o código-fonte. Um comentário não tem como
 * ser coberto por teste de comportamento — e este custou o recurso inteiro.
 */
const RAIZ = join(__dirname, '..', '..')

function arquivosTs(dir: string, achados: string[] = []): string[] {
  for (const nome of readdirSync(dir)) {
    if (nome === 'node_modules' || nome === '.next') continue
    const caminho = join(dir, nome)
    if (statSync(caminho).isDirectory()) arquivosTs(caminho, achados)
    else if (nome.endsWith('.ts') || nome.endsWith('.tsx')) achados.push(caminho)
  }
  return achados
}

describe('interpolação em comentário SQL', () => {
  it('nenhum arquivo tem ${...} dentro de uma linha de comentário --', () => {
    const culpados: string[] = []
    for (const arquivo of arquivosTs(RAIZ)) {
      const linhas = readFileSync(arquivo, 'utf8').split('\n')
      linhas.forEach((linha, i) => {
        // Comentário SQL de linha inteira com interpolação de template.
        if (/^\s*--/.test(linha) && /\$\{/.test(linha)) {
          culpados.push(`${arquivo.replace(RAIZ, 'src')}:${i + 1} → ${linha.trim().slice(0, 80)}`)
        }
      })
    }
    expect(
      culpados,
      'Interpolação dentro de comentário SQL: o Drizzle vira parâmetro, o Postgres\n' +
        'não enxerga (está depois do --) e RECUSA a consulta inteira. Escreva o\n' +
        'valor à mão no comentário, ou tire a frase de dentro do template.\n\n' +
        culpados.join('\n'),
    ).toEqual([])
  })
})

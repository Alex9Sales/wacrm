import { describe, expect, it } from 'vitest'
import {
  blocoDeAgendasParaPrompt,
  escolherAgenda,
  normalizarNomeDeAgenda,
  type AgendaDisponivel,
} from './agenda-do-profissional'

/**
 * Marcar na agenda errada põe o paciente na cadeira do dentista errado, e
 * ninguém percebe até o dia da consulta. Por isso quase todo caso aqui é sobre
 * RECUSAR, não sobre acertar.
 */
const CLINICA: AgendaDisponivel[] = [
  { id: 'a1', name: 'joycemartinsodontologia@gmail.com' },
  { id: 'a2', name: 'Dr André Cadamuro ' },
  { id: 'a3', name: 'Dra. Bruna Diodatti' },
  { id: 'a4', name: ' Dr. Igor Talamoni' },
  { id: 'a5', name: 'Dra. Juliane Tavares' },
  { id: 'a6', name: 'Dr. Lucas Pracchia' },
  { id: 'a7', name: 'Dra. Leticia Ghilardi' },
  { id: 'a8', name: 'Dra. Patrícia Lopes' },
  { id: 'a9', name: 'Dra Alessandra M' },
  { id: 'a10', name: 'Dra Simone Magalhães' },
]

describe('achar a agenda do profissional', () => {
  it('acha pelo primeiro nome, que é como a IA escreve', () => {
    expect(escolherAgenda('Dra. Bruna', CLINICA)).toMatchObject({ id: 'a3' })
    expect(escolherAgenda('Dr. Lucas', CLINICA)).toMatchObject({ id: 'a6' })
    expect(escolherAgenda('Igor', CLINICA)).toMatchObject({ id: 'a4' })
  })

  it('aceita o nome completo e ignora o título', () => {
    expect(escolherAgenda('Bruna Diodatti', CLINICA)).toMatchObject({ id: 'a3' })
    expect(escolherAgenda('DOUTORA BRUNA DIODATTI', CLINICA)).toMatchObject({ id: 'a3' })
    expect(escolherAgenda('dr lucas pracchia', CLINICA)).toMatchObject({ id: 'a6' })
  })

  it('não tropeça em acento nem em espaço sobrando do Google', () => {
    // As agendas vêm com espaço no começo/fim e acento, exatamente assim.
    expect(escolherAgenda('Patricia', CLINICA)).toMatchObject({ id: 'a8' })
    expect(escolherAgenda('Patrícia Lopes', CLINICA)).toMatchObject({ id: 'a8' })
    expect(escolherAgenda('andre cadamuro', CLINICA)).toMatchObject({ id: 'a2' })
    expect(escolherAgenda('Simone Magalhaes', CLINICA)).toMatchObject({ id: 'a10' })
  })

  it('RECUSA quando duas agendas poderiam ser', () => {
    const duasSimones: AgendaDisponivel[] = [
      { id: 's1', name: 'Dra Simone Magalhães' },
      { id: 's2', name: 'Dra. Simone Ferreira' },
    ]
    // Chutar aqui é pôr o paciente na cadeira errada.
    expect(escolherAgenda('Simone', duasSimones)).toBe('ambiguo')
    // Com o sobrenome, desempata.
    expect(escolherAgenda('Simone Ferreira', duasSimones)).toMatchObject({ id: 's2' })
  })

  it('devolve null quando não reconhece ninguém', () => {
    expect(escolherAgenda('Dr. Rogério', CLINICA)).toBeNull() // não é da clínica
    expect(escolherAgenda('', CLINICA)).toBeNull()
    expect(escolherAgenda(null, CLINICA)).toBeNull()
    expect(escolherAgenda(undefined, CLINICA)).toBeNull()
    expect(escolherAgenda('Dra.', CLINICA)).toBeNull() // só o título
    expect(escolherAgenda('a', CLINICA)).toBeNull() // letra solta não identifica
  })

  it('sem agendas cadastradas, não inventa', () => {
    expect(escolherAgenda('Bruna', [])).toBeNull()
  })

  it('partícula não identifica ninguém', () => {
    // "de", "da", "dos" não podem casar sozinhas com qualquer nome composto.
    expect(escolherAgenda('de', CLINICA)).toBeNull()
  })
})

describe('normalizar o nome', () => {
  it('tira título, acento e pontuação', () => {
    expect(normalizarNomeDeAgenda('Dra. Patrícia Lopes')).toBe('patricia lopes')
    expect(normalizarNomeDeAgenda('  Dr.  André   Cadamuro  ')).toBe('andre cadamuro')
  })

  it('não come palavra que só COMEÇA com o título', () => {
    // "Draco" não pode virar "aco" por causa do "Dra".
    expect(normalizarNomeDeAgenda('Draco Silva')).toBe('draco silva')
    expect(normalizarNomeDeAgenda('Drika')).toBe('drika')
  })
})

describe('o bloco que vai para o prompt', () => {
  it('diz quem está ocupado e quem está livre, por profissional', () => {
    const ocupados = new Map<string, string[]>([['a3', ['qua 01/10 10:00–11:00']]])
    const bloco = blocoDeAgendasParaPrompt(
      [CLINICA[2], CLINICA[5]],
      ocupados,
    )
    expect(bloco).toContain('Dra. Bruna Diodatti — ocupado: qua 01/10 10:00–11:00')
    // O Lucas está livre NAQUELE horário — antes, o ocupado da Bruna bloqueava
    // os outros nove, porque a lista não dizia de quem era.
    expect(bloco).toContain('Dr. Lucas Pracchia — sem compromissos no período')
  })

  it('sem agenda nenhuma, devolve vazio (não polui o prompt)', () => {
    expect(blocoDeAgendasParaPrompt([], new Map())).toBe('')
  })
})

import { describe, expect, it } from 'vitest'
import { pareceConsultaDeAlguem, phoneFromDescription, phoneKey } from './event-contact'

/**
 * Esta função decide a quem vai o lembrete de uma consulta. Errar aqui não é
 * deixar de avisar — é avisar a pessoa errada de que ela tem hora marcada.
 * Por isso os casos abaixo são quase todos sobre RECUSAR, não sobre acertar.
 */
describe('o telefone que vem do Capim na descrição', () => {
  const real = [
    'Paciente: Mateus Menegat Vanzin',
    'Telefone: (54) 9917-1108',
    'Status no Capim: Confirmado',
    'Observação: Limpezaa e rsc',
    'Profissional: Dra. Joyce Martins',
    'Cadeira: 102',
    'Importado do Capim (id 28020374)',
  ].join('\n')

  it('lê o telefone do evento real da clínica', () => {
    expect(phoneFromDescription(real)).toBe('5499171108')
  })

  it('aceita as máscaras que aparecem na prática', () => {
    expect(phoneFromDescription('Telefone: (11) 98424-2024')).toBe('11984242024')
    expect(phoneFromDescription('telefone: 11 9 8424 2024')).toBe('11984242024')
    expect(phoneFromDescription('Telefone:+55 (11) 98424-2024')).toBe('5511984242024')
  })

  it('não confunde com outros números da descrição', () => {
    // "Cadeira: 102" e o id do Capim não podem virar telefone.
    expect(phoneFromDescription('Cadeira: 102\nImportado do Capim (id 28020374)')).toBeNull()
  })

  it('recusa o que não identifica ninguém', () => {
    expect(phoneFromDescription('Telefone: 9917-1108')).toBeNull() // sem DDD
    expect(phoneFromDescription('Telefone: 102')).toBeNull()
    expect(phoneFromDescription('Telefone: a combinar')).toBeNull()
    expect(phoneFromDescription('Telefone:')).toBeNull()
  })

  it('recusa lixo longo — dois números colados não são um', () => {
    expect(phoneFromDescription('Telefone: 11984242024 / 11939614854')).toBeNull()
  })

  it('evento sem descrição fica órfão, e tudo bem', () => {
    expect(phoneFromDescription(null)).toBeNull()
    expect(phoneFromDescription(undefined)).toBeNull()
    expect(phoneFromDescription('')).toBeNull()
    expect(phoneFromDescription('Bloqueado: pausa')).toBeNull()
  })
})

describe('a chave de comparação (8 últimos dígitos)', () => {
  it('o MESMO telefone escrito de três jeitos dá a mesma chave', () => {
    // Capim, CRM antigo e CRM com o 9º dígito.
    expect(phoneKey('(54) 9917-1108')).toBe(phoneKey('5554999171108'))
    expect(phoneKey('11984242024')).toBe(phoneKey('+55 11 98424-2024'))
  })

  it('telefones diferentes não colidem', () => {
    expect(phoneKey('11984242024')).not.toBe(phoneKey('11939614854'))
  })

  it('curto demais não vira chave', () => {
    expect(phoneKey('1234567')).toBeNull()
    expect(phoneKey('')).toBeNull()
    expect(phoneKey(null)).toBeNull()
  })
})

describe('separar CONSULTA de bloqueio de agenda', () => {
  it('reconhece a consulta pelo "Paciente:" que o Capim escreve', () => {
    expect(
      pareceConsultaDeAlguem(
        'Paciente: Ian Douglas Miranda De Azevedo\nStatus no Capim: A confirmar\nCadeira: 102',
      ),
    ).toBe(true)
    expect(pareceConsultaDeAlguem('paciente: Maria')).toBe(true)
  })

  it('NÃO acusa bloqueio de agenda — são 453 para 118 consultas', () => {
    // Marcar estes como "ninguém será avisado" encheria a tela de alerta falso,
    // e alerta que grita à toa deixa de ser lido.
    expect(pareceConsultaDeAlguem('nao agendar')).toBe(false)
    expect(pareceConsultaDeAlguem('Bloqueado: nao marcar')).toBe(false)
    expect(pareceConsultaDeAlguem(null)).toBe(false)
    expect(pareceConsultaDeAlguem('')).toBe(false)
    expect(pareceConsultaDeAlguem('Almoço')).toBe(false)
  })

  it('não confunde a palavra solta com o campo', () => {
    // "paciente" no meio de uma frase não é o campo do Capim.
    expect(pareceConsultaDeAlguem('Retorno do paciente da semana passada')).toBe(false)
    expect(pareceConsultaDeAlguem('Paciente:')).toBe(false) // campo vazio
    expect(pareceConsultaDeAlguem('Paciente:   ')).toBe(false)
  })
})

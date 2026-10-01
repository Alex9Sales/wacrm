import { describe, expect, it } from 'vitest'
import {
  MARCADOR_FLUXIA,
  descricaoParaGoogle,
  eventoParaGoogle,
  rotuloDoBlocoFluxia,
  telefoneLegivel,
  textoTemTelefone,
  tirarBlocoFluxia,
  tituloParaGoogle,
} from './event-patient'
import { pareceConsultaDeAlguem, phoneFromDescription, phoneKey } from './event-contact'

// Dados fictícios (LGPD): nenhum paciente de verdade aqui.
const ANA = { name: 'Ana Teste', phone: '5511912345678' }
const BRUNO = { name: 'Bruno Exemplo', phone: '5521911112222' }

const blocoAna = `${MARCADOR_FLUXIA}\nPaciente: Ana Teste\nTelefone: (11) 91234-5678`

// Como o Capim escreve a descrição (formato real, conteúdo inventado).
const capim = (fone: string) =>
  [
    'Paciente: Carla Ficticia',
    `Telefone: ${fone}`,
    'Status no Capim: A confirmar',
    'Profissional: Dra. Exemplo',
    'Importado do Capim (id 10000001)',
  ].join('\n')

describe('telefone legível', () => {
  it('formata como a recepção escreve, com ou sem o 55', () => {
    expect(telefoneLegivel('5511900000000')).toBe('(11) 90000-0000')
    expect(telefoneLegivel('11900000000')).toBe('(11) 90000-0000') // ERP grava sem 55
    expect(telefoneLegivel('551133334444')).toBe('(11) 3333-4444') // fixo
    expect(telefoneLegivel('+55 (21) 91111-2222')).toBe('(21) 91111-2222')
  })

  it('número de fora vai com + e os dígitos', () => {
    expect(telefoneLegivel('351912345678')).toBe('+351912345678')
  })

  it('sem DDD não identifica ninguém', () => {
    expect(telefoneLegivel('90000000')).toBeNull()
    expect(telefoneLegivel('')).toBeNull()
    expect(telefoneLegivel(null)).toBeNull()
  })
})

describe('descrição que vai para o Google', () => {
  it('acrescenta o bloco do paciente no FIM da descrição do CRM', () => {
    expect(descricaoParaGoogle('rsc', ANA)).toBe(`rsc\n\n${blocoAna}`)
  })

  it('sem descrição, vai só o bloco', () => {
    expect(descricaoParaGoogle(null, ANA)).toBe(blocoAna)
    expect(descricaoParaGoogle('', ANA)).toBe(blocoAna)
  })

  it('é idempotente: aplicar de novo não duplica o bloco', () => {
    const uma = descricaoParaGoogle('rsc\nlevar exames', ANA)
    expect(descricaoParaGoogle(uma, ANA)).toBe(uma)
    expect(descricaoParaGoogle(descricaoParaGoogle(uma, ANA), ANA)).toBe(uma)
  })

  it('também sobre o que volta do Google com CRLF ou espaço sobrando', () => {
    const voltou = `rsc\r\n\r\n${MARCADOR_FLUXIA}  \r\nPaciente: Ana Teste\r\nTelefone: (11) 91234-5678\n`
    expect(descricaoParaGoogle(voltou, ANA)).toBe(`rsc\n\n${blocoAna}`)
  })

  it('e sobre o HTML que o Google devolve quando alguém edita pela tela dele', () => {
    const html = `rsc<br><br>${MARCADOR_FLUXIA}<br>Paciente: Ana Teste<br>Telefone: (11) 91234-5678`
    expect(tirarBlocoFluxia(html)).toBe('rsc')
    expect(descricaoParaGoogle(html, ANA)).toBe(`rsc\n\n${blocoAna}`)
  })

  it('trocou o paciente: o bloco velho sai e entra o atual', () => {
    const comAna = descricaoParaGoogle('rsc', ANA)
    const comBruno = descricaoParaGoogle(comAna, BRUNO)
    expect(comBruno).toBe(`rsc\n\n${MARCADOR_FLUXIA}\nPaciente: Bruno Exemplo\nTelefone: (21) 91111-2222`)
    expect(comBruno?.split(MARCADOR_FLUXIA)).toHaveLength(2)
  })

  it('sem paciente ligado: tira SÓ o bloco do FluxiaCRM', () => {
    expect(descricaoParaGoogle(`rsc\nlevar exames\n\n${blocoAna}`, null)).toBe('rsc\nlevar exames')
    expect(descricaoParaGoogle(blocoAna, null)).toBe('') // esvazia no Google também
    expect(descricaoParaGoogle('rsc', null)).toBe('rsc')
    expect(descricaoParaGoogle(null, null)).toBeNull() // nada a mandar: o Google fica como está
  })

  it('evento do Capim que já traz o telefone do paciente fica como está', () => {
    // Mesmo número escrito sem o 55 e sem o 9º dígito: é a mesma pessoa.
    const desc = capim('(11) 1234-5678')
    expect(descricaoParaGoogle(desc, ANA)).toBe(desc)
    expect(descricaoParaGoogle(capim('(11) 91234-5678'), ANA)).toBe(capim('(11) 91234-5678'))
  })

  it('NUNCA tira as linhas do Capim — nem "Paciente:" e "Telefone:" que não são nossos', () => {
    // Capim com outro número (paciente trocado no CRM) + um bloco nosso antigo.
    const desc = `${capim('(31) 93333-4444')}\n\n${blocoAna}`
    expect(descricaoParaGoogle(desc, BRUNO)).toBe(
      `${capim('(31) 93333-4444')}\n\n${MARCADOR_FLUXIA}\nPaciente: Bruno Exemplo\nTelefone: (21) 91111-2222`,
    )
    expect(descricaoParaGoogle(capim('(31) 93333-4444'), null)).toBe(capim('(31) 93333-4444'))
  })

  it('não tira o que alguém escreveu DEPOIS do bloco, lá no Google', () => {
    expect(tirarBlocoFluxia(`rsc\n\n${blocoAna}\nchegar 10 min antes`)).toBe('rsc\nchegar 10 min antes')
  })

  it('a marcadora no meio de uma linha não é bloco', () => {
    const desc = `ver ${MARCADOR_FLUXIA} depois\nPaciente: Fulano`
    expect(tirarBlocoFluxia(desc)).toBe(desc)
  })

  it('contato sem nome leva só o telefone; sem telefone, só o nome; sem nada, nada', () => {
    expect(descricaoParaGoogle('rsc', { name: null, phone: '5511900000000' })).toBe(
      `rsc\n\n${MARCADOR_FLUXIA}\nTelefone: (11) 90000-0000`,
    )
    // Nome que é o próprio telefone não é nome.
    expect(descricaoParaGoogle('rsc', { name: '+55 11 90000-0000', phone: '5511900000000' })).toBe(
      `rsc\n\n${MARCADOR_FLUXIA}\nTelefone: (11) 90000-0000`,
    )
    // Contato do Instagram: sem telefone.
    expect(descricaoParaGoogle('rsc', { name: 'Ana Teste', phone: '' })).toBe(
      `rsc\n\n${MARCADOR_FLUXIA}\nPaciente: Ana Teste`,
    )
    expect(descricaoParaGoogle('rsc', { name: '', phone: '' })).toBe('rsc')
    expect(descricaoParaGoogle(null, { name: null, phone: null })).toBeNull()
  })

  it('o bloco só-telefone também é idempotente', () => {
    const p = { name: null, phone: '5511900000000' }
    const uma = descricaoParaGoogle('rsc', p)
    expect(descricaoParaGoogle(uma, p)).toBe(uma)
  })
})

describe('ida e volta: o import religa o MESMO contato', () => {
  it('phoneFromDescription lê o telefone do bloco', () => {
    for (const desc of [null, 'rsc', 'Retorno\nlevar raio-x']) {
      const noGoogle = descricaoParaGoogle(desc, ANA)
      expect(phoneKey(phoneFromDescription(noGoogle))).toBe(phoneKey(ANA.phone))
    }
  })

  it('também com o telefone sem 55 que o ERP grava', () => {
    const noGoogle = descricaoParaGoogle('rsc', { name: 'Ana Teste', phone: '11912345678' })
    expect(phoneKey(phoneFromDescription(noGoogle))).toBe(phoneKey(ANA.phone))
  })

  it('vira "consulta de alguém" (some o alerta de consulta órfã)', () => {
    expect(pareceConsultaDeAlguem(descricaoParaGoogle('rsc', ANA))).toBe(true)
  })
})

describe('título que vai para o Google', () => {
  it('acrescenta o nome do paciente', () => {
    expect(tituloParaGoogle('RSC', ANA)).toBe('RSC · Ana Teste')
  })

  it('é idempotente', () => {
    const uma = tituloParaGoogle('RSC', ANA)
    expect(tituloParaGoogle(uma, ANA)).toBe(uma)
    expect(tituloParaGoogle(uma, ANA, 'Ana Teste')).toBe(uma)
  })

  it('não repete o nome que o título já tem — sem acento e sem maiúscula', () => {
    expect(tituloParaGoogle('Consulta ana teste', ANA)).toBe('Consulta ana teste')
    expect(tituloParaGoogle('Limpeza CONCEICAO', { name: 'Conceição Teste', phone: null })).toBe(
      'Limpeza CONCEICAO',
    )
  })

  it('basta o primeiro nome: o título do Capim traz o nome completo, o contato traz outro pedaço', () => {
    // Decisão: o título "já tem o paciente" quando contém o PRIMEIRO nome como
    // palavra inteira. Exigir o nome completo duplicaria quase todo evento do
    // Capim, que guarda "Ana Maria Pereira Teste" enquanto a recepção salvou o
    // contato como "Ana Pereira" — viraria "Ana Maria Pereira Teste · Ana
    // Pereira". O custo é aceitável: se outra "Ana" estiver no título, o nome
    // completo continua no bloco da descrição.
    expect(tituloParaGoogle('Ana Maria Pereira Teste', { name: 'Ana Pereira', phone: null })).toBe(
      'Ana Maria Pereira Teste',
    )
  })

  it('o primeiro nome tem que ser a palavra inteira', () => {
    expect(tituloParaGoogle('Banana', ANA)).toBe('Banana · Ana Teste')
    expect(tituloParaGoogle('Mariana', { name: 'Maria Teste', phone: null })).toBe('Mariana · Maria Teste')
  })

  it('pronome de tratamento não conta como primeiro nome', () => {
    expect(tituloParaGoogle('Reunião com a Dra', { name: 'Dra. Ana Teste', phone: null })).toBe(
      'Reunião com a Dra · Dra. Ana Teste',
    )
  })

  it('título vazio vira só o paciente', () => {
    expect(tituloParaGoogle('', ANA)).toBe('Ana Teste')
    expect(tituloParaGoogle('(sem título)', ANA)).toBe('Ana Teste')
  })

  it('contato sem nome: vai o telefone, uma vez só', () => {
    const p = { name: null, phone: '5511900000000' }
    expect(tituloParaGoogle('RSC', p)).toBe('RSC · (11) 90000-0000')
    expect(tituloParaGoogle('RSC · (11) 90000-0000', p)).toBe('RSC · (11) 90000-0000')
  })

  it('sem paciente, o título não muda', () => {
    expect(tituloParaGoogle('RSC', null)).toBe('RSC')
    expect(tituloParaGoogle('RSC', { name: null, phone: null })).toBe('RSC')
  })

  it('trocou o paciente: sai o nome antigo, entra o novo', () => {
    expect(tituloParaGoogle('RSC · Ana Teste', BRUNO, 'Ana Teste')).toBe('RSC · Bruno Exemplo')
    expect(tituloParaGoogle('Ana Teste', BRUNO, 'Ana Teste')).toBe('Bruno Exemplo')
  })

  it('desligou o paciente: o sufixo sai', () => {
    expect(tituloParaGoogle('RSC · Ana Teste', null, 'Ana Teste')).toBe('RSC')
    // Título que era só o nome não fica vazio.
    expect(tituloParaGoogle('Ana Teste', null, 'Ana Teste')).toBe('Ana Teste')
  })
})

describe('o compromisso inteiro, indo e voltando pelo sync', () => {
  it('criar → voltar pelo import → salvar de novo não muda nada', () => {
    const ida = eventoParaGoogle({ title: 'RSC', description: null }, ANA)
    expect(ida).toEqual({ summary: 'RSC · Ana Teste', description: blocoAna })

    // O import sobrescreve título e descrição do CRM com o que veio do Google.
    const noCrm = { title: ida.summary, description: ida.description }
    expect(eventoParaGoogle(noCrm, ANA)).toEqual(ida)
  })

  it('trocar o paciente depois que voltou troca título e bloco', () => {
    const ida = eventoParaGoogle({ title: 'RSC', description: 'levar exames' }, ANA)
    const noCrm = { title: ida.summary, description: ida.description }
    expect(rotuloDoBlocoFluxia(noCrm.description)).toBe('Ana Teste')
    expect(eventoParaGoogle(noCrm, BRUNO)).toEqual({
      summary: 'RSC · Bruno Exemplo',
      description: `levar exames\n\n${MARCADOR_FLUXIA}\nPaciente: Bruno Exemplo\nTelefone: (21) 91111-2222`,
    })
    expect(eventoParaGoogle(noCrm, null)).toEqual({ summary: 'RSC', description: 'levar exames' })
  })

  it('evento do Capim: o título ganha o nome se não tiver, a descrição fica', () => {
    const desc = capim('(11) 91234-5678')
    expect(eventoParaGoogle({ title: 'Limpeza', description: desc }, ANA)).toEqual({
      summary: 'Limpeza · Ana Teste',
      description: desc,
    })
  })
})

describe('telefone escrito no texto', () => {
  it('acha o número com qualquer máscara, pelos 8 últimos dígitos', () => {
    expect(textoTemTelefone('Telefone: (11) 1234-5678', ANA.phone)).toBe(true) // sem o 9º dígito
    expect(textoTemTelefone('ligar 11 91234 5678 antes', ANA.phone)).toBe(true)
  })

  it('não confunde com id do Capim, cadeira ou data', () => {
    // Mesmos 8 dígitos finais, mas sem DDD: não é telefone.
    expect(textoTemTelefone('Importado do Capim (id 12345678)', ANA.phone)).toBe(false)
    expect(textoTemTelefone('Cadeira: 102\n01/10/2026 13:30-19:00', ANA.phone)).toBe(false)
    expect(textoTemTelefone('Telefone: (21) 91111-2222', ANA.phone)).toBe(false)
  })
})

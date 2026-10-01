import { describe, expect, it } from 'vitest'
import {
  MARCADOR_FLUXIA,
  descricaoEmTexto,
  descricaoParaGoogle,
  levarPacienteAoGoogle,
  pareceReuniaoComConvidados,
  telefoneLegivel,
  textoTemTelefone,
  tirarBlocoFluxia,
} from './event-patient'
import { pareceConsultaDeAlguem, phoneFromDescription, phoneKey } from './event-contact'

// Dados fictícios (LGPD): nenhum paciente de verdade aqui.
const ANA = { name: 'Ana Teste', phone: '5511912345678' }
const BRUNO = { name: 'Bruno Exemplo', phone: '5521911112222' }

const blocoAna = `${MARCADOR_FLUXIA}\nPaciente: Ana Teste\nTelefone: (11) 91234-5678`
const blocoAnaHtml = `${MARCADOR_FLUXIA}<br>Paciente: Ana Teste<br>Telefone: (11) 91234-5678`
const blocoBrunoHtml = `${MARCADOR_FLUXIA}<br>Paciente: Bruno Exemplo<br>Telefone: (21) 91111-2222`

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
    expect(telefoneLegivel('555499171108')).toBe('(54) 9917-1108') // celular sem o 9º dígito
    expect(telefoneLegivel('55912345678')).toBe('(55) 91234-5678') // DDD 55 (RS), sem o país
  })

  it('número de fora vai com + e os dígitos', () => {
    expect(telefoneLegivel('351912345678')).toBe('+351912345678')
  })

  it('só é brasileiro o que é número brasileiro válido', () => {
    // EUA sem o "+": DDD "12" existe, mas celular de 11 dígitos começa com 9.
    expect(telefoneLegivel('12025550123')).toBe('+12025550123')
    expect(telefoneLegivel('+1 202 555 0123')).toBe('+12025550123')
    // DDD com zero não existe.
    expect(telefoneLegivel('0800123456')).toBe('+0800123456')
    expect(telefoneLegivel('2091234567')).toBe('+2091234567')
    // Fixo/celular antigo de 10 dígitos não começa com 0 ou 1.
    expect(telefoneLegivel('1112345678')).toBe('+1112345678')
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

  it('trocou o paciente: o bloco velho sai e entra o atual', () => {
    const comAna = descricaoParaGoogle('rsc', ANA)
    const comBruno = descricaoParaGoogle(comAna, BRUNO)
    expect(comBruno).toBe(`rsc\n\n${MARCADOR_FLUXIA}\nPaciente: Bruno Exemplo\nTelefone: (21) 91111-2222`)
    expect(comBruno.split(MARCADOR_FLUXIA)).toHaveLength(2)
  })

  it('sem paciente ligado: tira SÓ o bloco do FluxiaCRM', () => {
    expect(descricaoParaGoogle(`rsc\nlevar exames\n\n${blocoAna}`, null)).toBe('rsc\nlevar exames')
    expect(descricaoParaGoogle(blocoAna, null)).toBe('') // esvazia no Google também
    expect(descricaoParaGoogle('rsc', null)).toBe('rsc')
    expect(descricaoParaGoogle(null, null)).toBe('')
  })

  it('sem bloco e sem paciente, a descrição vai EXATAMENTE como está', () => {
    expect(descricaoParaGoogle('  rsc\n', null)).toBe('  rsc\n')
    expect(tirarBlocoFluxia('<b>rsc</b> ')).toBe('<b>rsc</b> ')
  })

  it('evento do Capim que já traz o telefone do paciente fica como está', () => {
    // Mesmo número escrito sem o 55 e sem o 9º dígito: é a mesma pessoa.
    const desc = capim('(11) 1234-5678')
    expect(descricaoParaGoogle(desc, ANA)).toBe(desc)
    expect(descricaoParaGoogle(capim('(11) 91234-5678'), ANA)).toBe(capim('(11) 91234-5678'))
    // Também quando o Capim voltou em HTML, com &nbsp; no número.
    const html = capim('(11)&nbsp;91234-5678').replace(/\n/g, '<br>')
    expect(descricaoParaGoogle(html, ANA)).toBe(html)
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
    expect(tirarBlocoFluxia(`${blocoAna}\nchegar 10 min antes`)).toBe('chegar 10 min antes')
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
    expect(descricaoParaGoogle(null, { name: null, phone: null })).toBe('')
  })

  it('nome sem nenhuma letra não é nome: vai só o telefone', () => {
    const soTelefone = `rsc\n\n${MARCADOR_FLUXIA}\nTelefone: (11) 91234-5678`
    for (const name of ['🌸🌸', '...', '123.456.789-01', '12.345.678/0001-90', '12345678901']) {
      expect(descricaoParaGoogle('rsc', { name, phone: ANA.phone })).toBe(soTelefone)
    }
    // E sem telefone, nada vai — CPF não pode parar na agenda do Google.
    expect(descricaoParaGoogle('rsc', { name: '123.456.789-01', phone: null })).toBe('rsc')
  })

  it('nome em outra escrita ou só com pronome continua sendo nome', () => {
    expect(descricaoParaGoogle(null, { name: 'Юлия', phone: null })).toBe(`${MARCADOR_FLUXIA}\nPaciente: Юлия`)
    expect(descricaoParaGoogle(null, { name: 'Dra.', phone: null })).toBe(`${MARCADOR_FLUXIA}\nPaciente: Dra.`)
  })

  it('o bloco só-telefone também é idempotente', () => {
    const p = { name: null, phone: '5511900000000' }
    const uma = descricaoParaGoogle('rsc', p)
    expect(descricaoParaGoogle(uma, p)).toBe(uma)
  })

  it('"<" e ">" saem do nome — "Ana <3" não quebra o bloco nem estraga o texto da recepção', () => {
    const p = { name: 'Ana <3', phone: ANA.phone }
    const uma = descricaoParaGoogle('levar exames', p)
    expect(uma).toBe(`levar exames\n\n${MARCADOR_FLUXIA}\nPaciente: Ana 3\nTelefone: (11) 91234-5678`)
    expect(descricaoParaGoogle(uma, p)).toBe(uma)
    expect(descricaoParaGoogle(descricaoParaGoogle(uma, p), p)).toBe(uma)
    expect(tirarBlocoFluxia(uma)).toBe('levar exames')

    // Sem telefone o "<3" acumulava a cada salvamento.
    const semFone = { name: 'Ana <3', phone: null }
    const s1 = descricaoParaGoogle('levar exames', semFone)
    expect(descricaoParaGoogle(s1, semFone)).toBe(s1)
    expect(tirarBlocoFluxia(s1)).toBe('levar exames')

    // Em HTML também.
    const h1 = descricaoParaGoogle('levar<br>exames', p)
    expect(h1).toBe(`levar<br>exames<br><br>${MARCADOR_FLUXIA}<br>Paciente: Ana 3<br>Telefone: (11) 91234-5678`)
    expect(descricaoParaGoogle(h1, p)).toBe(h1)
  })
})

describe('descrição que voltou do Google em HTML', () => {
  it('<br>: o bloco é achado e trocado', () => {
    const html = `rsc<br><br>${blocoAnaHtml}`
    expect(tirarBlocoFluxia(html)).toBe('rsc')
    // Sobrou texto puro: o bloco novo volta com quebra de texto.
    expect(descricaoParaGoogle(html, ANA)).toBe(`rsc\n\n${blocoAna}`)
    expect(descricaoParaGoogle(html, null)).toBe('rsc')
    expect(descricaoParaGoogle(`<b>rsc</b><br><br>${blocoAnaHtml}`, null)).toBe('<b>rsc</b>')
    expect(descricaoParaGoogle(blocoAnaHtml, null)).toBe('')
  })

  it('<br/> e <b> em volta das nossas linhas', () => {
    const html = `rsc<br/><br/><b>${MARCADOR_FLUXIA}</b><br/>Paciente: <b>Ana Teste</b><br/>Telefone: <b>(11) 91234-5678</b>`
    expect(tirarBlocoFluxia(html)).toBe('rsc')
  })

  it('&nbsp; e &mdash; no lugar do espaço e do travessão', () => {
    const html =
      'rsc<br><br>&mdash;&nbsp;FluxiaCRM&nbsp;&mdash;<br>Paciente:&nbsp;Ana Teste<br>Telefone: (11)&nbsp;91234-5678'
    expect(tirarBlocoFluxia(html)).toBe('rsc')
    expect(tirarBlocoFluxia(html.replace(/&mdash;/g, '&#8212;'))).toBe('rsc')
  })

  it('<div> por linha: o bloco sai inteiro e o HTML do resto fica fechado', () => {
    const html = `<div>rsc</div><div>${MARCADOR_FLUXIA}</div><div>Paciente: Ana Teste</div><div>Telefone: (11) 91234-5678</div>`
    expect(tirarBlocoFluxia(html)).toBe('<div>rsc</div>')
    // Trocar o paciente deixa UM bloco (antes ficavam os dois).
    const comBruno = descricaoParaGoogle(html, BRUNO)
    expect(comBruno).toBe(`<div>rsc</div><br><br>${blocoBrunoHtml}`)
    expect(comBruno.split(MARCADOR_FLUXIA)).toHaveLength(2)
    expect(descricaoParaGoogle(comBruno, BRUNO)).toBe(comBruno)
    // Desligar o paciente tira o bloco (antes ficava o da Ana).
    expect(descricaoParaGoogle(html, null)).toBe('<div>rsc</div>')
  })

  it('<p> por linha e a linha em branco do editor (<div><br></div>)', () => {
    expect(
      tirarBlocoFluxia(`<p>rsc</p><p>${MARCADOR_FLUXIA}</p><p>Paciente: Ana Teste</p><p>Telefone: (11) 91234-5678</p>`),
    ).toBe('<p>rsc</p>')
    expect(
      tirarBlocoFluxia(
        `<div>rsc</div><div><br></div><div>${MARCADOR_FLUXIA}</div><div>Paciente: Ana Teste</div><div>Telefone: (11) 91234-5678</div>`,
      ),
    ).toBe('<div>rsc</div>')
  })

  it('só o bloco, em <div>: não sobra casca', () => {
    expect(tirarBlocoFluxia(`<div>${MARCADOR_FLUXIA}</div><div>Paciente: Ana Teste</div>`)).toBe('')
  })

  it('o que a recepção escreveu depois do bloco, pelo Google, fica', () => {
    const html = `rsc<br><br>${blocoAnaHtml}<br>chegar 10 min antes`
    expect(tirarBlocoFluxia(html)).toBe('rsc<br>chegar 10 min antes')
    // A base continua HTML: o bloco entra com <br>, não com "\n".
    expect(descricaoParaGoogle(html, ANA)).toBe(`rsc<br>chegar 10 min antes<br><br>${blocoAnaHtml}`)
    expect(descricaoParaGoogle(descricaoParaGoogle(html, ANA), ANA)).toBe(
      `rsc<br>chegar 10 min antes<br><br>${blocoAnaHtml}`,
    )
  })

  it('descrição em texto puro com a mesma cara (descricaoEmTexto)', () => {
    expect(descricaoEmTexto(`<div>rsc</div><div>Paciente:&nbsp;<b>Ana</b></div>`)).toBe('\nrsc\nPaciente: Ana\n')
  })
})

describe('ida e volta: o import religa o MESMO contato', () => {
  it('phoneFromDescription lê o telefone do bloco', () => {
    for (const desc of [null, 'rsc', 'Retorno\nlevar raio-x', 'Retorno<br>levar raio-x', '<div>Retorno</div>']) {
      const noGoogle = descricaoParaGoogle(desc, ANA)
      expect(phoneKey(phoneFromDescription(noGoogle))).toBe(phoneKey(ANA.phone))
    }
  })

  it('também com o telefone sem 55 que o ERP grava', () => {
    const noGoogle = descricaoParaGoogle('rsc', { name: 'Ana Teste', phone: '11912345678' })
    expect(phoneKey(phoneFromDescription(noGoogle))).toBe(phoneKey(ANA.phone))
  })

  it('o HTML que o Google devolve não gruda dígitos no telefone', () => {
    // Antes: "(11) 91234-5678<br>chegar 10 min antes" virava 1191234567810.
    const voltou = `rsc<br><br>${blocoAnaHtml}<br>chegar 10 min antes`
    expect(phoneFromDescription(voltou)).toBe('11912345678')
    expect(phoneKey(phoneFromDescription(voltou))).toBe(phoneKey(ANA.phone))
    expect(phoneFromDescription('Telefone: (11) 91234-5678</div><div>Cadeira 102')).toBe('11912345678')
    // Negrito no número (ou no rótulo) não esconde o telefone.
    expect(phoneFromDescription('Telefone: <b>(11) 91234-5678</b><br>chegar 10 min antes')).toBe('11912345678')
    expect(phoneFromDescription('<b>Telefone:</b> (11) 91234-5678<br/>Cadeira 102')).toBe('11912345678')
  })

  it('vira "consulta de alguém" (some o alerta de consulta órfã)', () => {
    expect(pareceConsultaDeAlguem(descricaoParaGoogle('rsc', ANA))).toBe(true)
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

describe('quando o paciente vai para o Google', () => {
  const evento = { location: null, description: null }

  it('só na conta que optou — e só com true de verdade', () => {
    expect(levarPacienteAoGoogle({ ligadoNaConta: true, op: 'create', evento })).toBe(true)
    expect(levarPacienteAoGoogle({ ligadoNaConta: true, op: 'update', evento })).toBe(true)
    for (const ligadoNaConta of [false, undefined, null, 'true', 1]) {
      expect(levarPacienteAoGoogle({ ligadoNaConta, op: 'create', evento })).toBe(false)
    }
  })

  it('nunca na criação com convidados ou com sala do Meet', () => {
    expect(
      levarPacienteAoGoogle({ ligadoNaConta: true, op: 'create', convidados: ['lead@example.com'], evento }),
    ).toBe(false)
    expect(levarPacienteAoGoogle({ ligadoNaConta: true, op: 'create', meet: true, evento })).toBe(false)
    expect(levarPacienteAoGoogle({ ligadoNaConta: true, op: 'create', convidados: [], meet: false, evento })).toBe(
      true,
    )
  })

  it('nunca na edição de evento com link de videochamada', () => {
    const reuniao = { location: 'https://meet.google.com/abc-defg-hij', description: null }
    expect(levarPacienteAoGoogle({ ligadoNaConta: true, op: 'update', evento: reuniao })).toBe(false)
    expect(levarPacienteAoGoogle({ ligadoNaConta: true, op: 'create', evento: reuniao })).toBe(false)
  })

  it('o que conta como reunião com convidados', () => {
    expect(pareceReuniaoComConvidados({ location: 'https://meet.google.com/abc-defg-hij' })).toBe(true)
    expect(pareceReuniaoComConvidados({ description: 'Entrar: https://us02web.zoom.us/j/123' })).toBe(true)
    expect(pareceReuniaoComConvidados({ location: 'https://teams.microsoft.com/l/meetup-join/x' })).toBe(true)
    expect(pareceReuniaoComConvidados({ location: 'Consultório 2', description: capim('(11) 91234-5678') })).toBe(
      false,
    )
    expect(pareceReuniaoComConvidados({})).toBe(false)
  })
})

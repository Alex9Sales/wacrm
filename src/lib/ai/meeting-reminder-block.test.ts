import { describe, expect, it } from 'vitest'
import {
  avisoNaAgenda,
  decideImpedimento,
  isMeetingReminderBlock,
  mudouOInicio,
  recomecoDoLembrete,
  RECUPERACAO_MS,
  rotuloDoBloqueio,
  type LembreteDoCompromisso,
  type MeetingReminderBlock,
} from './meeting-reminder-block'

/**
 * Estes rótulos são lidos por quem marcou a consulta, dentro do compromisso.
 * Errar aqui é dizer à recepção que está tudo certo quando o paciente não vai
 * receber aviso nenhum.
 */
const TODOS: MeetingReminderBlock[] = [
  'sem_conversa',
  'ia_pausada',
  'sem_template',
  'template_falhou',
  'sem_historico',
  'envio_falhou',
  'ia_falhou',
  'sem_ia',
  'sem_paciente',
]

describe('o que vem do banco', () => {
  it('aceita os motivos que o worker grava', () => {
    for (const m of TODOS) expect(isMeetingReminderBlock(m)).toBe(true)
  })

  it('recusa o que não reconhece — coluna de texto aceita qualquer coisa', () => {
    // Um motivo antigo, um erro de digitação ou lixo não podem virar um aviso
    // sem rótulo na tela.
    expect(isMeetingReminderBlock('motivo_que_nao_existe')).toBe(false)
    expect(isMeetingReminderBlock('')).toBe(false)
    expect(isMeetingReminderBlock(null)).toBe(false)
    expect(isMeetingReminderBlock(undefined)).toBe(false)
    expect(isMeetingReminderBlock(1)).toBe(false)
    expect(isMeetingReminderBlock({ motivo: 'ia_pausada' })).toBe(false)
  })
})

describe('insistir ou liberar a vaga na fila', () => {
  const MIN = 60_000
  const H = 60 * MIN

  it('com degrau futuro pela frente, sempre segura', () => {
    // Segurar aqui é de graça: a varredura só tenta o degrau vencido mais
    // recente, então o preso é substituído sozinho quando o próximo vence.
    expect(decideImpedimento({ ehUltimoDegrau: false, msDesdeODegrau: 0 })).toBe('segura')
    expect(decideImpedimento({ ehUltimoDegrau: false, msDesdeODegrau: 100 * H })).toBe('segura')
  })

  it('no último degrau, segura durante a janela de recuperação', () => {
    // Tempo de alguém religar a IA, escolher o template, o número voltar do ar.
    expect(decideImpedimento({ ehUltimoDegrau: true, msDesdeODegrau: 0 })).toBe('segura')
    expect(decideImpedimento({ ehUltimoDegrau: true, msDesdeODegrau: 5 * H })).toBe('segura')
    expect(decideImpedimento({ ehUltimoDegrau: true, msDesdeODegrau: RECUPERACAO_MS })).toBe('segura')
  })

  it('no último degrau, passada a janela, encerra e devolve a vaga', () => {
    // São 40 vagas por agente (PER_AGENT_CAP). Um dia com o canal fora do ar
    // travaria 40 consultas, e os travados de ontem empurrariam os avisos de
    // amanhã para fora da fila. Insistir depois disso não recupera mais nada.
    expect(decideImpedimento({ ehUltimoDegrau: true, msDesdeODegrau: RECUPERACAO_MS + 1 })).toBe('encerra')
    expect(decideImpedimento({ ehUltimoDegrau: true, msDesdeODegrau: 48 * H })).toBe('encerra')
  })

  it('degrau que ainda nem venceu nunca encerra', () => {
    // msDesdeODegrau negativo = a hora dele ainda não chegou.
    expect(decideImpedimento({ ehUltimoDegrau: true, msDesdeODegrau: -3 * H })).toBe('segura')
  })
})

describe('o texto que a pessoa lê', () => {
  it('todo motivo tem as três partes preenchidas', () => {
    for (const m of TODOS) {
      const r = rotuloDoBloqueio(m)
      expect(r.curto.length).toBeGreaterThan(3)
      expect(r.explicacao.length).toBeGreaterThan(20)
      // Sem "como resolver" o aviso vira reclamação: a pessoa lê e não sabe o
      // que fazer. Foi a lição do campo pela metade do lembrete do João.
      expect(r.comoResolver.length).toBeGreaterThan(20)
    }
  })

  it('o aviso fala do CONTATO, não do sistema', () => {
    // Quem abre a agenda quer saber se a pessoa vai ser avisada — "erro no
    // followup" não diz nada a uma recepcionista.
    for (const m of TODOS) {
      const aviso = avisoNaAgenda(m)
      // 01/10: "lembrete", não "confirmação" — confirmação agora é a mensagem
      // que sai na hora de agendar, e os dois avisos se contradiziam.
      expect(aviso).toContain('não vai receber o lembrete')
      expect(aviso).not.toMatch(/null|undefined|error|Error/)
    }
  })

  it('nenhum texto do lembrete chama o lembrete de "confirmação"', () => {
    for (const m of TODOS) {
      const r = rotuloDoBloqueio(m)
      expect(`${avisoNaAgenda(m)} ${r.curto} ${r.explicacao} ${r.comoResolver}`).not.toMatch(/confirmação/i)
    }
  })

  it('cada motivo tem um rótulo curto DIFERENTE', () => {
    // Dois motivos com o mesmo rótulo fariam a pessoa resolver a coisa errada.
    const curtos = TODOS.map((m) => rotuloDoBloqueio(m).curto)
    expect(new Set(curtos).size).toBe(TODOS.length)
  })

  it('está em português e sem jargão de código', () => {
    for (const m of TODOS) {
      const r = rotuloDoBloqueio(m)
      const tudo = `${r.curto} ${r.explicacao} ${r.comoResolver}`
      expect(tudo).not.toMatch(/conversation_id|contact_id|reminders_sent|stamp|sweep/)
    }
  })
})

describe('remarcou: o lembrete recomeça', () => {
  // 01/10: consulta arrastada no Google depois do lembrete de 24h ficava sem
  // lembrete na data nova — o sync mantinha o contador da data antiga.
  const ZERA = { remindersSent: 0, reminderBlock: null, reminderBlockAt: null }
  /** Compromisso sem nenhum degrau gasto (o recomeço só olha o início). */
  const em = (startsAt: string): LembreteDoCompromisso => ({ startsAt })

  it('horário novo zera o contador e o motivo', () => {
    expect(recomecoDoLembrete(em('2026-10-02T13:00:00.000Z'), '2026-10-03T16:00:00.000Z')).toEqual(ZERA)
  })

  it('o mesmo instante em formatos diferentes NÃO é remarcação', () => {
    // O banco devolve o texto do Postgres; o Google, ISO.
    expect(recomecoDoLembrete(em('2026-10-03 13:00:00-03'), '2026-10-03T16:00:00.000Z')).toEqual({})
  })

  it('milissegundos que o Google não guarda NÃO são remarcação', () => {
    // Zerar aqui repetiria para o paciente um degrau que já saiu.
    expect(recomecoDoLembrete(em('2026-10-03 16:00:00.123456+00'), '2026-10-03T16:00:00Z')).toEqual({})
  })

  it('um segundo de diferença já é outro horário', () => {
    expect(recomecoDoLembrete(em('2026-10-03T16:00:00Z'), '2026-10-03T16:00:01Z')).toEqual(ZERA)
    expect(mudouOInicio('2026-10-03T16:00:00Z', new Date('2026-10-03T16:00:01Z'))).toBe(true)
  })

  it('horário ilegível não zera — na dúvida, não repete degrau', () => {
    expect(recomecoDoLembrete(em('não é data'), '2026-10-03T16:00:00Z')).toEqual({})
    expect(recomecoDoLembrete(em('2026-10-03T16:00:00Z'), '')).toEqual({})
    expect(mudouOInicio('2026-10-03T16:00:00Z', 'amanhã')).toBe(false)
  })
})

describe('moveu e VOLTOU: o lembrete que já saiu não sai de novo (02/10)', () => {
  // A recepção (ou o Google, ou a IA) mudava 10h→11h e desfazia 11h→10h: o
  // contador era zerado nas duas vezes, e o lembrete das 10h que o paciente
  // já tinha recebido saía DE NOVO. Horários fictícios, em UTC.
  const DEZ = '2026-10-05T13:00:00.000Z'
  const ONZE = '2026-10-05T14:00:00.000Z'
  const MEIO_DIA = '2026-10-05T15:00:00.000Z'

  /** Aplica o UPDATE que o recomeço manda gravar — como o banco ficaria. */
  const mover = (linha: LembreteDoCompromisso, para: string): LembreteDoCompromisso => ({
    ...linha,
    ...recomecoDoLembrete(linha, para),
    startsAt: para,
  })
  /** O degrau que a varredura carimba quando o lembrete sai. */
  const saiuLembrete = (linha: LembreteDoCompromisso, n: number): LembreteDoCompromisso => ({ ...linha, remindersSent: n })

  it('move e volta → o contador do horário de antes é restaurado', () => {
    const lembrou = { startsAt: DEZ, remindersSent: 1 }
    const foi = mover(lembrou, ONZE)
    expect(foi).toMatchObject({ remindersSent: 0, remindersPrevStartsAt: DEZ, remindersPrevSent: 1 })

    const voltou = recomecoDoLembrete(foi, DEZ)
    expect(voltou).toMatchObject({ remindersSent: 1, reminderBlock: null, reminderBlockAt: null })
    // Contador 0 no horário que sai: nada a guardar, e o guardado não é apagado.
    expect(voltou).not.toHaveProperty('remindersPrevStartsAt')
    expect(voltou).not.toHaveProperty('remindersPrevSent')
  })

  it('move para outro horário NOVO → zera (o guardado não é desse horário)', () => {
    const foi = mover({ startsAt: DEZ, remindersSent: 1 }, ONZE)
    expect(recomecoDoLembrete(foi, MEIO_DIA)).toEqual({ remindersSent: 0, reminderBlock: null, reminderBlockAt: null })
  })

  it('move, move de novo, volta ao primeiro → restaura o do primeiro', () => {
    const primeiro = { startsAt: DEZ, remindersSent: 2 }
    const segundo = mover(primeiro, ONZE)
    const terceiro = mover(segundo, MEIO_DIA)
    // No 11h nada tinha saído: o guardado continua sendo o das 10h.
    expect(terceiro).toMatchObject({ remindersSent: 0, remindersPrevStartsAt: DEZ, remindersPrevSent: 2 })
    expect(mover(terceiro, DEZ)).toMatchObject({ startsAt: DEZ, remindersSent: 2 })
  })

  it('contador 0 não guarda nada', () => {
    const r = recomecoDoLembrete({ startsAt: DEZ, remindersSent: 0 }, ONZE)
    expect(r).toEqual({ remindersSent: 0, reminderBlock: null, reminderBlockAt: null })
    // E não apaga o guardado de antes.
    const comGuardado = { startsAt: ONZE, remindersSent: 0, remindersPrevStartsAt: DEZ, remindersPrevSent: 1 }
    expect(recomecoDoLembrete(comGuardado, MEIO_DIA)).not.toHaveProperty('remindersPrevStartsAt')
  })

  it('volta com SÓ o guardado: o que saiu no horário de passagem é de outro horário', () => {
    // 02/10/2026, revisão: era o maior dos dois. 10h (1 degrau) → 11h, onde
    // saíram 2 → volta às 10h: fica 1 — os 2 eram degraus das 11h.
    const passagem = saiuLembrete(mover({ startsAt: DEZ, remindersSent: 1 }, ONZE), 2)
    const r = recomecoDoLembrete(passagem, DEZ)
    expect(r).toMatchObject({ remindersSent: 1 })
    // E o das 11h (2) passa a ser o guardado: voltar às 11h de novo não repete.
    expect(r).toMatchObject({ remindersPrevStartsAt: ONZE, remindersPrevSent: 2 })
    const deVoltaAsDez = mover(passagem, DEZ)
    expect(deVoltaAsDez).toMatchObject({ startsAt: DEZ, remindersSent: 1, remindersPrevStartsAt: ONZE, remindersPrevSent: 2 })
    expect(mover(deVoltaAsDez, ONZE)).toMatchObject({ startsAt: ONZE, remindersSent: 2, remindersPrevStartsAt: DEZ, remindersPrevSent: 1 })
  })

  it('degraus [24h, 2h]: o "2h antes" do horário original ainda sai depois do vai-e-volta', () => {
    // O caso da revisão. Sexta 10h (-03) com o de 24h enviado (1) → movida
    // para quinta 15h, onde saem o de 24h e o de 2h (2) → volta para sexta
    // 10h. Com o maior dos dois ficava 2 e o "2h antes" das 10h — que o
    // paciente nunca recebeu — não saía. Datas fictícias.
    const SEXTA_10H = '2026-10-09T13:00:00.000Z'
    const QUINTA_15H = '2026-10-08T18:00:00.000Z'
    const vinteQuatroHorasAntes = { startsAt: SEXTA_10H, remindersSent: 1 }
    const naQuinta = saiuLembrete(mover(vinteQuatroHorasAntes, QUINTA_15H), 2)
    const deVolta = mover(naQuinta, SEXTA_10H)
    // 1 = só o de 24h das 10h saiu: o próximo degrau (2h antes) ainda sai.
    expect(deVolta).toMatchObject({ startsAt: SEXTA_10H, remindersSent: 1, reminderBlock: null })
  })

  it('volta "no minuto": segundos do Google e o texto do Postgres contam como o mesmo horário', () => {
    const linha = { startsAt: '2026-10-05 14:00:00+00', remindersSent: 0, remindersPrevStartsAt: '2026-10-05 13:00:00+00', remindersPrevSent: '1' }
    expect(recomecoDoLembrete(linha, '2026-10-05T13:00:30Z')).toMatchObject({ remindersSent: 1 })
    // Um minuto inteiro de diferença já é outro horário.
    expect(recomecoDoLembrete(linha, '2026-10-05T13:01:00Z')).toMatchObject({ remindersSent: 0 })
  })

  it('o início salvo vai em ISO; guardado ilegível ou zerado não restaura', () => {
    expect(recomecoDoLembrete({ startsAt: '2026-10-05 13:00:00-03', remindersSent: 1 }, ONZE)).toMatchObject({
      remindersPrevStartsAt: '2026-10-05T16:00:00.000Z',
      remindersPrevSent: 1,
    })
    const base = { startsAt: ONZE, remindersSent: 0 }
    expect(recomecoDoLembrete({ ...base, remindersPrevStartsAt: 'lixo', remindersPrevSent: 1 }, DEZ)).toMatchObject({ remindersSent: 0 })
    expect(recomecoDoLembrete({ ...base, remindersPrevStartsAt: DEZ, remindersPrevSent: 0 }, DEZ)).toMatchObject({ remindersSent: 0 })
    expect(recomecoDoLembrete({ ...base, remindersPrevStartsAt: null, remindersPrevSent: null }, DEZ)).toMatchObject({ remindersSent: 0 })
  })
})

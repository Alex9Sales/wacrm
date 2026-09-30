import { describe, expect, it } from 'vitest'
import {
  avisoNaAgenda,
  decideImpedimento,
  isMeetingReminderBlock,
  RECUPERACAO_MS,
  rotuloDoBloqueio,
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
      expect(aviso).toContain('não vai receber a confirmação')
      expect(aviso).not.toMatch(/null|undefined|error|Error/)
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

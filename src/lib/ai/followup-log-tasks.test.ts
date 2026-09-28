import { describe, expect, it } from 'vitest'
import { readFollowUpConfig } from './followup'

/**
 * `logTasks` (Zelo, 28/09). O gestor abre o funil, não vê movimento e conclui
 * que os follow-ups não estão saindo — estavam, 836 mensagens em 12 dias, todas
 * no bastidor. Com a chave ligada, cada envio vira tarefa CONCLUÍDA no card.
 *
 * Nasce DESLIGADA de propósito: em conta de venda rápida saem dezenas de toques
 * por dia e isso entupiria a lista de tarefas de quem usa tarefa para trabalhar.
 */
describe('logTasks é opt-in por agente', () => {
  it('desligado quando a conta nunca configurou nada', () => {
    expect(readFollowUpConfig({ enabled: true }).logTasks).toBe(false)
  })

  it('só liga com `true` de verdade — string "true" não conta', () => {
    // A tela manda booleano; qualquer outra origem (importação, API de
    // terceiro) não deve ligar registro em massa por engano.
    for (const v of ['true', 1, 'sim', {}, null, undefined]) {
      expect(readFollowUpConfig({ enabled: true, logTasks: v }).logTasks).toBe(false)
    }
    expect(readFollowUpConfig({ enabled: true, logTasks: true }).logTasks).toBe(true)
  })

  it('sobrevive junto do resto da configuração', () => {
    const cfg = readFollowUpConfig({
      enabled: true,
      logTasks: true,
      skipWhenDealExists: true,
      steps: [{ action: 'followup', delayValue: 3, delayUnit: 'hours' }],
      meetingReminders: [
        { when: 'after', offsetValue: 4, offsetUnit: 'hours', onlyIfStage: 'Reunião agendada' },
      ],
      stageTriggers: [{ stage: 'Reunião realizada', delayValue: 5, delayUnit: 'minutes' }],
    })
    expect(cfg.logTasks).toBe(true)
    expect(cfg.skipWhenDealExists).toBe(true)
    expect(cfg.steps).toHaveLength(1)
    expect(cfg.meetingReminders[0].onlyIfStage).toBe('Reunião agendada')
    expect(cfg.stageTriggers[0].stage).toBe('Reunião realizada')
  })
})

import { describe, expect, it } from 'vitest'
import { readFollowUpConfig } from './followup'

/**
 * `onlyIfStage` no lembrete de reunião (Zelo, 28/09). É ele que faz o "no-show"
 * existir sem coluna própria: o lembrete de 4 h DEPOIS da reunião só sai para
 * quem ficou parado em "Reunião agendada" — quem o responsável moveu para
 * "Reunião realizada" compareceu, e ouvir "sentimos sua falta" seria pior que
 * silêncio.
 *
 * O campo tem de sobreviver à ida e volta pela tela de configuração, que monta
 * o objeto campo a campo: um campo que a tela não conhece some no primeiro
 * "Salvar", e o no-show voltaria a disparar para todo mundo sem ninguém ver.
 */
describe('onlyIfStage sobrevive à leitura da configuração', () => {
  it('guarda a etapa quando ela vem preenchida', () => {
    const cfg = readFollowUpConfig({
      enabled: true,
      meetingReminders: [
        {
          when: 'after',
          offsetValue: 4,
          offsetUnit: 'hours',
          instructions: 'Pergunte como foi.',
          onlyIfStage: 'Reunião agendada',
        },
      ],
    })
    expect(cfg.meetingReminders[0].onlyIfStage).toBe('Reunião agendada')
  })

  it('sem o campo, o lembrete dispara sempre (como era antes)', () => {
    const cfg = readFollowUpConfig({
      enabled: true,
      meetingReminders: [{ when: 'before', offsetValue: 1, offsetUnit: 'hours' }],
    })
    expect(cfg.meetingReminders[0].onlyIfStage).toBeNull()
  })

  it('string vazia ou só espaços vale como "manda sempre", não como etapa ""', () => {
    // A tela manda '' quando o operador não preenche; '' nunca casaria com
    // nenhuma etapa, e o lembrete ficaria mudo para sempre.
    for (const v of ['', '   ']) {
      const cfg = readFollowUpConfig({
        enabled: true,
        meetingReminders: [
          { when: 'after', offsetValue: 4, offsetUnit: 'hours', onlyIfStage: v },
        ],
      })
      expect(cfg.meetingReminders[0].onlyIfStage).toBeNull()
    }
  })

  it('ignora tipo errado em vez de quebrar a configuração inteira', () => {
    const cfg = readFollowUpConfig({
      enabled: true,
      meetingReminders: [
        { when: 'after', offsetValue: 4, offsetUnit: 'hours', onlyIfStage: 42 },
      ],
    })
    expect(cfg.meetingReminders[0].onlyIfStage).toBeNull()
    expect(cfg.meetingReminders).toHaveLength(1)
  })

  it('o resto do lembrete continua intacto ao lado do campo novo', () => {
    const cfg = readFollowUpConfig({
      enabled: true,
      meetingReminders: [
        {
          when: 'after',
          offsetValue: 4,
          offsetUnit: 'hours',
          instructions: 'texto',
          templateName: 'no_show',
          templateLanguage: 'pt_BR',
          templateParams: ['{nome}'],
          onlyIfStage: 'Reunião agendada',
        },
      ],
    })
    const r = cfg.meetingReminders[0]
    expect(r).toMatchObject({
      when: 'after',
      offsetValue: 4,
      offsetUnit: 'hours',
      instructions: 'texto',
      templateName: 'no_show',
      templateLanguage: 'pt_BR',
      templateParams: ['{nome}'],
      onlyIfStage: 'Reunião agendada',
    })
  })
})

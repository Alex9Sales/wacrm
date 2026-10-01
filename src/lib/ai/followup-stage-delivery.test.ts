import { describe, expect, it } from 'vitest'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
  deliveryTextPrefix,
  hasUnfilledTemplateVars,
  planStageDelivery,
  readFollowUpConfig,
  splitStageTriggers,
  sqlSemPedidoDeHumanoPendente,
  sqlStageConversationCond,
  stageSkipNote,
} from './followup'
import { HANDOFF_NOTE_PREFIX } from './handoff-pause'

/**
 * Gatilho de etapa como ENTREGA (01/10, Zelo "Envio da COF").
 *
 * O responsável move o card para "Envio da COF" e o lead deveria receber a
 * Circular de Oferta de Franquia: o texto que o dono aprovou no modelo, com o
 * PDF. O que aconteceu: quatro mensagens com o marcador cru
 * "[[ENVIAR: Circular de Oferta de Franquia]]", nenhum PDF; o gatilho era
 * cancelado se o lead escrevesse dentro do atraso; e conversa com IA desligada
 * ou com atendente nem entrava na fila. Ids e nomes fictícios.
 */

const COF = {
  stage: 'Envio da COF',
  delayValue: 5,
  delayUnit: 'minutes',
  templateName: 'envio_cof',
  templateLanguage: 'pt_BR',
  templateParams: ['{nome}'],
}

describe('readStageTrigger — campos da entrega sobrevivem à configuração', () => {
  const ler = (t: Record<string, unknown>) =>
    readFollowUpConfig({ enabled: true, stageTriggers: [t] }).stageTriggers[0]

  it('padrões: tudo desligado (gatilho antigo continua igual)', () => {
    const t = ler({ stage: 'Agendado', delayValue: 3, delayUnit: 'hours' })
    expect(t.sendTemplateText).toBe(false)
    expect(t.attachMaterial).toBeNull()
    expect(t.ignoreAiPause).toBe(false)
    expect(t.enrollCadenceId).toBeNull()
  })

  it('lê os quatro campos quando vêm preenchidos', () => {
    const t = ler({
      ...COF,
      sendTemplateText: true,
      attachMaterial: '  Circular de Oferta de Franquia  ',
      ignoreAiPause: true,
      enrollCadenceId: '0F0E0D0C-0000-4000-8000-000000000001',
    })
    expect(t).toMatchObject({
      stage: 'Envio da COF',
      templateName: 'envio_cof',
      sendTemplateText: true,
      attachMaterial: 'Circular de Oferta de Franquia',
      ignoreAiPause: true,
      enrollCadenceId: '0f0e0d0c-0000-4000-8000-000000000001',
    })
  })

  it('entrega sem modelo não existe: sendTemplateText cai para false', () => {
    // A tela desabilita a caixa sem modelo, mas a regra mora na leitura — é
    // por onde a API e qualquer importação também passam.
    const t = ler({ stage: 'Envio da COF', sendTemplateText: true })
    expect(t.templateName).toBeNull()
    expect(t.sendTemplateText).toBe(false)
  })

  it('só `true` de verdade liga as chaves — "true", 1 e afins não', () => {
    for (const v of ['true', 1, 'sim', {}, null]) {
      const t = ler({ ...COF, sendTemplateText: v, ignoreAiPause: v })
      expect(t.sendTemplateText).toBe(false)
      expect(t.ignoreAiPause).toBe(false)
    }
  })

  it('string vazia vira null (não "material vazio" que nunca casaria)', () => {
    const t = ler({ ...COF, attachMaterial: '   ', enrollCadenceId: '' })
    expect(t.attachMaterial).toBeNull()
    expect(t.enrollCadenceId).toBeNull()
  })

  it('id de cadência que não é uuid vira null (nada de lixo no SQL do worker)', () => {
    for (const v of ['abc', '123', 42, "x'; drop table cadences; --"]) {
      expect(ler({ ...COF, enrollCadenceId: v }).enrollCadenceId).toBeNull()
    }
  })

  it('limita o nome do material a 200 caracteres', () => {
    expect(ler({ ...COF, attachMaterial: 'x'.repeat(500) }).attachMaterial).toHaveLength(200)
  })
})

describe('planStageDelivery — modo ENTREGA (texto do modelo, sem IA)', () => {
  const entrega = {
    sendTemplateText: true,
    templateName: 'envio_cof',
    customerRepliedAfterStage: false,
    renderedBody: 'Olá Ana, segue a Circular de Oferta de Franquia para você analisar.',
    hasAttachment: true,
  }

  it('janela aberta no oficial: manda o TEXTO do modelo + o arquivo', () => {
    expect(planStageDelivery({ ...entrega, officialChannel: true, windowOpen: true })).toEqual({
      send: 'text',
      attach: true,
      reason: 'texto_do_modelo',
    })
  })

  it('canal sem templates (WAHA): texto do modelo + arquivo, a qualquer hora', () => {
    expect(planStageDelivery({ ...entrega, officialChannel: false, windowOpen: false })).toEqual({
      send: 'text',
      attach: true,
      reason: 'texto_do_modelo',
    })
  })

  it('janela fechada no oficial: o MODELO, e nenhum arquivo (a Meta não aceita)', () => {
    expect(planStageDelivery({ ...entrega, officialChannel: true, windowOpen: false })).toEqual({
      send: 'template',
      attach: false,
      reason: 'modelo_fora_da_janela',
    })
  })

  it('o cliente ter respondido NÃO cancela a entrega (era o que barrava a COF)', () => {
    const p = planStageDelivery({
      ...entrega,
      customerRepliedAfterStage: true,
      officialChannel: true,
      windowOpen: true,
    })
    expect(p.send).toBe('text')
  })

  it('variável sem valor no oficial: manda o próprio modelo em vez de "{{1}}" à mostra', () => {
    const p = planStageDelivery({
      ...entrega,
      renderedBody: 'Olá {{1}}, segue a circular.',
      officialChannel: true,
      windowOpen: true,
    })
    expect(p).toEqual({ send: 'template', attach: true, reason: 'modelo_variavel_vazia' })
  })

  it('variável sem valor fora do oficial: não manda (e avisa)', () => {
    const p = planStageDelivery({
      ...entrega,
      renderedBody: 'Olá {{1}}, segue a circular.',
      officialChannel: false,
      windowOpen: false,
    })
    expect(p).toEqual({ send: 'skip', attach: false, reason: 'variavel_vazia' })
    expect(stageSkipNote(p.reason, 'Envio da COF', 'envio_cof')).toMatch(/não saiu/)
  })

  it('corpo do modelo não achado: oficial manda o modelo; fora dele, nada (com aviso)', () => {
    expect(
      planStageDelivery({ ...entrega, renderedBody: null, officialChannel: true, windowOpen: true }),
    ).toEqual({ send: 'template', attach: true, reason: 'modelo_sem_corpo' })
    const p = planStageDelivery({
      ...entrega,
      renderedBody: null,
      officialChannel: false,
      windowOpen: true,
    })
    expect(p).toEqual({ send: 'skip', attach: false, reason: 'corpo_nao_encontrado' })
    expect(stageSkipNote(p.reason, 'Envio da COF', 'envio_cof')).toMatch(/não foi encontrado/)
  })

  it('sem material escolhido, attach fica false', () => {
    const p = planStageDelivery({
      ...entrega,
      hasAttachment: false,
      officialChannel: true,
      windowOpen: true,
    })
    expect(p.attach).toBe(false)
  })

  it('caixa marcada sem modelo é modo IA (não há o que entregar)', () => {
    const p = planStageDelivery({
      ...entrega,
      templateName: null,
      officialChannel: false,
      windowOpen: true,
    })
    expect(p.send).toBe('ai')
  })
})

describe('planStageDelivery — modo IA (como sempre foi)', () => {
  const ia = {
    sendTemplateText: false,
    templateName: null,
    customerRepliedAfterStage: false,
    renderedBody: null,
    hasAttachment: false,
  }

  it('janela aberta: texto da IA', () => {
    expect(planStageDelivery({ ...ia, officialChannel: true, windowOpen: true })).toEqual({
      send: 'ai',
      attach: false,
      reason: 'ia',
    })
  })

  it('cliente respondeu depois de entrar na etapa: não manda, SEM aviso (o auto-reply cuida)', () => {
    const p = planStageDelivery({
      ...ia,
      customerRepliedAfterStage: true,
      officialChannel: false,
      windowOpen: true,
    })
    expect(p).toEqual({ send: 'skip', attach: false, reason: 'cliente_respondeu' })
    expect(stageSkipNote(p.reason, 'Agendado', null)).toBeNull()
  })

  it('janela fechada no oficial com modelo: manda o modelo', () => {
    expect(
      planStageDelivery({ ...ia, templateName: 'confirma', officialChannel: true, windowOpen: false }),
    ).toEqual({ send: 'template', attach: false, reason: 'modelo_fora_da_janela' })
  })

  it('janela fechada no oficial SEM modelo: nada sai — e a equipe fica sabendo', () => {
    const p = planStageDelivery({ ...ia, officialChannel: true, windowOpen: false })
    expect(p).toEqual({ send: 'skip', attach: false, reason: 'janela_fechada_sem_modelo' })
    expect(stageSkipNote(p.reason, 'Agendado', null)).toBe(
      '⚠️ Etapa "Agendado": janela de 24h fechada e o gatilho não tem modelo — nada foi enviado.',
    )
  })

  it('material do gatilho no modo IA também vai, com envio livre', () => {
    const p = planStageDelivery({ ...ia, hasAttachment: true, officialChannel: false, windowOpen: false })
    expect(p).toEqual({ send: 'ai', attach: true, reason: 'ia' })
  })
})

describe('hasUnfilledTemplateVars', () => {
  it('acha {{n}} com ou sem espaço', () => {
    expect(hasUnfilledTemplateVars('Olá {{1}}')).toBe(true)
    expect(hasUnfilledTemplateVars('Olá {{ 2 }}')).toBe(true)
    expect(hasUnfilledTemplateVars('Olá Ana')).toBe(false)
    expect(hasUnfilledTemplateVars(null)).toBe(false)
  })
})

describe('deliveryTextPrefix — guarda de duplicata', () => {
  it('pega os 60 primeiros caracteres do texto', () => {
    const texto = 'Olá Ana, segue a Circular de Oferta de Franquia para análise. Qualquer dúvida, chame.'
    expect(deliveryTextPrefix(texto)).toBe(Array.from(texto).slice(0, 60).join(''))
  })

  it('texto curto demais não serve de prova ("Olá, Ana!" sairia em qualquer conversa)', () => {
    expect(deliveryTextPrefix('Olá, Ana!')).toBeNull()
    expect(deliveryTextPrefix('')).toBeNull()
    expect(deliveryTextPrefix(null)).toBeNull()
  })

  it('conta emoji como UM caractere, como o left() do Postgres', () => {
    const texto = `📄${'a'.repeat(80)}`
    const p = deliveryTextPrefix(texto) as string
    expect(Array.from(p)).toHaveLength(60)
    expect(p.startsWith('📄')).toBe(true)
  })
})

describe('separação de etapas normais × operacionais (SQL do gatilho)', () => {
  const dialect = new PgDialect()
  const plano = (s: string) => s.replace(/\s+/g, ' ').trim()
  const trig = (stage: string, ignoreAiPause: boolean) =>
    readFollowUpConfig({ enabled: true, stageTriggers: [{ stage, ignoreAiPause }] }).stageTriggers[0]

  it('separa pelo ignoreAiPause, em minúsculas', () => {
    expect(splitStageTriggers([trig('Agendado', false), trig('Envio da COF', true)])).toEqual({
      normal: ['agendado'],
      operational: ['envio da cof'],
    })
  })

  it('etapa repetida: vale o PRIMEIRO gatilho, o mesmo que o laço acha', () => {
    expect(splitStageTriggers([trig('Envio da COF', false), trig('envio da cof', true)])).toEqual({
      normal: ['envio da cof'],
      operational: [],
    })
  })

  it('normal mantém as travas; operacional aceita IA desligada, atribuída e resolvida', () => {
    const q = dialect.sqlToQuery(sqlStageConversationCond(['agendado'], ['envio da cof']))
    const texto = plano(q.sql)
    // Os dois ramos são "(…) OR (…)"; a trava da pausa tem um OR dentro.
    const [normal, operacional] = texto.split(') OR (')
    expect(normal).toContain("c.status IN ('open','pending')")
    expect(normal).toContain('c.ai_autoreply_disabled = false')
    expect(normal).toContain('c.ai_paused_until IS NULL OR c.ai_paused_until <= now()')
    expect(normal).toContain('c.assigned_agent_id IS NULL')
    expect(operacional).toContain("c.status <> 'spam'")
    expect(operacional).not.toContain('ai_autoreply_disabled')
    expect(operacional).not.toContain('assigned_agent_id')
    expect(q.params).toEqual(['agendado', 'envio da cof'])
  })

  it('só operacionais: não sobra ramo com as travas', () => {
    const texto = plano(dialect.sqlToQuery(sqlStageConversationCond([], ['envio da cof'])).sql)
    expect(texto).not.toContain('assigned_agent_id')
    expect(texto).toContain("c.status <> 'spam'")
  })

  it('nenhuma etapa: não casa nada (em vez de casar tudo)', () => {
    expect(plano(dialect.sqlToQuery(sqlStageConversationCond([], [])).sql)).toBe('AND false')
  })
})

describe('escada de silêncio não cutuca quem pediu um humano', () => {
  const dialect = new PgDialect()
  const q = dialect.sqlToQuery(sqlSemPedidoDeHumanoPendente())
  const texto = q.sql.replace(/\s+/g, ' ')

  it('procura a nota de transferência pelo prefixo exato, só em nota interna', () => {
    expect(texto).toContain('NOT EXISTS')
    expect(texto).toContain('mh.is_internal = true')
    expect(q.params).toContain(HANDOFF_NOTE_PREFIX)
    expect(q.params).toContain(Array.from(HANDOFF_NOTE_PREFIX).length)
  })

  it('só vale se a nota for mais nova que a última mensagem do cliente', () => {
    expect(texto).toContain('mh.created_at > COALESCE(')
    expect(texto).toContain("mc.sender_type = 'customer'")
    expect(texto).toContain('mc.is_internal = false')
  })

  it('colunas qualificadas nas duas subqueries (nada de coluna solta)', () => {
    expect(texto).toContain('mh.conversation_id = c.id')
    expect(texto).toContain('mc.conversation_id = c.id')
    expect(texto).not.toMatch(/WHERE conversation_id/)
  })
})

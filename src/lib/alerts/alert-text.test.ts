import { describe, expect, it } from 'vitest'

import { CALL_LOG_PREFIX } from '@/lib/inbox/call-log'

import { alertContactName, buildClientTail, clipAtWord, oneLine, oneLineSummary, summarizeClientMessage } from './alert-text'
import { DEFAULT_ALERT_TEMPLATES, renderAlertTemplate } from './templates'

const text = (contentText: string) => ({ contentType: 'text', contentText, transcription: null })
const PIN = 'https://www.google.com/maps?q=-20.3722465,-54.5781869'

describe('resumo do aviso — caso Gisele (15/09 18:22)', () => {
  const falas = [
    text('Comunidade indígena água bonita 114'),
    text(`📍 Localização\n${PIN}`),
    text('É esse endereço, mas o número é 114'),
    text('Quase em frente a convivência da aldeia'),
  ]

  it('localização vira uma linha com o link INTEIRO; falas separadas por " · "', () => {
    expect(buildClientTail(falas)).toBe(
      `Comunidade indígena água bonita 114 · 📍 localização: ${PIN} · É esse endereço, mas o número é 114 · Quase em frente a convivência da aldeia`,
    )
  })

  it('o aviso renderizado não tem nome ".", nem link quebrado de linha', () => {
    const out = renderAlertTemplate(DEFAULT_ALERT_TEMPLATES.handoff, {
      cliente: alertContactName('.'),
      telefone: '556791270860',
      motivo: 'A IA pediu um humano nesta conversa',
      resumo: `Cliente disse: ${buildClientTail(falas)}`,
    })
    expect(out).toContain('\n👤 556791270860\n')
    expect(out).not.toContain('👤 .')
    expect(out).not.toContain('\nhttps')
    expect(out).toContain(PIN)
  })
})

describe('resumo do aviso — caso joselina (áudio cortado no meio da palavra)', () => {
  const audio = {
    contentType: 'audio',
    contentText: '[audio]',
    transcription:
      'Não, eu passei na loja e fiz o pedido de dois burjão, já deixei pago, só que até agora ninguém veio entregar aqui em casa, já faz duas horas que eu tô esperando',
  }

  it('áudio mostra a transcrição, cortada em palavra inteira com reticências', () => {
    const s = summarizeClientMessage(audio)
    expect(s.startsWith('🎤 Não, eu passei')).toBe(true)
    expect(s.endsWith('…')).toBe(true)
    expect(Array.from(s).length).toBeLessThanOrEqual(141)
    expect(s).not.toMatch(/\s\p{L}{1,2}…$/u)
  })

  it('a fala mais NOVA nunca sai; estourou o total, sai a mais antiga', () => {
    const longa = (n: number) => text(`${n} `.repeat(60).trim())
    const tail = buildClientTail([longa(1), longa(2), longa(3), text('última fala do cliente')], { maxTotal: 200 })
    expect(tail.endsWith('última fala do cliente')).toBe(true)
    expect(tail.startsWith('1 1')).toBe(false)
  })
})

describe('summarizeClientMessage — mídia e casos especiais', () => {
  it('rótulos curtos', () => {
    expect(summarizeClientMessage({ contentType: 'image', contentText: '[image]', transcription: 'comprovante do Pix' })).toBe('📷 mandou uma foto')
    expect(summarizeClientMessage({ contentType: 'audio', contentText: '[audio]', transcription: null })).toBe('🎤 mandou um áudio')
    expect(summarizeClientMessage({ contentType: 'location', contentText: 'Casa - Rua X - -20.1,-54.2', transcription: null })).toBe('📍 mandou a localização')
    expect(summarizeClientMessage(text('[sticker]'))).toBe('🎟️ mandou uma figurinha')
    expect(summarizeClientMessage(text(`${CALL_LOG_PREFIX}perdida`))).toBe('📞 ligação')
  })

  it('texto com quebra de linha vira uma linha com " / "', () => {
    expect(summarizeClientMessage(text('2 P13\nRua X 45\n\nCentro'))).toBe('2 P13 / Rua X 45 / Centro')
  })

  it('link cortado some inteiro', () => {
    const s = clipAtWord(`${'palavra '.repeat(10)}${PIN}`, 90)
    expect(s).not.toMatch(/https?:|htt…|maps\?q=-20\.3722465,-5…/)
    expect(s.endsWith('…')).toBe(true)
    expect(clipAtWord(`${'a'.repeat(84)} https://www.google.com`, 90)).toBe(`${'a'.repeat(84)}…`)
  })

  it('link INTEIRO que cabia não some (revisão 16/09)', () => {
    const msg =
      'Boa tarde, quero dois botijões P-13 para entregar no endereço que mandei ontem, fica aqui: https://maps.app.goo.gl/q4Zx9TtYhLmNpRs8A obrigada viu, aguardo'
    expect(summarizeClientMessage(text(msg))).toContain('https://maps.app.goo.gl/q4Zx9TtYhLmNpRs8A')
  })

  it('fala que é só um link longo não vira vazio', () => {
    const longo = `https://www.google.com/maps/place/Rua+Salim+Felicio,+16/@-20.4697,-54.6201,17z/data=${'x'.repeat(120)}`
    expect(summarizeClientMessage(text(longo))).toBe('🔗 mandou um link')
    expect(buildClientTail([text('oi'), text(longo)])).toBe('oi · 🔗 mandou um link')
  })

  it('não parte emoji composto', () => {
    const s = clipAtWord(`${'a'.repeat(137)}👨‍👩‍👧 fim`, 140)
    expect(s.includes('‍…')).toBe(false)
  })
})

describe('alertContactName', () => {
  it('nome sem letra não é nome', () => {
    for (const lixo of ['.', '...', '🙂', 'ㅤ', '⠀', '  ', '556791270860', '+55 67 99127-0860']) {
      expect(alertContactName(lixo)).toBe('')
    }
    expect(alertContactName(null)).toBe('')
  })

  it('nome de verdade passa, sem marcação do WhatsApp nas pontas', () => {
    expect(alertContactName('Zé')).toBe('Zé')
    expect(alertContactName('~Gi~')).toBe('Gi')
    expect(alertContactName('*Maria José*')).toBe('Maria José')
    expect(alertContactName('Meus Filhos Minha Vida 💙🩷')).toBe('Meus Filhos Minha Vida 💙🩷')
    expect(alertContactName('Família \u{1F468}\u200D\u{1F469}\u200D\u{1F467} Souza')).toBe('Família \u{1F468}\u200D\u{1F469}\u200D\u{1F467} Souza')
  })
})

describe('renderAlertTemplate — valor vira uma linha e variável vazia leva o separador', () => {
  it('cliente vazio → só o telefone; telefone vazio → só o nome', () => {
    expect(renderAlertTemplate('👤 {{cliente}} · {{telefone}}', { cliente: '', telefone: '556791270860' })).toBe('👤 556791270860')
    expect(renderAlertTemplate('👤 {{cliente}} · {{telefone}}', { cliente: 'Gisele', telefone: '' })).toBe('👤 Gisele')
    expect(renderAlertTemplate('🗓️ {{quando}} — {{agenda}}', { quando: '', agenda: 'Consulta' })).toBe('🗓️ Consulta')
  })

  it('valor com várias linhas não quebra o negrito do template personalizado', () => {
    expect(renderAlertTemplate('*📋 {{resumo}}*', { resumo: 'linha 1\nlinha 2' })).toBe('*📋 linha 1 / linha 2*')
  })

  it('aviso de pedido mantém o link do endereço (o despacho precisa dele)', () => {
    const out = renderAlertTemplate(DEFAULT_ALERT_TEMPLATES.order, {
      titulo: 'Gisele — P-13',
      valor: 'R$ 125,00',
      cliente: 'Gisele',
      telefone: '556791270860',
      resumo: `Aldeia Água Bonita 114\n${PIN}`,
    })
    expect(out).toContain(`📝 Aldeia Água Bonita 114 / ${PIN}`)
  })

  it('linha sem nenhum dado continua sumindo', () => {
    expect(renderAlertTemplate('a\n📝 {{notas}}\nb', { notas: '' })).toBe('a\nb')
  })
})

describe('oneLine / oneLineSummary', () => {
  it('limpa bordas e espaços', () => {
    expect(oneLine('\n  oi\n\n tudo bem?  \n')).toBe('oi / tudo bem?')
    expect(oneLineSummary('x'.repeat(500), 400).length).toBeLessThanOrEqual(401)
  })
})

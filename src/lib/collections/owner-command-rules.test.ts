import { describe, expect, it } from 'vitest'

import { formatCandidates, formatProposal, joinCustomerBurst, looksLikeCancel, looksLikeChargeCommand, looksLikeConfirmation, looksLikeCrmOwnText, normalizeParsedCommand, pickCandidateIndex } from './owner-command-rules'

const hoje = new Date(2026, 8, 6)

describe('comando do dono — reconhecer', () => {
  it('pedido de cobrança precisa de verbo + palavra de cobrança', () => {
    expect(looksLikeChargeCommand('cria uma cobrança de 150 pro João vencendo dia 10')).toBe(true)
    expect(looksLikeChargeCommand('gera um boleto de R$ 80 pra Maria')).toBe(true)
    expect(looksLikeChargeCommand('manda o pix de 125 pro 67 99999-1234')).toBe(true)
    expect(looksLikeChargeCommand('quanto tá o gás?')).toBe(false)
    expect(looksLikeChargeCommand('a cobrança do João já foi paga?')).toBe(false)
  })

  it('confirmação e cancelamento', () => {
    for (const t of ['sim', 'SIM', 'ok', 'pode', 'isso mesmo', 'confirma', '👍']) expect(looksLikeConfirmation(t)).toBe(true)
    for (const t of ['não', 'cancela', 'deixa pra lá', 'errado']) expect(looksLikeCancel(t)).toBe(true)
    expect(looksLikeConfirmation('simão da silva')).toBe(false)
    expect(looksLikeCancel('não sei se ele paga')).toBe(true)
  })

  it('escolha entre candidatos: número ou ordinal', () => {
    expect(pickCandidateIndex('2', 3)).toBe(1)
    expect(pickCandidateIndex('o 3', 3)).toBe(2)
    expect(pickCandidateIndex('primeiro', 3)).toBe(0)
    expect(pickCandidateIndex('5', 3)).toBeNull()
    expect(pickCandidateIndex('sim', 3)).toBeNull()
  })
})

describe('comando do dono — normalizar o que o modelo extraiu', () => {
  it('valor e data pelas mesmas regras da emissão; vencimento padrão +3 dias; telefone vence o nome', () => {
    const p = normalizeParsedCommand({ customer: 'João Silva', value: 'R$ 150,00', dueDate: '10/09' }, hoje)
    expect(p).toEqual({ customerQuery: 'João Silva', value: 150, dueDate: '2026-09-10', description: 'Cobrança', dueDefaulted: false, installments: null })
    expect(normalizeParsedCommand({ customer: 'Ana', value: 300, installments: '3x' }, hoje).installments).toBe(3)
    expect(normalizeParsedCommand({ customer: 'Ana', value: 300, installments: 1 }, hoje).installments).toBeNull()
    const semVenc = normalizeParsedCommand({ customer: 'Maria', value: 80 }, hoje)
    expect(semVenc.dueDate).toBe('2026-09-09')
    expect(semVenc.dueDefaulted).toBe(true) // a proposta avisa que os 3 dias foram padrão
    expect(normalizeParsedCommand({ customer: 'Maria', phone: '67 99999-1234', value: 80 }, hoje).customerQuery).toBe('67 99999-1234')
    expect(normalizeParsedCommand({ customer: 'Maria', value: 'abc' }, hoje).value).toBeNull()
  })

  it('textos para o dono: proposta com SIM/NÃO, lista numerada', () => {
    const t = formatProposal({ name: 'João Silva', phone: '5567999991234', value: 150, dueDate: '2026-09-10', description: 'Serviço' }).replace(/\u00a0/g, ' ')
    expect(t).toContain('R$ 150,00')
    expect(t).toContain('10/09/2026')
    expect(t).toContain('SIM')
    const c = formatCandidates([{ name: 'João A', phone: '1' }, { name: null, phone: '2' }])
    expect(c).toContain('1) João A')
    expect(c).toContain('2) Sem nome')
  })
})

describe('comando do dono — rajada de balões (08/09)', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 8, 8, 16, 5, s)).toISOString()
  it('junta os balões do dono em ordem e o conjunto vira pedido de cobrança', () => {
    const rows = [
      { senderType: 'customer', text: 'Pix', createdAt: at(50) },
      { senderType: 'customer', text: 'Vencimento amanhã', createdAt: at(40) },
      { senderType: 'customer', text: 'Valor de 5 reais', createdAt: at(30) },
      { senderType: 'customer', text: 'Para Danyela Souza', createdAt: at(20) },
      { senderType: 'customer', text: 'Cria uma cobrança', createdAt: at(10) },
      { senderType: 'bot', text: 'Bom dia, Alex!', createdAt: at(0) },
    ]
    const burst = joinCustomerBurst(rows)
    expect(burst).toBe('Cria uma cobrança\nPara Danyela Souza\nValor de 5 reais\nVencimento amanhã\nPix')
    expect(looksLikeChargeCommand('Pix')).toBe(false)
    expect(looksLikeChargeCommand(burst)).toBe(true)
  })
  it('para na última resposta do CRM: o que veio antes dela não entra', () => {
    const rows = [
      { senderType: 'customer', text: 'sim', createdAt: at(30) },
      { senderType: 'bot', text: 'Confirma? Responda SIM', createdAt: at(20) },
      { senderType: 'customer', text: 'cria uma cobrança de 5 pra Ana', createdAt: at(10) },
    ]
    expect(joinCustomerBurst(rows)).toBe('sim')
  })
  it('última mensagem não é do dono → vazio; janela e limite respeitados', () => {
    expect(joinCustomerBurst([{ senderType: 'bot', text: 'x', createdAt: at(0) }])).toBe('')
    const old = { senderType: 'customer', text: 'de ontem', createdAt: new Date(Date.UTC(2026, 8, 7, 16, 0, 0)).toISOString() }
    expect(joinCustomerBurst([{ senderType: 'customer', text: 'agora', createdAt: at(0) }, old])).toBe('agora')
    const many = Array.from({ length: 12 }, (_, i) => ({ senderType: 'customer', text: `m${i}`, createdAt: at(59 - i) }))
    expect(joinCustomerBurst(many, { max: 3 })).toBe('m2\nm1\nm0')
  })
})

describe('loop de 09/09 — texto do próprio CRM nunca é pedido nem confirmação', () => {
  const own = [
    'Confirma? Cobrar R$ 10,00 de Alex Sanabria (556791875477), vencendo 12/09/2026, "Cobrança"',
    'Qual o valor da cobrança para Alex Sanabria? Exemplo: "150,00".',
    'Preciso do CPF ou CNPJ de Alex Sanabria (11 ou 14 números) pra gerar no Asaas — ou responda NÃO pra cancelar.',
    'O Asaas exige CPF ou CNPJ pra gerar a cobrança de Alex Sanabria. Me manda o documento.',
    'Pronto ✅ Cobrança de R$ 10,00 para Alex, vence 12/09/2026.',
    'Cancelado. Nada foi cobrado.',
    'Ficou pendente: Confirma? Cobrar R$ 10,00 de Alex…',
    'Equipe hoje:\n• Alex Sales — 8 conversas atendidas · 78 abertas',
    '🌟 Bom dia! Seu resumo da Fluxia — 09/09',
    'Encontrei o Luan: negócio "Agente Gestão de Dados DRE"…',
  ]
  it('reconhece os textos que o CRM manda pro dono', () => {
    for (const t of own) expect(looksLikeCrmOwnText(t), t).toBe(true)
  })
  it('"Confirma? Cobrar…" NÃO conta como SIM (era o que criava a cobrança); "sim" curto continua valendo', () => {
    expect(looksLikeConfirmation('Confirma? Cobrar R$ 10,00 de Alex Sanabria (556791875477), vencendo 12/09/2026')).toBe(false)
    expect(looksLikeConfirmation('confirma')).toBe(true)
    expect(looksLikeConfirmation('sim, pode mandar')).toBe(true)
    expect(looksLikeConfirmation('sim ' + 'x'.repeat(70))).toBe(false)
  })
  it('pedido de gente continua sendo pedido', () => {
    expect(looksLikeCrmOwnText('cria uma cobrança de 150 pro João vencendo dia 10')).toBe(false)
    expect(looksLikeCrmOwnText('quem está devendo?')).toBe(false)
  })
})

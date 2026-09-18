import { describe, expect, it } from 'vitest'

import {
  accountHint,
  accountRefusalText,
  connectionAfterLookup,
  dayMonth,
  documentFieldView,
  joinLabels,
  MANUAL_DOCUMENT_REQUIRED_ERROR,
  type AccountHistoryView,
  type AccountLookup,
  type DocumentLookup,
} from './charge-form'

// Caso GoLink (15/09): duas contas do Asaas, dois CNPJs.
const ASAAS = { id: 'c-asaas', label: 'Asaas' }
const GOLINK = { id: 'c-golink', label: 'AsaasGoLink' }
const CONNS = [ASAAS, GOLINK]

const hist = (over: Partial<AccountHistoryView> & Pick<AccountHistoryView, 'id' | 'label'>): AccountHistoryView => ({
  enabled: true,
  charges: 1,
  lastAt: '2026-09-10',
  ...over,
})
const ok = (accounts: AccountHistoryView[], suggestedId: string | null, disabledHomeLabel: string | null = null): AccountLookup => ({
  state: 'ok',
  suggestedId,
  accounts,
  disabledHomeLabel,
})

describe('dayMonth / joinLabels', () => {
  it('data do histórico vira dd/mm; lixo vira null', () => {
    expect(dayMonth('2026-09-10')).toBe('10/09')
    expect(dayMonth('2026-09-10T12:00:00Z')).toBe('10/09')
    expect(dayMonth(null)).toBeNull()
    expect(dayMonth('ontem')).toBeNull()
  })

  it('junta rótulos em português', () => {
    expect(joinLabels(['A'])).toBe('A')
    expect(joinLabels(['A', 'B'])).toBe('A e B')
    expect(joinLabels(['A', 'B', 'C'])).toBe('A, B e C')
  })
})

describe('connectionAfterLookup — o que fica escolhido quando a consulta volta', () => {
  it('uma conta só: ela, sempre', () => {
    expect(connectionAfterLookup({ state: 'loading' }, [ASAAS])).toBe('c-asaas')
    expect(connectionAfterLookup({ state: 'error' }, [ASAAS])).toBe('c-asaas')
  })

  it('2+ contas com histórico: a da última cobrança', () => {
    expect(connectionAfterLookup(ok([hist(GOLINK)], 'c-golink'), CONNS)).toBe('c-golink')
  })

  it('2+ contas sem histórico, com falha ou carregando: VAZIO (quem gera escolhe)', () => {
    expect(connectionAfterLookup(ok([], null), CONNS)).toBe('')
    expect(connectionAfterLookup({ state: 'error' }, CONNS)).toBe('')
    expect(connectionAfterLookup({ state: 'loading' }, CONNS)).toBe('')
  })

  it('sugestão que não está no select (lista velha) não é aplicada', () => {
    expect(connectionAfterLookup(ok([hist({ id: 'c-outra', label: 'Outra' })], 'c-outra'), CONNS)).toBe('')
  })
})

describe('accountHint — a dica embaixo do select', () => {
  it('uma conta só: nada muda na tela', () => {
    expect(accountHint(ok([hist(ASAAS)], 'c-asaas'), [ASAAS], 'c-asaas')).toBeNull()
  })

  it('sem contato: nada; carregando e falha: os textos', () => {
    expect(accountHint({ state: 'idle' }, CONNS, '')).toBeNull()
    expect(accountHint({ state: 'loading' }, CONNS, '')).toEqual({ text: 'Conferindo a conta do Asaas deste cliente…', tone: 'muted' })
    expect(accountHint({ state: 'error' }, CONNS, '')).toEqual({
      text: 'Não deu para conferir a conta deste cliente agora. Confira antes de gerar.',
      tone: 'warn',
    })
  })

  it('histórico em 1 conta e ela escolhida', () => {
    expect(accountHint(ok([hist(GOLINK)], 'c-golink'), CONNS, 'c-golink')).toEqual({
      text: 'Cliente da conta AsaasGoLink — última cobrança em 10/09. Conta já escolhida.',
      tone: 'muted',
    })
  })

  it('trocou para uma conta onde o cliente não tem cobrança → aviso', () => {
    expect(accountHint(ok([hist(GOLINK)], 'c-golink'), CONNS, 'c-asaas')).toEqual({
      text: 'Atenção: as cobranças deste cliente são da conta AsaasGoLink. Gerando na Asaas, ele é cadastrado também na Asaas e o dinheiro cai lá.',
      tone: 'warn',
    })
  })

  it('histórico nas duas contas: a mais recente primeiro, sem aviso ao escolher a outra', () => {
    const lookup = ok([hist({ ...ASAAS, lastAt: '2026-08-01' }), hist({ ...GOLINK, lastAt: '2026-09-05' })], 'c-golink')
    const esperado = {
      text: 'Este cliente tem cobranças nas contas AsaasGoLink e Asaas. Escolhi a da última cobrança (AsaasGoLink) — confira.',
      tone: 'muted',
    }
    expect(accountHint(lookup, CONNS, 'c-golink')).toEqual(esperado)
    // Revisão 15/09: com a outra conta do histórico no select, não diz "escolhi".
    expect(accountHint(lookup, CONNS, 'c-asaas')).toEqual({
      text: 'Este cliente tem cobranças nas contas AsaasGoLink e Asaas. A última foi na AsaasGoLink — confira a conta escolhida.',
      tone: 'muted',
    })
  })

  it('empate de data → a com mais cobranças vem primeiro', () => {
    const lookup = ok([hist({ ...ASAAS, charges: 2 }), hist({ ...GOLINK, charges: 9 })], 'c-golink')
    expect(accountHint(lookup, CONNS, 'c-golink')?.text).toContain('(AsaasGoLink)')
  })

  it('histórico só em conta desligada → avisa, não pré-escolhe', () => {
    const lookup = ok([hist({ id: 'c-velha', label: 'Antiga', enabled: false })], null, 'Antiga')
    expect(connectionAfterLookup(lookup, CONNS)).toBe('')
    expect(accountHint(lookup, CONNS, '')).toEqual({
      text: 'As cobranças deste cliente são da conta Antiga, que está desligada em Cobranças. Escolha a conta com atenção.',
      tone: 'warn',
    })
  })

  it('conta desligada no histórico junto de uma ligada: vale a ligada', () => {
    const lookup = ok([hist({ id: 'c-velha', label: 'Antiga', enabled: false, lastAt: '2026-09-12' }), hist(GOLINK)], 'c-golink')
    expect(accountHint(lookup, CONNS, 'c-golink')?.text).toBe('Cliente da conta AsaasGoLink — última cobrança em 10/09. Conta já escolhida.')
  })

  it('sem histórico', () => {
    expect(accountHint(ok([], null), CONNS, '')).toEqual({
      text: 'Este cliente ainda não tem cobrança no CRM. Escolha a conta do Asaas com atenção: o dinheiro cai na conta escolhida.',
      tone: 'muted',
    })
  })
})

describe('accountRefusalText — recusa do servidor', () => {
  it('texto do desenho', () => {
    expect(accountRefusalText('AsaasGoLink', 'Asaas')).toBe('Este cliente já está cadastrado na conta AsaasGoLink do Asaas, não na Asaas. Nada foi criado.')
  })
})

describe('documentFieldView — CPF/CNPJ só obrigatório em produção sem documento conhecido', () => {
  const CPF_OK = '529.982.247-25'
  const unknown: Extract<DocumentLookup, { state: 'ok' }> = { state: 'ok', known: false, masked: null, asaasName: null }
  const known: Extract<DocumentLookup, { state: 'ok' }> = { state: 'ok', known: true, masked: '11.222.***/****-81', asaasName: 'Tio Burguer Lanches' }
  const view = (over: Partial<Parameters<typeof documentFieldView>[0]>) =>
    documentFieldView({ hasContact: true, environment: 'production', lookup: unknown, typed: '', ...over })

  it('sem contato: pede o contato e não trava', () => {
    const v = view({ hasContact: false, lookup: { state: 'idle' } })
    expect(v.hint).toBe('Escolha o contato para ver se o CPF/CNPJ já está no cadastro.')
    expect(v.required).toBe(false)
    expect(v.ok).toBe(true)
  })

  it('carregando: dica e sem trava', () => {
    const v = view({ lookup: { state: 'loading' } })
    expect(v.hint).toBe('Conferindo o cadastro do contato…')
    expect(v.ok).toBe(true)
  })

  it('produção sem documento: obrigatório, vazio trava, válido libera', () => {
    const v = view({})
    expect(v.label).toBe('CPF/CNPJ do cliente (obrigatório)')
    expect(v.placeholder).toBe('só números')
    expect(v.hint).toBe('Obrigatório: o Asaas de produção não gera cobrança sem CPF ou CNPJ, e ainda não temos o deste contato.')
    expect(v.required).toBe(true)
    expect(v.ok).toBe(false)
    expect(view({ typed: CPF_OK }).ok).toBe(true)
  })

  it('conta ainda não escolhida (ambiente desconhecido) conta como produção', () => {
    expect(view({ environment: undefined }).required).toBe(true)
    expect(view({ environment: '' }).required).toBe(true)
  })

  it('documento conhecido: dica com mascarado e nome do Asaas; vazio libera', () => {
    const v = view({ lookup: known })
    expect(v.label).toBe('CPF/CNPJ do cliente')
    expect(v.placeholder).toBe('já temos no cadastro')
    expect(v.hint).toBe(
      'Já temos o CPF/CNPJ deste contato: 11.222.***/****-81 (Tio Burguer Lanches). Deixe em branco para usar esse, ou digite outro.',
    )
    expect(v.ok).toBe(true)
    expect(view({ lookup: { ...known, asaasName: null } }).hint).toBe(
      'Já temos o CPF/CNPJ deste contato: 11.222.***/****-81. Deixe em branco para usar esse, ou digite outro.',
    )
  })

  it('sandbox: opcional', () => {
    const v = view({ environment: 'sandbox' })
    expect(v.required).toBe(false)
    expect(v.ok).toBe(true)
    expect(v.placeholder).toBe('opcional no sandbox')
    expect(v.hint).toBe('Conta de teste (sandbox): o CPF/CNPJ é opcional.')
  })

  it('falha na consulta NÃO trava (o servidor decide)', () => {
    const v = view({ lookup: { state: 'error' } })
    expect(v.required).toBe(false)
    expect(v.ok).toBe(true)
    expect(v.hint).toBe('Não deu para conferir o cadastro agora. Na conta de produção, preencha o CPF/CNPJ para garantir.')
  })

  it('digitado inválido trava em qualquer caso — mesmo com documento conhecido', () => {
    const errado = view({ lookup: known, typed: '529.982.247-26' })
    expect(errado.invalid).toBe(true)
    expect(errado.showInvalid).toBe(true)
    expect(errado.ok).toBe(false)
    // Telefone colado no campo não vira CPF.
    expect(view({ environment: 'sandbox', typed: '67991875477' }).ok).toBe(false)
  })

  it('digitando: trava, mas só mostra o erro a partir de 11 números', () => {
    const v = view({ typed: '52998' })
    expect(v.invalid).toBe(true)
    expect(v.showInvalid).toBe(false)
    expect(v.ok).toBe(false)
  })

  it('só pontuação conta como vazio', () => {
    expect(view({ lookup: known, typed: '.-/' }).ok).toBe(true)
  })

  it('o erro de documento da action continua dizendo "CPF ou CNPJ"', () => {
    expect(MANUAL_DOCUMENT_REQUIRED_ERROR).toMatch(/CPF ou CNPJ/)
  })
})

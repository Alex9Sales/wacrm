// ============================================================
// 🧾 Nova cobrança (tela) — o que o diálogo mostra sobre a CONTA do Asaas e o
// CPF/CNPJ (15/09). O diálogo só pinta; a regra fica aqui, testável.
//
// Conta (caso GoLink, duas contas = dois CNPJs): a conta segue o cliente. O
// diálogo pré-escolhe a conta da última cobrança dele; sem histórico e com 2+
// contas, começa vazio e quem gera escolhe — o dinheiro cai na conta escolhida.
// Trocar para uma conta onde o cliente não tem cobrança avisa.
//
// Documento: obrigatório só em produção sem documento conhecido (a mesma trava
// do servidor, emit.ts). O digitado passa pelos verificadores — telefone colado
// no campo não vira CPF.
//
// Puro (sem banco, sem 'server-only') — importado pelo client e pela action.
// ============================================================

import { normalizeValidDocument, onlyDigits } from './document'

// ------------------------------------------------------------ conta do Asaas

/** Uma conta onde o cliente tem cobrança no CRM (nunca a chave). */
export interface AccountHistoryView {
  id: string
  label: string
  enabled: boolean
  charges: number
  /** YYYY-MM-DD da cobrança mais recente. */
  lastAt: string | null
}

export type AccountLookup =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error' }
  | {
      state: 'ok'
      /** A conta da última cobrança do cliente, se ligada. null = sem sugestão (sem histórico, ou só em conta desligada). */
      suggestedId: string | null
      accounts: AccountHistoryView[]
      /** O histórico do cliente só está numa conta DESLIGADA. */
      disabledHomeLabel: string | null
    }

export interface AccountHint {
  text: string
  tone: 'muted' | 'warn'
}

interface ConnOption {
  id: string
  label: string
}

/** "2026-09-10" → "10/09"; lixo → null. */
export function dayMonth(ymd: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd ?? '')
  return m ? `${m[3]}/${m[2]}` : null
}

/** "A", "A e B", "A, B e C" */
export function joinLabels(labels: readonly string[]): string {
  return labels.length <= 1 ? (labels[0] ?? '') : `${labels.slice(0, -1).join(', ')} e ${labels[labels.length - 1]}`
}

/** Contas LIGADAS (e presentes no select) onde o cliente tem cobrança — mais recente primeiro; empate → mais cobranças. */
function homesOf(lookup: Extract<AccountLookup, { state: 'ok' }>, conns: readonly ConnOption[]): AccountHistoryView[] {
  const ids = new Set(conns.map((c) => c.id))
  return lookup.accounts
    .filter((a) => a.enabled && ids.has(a.id))
    .sort((a, b) => {
      const la = a.lastAt ?? ''
      const lb = b.lastAt ?? ''
      if (la !== lb) return la < lb ? 1 : -1
      return (b.charges ?? 0) - (a.charges ?? 0)
    })
}

/**
 * Conta que fica escolhida quando a consulta volta e ninguém mexeu no select:
 * a sugestão, se ela está entre as contas da tela; senão vazio (com 2+ contas,
 * sem histórico ou com a consulta falhando, quem gera escolhe). Com uma conta
 * só, ela.
 */
export function connectionAfterLookup(lookup: AccountLookup, conns: readonly ConnOption[]): string {
  if (conns.length <= 1) return conns[0]?.id ?? ''
  if (lookup.state !== 'ok' || !lookup.suggestedId) return ''
  return conns.some((c) => c.id === lookup.suggestedId) ? lookup.suggestedId : ''
}

/**
 * O que aparece embaixo do select "Conta do Asaas". Só com 2+ contas: com uma,
 * nada muda na tela.
 */
export function accountHint(lookup: AccountLookup, conns: readonly ConnOption[], connectionId: string): AccountHint | null {
  if (conns.length < 2) return null
  if (lookup.state !== 'ok') {
    if (lookup.state === 'loading') return { text: 'Conferindo a conta do Asaas deste cliente…', tone: 'muted' }
    if (lookup.state === 'error') return { text: 'Não deu para conferir a conta deste cliente agora. Confira antes de gerar.', tone: 'warn' }
    return null
  }

  const homes = homesOf(lookup, conns)
  if (homes.length) {
    const chosen = conns.find((c) => c.id === connectionId)
    // Escolheu uma conta onde o cliente NÃO tem cobrança: vai nascer um segundo cadastro lá.
    if (chosen && !homes.some((h) => h.id === chosen.id)) {
      return {
        text: `Atenção: as cobranças deste cliente são da conta ${homes[0].label}. Gerando na ${chosen.label}, ele é cadastrado também na ${chosen.label} e o dinheiro cai lá.`,
        tone: 'warn',
      }
    }
    if (homes.length === 1) {
      const quando = dayMonth(homes[0].lastAt)
      const escolhida = chosen?.id === homes[0].id ? ' Conta já escolhida.' : ''
      return { text: `Cliente da conta ${homes[0].label}${quando ? ` — última cobrança em ${quando}` : ''}.${escolhida}`, tone: 'muted' }
    }
    // Só diz "escolhi" quando a conta do select é mesmo a da última cobrança
    // (a pessoa pode ter trocado para outra do histórico, ou escolhido antes).
    const labels = joinLabels(homes.map((h) => h.label))
    return {
      text:
        chosen?.id === homes[0].id
          ? `Este cliente tem cobranças nas contas ${labels}. Escolhi a da última cobrança (${homes[0].label}) — confira.`
          : `Este cliente tem cobranças nas contas ${labels}. A última foi na ${homes[0].label} — confira a conta escolhida.`,
      tone: 'muted',
    }
  }
  if (lookup.disabledHomeLabel) {
    return {
      text: `As cobranças deste cliente são da conta ${lookup.disabledHomeLabel}, que está desligada em Cobranças. Escolha a conta com atenção.`,
      tone: 'warn',
    }
  }
  return {
    text: 'Este cliente ainda não tem cobrança no CRM. Escolha a conta do Asaas com atenção: o dinheiro cai na conta escolhida.',
    tone: 'muted',
  }
}

/** Recusa do servidor: o cliente já existe noutra conta do Asaas (toast e aviso âmbar). */
export function accountRefusalText(otherLabel: string, chosenLabel: string): string {
  return `Este cliente já está cadastrado na conta ${otherLabel} do Asaas, não na ${chosenLabel}. Nada foi criado.`
}

// ------------------------------------------------------------------ CPF/CNPJ

/** Erro da action quando falta documento (produção). */
export const MANUAL_DOCUMENT_REQUIRED_ERROR =
  'Falta o CPF ou CNPJ do cliente: o Asaas de produção não gera cobrança sem ele. Preencha o campo e tente de novo — nada foi criado no Asaas.'

/** Erro da action (e do campo) quando o documento digitado não passa nos verificadores. */
export const MANUAL_INVALID_DOCUMENT_ERROR = 'CPF/CNPJ inválido — confira os números.'

export type DocumentLookup =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'error' }
  | { state: 'ok'; known: boolean; masked: string | null; asaasName: string | null }

export interface DocumentFieldView {
  label: string
  placeholder: string
  hint: string
  /** Precisa digitar para liberar o botão (produção sem documento conhecido). */
  required: boolean
  /** Digitaram números que não formam CPF/CNPJ válido. */
  invalid: boolean
  /** Já dá para mostrar o erro no campo (sem piscar vermelho a cada dígito). */
  showInvalid: boolean
  /** O campo deixa gerar: vazio e não obrigatório, ou digitado válido. */
  ok: boolean
}

/**
 * Rótulo, placeholder, dica e trava do campo CPF/CNPJ.
 * `environment` = da conta escolhida (vazio/desconhecido conta como produção,
 * igual ao servidor). Falha na consulta NÃO bloqueia: a trava do servidor decide.
 */
export function documentFieldView(input: {
  hasContact: boolean
  environment: string | null | undefined
  lookup: DocumentLookup
  typed: string
}): DocumentFieldView {
  const { lookup } = input
  const sandbox = input.environment === 'sandbox'
  const known = lookup.state === 'ok' && lookup.known
  const required = !sandbox && input.hasContact && lookup.state === 'ok' && !lookup.known
  const digits = onlyDigits(input.typed)
  const invalid = digits.length > 0 && normalizeValidDocument(digits) == null
  const ok = digits.length === 0 ? !required : !invalid

  let hint: string
  if (!input.hasContact) hint = 'Escolha o contato para ver se o CPF/CNPJ já está no cadastro.'
  else if (sandbox) hint = 'Conta de teste (sandbox): o CPF/CNPJ é opcional.'
  else if (lookup.state === 'ok' && lookup.known) {
    const masked = lookup.masked ?? ''
    hint = lookup.asaasName
      ? `Já temos o CPF/CNPJ deste contato: ${masked} (${lookup.asaasName}). Deixe em branco para usar esse, ou digite outro.`
      : `Já temos o CPF/CNPJ deste contato: ${masked}. Deixe em branco para usar esse, ou digite outro.`
  } else if (lookup.state === 'ok') hint = 'Obrigatório: o Asaas de produção não gera cobrança sem CPF ou CNPJ, e ainda não temos o deste contato.'
  else if (lookup.state === 'error') hint = 'Não deu para conferir o cadastro agora. Na conta de produção, preencha o CPF/CNPJ para garantir.'
  else hint = 'Conferindo o cadastro do contato…'

  return {
    label: required ? 'CPF/CNPJ do cliente (obrigatório)' : 'CPF/CNPJ do cliente',
    placeholder: sandbox ? 'opcional no sandbox' : known ? 'já temos no cadastro' : 'só números',
    hint,
    required,
    invalid,
    showInvalid: invalid && digits.length >= 11,
    ok,
  }
}

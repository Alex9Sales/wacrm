import { describe, expect, it } from 'vitest'
import { mergeOrderNote, type OrderFields } from './order-note'

const fields = (over: Partial<OrderFields> = {}): OrderFields => ({
  obs: '',
  endereco: '',
  bairro: '',
  pagamento: '',
  ...over,
})

describe('o caso que quebrou o despacho (28/09)', () => {
  it('a rua que o modelo esqueceu entra; o que ele já disse não repete', () => {
    // Formato do aviso que saiu sem rua: bairro e pagamento estavam no texto do
    // modelo, o endereço só existia nos argumentos da ferramenta.
    const nota = mergeOrderNote('1 botijão · Jardim Aurora · dinheiro · troco para R$ 200', fields({
      endereco: 'rua das laranjeiras 182',
      bairro: 'Jardim Aurora',
      pagamento: 'dinheiro',
    }))
    expect(nota).toBe(
      '1 botijão · Jardim Aurora · dinheiro · troco para R$ 200 · endereço: rua das laranjeiras 182',
    )
  })

  it('endereço completo quando o modelo não disse nem bairro', () => {
    expect(mergeOrderNote('1 botijão', fields({
      endereco: 'rua das laranjeiras 182',
      bairro: 'Jardim Aurora',
      pagamento: 'pix',
    }))).toBe('1 botijão · endereço: rua das laranjeiras 182, Jardim Aurora · pagamento: pix')
  })

  it('modelo que já escreveu tudo não ganha nada colado atrás', () => {
    const texto = '2 botijões · Rua das Laranjeiras, 182 — Jardim Aurora · pagamento: pix'
    expect(mergeOrderNote(texto, fields({
      endereco: 'rua das laranjeiras 182',
      bairro: 'Jardim Aurora',
      pagamento: 'pix',
    }))).toBe(texto)
  })
})

describe('compara por conteúdo, não por formato', () => {
  it('tipo de via na frente não faz a rua repetir', () => {
    // Modelo escreve "Rua X, 182"; a ferramenta recebeu "x 182" — é a mesma rua.
    const nota = mergeOrderNote('Entrega na Rua das Laranjeiras, 182', fields({
      endereco: 'das laranjeiras 182',
    }))
    expect(nota).toBe('Entrega na Rua das Laranjeiras, 182')
  })

  it('acento e caixa diferentes não fazem o bairro repetir', () => {
    expect(mergeOrderNote('entrega no bosque da esperanca', fields({
      bairro: 'Bosque da Esperança',
    }))).toBe('entrega no bosque da esperanca')
  })

  it('bairro sozinho, quando a rua já está dita, vai rotulado', () => {
    expect(mergeOrderNote('Rua das Laranjeiras, 182', fields({
      endereco: 'rua das laranjeiras 182',
      bairro: 'Jardim Aurora',
    }))).toBe('Rua das Laranjeiras, 182 · bairro: Jardim Aurora')
  })
})

describe('não devolve resumo vazio nem inventa', () => {
  it('sem dados do pedido devolve o texto do modelo intacto', () => {
    expect(mergeOrderNote('1 botijão · pix', null)).toBe('1 botijão · pix')
    expect(mergeOrderNote('1 botijão · pix', undefined)).toBe('1 botijão · pix')
  })

  it('sem texto do modelo monta o resumo só com os dados reais', () => {
    expect(mergeOrderNote(null, fields({
      obs: 'portão azul',
      endereco: 'rua das laranjeiras 182',
      bairro: 'Jardim Aurora',
      pagamento: 'dinheiro',
    }))).toBe('portão azul · endereço: rua das laranjeiras 182, Jardim Aurora · pagamento: dinheiro')
  })

  it('nada de um lado nem do outro devolve null, não string vazia', () => {
    // O template do aviso põe "📝 {{resumo}}"; string vazia deixaria o rótulo
    // solto na mensagem do dono.
    expect(mergeOrderNote(null, fields())).toBeNull()
    expect(mergeOrderNote('   ', fields())).toBeNull()
  })

  it('campo em branco nos argumentos não vira rótulo vazio', () => {
    expect(mergeOrderNote('1 botijão', fields({ endereco: '   ', pagamento: 'pix' }))).toBe(
      '1 botijão · pagamento: pix',
    )
  })
})

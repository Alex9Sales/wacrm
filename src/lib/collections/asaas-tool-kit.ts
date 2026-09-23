// ============================================================
// 🧰 Kit de ferramentas do Asaas — um clique, sem o cliente colar chave.
//
// 23/09 (Alex): "vamos colocar esse botão de instalar ferramentas no Asaas".
// Hoje, para o agente consultar a cobrança do cliente ao vivo, alguém tem que
// criar ferramenta por ferramenta na mão e colar a chave do Asaas em cada uma
// — foi o que fizemos para a Fluxia em 26/08 e para o Rafael agora. A conta já
// tem a chave guardada em `asaas_connections` (Cobranças → conectar); o botão
// usa ELA e monta as ferramentas prontas.
//
// Só CONSULTA (risk 'read'): ver cadastro, ver as cobranças, pegar o Pix
// copia-e-cola e a linha digitável do boleto. Nada de criar ou alterar
// cobrança por aqui — isso continua no fluxo do CRM, com registro.
//
// Puro (sem DB, sem server-only): a action instala, o teste confere.
// ============================================================

import type { ToolParamDef } from '@/lib/ai/external-tools'

/** Header de autenticação do Asaas. NÃO é `Authorization` (erro clássico: 401 access_token_not_found). */
export const ASAAS_AUTH_HEADER = 'access_token'

/** Prefixo dos slugs do kit — é assim que reconhecemos o que já foi instalado. */
export const ASAAS_KIT_PREFIX = 'asaas_'

export interface AsaasKitTool {
  /** Slug fixo (não vem do nome): reinstalar ATUALIZA em vez de duplicar. */
  slug: string
  name: string
  description: string
  method: 'GET'
  /** Caminho a partir da raiz da API, com {placeholders}. */
  path: string
  params: ToolParamDef[]
}

/**
 * As 5 ferramentas do kit. A ordem é a do uso real: acha o cliente, vê o que
 * ele deve, e só então busca a forma de pagar.
 *
 * As descrições são o que a IA lê para decidir — por isso falam do FLUXO
 * ("use o id que veio da busca"), não da API.
 */
export const ASAAS_KIT: readonly AsaasKitTool[] = [
  {
    slug: 'asaas_cliente_por_documento',
    name: 'Asaas — achar cliente pelo CPF/CNPJ',
    description:
      'Acha o cadastro do cliente no Asaas pelo CPF ou CNPJ. Use quando o cliente informar o documento. Devolve o "id" do cliente, que as outras ferramentas do Asaas pedem.',
    method: 'GET',
    path: '/customers?cpfCnpj={documento}&limit=5',
    params: [
      {
        name: 'documento',
        type: 'string',
        description: 'CPF ou CNPJ do cliente, só números, sem ponto nem traço.',
        required: true,
      },
    ],
  },
  {
    slug: 'asaas_cliente_por_nome',
    name: 'Asaas — achar cliente pelo nome',
    description:
      'Acha o cadastro do cliente no Asaas pelo nome ou razão social, quando ele não passou o documento. Devolve o "id" do cliente. Se vier mais de um, confirme com o cliente antes de seguir.',
    method: 'GET',
    path: '/customers?name={nome}&limit=5',
    params: [
      {
        name: 'nome',
        type: 'string',
        description: 'Nome ou parte do nome do cliente, como ele se apresentou.',
        required: true,
      },
    ],
  },
  {
    slug: 'asaas_cobrancas_do_cliente',
    name: 'Asaas — cobranças do cliente',
    description:
      'Lista as cobranças de um cliente. Use o "id" que veio da busca. Em "status" use OVERDUE para vencidas, PENDING para as que ainda vão vencer e RECEIVED para as pagas — uma chamada por situação. Cada cobrança traz o valor, o vencimento e o link de pagamento (invoiceUrl). Se a lista voltar vazia, diga ao cliente que não há cobrança nessa situação — nunca invente valor nem link.',
    method: 'GET',
    path: '/payments?customer={id_cliente}&status={status}&limit=10',
    params: [
      {
        name: 'id_cliente',
        type: 'string',
        description: 'O "id" do cliente no Asaas, vindo de uma das buscas.',
        required: true,
      },
      {
        // Obrigatório de propósito: o Asaas recusa `status=` vazio na URL.
        name: 'status',
        type: 'string',
        description: 'OVERDUE (vencidas), PENDING (a vencer) ou RECEIVED (pagas).',
        required: true,
      },
    ],
  },
  {
    slug: 'asaas_pix_da_cobranca',
    name: 'Asaas — Pix copia e cola da cobrança',
    description:
      'Pega o código Pix copia e cola de uma cobrança, quando o cliente pedir para pagar no Pix. Use o "id" da cobrança. Mande para o cliente o campo "payload" inteiro, sem cortar.',
    method: 'GET',
    path: '/payments/{id_cobranca}/pixQrCode',
    params: [
      {
        name: 'id_cobranca',
        type: 'string',
        description: 'O "id" da cobrança, vindo da lista de cobranças.',
        required: true,
      },
    ],
  },
  {
    slug: 'asaas_boleto_da_cobranca',
    name: 'Asaas — linha digitável do boleto',
    description:
      'Pega a linha digitável do boleto de uma cobrança, quando o cliente pedir para pagar no boleto. Use o "id" da cobrança e mande o campo "identificationField" inteiro. Só existe em cobrança de boleto.',
    method: 'GET',
    path: '/payments/{id_cobranca}/identificationField',
    params: [
      {
        name: 'id_cobranca',
        type: 'string',
        description: 'O "id" da cobrança, vindo da lista de cobranças.',
        required: true,
      },
    ],
  },
]

/** A ferramenta pronta para gravar: URL completa no ambiente da conexão. */
export interface AsaasKitPlan extends AsaasKitTool {
  url: string
}

/**
 * Monta o kit para uma conexão. `baseUrl` é a raiz da API daquela conexão
 * (produção ou sandbox) — quem chama passa `asaasBaseUrl(environment)`, então
 * conta de teste instala ferramenta de teste.
 */
export function planAsaasKit(baseUrl: string): AsaasKitPlan[] {
  const raiz = baseUrl.replace(/\/+$/, '')
  return ASAAS_KIT.map((t) => ({ ...t, url: `${raiz}${t.path}` }))
}

/** Uma ferramenta é do kit? (slug fixo — nome editado pelo cliente não confunde) */
export function isAsaasKitSlug(slug: string): boolean {
  return ASAAS_KIT.some((t) => t.slug === slug)
}

/** Quantas do kit já estão neste agente. */
export function asaasKitInstalledCount(slugs: readonly string[]): number {
  const have = new Set(slugs)
  return ASAAS_KIT.filter((t) => have.has(t.slug)).length
}

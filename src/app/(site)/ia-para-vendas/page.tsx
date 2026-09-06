import { MarketingPage, pageMetadata, type PageSpec } from '@/components/marketing/marketing-page'

const spec: PageSpec = {
  "path": "/ia-para-vendas",
  "eyebrow": "IA para vendas",
  "datePublished": "2026-09-06",
  "title": "IA para vendas: do lead à recompra sem depender da memória da equipe",
  "metaTitle": "IA para vendas no WhatsApp: qualificação, funil, follow-up e recompra",
  "metaDescription": "Como usar IA para vender por conversa: qualificar o lead, mover o funil, sugerir a próxima ação, fazer follow-up, montar proposta com aceite, chamar de volta quem atrasou a recompra e cobrar. O que o FluxiaCRM faz em cada etapa.",
  "intro": "IA para vendas não é só responder rápido. É garantir que nenhum lead fique esperando, que cada negócio tenha uma próxima ação, que o follow-up aconteça sem ninguém lembrar e que o cliente antigo seja chamado de volta na hora certa. O FluxiaCRM cobre esse caminho inteiro, com o vendedor decidindo onde a IA age sozinha.",
  "sections": [
    {
      "id": "lead",
      "h2": "No primeiro contato",
      "bullets": [
        "Resposta em segundos, 24 horas, em qualquer canal.",
        "Qualificação pela conversa: o que precisa, para quando, onde.",
        "Lead novo distribuído entre vendedores por rodízio ou carga.",
        "Cria o negócio no funil na etapa certa, com a origem gravada."
      ]
    },
    {
      "id": "funil",
      "h2": "Durante a negociação",
      "bullets": [
        "Próxima ação sugerida no card, com o motivo.",
        "Alerta de negócio parado há dias.",
        "Proposta em página pública com aceite e PDF.",
        "Previsão de receita por etapa antes de o mês acabar."
      ],
      "example": {
        "title": "Follow-up com contexto",
        "body": "A IA reengaja quem sumiu depois de pedir preço, retomando exatamente de onde a conversa parou, e para na hora em que o cliente responde."
      }
    },
    {
      "id": "depois",
      "h2": "Depois da venda",
      "bullets": [
        "Venda ganha vira histórico de compras, sem duplicar com o ERP.",
        "Frequência de recompra calculada por cliente; \"chamar de volta\" automático com ritmo de disparo e pausa se a linha cair.",
        "Régua de cobrança para parcela vencida, com link do Asaas e aprovação humana.",
        "Cadência de pós-venda opcional ao ganhar."
      ]
    },
    {
      "id": "relatorios",
      "h2": "O que você vê",
      "bullets": [
        "Conversão e ticket por responsável, com metas.",
        "Raio-X do funil: em que etapa se perde e por quê.",
        "Origem de cada venda: anúncio, Instagram, indicação, site.",
        "Custo da IA por conversa e por agente."
      ]
    }
  ],
  "faq": [
    {
      "q": "A IA fecha a venda sozinha?",
      "a": "Ela pode confirmar pedidos simples dentro das regras (preço de tabela, endereço confirmado) e criar o pedido no ERP. Desconto fora da política, exceção e reclamação vão para uma pessoa."
    },
    {
      "q": "Como ela sabe quem chamar de volta?",
      "a": "Pela frequência de compra de cada cliente, calculada do histórico. Quem está atrasado em relação ao próprio ritmo vira sinal, e o sinal vira mensagem, com teto por dia e por linha."
    }
  ],
  "related": [
    {
      "href": "/follow-up-automatico",
      "label": "Follow-up automático"
    },
    {
      "href": "/customer-intelligence",
      "label": "Customer Intelligence"
    },
    {
      "href": "/crm-autonomo",
      "label": "O que é CRM autônomo"
    },
    {
      "href": "/cases/familia-do-gas",
      "label": "Case: Família do Gás"
    }
  ]
}

export const metadata = pageMetadata(spec)

export default function Page() {
  return <MarketingPage spec={spec} />
}

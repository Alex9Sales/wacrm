import { MarketingPage, pageMetadata, type PageSpec } from '@/components/marketing/marketing-page'

const spec: PageSpec = {
  "path": "/follow-up-automatico",
  "eyebrow": "Follow-up automático",
  "datePublished": "2026-09-06",
  "title": "Follow-up automático que para quando o cliente responde",
  "metaTitle": "Follow-up automático no WhatsApp e e-mail, com contexto e sem rajada",
  "metaDescription": "Como o FluxiaCRM faz follow-up automático: cadência multicanal que para na resposta, reengajamento inteligente do agente, alerta de negócio parado e \"chamar de volta\" para recompra atrasada, com ritmo humano.",
  "intro": "Follow-up é a venda que some por falta de lembrança. No FluxiaCRM ele acontece de três jeitos, todos com uma regra em comum: para na hora em que o cliente responde, e nunca sai em rajada. Cadência de mensagens fixas por etapa, reengajamento escrito pelo agente com o contexto da conversa, e \"chamar de volta\" para quem atrasou a recompra.",
  "sections": [
    {
      "id": "cadencia",
      "h2": "Cadência multicanal",
      "paragraphs": [
        "Uma sequência de mensagens fixas, por WhatsApp e e-mail, com prazos (dia 1, dia 3, dia 6). Cada degrau vira uma mensagem agendada; se o canal do lead não existe, pula o degrau. Responder pausa a cadência; dá para retomar de onde parou."
      ]
    },
    {
      "id": "inteligente",
      "h2": "Follow-up inteligente do agente",
      "paragraphs": [
        "Para conversas em que a IA atende, o próprio agente reengaja quem sumiu, escrevendo a mensagem a partir do que já foi dito, uma vez por silêncio, dentro do horário. Ele não repete pergunta que o cliente já respondeu."
      ],
      "example": {
        "title": "Preço perguntado às 22h",
        "body": "O cliente pergunta o preço, some. No dia seguinte, dentro do horário, o agente volta: \"ficou alguma dúvida sobre o P-13 a R$ 125?\". Se o cliente responde, a conversa segue normal e o follow-up para."
      }
    },
    {
      "id": "chamar-de-volta",
      "h2": "Chamar de volta quem atrasou a recompra",
      "paragraphs": [
        "O histórico de compras dá a frequência de cada cliente. Quem passou do próprio ritmo entra numa leva diária por linha de WhatsApp, com teto por linha e intervalo entre mensagens que você escolhe (8 a 10 minutos é um ritmo comum). Quem já tem conversa numa linha recebe por ela. Se a linha cair, a leva pausa e avisa."
      ]
    },
    {
      "id": "negocio-parado",
      "h2": "Negócio parado",
      "bullets": [
        "Alerta no card quando o negócio fica dias sem movimento.",
        "Sugestão de próxima ação com o motivo.",
        "Opcional: cadência automática para negócio esfriando."
      ]
    }
  ],
  "faq": [
    {
      "q": "O cliente vai receber mensagem repetida?",
      "a": "Não. Cadência para na resposta, o agente reengaja uma vez por silêncio, e a reativação respeita um intervalo de 7 dias por cliente e o descadastro."
    },
    {
      "q": "Por qual número sai?",
      "a": "Pela conversa que o cliente já tem. Para quem nunca falou, pela linha que você escolher para isso."
    }
  ],
  "related": [
    {
      "href": "/ia-para-vendas",
      "label": "IA para vendas"
    },
    {
      "href": "/crm-whatsapp",
      "label": "CRM para WhatsApp"
    },
    {
      "href": "/customer-intelligence",
      "label": "Customer Intelligence"
    },
    {
      "href": "/crm-autonomo",
      "label": "O que é CRM autônomo"
    }
  ]
}

export const metadata = pageMetadata(spec)

export default function Page() {
  return <MarketingPage spec={spec} />
}

import { MarketingPage, pageMetadata, type PageSpec } from '@/components/marketing/marketing-page'

const spec: PageSpec = {
  "path": "/crm-com-ia",
  "eyebrow": "CRM com IA",
  "datePublished": "2026-09-06",
  "title": "CRM com inteligência artificial: o que muda de verdade",
  "metaTitle": "CRM com IA: o que um agente faz no atendimento e nas vendas",
  "metaDescription": "CRM com IA não é chatbot com menu. É um agente que atende no WhatsApp e Instagram, consulta sua base e seu ERP, qualifica, cria pedidos, faz follow-up e passa para um humano na hora certa. Veja o que o FluxiaCRM faz.",
  "intro": "Um CRM com IA de verdade muda três coisas: quem responde primeiro (a IA, em segundos, 24 horas), o que o sistema sabe do cliente (histórico, preferências, próxima compra) e quem executa a rotina (follow-up, reativação, cobrança). O vendedor entra onde vale a pena. O FluxiaCRM faz isso com agentes por canal, ferramentas que falam com o seu ERP e supervisão humana por tipo de ação.",
  "sections": [
    {
      "id": "chatbot-vs-agente",
      "h2": "Chatbot × agente de IA",
      "paragraphs": [
        "O chatbot segue um fluxo: menu, opção, resposta pronta. O agente lê a conversa inteira, consulta a base de conhecimento e o histórico, decide o que perguntar e o que fazer, e usa ferramentas: buscar o cadastro, criar o pedido, gerar a cobrança, agendar. Quando o cliente sai do roteiro, o chatbot trava; o agente continua."
      ]
    },
    {
      "id": "o-que-faz",
      "h2": "O que os agentes fazem no FluxiaCRM",
      "bullets": [
        "Atendem WhatsApp, Instagram Direct, Messenger e e-mail, entendendo áudio, imagem e PDF.",
        "Respondem com a sua base de conhecimento e no seu tom; não inventam preço nem política.",
        "Qualificam, etiquetam, criam o negócio no funil e movem de etapa.",
        "Consultam e gravam no seu ERP por ferramentas configuradas na tela.",
        "Geram cobrança no Asaas e mandam o link, dentro de um teto por conta.",
        "Fazem follow-up de quem sumiu e chamam de volta quem atrasou a recompra.",
        "Transferem para um humano quando o cliente pede ou a regra manda, com resumo."
      ]
    },
    {
      "id": "custo",
      "h2": "Quanto custa a IA",
      "paragraphs": [
        "O consumo do modelo é pago direto ao provedor, com a chave do próprio cliente (OpenAI ou Google Gemini). O Fluxia mostra o custo por conversa, agente, canal e modelo, sem margem sobre tokens."
      ],
      "example": {
        "title": "Revenda de gás, primeiros dez dias",
        "body": "R$ 0,35 por conversa e R$ 0,67 por pedido fechado, com a IA respondendo em todos os pedidos e consultando o ERP a cada atendimento."
      }
    },
    {
      "id": "controle",
      "h2": "O controle continua com você",
      "bullets": [
        "Ligar a IA por canal e pausar por conversa.",
        "Limite de respostas por conversa e horário de atendimento.",
        "Política por ação: só sugere, pede aprovação, automático.",
        "Freio geral que pausa toda a autonomia da conta."
      ]
    }
  ],
  "faq": [
    {
      "q": "A IA inventa resposta?",
      "a": "Ela responde a partir da base de conhecimento que você sobe e das regras que você escreve. Quando não tem a informação, pergunta ou transfere, em vez de inventar."
    },
    {
      "q": "Qual modelo de IA é usado?",
      "a": "O que você escolher e pagar: OpenAI ou Google Gemini, com a sua chave. Dá para trocar o modelo por agente."
    },
    {
      "q": "Funciona com o meu WhatsApp atual?",
      "a": "Sim. Você conecta lendo um QR no número que já usa, ou pela API oficial da Meta se a operação já tiver."
    }
  ],
  "related": [
    {
      "href": "/agentes-de-ia",
      "label": "Agentes de IA"
    },
    {
      "href": "/crm-whatsapp",
      "label": "CRM para WhatsApp"
    },
    {
      "href": "/ia-para-vendas",
      "label": "IA para vendas"
    },
    {
      "href": "/como-funciona",
      "label": "Como funciona"
    }
  ]
}

export const metadata = pageMetadata(spec)

export default function Page() {
  return <MarketingPage spec={spec} />
}

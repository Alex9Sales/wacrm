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
      "h2": "Quanto custa a IA: o medidor de uma conta real",
      "paragraphs": [
        "O consumo do modelo é pago direto ao provedor, com a chave do próprio cliente (OpenAI ou Google Gemini). O Fluxia mostra o custo por conversa, agente, canal e modelo, sem margem sobre tokens."
      ],
      "example": {
        "title": "Revenda de gás, 30 dias de operação (até 07/09/2026)",
        "body": "R$ 122,41 de IA no mês para 445 conversas atendidas e 261 pedidos criados no ERP: R$ 0,28 por conversa e R$ 0,47 por pedido, com a IA consultando o ERP em média 5,8 vezes por conversa."
      },
      "stats": [
        {"label": "Conversas atendidas pela IA", "value": "445", "hint": "de 631 no período: 77% de envolvimento"},
        {"label": "Pedidos criados pela IA", "value": "261", "hint": "no ERP, sem ninguém digitando"},
        {"label": "Custo total de IA em 30 dias", "value": "R$ 122,41", "hint": "4.329 requisições · 57 milhões de tokens, 65% em cache"},
        {"label": "Custo por conversa", "value": "R$ 0,28", "hint": "pago direto ao provedor, na chave da empresa"},
        {"label": "Custo por pedido criado", "value": "R$ 0,47", "hint": "R$ 122,41 ÷ 261 pedidos"},
        {"label": "Pediu ajuda a um humano", "value": "65 vezes", "hint": "15% das conversas, como deve"}
      ],
      "note": "Números do painel Agentes IA da própria conta, 30 dias até 07/09/2026, câmbio de R$ 5,40 por dólar. Modelos: gpt-5.5 no atendimento e gpt-5.6-luna nas ferramentas."
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

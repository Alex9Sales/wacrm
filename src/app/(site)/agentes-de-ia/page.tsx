import { MarketingPage, pageMetadata, type PageSpec } from '@/components/marketing/marketing-page'

const spec: PageSpec = {
  "path": "/agentes-de-ia",
  "eyebrow": "Agentes de IA",
  "datePublished": "2026-09-06",
  "title": "Agentes de IA para vendas e atendimento: como funcionam no FluxiaCRM",
  "metaTitle": "Agentes de IA para vendas: ferramentas, base de conhecimento e transferência para humano",
  "metaDescription": "O que um agente de IA faz no FluxiaCRM: atende por canal, usa base de conhecimento e materiais, consulta e grava no ERP por ferramentas, roteia entre agentes, transfere para humano com resumo e tem custo medido por agente.",
  "intro": "No FluxiaCRM cada agente de IA tem um prompt em português, uma base de conhecimento, materiais que pode enviar, ferramentas que pode usar e uma lista do que tem permissão para fazer. Um agente pode passar a conversa para outro (SDR para vendas, vendas para suporte) e para um humano, sempre com resumo. O custo de cada um aparece no medidor.",
  "sections": [
    {
      "id": "anatomia",
      "h2": "O que compõe um agente",
      "bullets": [
        "Prompt com as regras do negócio, em português, editado na tela.",
        "Base de conhecimento: preços, condições, PDFs, respostas prontas.",
        "Materiais: catálogo, contrato, vídeo, enviados com um marcador na resposta.",
        "Ferramentas nativas: etiquetar, transferir, resolver, mover card, agendar, criar card, gerar cobrança.",
        "Ferramentas externas: chamadas HTTP ao seu ERP com risco por ferramenta e histórico de execuções."
      ]
    },
    {
      "id": "ferramentas",
      "h2": "Ferramentas externas: a IA fala com o seu ERP",
      "paragraphs": [
        "Cada ferramenta é um endpoint com parâmetros e um nível de risco. Leitura (buscar cliente, estoque, última compra) roda livre; escrita (criar pedido, corrigir endereço) tem trava contra duplicidade na mesma conversa. Se a ferramenta não responde, o agente segue com o que sabe e o histórico do CRM vira fonte alternativa, em vez de transferir."
      ],
      "example": {
        "title": "Pedido no ERP sem n8n",
        "body": "Uma revenda de gás liga a IA ao ERP em Supabase: consulta o cadastro pelo telefone, o estoque por produto, a última compra, calcula a distância pelo endereço e cria o pedido. Tudo configurado na tela de ferramentas, sem código."
      }
    },
    {
      "id": "humano",
      "h2": "Transferir para humano do jeito certo",
      "bullets": [
        "Quando o cliente pede, quando a regra manda (vazamento, exceção comercial, fiado) ou quando a IA não tem segurança sobre uma informação do negócio.",
        "A transferência leva o resumo e desliga a IA naquela conversa; ligar de novo continua com contexto.",
        "Ferramenta lenta não é motivo para transferir: o agente segue com a tabela e o que o cliente já disse."
      ]
    },
    {
      "id": "seguranca",
      "h2": "Segurança",
      "bullets": [
        "Conteúdo do cliente, áudio, imagem, resposta do ERP e bio do Instagram são desarmados antes do modelo: instrução escondida não executa.",
        "Uma geração por conversa de cada vez; mensagem que chega no meio é respondida em seguida, não em paralelo.",
        "Limite de respostas por conversa, por episódio de atendimento."
      ]
    }
  ],
  "faq": [
    {
      "q": "Posso ter agentes diferentes por número?",
      "a": "Sim. Cada canal escolhe seus agentes, e um roteador passa a conversa entre eles quando o assunto muda."
    },
    {
      "q": "A IA pode enviar documentos?",
      "a": "Sim, os materiais que você sobe para o agente: catálogo, contrato, circular, vídeo."
    },
    {
      "q": "Quanto custa cada agente?",
      "a": "O consumo é pago ao provedor com a sua chave; o medidor mostra o custo por agente, canal, conversa e modelo."
    }
  ],
  "related": [
    {
      "href": "/crm-com-ia",
      "label": "CRM com IA"
    },
    {
      "href": "/como-funciona",
      "label": "Como funciona"
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

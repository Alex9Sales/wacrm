import { MarketingPage, pageMetadata, type PageSpec } from '@/components/marketing/marketing-page'

const spec: PageSpec = {
  "path": "/customer-intelligence",
  "eyebrow": "Customer Intelligence",
  "datePublished": "2026-09-06",
  "title": "Customer Intelligence: a memória comercial que faz a IA vender melhor",
  "metaTitle": "Customer Intelligence no CRM: histórico de compras, frequência e próxima compra prevista",
  "metaDescription": "O que é Customer Intelligence no FluxiaCRM: histórico de compras de planilha, ERP e funil sem duplicar, ticket médio, frequência, produto e pagamento preferidos, próxima compra prevista e sinais que viram ação.",
  "intro": "Customer Intelligence é o CRM saber, de cada cliente, o que ele compra, quanto, com que frequência, como paga e quando deve voltar, e usar isso no atendimento e nas ações. No FluxiaCRM essa memória é nativa: nasce da planilha importada, do ERP sincronizado ou das vendas ganhas no funil, e a mesma venda nunca conta duas vezes.",
  "sections": [
    {
      "id": "fontes",
      "h2": "De onde vem o histórico",
      "bullets": [
        "Planilha de vendas importada (a importação só atualiza, nunca duplica).",
        "ERP sincronizado diariamente por ferramenta.",
        "Negócio ganho no funil.",
        "Cobranças do Asaas."
      ],
      "paragraphs": [
        "A mesma venda que chega por dois caminhos (planilha e ERP, ou ERP e funil) vira uma só: fica a fonte mais precisa e a repetida aponta para ela. Uma revenda com 4.500 vendas em planilha e 4.000 no ERP tinha 4.000 em dobro; hoje cada cliente mostra as compras reais."
      ]
    },
    {
      "id": "metricas",
      "h2": "O que é calculado por cliente",
      "bullets": [
        "Quantidade de compras, total e ticket médio.",
        "Frequência de recompra e próxima compra prevista.",
        "Produto mais comprado e forma de pagamento habitual.",
        "Dias desde a última compra e atraso em relação ao ritmo dele."
      ]
    },
    {
      "id": "uso",
      "h2": "Como a IA usa isso",
      "paragraphs": [
        "O agente recebe os fatos do cliente no atendimento: \"cliente recorrente, 3 compras, última em 08/06, costuma levar P-13 Ultragaz no Pix\". Se o ERP não responde, esse histórico vale como cadastro. Os sinais (recompra atrasada, cliente sumido, alto valor) nascem dessas métricas e alimentam o \"chamar de volta\" e as sugestões no funil."
      ],
      "example": {
        "title": "Cliente que compra a cada 18 dias",
        "body": "Aos 40 dias sem comprar ele vira sinal de recompra atrasada. A leva do dia inclui ele, na linha em que ele já conversa, com uma mensagem que cita o produto de sempre."
      }
    },
    {
      "id": "painel",
      "h2": "Onde você vê",
      "bullets": [
        "Ficha do contato: histórico, métricas e \"o que a IA vê deste cliente\".",
        "Lista de recompra: quem chamar de volta hoje, com o motivo.",
        "Relatórios: ticket, conversão e origem da venda."
      ]
    }
  ],
  "faq": [
    {
      "q": "Preciso importar tudo de uma vez?",
      "a": "Não. Importe uma planilha inicial e deixe o ERP ou o funil alimentar o resto. Importar de novo só atualiza."
    },
    {
      "q": "E se o cliente compra em dois números da empresa?",
      "a": "É o mesmo contato. O telefone é casado com DDD, com ou sem 55 e nono dígito, e a conversa nos dois números aparece junta."
    }
  ],
  "related": [
    {
      "href": "/crm-autonomo",
      "label": "O que é CRM autônomo"
    },
    {
      "href": "/ia-para-vendas",
      "label": "IA para vendas"
    },
    {
      "href": "/follow-up-automatico",
      "label": "Follow-up automático"
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

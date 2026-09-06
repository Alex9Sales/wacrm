import { MarketingPage, pageMetadata, type PageSpec } from '@/components/marketing/marketing-page'

const spec: PageSpec = {
  "path": "/cases/familia-do-gas",
  "eyebrow": "Case",
  "datePublished": "2026-09-06",
  "title": "Como a Família do Gás usa agentes de IA para atender e criar pedidos automaticamente",
  "metaTitle": "Case Família do Gás: IA atendendo no WhatsApp e criando pedidos no ERP",
  "metaDescription": "Revenda de gás em Campo Grande que colocou um agente de IA atendendo no WhatsApp: consulta o ERP, cria pedidos, corrige endereço, calcula distância e chama de volta quem atrasou a recompra. Números reais dos primeiros dez dias.",
  "intro": "A Família do Gás é uma revenda de gás em Campo Grande (MS) com vários números de WhatsApp e um ERP próprio. Em agosto de 2026 ela colocou um agente de IA, a \"Maria\", atendendo os pedidos de ponta a ponta. Nos primeiros dez dias foram 330 conversas e 168 pedidos criados pela IA, a um custo de R$ 0,67 por pedido, saindo de 1 pedido no primeiro dia para 30 por dia.",
  "breadcrumb": [
    {
      "name": "Início",
      "path": "/"
    },
    {
      "name": "Cases",
      "path": "/cases/familia-do-gas"
    },
    {
      "name": "Família do Gás",
      "path": "/cases/familia-do-gas"
    }
  ],
  "sections": [
    {
      "id": "operacao",
      "h2": "A operação",
      "paragraphs": [
        "O cliente manda \"pode me enviar um gás?\". A Maria reconhece o número, consulta o cadastro e a última compra no ERP, passa o preço da tabela (Ultragaz ou Copagaz, conforme o que ele costuma levar), confirma endereço e forma de pagamento, cria o pedido no ERP e diz que já saiu. Reclamação, vazamento, fiado e desconto fora da política vão para uma pessoa, com resumo."
      ]
    },
    {
      "id": "ferramentas",
      "h2": "As ferramentas ligadas ao ERP",
      "bullets": [
        "Buscar cliente pelo telefone, consultar estoque, última compra e histórico de compras.",
        "Calcular distância pelo endereço, com regra de preço por faixa e por bairro.",
        "Criar o pedido, editar a forma de pagamento e corrigir o endereço do cliente, em vez de criar de novo.",
        "Tudo configurado na tela de ferramentas do agente, sem código e sem n8n."
      ]
    },
    {
      "id": "numeros",
      "h2": "Os números dos primeiros dez dias",
      "bullets": [
        "330 conversas atendidas pela IA, 168 pedidos criados.",
        "R$ 0,67 de IA por pedido e R$ 0,35 por conversa, medidos no painel de custo, pagos com a chave da própria empresa.",
        "Rampa de 1 pedido no primeiro dia para 30 pedidos por dia.",
        "A IA pediu ajuda de um humano 51 vezes no mês, como deve."
      ],
      "paragraphs": [
        "Os números vêm do painel da conta em 04/09/2026 e cobrem os primeiros dez dias de operação com a IA ligada em todos os pedidos."
      ]
    },
    {
      "id": "memoria",
      "h2": "A memória comercial",
      "paragraphs": [
        "O histórico de 4.222 vendas foi importado da planilha e passou a ser sincronizado com o ERP todo dia. Quando o ERP ficou lento por alguns minutos, a IA seguiu atendendo com o histórico do próprio CRM. A partir da frequência de cada cliente, o \"chamar de volta\" sai todo dia em levas por linha, com ritmo de disparo e pausa se a linha cair."
      ],
      "example": {
        "title": "O que mudou para a equipe",
        "body": "A equipe entrou nas exceções: cliente que pede desconto fora da tabela, endereço que o mapa não acha, reclamação. O resto, inclusive de madrugada, a Maria resolve e registra."
      }
    },
    {
      "id": "licoes",
      "h2": "O que aprendemos no caminho",
      "bullets": [
        "Ferramenta lenta não é motivo para transferir: o agente segue com a tabela e o que o cliente já disse.",
        "O mesmo pedido não pode ser criado duas vezes: mudança de pagamento é edição, não novo pedido.",
        "O histórico de compras não pode ter a mesma venda em dobro; a importação só atualiza.",
        "Cliente de outra marca pelo nome (\"Super\") recebe \"aqui trabalhamos com Ultragaz\" e a venda segue."
      ]
    }
  ],
  "faq": [
    {
      "q": "Serve para outras revendas ou distribuidoras?",
      "a": "Sim. O que é específico (preços, marcas, bairros, regras de desconto) fica no prompt e nas ferramentas da conta; o motor é o mesmo."
    },
    {
      "q": "Precisa ter ERP?",
      "a": "Não. Sem ERP, o pedido vira negócio ganho no funil e o histórico nasce ali."
    }
  ],
  "related": [
    {
      "href": "/como-funciona",
      "label": "Como funciona"
    },
    {
      "href": "/agentes-de-ia",
      "label": "Agentes de IA"
    },
    {
      "href": "/customer-intelligence",
      "label": "Customer Intelligence"
    },
    {
      "href": "/follow-up-automatico",
      "label": "Follow-up automático"
    }
  ],
  "cta": {
    "title": "Quer ver isso no seu negócio?",
    "body": "Conte como é a sua operação no WhatsApp e a gente mostra, em uma conversa, o que o agente faria no seu caso."
  }
}

export const metadata = pageMetadata(spec)

export default function Page() {
  return <MarketingPage spec={spec} />
}

import { MarketingPage, pageMetadata, type PageSpec } from '@/components/marketing/marketing-page'

const spec: PageSpec = {
  "path": "/como-funciona",
  "eyebrow": "Como funciona",
  "datePublished": "2026-09-06",
  "title": "Como funciona o FluxiaCRM",
  "metaTitle": "Como funciona o FluxiaCRM — do lead à venda, com IA e supervisão humana",
  "metaDescription": "O caminho de uma conversa no FluxiaCRM em 8 passos: o lead entra, a IA identifica o cliente, recupera o contexto, atende, percebe sinais, age dentro das regras, o humano aprova quando precisa e o CRM registra tudo.",
  "intro": "O FluxiaCRM é um CRM em que agentes de IA atendem e vendem por conversa (WhatsApp, Instagram, Messenger e e-mail) e um humano supervisiona. Cada conversa passa pelos mesmos oito passos: entrar, ser identificada, ganhar contexto, ser atendida, gerar sinais, virar ação, passar pela sua aprovação quando a regra pede, e ficar registrada. Abaixo, o que acontece em cada um, com o que o produto faz de verdade.",
  "sections": [
    {
      "id": "passos",
      "h2": "Os oito passos de uma conversa",
      "steps": [
        {
          "title": "O lead entra",
          "body": "Pelo WhatsApp (número lido por QR ou API oficial da Meta), Instagram Direct, Messenger, e-mail, comentário em post que vira DM, landing page ou quiz escrito pela IA, link de WhatsApp com QR rastreado, anúncios de lead da Meta e do TikTok, ou pela API. Tudo cai na mesma caixa de entrada, com a origem gravada."
        },
        {
          "title": "O Fluxia identifica o cliente",
          "body": "O telefone é casado com DDD e tolerância ao nono dígito e ao 55, nunca só pelos últimos oito números. O mesmo cliente é um contato só, mesmo falando em dois números da empresa. Se a base foi importada de planilha ou do ERP, o histórico dele já está lá."
        },
        {
          "title": "A IA recupera o contexto",
          "body": "Base de conhecimento (tabela de preços, condições, PDFs), histórico de compras, o que ele disse nas outras conversas e, quando a empresa tem ERP, o cadastro e a última compra consultados por ferramenta. Se o ERP não responder, o histórico do próprio CRM vale como fonte."
        },
        {
          "title": "A IA atende",
          "body": "Responde em segundos, entende áudio, imagem e PDF, fala no tom da empresa e cumpre regras de negócio escritas em português. Pode criar o pedido no ERP, corrigir endereço, calcular distância, gerar uma cobrança no Asaas e mandar o link, agendar, mover o negócio de etapa e chamar um humano quando o cliente pede."
        },
        {
          "title": "O Fluxia percebe sinais",
          "body": "Recompra atrasada, cliente sumido, negócio parado há dias, proposta sem resposta, parcela vencida, cliente de alto valor. Os sinais nascem das métricas do próprio histórico, sem depender de ninguém lembrar."
        },
        {
          "title": "A IA sugere ou executa",
          "body": "Cada tipo de ação tem uma política: só sugere, pede aprovação ou executa sozinha, com teto por dia, horário e ritmo entre mensagens. Cobrar, reativar, fazer follow-up e mover negócio são ações diferentes com regras diferentes."
        },
        {
          "title": "O humano aprova quando precisa",
          "body": "A fila \"Precisa de você\" mostra o texto, o motivo e o que vai acontecer ao aprovar. Dá para editar, recusar, corrigir depois e desfazer. Um freio geral pausa tudo. O que a equipe decide vira histórico de confiança por ação."
        },
        {
          "title": "O CRM registra tudo",
          "body": "Conversa, negócio, histórico de compras sem duplicar, quem falou o quê, o que a IA fez e por quê, e o custo da IA por conversa, agente, canal e modelo, pago com a chave do próprio cliente."
        }
      ]
    },
    {
      "id": "exemplo",
      "h2": "Um exemplo de ponta a ponta",
      "example": {
        "title": "Revenda de gás, cliente recorrente",
        "body": "\"Pode me mandar um gás?\" às 12h16. A IA reconhece o número, vê no histórico que a última compra foi um P-13 Ultragaz paga no Pix, confirma o endereço, passa o preço da tabela, cria o pedido no ERP e avisa que já saiu. Se o ERP estivesse fora do ar, ela seguiria com o histórico do CRM e pediria só o endereço. Se ele dissesse \"vou pagar depois\", a regra manda chamar um responsável."
      }
    },
    {
      "id": "supervisao",
      "h2": "Onde entra a supervisão humana",
      "paragraphs": [
        "Autonomia no Fluxia não é \"ligar e torcer\". Toda ação nasce no modo mais conservador e só sobe para automático com evidência: um número mínimo de decisões aprovadas sem edição, durante um período mínimo, sem reversões graves. Quem decide o critério é a empresa, e o painel mostra o placar."
      ]
    }
  ],
  "faq": [
    {
      "q": "Preciso de ERP para usar?",
      "a": "Não. Sem ERP, o histórico de compras nasce das vendas ganhas no funil e das planilhas importadas. Com ERP, a IA consulta cadastro, estoque e última compra por ferramentas HTTP configuradas na tela, sem programação."
    },
    {
      "q": "A IA fala com todo mundo sozinha?",
      "a": "Só onde você liga. Ela atende nos canais escolhidos, respeita horário de atendimento, para quando um humano assume a conversa e tem limite de respostas por conversa."
    },
    {
      "q": "Quanto tempo para colocar no ar?",
      "a": "A conexão do WhatsApp é um QR e o funil vem pronto. O que leva mais tempo é ensinar o agente com os seus materiais, e é isso que faz diferença."
    }
  ],
  "related": [
    {
      "href": "/crm-autonomo",
      "label": "O que é CRM autônomo"
    },
    {
      "href": "/agentes-de-ia",
      "label": "Agentes de IA"
    },
    {
      "href": "/cases/familia-do-gas",
      "label": "Case: Família do Gás"
    },
    {
      "href": "/customer-intelligence",
      "label": "Customer Intelligence"
    }
  ]
}

export const metadata = pageMetadata(spec)

export default function Page() {
  return <MarketingPage spec={spec} />
}

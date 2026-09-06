import { MarketingPage, pageMetadata, type PageSpec } from '@/components/marketing/marketing-page'

const spec: PageSpec = {
  "path": "/sobre",
  "eyebrow": "Sobre",
  "datePublished": "2026-09-06",
  "title": "Sobre o FluxiaCRM e a Sales Tecnologia",
  "metaTitle": "Sobre o FluxiaCRM — quem faz, de onde, para quem",
  "metaDescription": "O FluxiaCRM é desenvolvido pela Sales Tecnologia, em Campo Grande (MS), para empresas que vendem por conversa: CRM com agentes de IA, funil, follow-up automático e supervisão humana.",
  "intro": "O FluxiaCRM é um produto da Sales Tecnologia, empresa de Campo Grande, Mato Grosso do Sul, fundada por Alex Sales. Ele nasceu de uma pergunta simples: por que o comercial das empresas que vendem pelo WhatsApp depende tanto da memória e do horário de quem atende? A resposta foi um CRM em que agentes de IA atendem, conhecem o cliente, percebem o momento e agem dentro das regras da empresa, com um humano supervisionando.",
  "sections": [
    {
      "id": "o-que-e",
      "h2": "O que é",
      "paragraphs": [
        "Um CRM com caixa de entrada compartilhada (WhatsApp, Instagram, Messenger, e-mail), funil de vendas, agenda, propostas, cobrança pelo Asaas, disparos e cadências, captação (landing pages, quiz, anúncios de lead) e agentes de IA com ferramentas para falar com o seu ERP. Tudo numa conta, com a equipe inteira dentro."
      ]
    },
    {
      "id": "para-quem",
      "h2": "Para quem",
      "bullets": [
        "Revendas e distribuidoras com pedido recorrente.",
        "Clínicas, consultórios e serviços que vivem de agenda e follow-up.",
        "Mentorias, consultorias e negócios que qualificam pelo Instagram e fecham no WhatsApp.",
        "Qualquer equipe pequena ou média que vende conversando e não quer perder lead de madrugada."
      ]
    },
    {
      "id": "principios",
      "h2": "Princípios",
      "bullets": [
        "Supervisão humana de verdade: nada sobe para automático sem evidência, e tudo tem freio.",
        "Custo transparente: a IA roda com a chave do próprio cliente e o custo aparece por conversa.",
        "Dados do cliente na conta dele, com exclusão a pedido.",
        "Regras de negócio em português, editadas na tela, não em código."
      ]
    },
    {
      "id": "contato",
      "h2": "Contato",
      "paragraphs": [
        "Fale com a gente no WhatsApp pelo link no rodapé, ou teste grátis por 7 dias sem cartão. Políticas de privacidade, termos de uso e exclusão de dados estão nos links do rodapé."
      ]
    }
  ],
  "related": [
    {
      "href": "/como-funciona",
      "label": "Como funciona"
    },
    {
      "href": "/cases/familia-do-gas",
      "label": "Case: Família do Gás"
    },
    {
      "href": "/crm-autonomo",
      "label": "O que é CRM autônomo"
    }
  ],
  "cta": {
    "title": "Conheça por dentro",
    "body": "Sete dias grátis, sem cartão, para ver o agente atendendo no seu número."
  }
}

export const metadata = pageMetadata(spec)

export default function Page() {
  return <MarketingPage spec={spec} />
}

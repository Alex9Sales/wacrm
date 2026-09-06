import { MarketingPage, pageMetadata, type PageSpec } from '@/components/marketing/marketing-page'

const spec: PageSpec = {
  "path": "/crm-whatsapp",
  "eyebrow": "CRM para WhatsApp",
  "datePublished": "2026-09-06",
  "title": "CRM para WhatsApp: vários números, uma caixa, IA atendendo",
  "metaTitle": "CRM para WhatsApp com IA: caixa compartilhada, funil e disparos seguros",
  "metaDescription": "CRM para WhatsApp com vários números na mesma caixa de entrada, agentes de IA que atendem 24 horas, funil de vendas, disparos com ritmo humano e proteção do número. Conecta por QR ou API oficial.",
  "intro": "Vender pelo WhatsApp com a equipe cada um no seu número acaba em cliente sem resposta e ninguém sabendo quem falou o quê. O FluxiaCRM junta todos os números numa caixa só, com setores, atribuição e histórico, e coloca agentes de IA respondendo em segundos. Disparos e cadências saem com ritmo humano, descadastro automático e pausa se o número cair.",
  "sections": [
    {
      "id": "conexao",
      "h2": "Como conecta",
      "bullets": [
        "Número atual: leitura de QR, sem trocar de chip e sem API oficial.",
        "API oficial da Meta (Cloud API): para quem já tem, com templates e ligação pelo WhatsApp.",
        "Vários números na mesma conta, cada um com seu setor padrão e seus agentes de IA."
      ]
    },
    {
      "id": "caixa",
      "h2": "Caixa de entrada compartilhada",
      "bullets": [
        "Setores e atribuição: quem vê o quê, quem responde o quê.",
        "Marcar como não lida, notas internas, menção da equipe, chat interno.",
        "Áudio transcrito, imagem lida pela IA, PDF entendido.",
        "Ligação pelo WhatsApp e webphone dentro do CRM."
      ]
    },
    {
      "id": "ia",
      "h2": "IA no WhatsApp",
      "paragraphs": [
        "O agente responde só nos números em que você ligou, respeita o horário de atendimento, para quando um humano entra na conversa e volta quando ele sai. Ele consulta a base de conhecimento e o ERP, cria pedidos e transfere com resumo."
      ],
      "example": {
        "title": "Cliente que muda de ideia",
        "body": "O cliente fecha no cartão, manda o comprovante do Pix depois. A IA não cria outro pedido: edita a forma de pagamento do pedido que já existe no ERP. Foi um caso real que virou regra."
      }
    },
    {
      "id": "disparos",
      "h2": "Disparos e cadências sem queimar o número",
      "bullets": [
        "Ritmo humano entre mensagens (você define o intervalo) e teto por dia.",
        "\"Responda SAIR\" anexado e opt-out automático; quem pediu para sair nunca recebe.",
        "Se o número cair ou der erro, o disparo pausa sozinho e avisa o dono.",
        "Cadência multicanal: WhatsApp e e-mail, que para quando o cliente responde."
      ]
    }
  ],
  "faq": [
    {
      "q": "Meu número corre risco de bloqueio?",
      "a": "É o risco de qualquer disparo em massa, e a plataforma trabalha contra ele: ritmo humanizado, descadastro automático, aviso quando o volume sobe e pausa se a linha cair. Disparo de texto sai só em número não-oficial ou e-mail; no oficial, template."
    },
    {
      "q": "Quantos números posso conectar?",
      "a": "Depende do plano: 1 no Start, 3 no Essencial, 6 no Pro e ilimitado no Enterprise."
    },
    {
      "q": "Dá para usar o mesmo número em dois computadores?",
      "a": "Sim. A caixa é da conta: toda a equipe entra pelo CRM, cada um com seu login e seu setor."
    }
  ],
  "related": [
    {
      "href": "/crm-com-ia",
      "label": "CRM com IA"
    },
    {
      "href": "/follow-up-automatico",
      "label": "Follow-up automático"
    },
    {
      "href": "/como-funciona",
      "label": "Como funciona"
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

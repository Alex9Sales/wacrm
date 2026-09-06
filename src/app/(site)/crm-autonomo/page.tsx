import { MarketingPage, pageMetadata, type PageSpec } from '@/components/marketing/marketing-page'

const spec: PageSpec = {
  "path": "/crm-autonomo",
  "eyebrow": "Conceito",
  "datePublished": "2026-09-06",
  "title": "CRM autônomo: o que é e como agentes de IA podem operar seu comercial",
  "metaTitle": "CRM autônomo: o que é e como funciona a autonomia supervisionada",
  "metaDescription": "CRM autônomo é o CRM em que a IA não só registra, mas percebe sinais, decide a próxima ação e executa dentro de regras, com aprovação humana onde a empresa quiser. Veja como isso funciona no FluxiaCRM.",
  "intro": "Um CRM tradicional guarda o que a equipe lembra de anotar. Um CRM autônomo percebe o que está acontecendo com cada cliente, propõe ou executa a próxima ação e registra o resultado, dentro de regras que a empresa escreve. \"Supervisionado\" é a parte que importa: nada sobe para automático sem evidência, e um humano pode corrigir, desfazer ou pausar tudo a qualquer momento.",
  "sections": [
    {
      "id": "tradicional-vs-autonomo",
      "h2": "CRM tradicional × CRM autônomo",
      "bullets": [
        "Tradicional: o vendedor atende, anota, lembra de fazer follow-up, decide quem chamar de volta. O sistema é um arquivo.",
        "Autônomo: agentes de IA atendem por conversa, o sistema calcula ticket, frequência e próxima compra prevista, gera sinais (recompra atrasada, negócio parado, parcela vencida) e transforma sinal em ação.",
        "Supervisionado: cada ação tem um nível, só sugere, pede aprovação ou executa, e um freio geral. O humano continua dono do que sai para o cliente."
      ]
    },
    {
      "id": "motor",
      "h2": "Sinal → política → ação → resultado",
      "paragraphs": [
        "O motor do Fluxia é um laço simples de explicar. Um sinal aparece (o cliente que compra a cada 18 dias está há 40 sem comprar). A política da conta diz o que fazer com esse tipo de sinal (reativar: pedir aprovação). A ação é montada com a mensagem já escrita, o motivo e o que vai acontecer. O resultado fica gravado: aprovada sem mexer, editada, recusada, revertida. É esse registro que alimenta o portão de promoção."
      ]
    },
    {
      "id": "promocao",
      "h2": "Como uma ação ganha o direito de ser automática",
      "paragraphs": [
        "Uma ação sobe de \"pede aprovação\" para \"automático\" quando acumula evidência: um mínimo de decisões, um período mínimo, uma taxa alta de aprovação sem edição, uma taxa baixa de recusa e zero reversões graves. Os limiares são configuração da conta, não constantes no código. Enquanto os números não ficam verdes, a fila continua passando por gente."
      ],
      "example": {
        "title": "Cobrança de parcela vencida",
        "body": "A régua de cobrança propõe uma mensagem por devedor, com as parcelas do momento e o link, a cada 3 dias, dentro do horário e de um teto diário. Antes de cada envio o sistema reconfere no Asaas se ainda está em aberto. A ação nasce em \"pede aprovação\" e só vira automática depois de 20 decisões em 14 dias com pelo menos 90% aprovadas sem edição."
      }
    },
    {
      "id": "memoria",
      "h2": "Memória comercial: a base de tudo",
      "paragraphs": [
        "Sem memória não há autonomia útil. O Fluxia guarda o histórico de compras de cada cliente, vindo da planilha, do ERP ou do funil, sem duplicar a mesma venda, e calcula ticket médio, frequência, produto e pagamento preferidos e a próxima compra prevista. O agente recebe isso no atendimento; os sinais nascem daí. Veja a página de Customer Intelligence."
      ]
    },
    {
      "id": "seguranca",
      "h2": "Segurança e auditoria",
      "bullets": [
        "Conteúdo de terceiros (mensagem, áudio, texto dentro de imagem, resposta do ERP) é desarmado antes de chegar ao modelo: instrução escondida numa mensagem não executa nada.",
        "Cada ação da IA fica no histórico com sinal, política, decisão e resultado. \"Corrigir\" pausa a IA naquela conversa e, na cobrança, para a régua no devedor.",
        "Ferramentas que gravam (criar pedido, gerar cobrança) têm trava contra duplicidade e limite de valor; acima do teto a IA avisa uma pessoa em vez de agir.",
        "Custo da IA visível por conversa, agente, canal e modelo, pago com a chave do próprio cliente."
      ]
    },
    {
      "id": "nichos",
      "h2": "Exemplos por tipo de negócio",
      "bullets": [
        "Revenda de gás e água: reconhece o cliente, sabe o que ele compra e quando, cria o pedido no ERP e chama de volta quem atrasou a recompra.",
        "Clínica e consultório: qualifica, agenda no Google Calendar, faz follow-up de quem pediu orçamento e não fechou.",
        "Mentoria e serviços: qualifica pelo perfil, envia material, marca reunião e mantém a cadência até a resposta.",
        "Distribuidora: cadastro e pedidos pelo ERP, cobrança de parcela vencida com régua e link de pagamento."
      ]
    },
    {
      "id": "com-ou-sem-erp",
      "h2": "Com ERP ou sem ERP",
      "paragraphs": [
        "Com ERP, a IA consulta e grava pelas ferramentas externas configuradas na tela (endpoint, parâmetros, risco). Sem ERP, o próprio Fluxia é a memória: importação de planilhas, vendas ganhas no funil e cobranças pelo Asaas constroem o histórico."
      ]
    }
  ],
  "faq": [
    {
      "q": "CRM autônomo substitui o vendedor?",
      "a": "Não. Ele tira do vendedor o que é lembrança e repetição, atender de madrugada, follow-up, chamar de volta, cobrar, e deixa com gente o que exige julgamento: exceção comercial, reclamação, negociação fora da política."
    },
    {
      "q": "O que acontece quando a IA erra?",
      "a": "A ação fica registrada, dá para corrigir na conversa e desfazer o que for reversível. A correção pausa a IA naquela conversa e conta contra a promoção daquela ação para automático."
    },
    {
      "q": "Isso é um chatbot?",
      "a": "Um chatbot segue um fluxo fixo. Um agente entende a conversa, consulta dados, decide a próxima ação e usa ferramentas. A diferença aparece quando o cliente sai do roteiro."
    }
  ],
  "related": [
    {
      "href": "/como-funciona",
      "label": "Como funciona"
    },
    {
      "href": "/customer-intelligence",
      "label": "Customer Intelligence"
    },
    {
      "href": "/agentes-de-ia",
      "label": "Agentes de IA"
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

/**
 * Starter flow templates.
 *
 * Three pre-canned flows users can clone with one click instead of
 * building from scratch. Each template is a plain JS object describing
 * the same shape `/api/flows` PUT accepts — name, trigger config,
 * entry_node_id, fallback_policy, nodes[] — keyed by a stable
 * `slug`.
 *
 * The clone path (`/api/flows` POST with `template_slug`) creates a
 * NEW flow_row + flow_nodes rows for the user. `node_key`s are kept
 * verbatim (they're stable strings, not UUIDs, so cloning never
 * needs to rewrite edge references).
 *
 * Choosing a single static module over a DB-backed gallery for v1
 * because: (a) the set is small and changes with code releases, not
 * data; (b) keeps templates portable across self-hosted instances
 * without migrations; (c) editing in source is the lowest-friction
 * way to add the next template.
 */

import type {
  CollectInputNodeConfig,
  ConditionNodeConfig,
  HandoffNodeConfig,
  KeywordTriggerConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMessageNodeConfig,
  StartNodeConfig,
} from "./types";

export type FlowTemplateNodeType =
  | "start"
  | "send_message"
  | "send_buttons"
  | "send_list"
  | "collect_input"
  | "condition"
  | "set_tag"
  | "handoff"
  | "end";

export interface FlowTemplateNode {
  node_key: string;
  node_type: FlowTemplateNodeType;
  config:
    | StartNodeConfig
    | SendMessageNodeConfig
    | SendButtonsNodeConfig
    | SendListNodeConfig
    | CollectInputNodeConfig
    | ConditionNodeConfig
    | HandoffNodeConfig
    | Record<string, unknown>;
}

export interface FlowTemplate {
  slug: string;
  name: string;
  description: string;
  /** Used by the gallery to surface a relevant icon. lucide-react name. */
  icon: "MessageSquare" | "HelpCircle" | "UserPlus";
  trigger_type: "keyword" | "first_inbound_message" | "manual";
  trigger_config: KeywordTriggerConfig | Record<string, unknown>;
  entry_node_id: string;
  nodes: FlowTemplateNode[];
}

// ============================================================
// 1. Welcome menu — the example from the owner's brief
// ============================================================
const WELCOME_MENU: FlowTemplate = {
  slug: "welcome_menu",
  name: "Menu de boas-vindas",
  description:
    "Recebe o cliente que manda uma palavra-chave e encaminha pro atendente certo, conforme ele já seja cliente ou seja novo.",
  icon: "MessageSquare",
  trigger_type: "keyword",
  trigger_config: {
    keywords: ["oi", "olá", "ola", "ajuda", "suporte"],
    match_type: "contains",
  },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "welcome" },
    },
    {
      node_key: "welcome",
      node_type: "send_buttons",
      config: {
        text: "Oi! 👋 Bem-vindo ao atendimento. Você já é cliente ou é novo por aqui?",
        footer_text: "Toque em um botão abaixo para continuar.",
        buttons: [
          {
            reply_id: "existing",
            title: "Já sou cliente",
            next_node_key: "existing_handoff",
          },
          {
            reply_id: "new",
            title: "Sou novo",
            next_node_key: "new_handoff",
          },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: "existing_handoff",
      node_type: "handoff",
      config: {
        customer_message:
          "Perfeito! Já estou te encaminhando para um atendente. Um instante 🙂",
        note: "Cliente já cadastrado precisa de ajuda — confira o histórico da conta antes de responder.",
      } as HandoffNodeConfig,
    },
    {
      node_key: "new_handoff",
      node_type: "handoff",
      config: {
        customer_message:
          "Que bom te ver por aqui! Já estou te passando para um atendente. Um instante 🙂",
        note: "Cliente novo — enviar preços + link de boas-vindas.",
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// 2. FAQ bot — list-message answers, fully automated
// ============================================================
const FAQ_BOT: FlowTemplate = {
  slug: "faq_bot",
  name: "Bot de perguntas frequentes",
  description:
    "Responde as dúvidas mais comuns automaticamente. O cliente escolhe um tópico da lista; o bot responde e encerra.",
  icon: "HelpCircle",
  trigger_type: "keyword",
  trigger_config: {
    keywords: ["duvida", "dúvida", "perguntas", "informações", "info"],
    match_type: "contains",
  },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "topics" },
    },
    {
      node_key: "topics",
      node_type: "send_list",
      config: {
        text: "Como posso te ajudar?",
        button_label: "Ver tópicos",
        sections: [
          {
            title: "Perguntas comuns",
            rows: [
              {
                reply_id: "hours",
                title: "Horário de atendimento",
                next_node_key: "answer_hours",
              },
              {
                reply_id: "pricing",
                title: "Preços",
                next_node_key: "answer_pricing",
              },
              {
                reply_id: "refunds",
                title: "Política de reembolso",
                next_node_key: "answer_refunds",
              },
            ],
          },
          {
            title: "Outros",
            rows: [
              {
                reply_id: "human",
                title: "Falar com um atendente",
                next_node_key: "human_handoff",
              },
            ],
          },
        ],
      } as SendListNodeConfig,
    },
    {
      node_key: "answer_hours",
      node_type: "send_message",
      config: {
        text: "Atendemos de segunda a sexta, das 8h às 18h. No fim de semana, só casos urgentes.",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "answer_pricing",
      node_type: "send_message",
      config: {
        text: "Nossos planos começam em R$ 9/mês. Acesse https://exemplo.com/precos para ver a tabela completa.",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "answer_refunds",
      node_type: "send_message",
      config: {
        text: "Fazemos reembolso em até 30 dias após a compra. Responda com o número do pedido que a gente resolve.",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "human_handoff",
      node_type: "handoff",
      config: {
        customer_message:
          "Claro! Já estou te passando para um atendente. Um instante 🙂",
        note: "Cliente pediu para falar com um atendente pelo bot de perguntas frequentes.",
      } as HandoffNodeConfig,
    },
    {
      node_key: "end",
      node_type: "end",
      config: {},
    },
  ],
};

// ============================================================
// 3. Lead capture — collect_input chain, ends in a handoff
// ============================================================
const LEAD_CAPTURE: FlowTemplate = {
  slug: "lead_capture",
  name: "Captura de lead",
  description:
    "Recebe quem manda a primeira mensagem, coleta nome + e-mail + empresa e transfere pro vendedor com os dados na nota.",
  icon: "UserPlus",
  trigger_type: "first_inbound_message",
  trigger_config: {},
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "intro" },
    },
    {
      node_key: "intro",
      node_type: "send_message",
      config: {
        text: "Boas-vindas! 👋 Vou fazer algumas perguntas rápidas pra te direcionar pra pessoa certa.",
        next_node_key: "ask_name",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "ask_name",
      node_type: "collect_input",
      config: {
        prompt_text: "Qual é o seu nome?",
        var_key: "name",
        next_node_key: "ask_email",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_email",
      node_type: "collect_input",
      config: {
        prompt_text: "Obrigado {{vars.name}}! Qual é o seu e-mail?",
        var_key: "email",
        next_node_key: "ask_company",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_company",
      node_type: "collect_input",
      config: {
        prompt_text: "Quase lá — qual é o nome da sua empresa?",
        var_key: "company",
        next_node_key: "handoff",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "handoff",
      node_type: "handoff",
      config: {
        note: "Novo lead — nome={{vars.name}}, e-mail={{vars.email}}, empresa={{vars.company}}.",
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// 4. Comentário do Instagram → DM (ManyChat) — começa com BOTÕES
//    (as opções viram botões tocáveis no DM), pronto pra ligar numa
//    automação de comentário. O 1º nó SER send_buttons é o que abre a
//    janela de 24h do IG quando a pessoa toca.
// ============================================================
const COMMENT_TO_DM: FlowTemplate = {
  slug: "comment_to_dm",
  name: "Comentário do Instagram → DM",
  description:
    "Pra ligar numa automação de comentário: começa com botões (as opções viram botões tocáveis no DM) e ramifica — manda o link ou passa pro atendente.",
  icon: "MessageSquare",
  trigger_type: "manual",
  trigger_config: {},
  entry_node_id: "menu",
  nodes: [
    {
      node_key: "menu",
      node_type: "send_buttons",
      config: {
        text: "O que você quer ver primeiro?",
        buttons: [
          {
            reply_id: "link",
            title: "💰 Quero o link",
            next_node_key: "send_link",
          },
          {
            reply_id: "duvida",
            title: "💬 Tenho dúvida",
            next_node_key: "duvida_handoff",
          },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: "send_link",
      node_type: "send_message",
      config: {
        text: "Aqui está 👉 https://exemplo.com . Qualquer dúvida, é só chamar! 💜",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "duvida_handoff",
      node_type: "handoff",
      config: {
        customer_message: "Claro! Já te passo pra um atendente 🙂",
        note: "Veio de um comentário no Instagram e tem uma dúvida.",
      } as HandoffNodeConfig,
    },
    {
      node_key: "end",
      node_type: "end",
      config: {},
    },
  ],
};

// ============================================================
// 5. Qualificação por produto — multicanal (pedido do Rafael, 01/09)
//
// O mesmo fluxo que ele monta no ManyChat: o cliente escolhe o modelo/marca
// numa lista, recebe a informação certa daquele modelo e decide se quer
// falar com um especialista. Roda em QUALQUER canal com fluxo: WhatsApp
// (oficial ou não — no WAHA a lista vira texto numerado), Instagram
// (comentário → DM inicia o fluxo) e Messenger. Os textos são modelo de
// exemplo: o cliente edita marcas, descrições e mensagens no construtor.
// ============================================================
const PRODUCT_QUALIFIER: FlowTemplate = {
  slug: "product_qualifier",
  name: "Qualificação por produto (multicanal)",
  description:
    "O cliente escolhe o modelo/marca que tem, recebe a informação daquele produto e pode pedir um especialista. Funciona igual no WhatsApp, Instagram e Messenger.",
  icon: "HelpCircle",
  trigger_type: "keyword",
  trigger_config: {
    keywords: ["produtos", "modelos", "catalogo", "catálogo", "compatível", "compativel"],
    match_type: "contains",
  },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "which_model" },
    },
    {
      node_key: "which_model",
      node_type: "send_list",
      config: {
        text: "Oi! 👋 Pra te passar a informação certa, me diz: qual modelo/marca você tem?",
        button_label: "Escolher modelo",
        sections: [
          {
            title: "Modelos",
            rows: [
              { reply_id: "brand_a", title: "Marca A", next_node_key: "info_a" },
              { reply_id: "brand_b", title: "Marca B", next_node_key: "info_b" },
              { reply_id: "brand_c", title: "Marca C", next_node_key: "info_c" },
              { reply_id: "brand_d", title: "Marca D", next_node_key: "info_d" },
            ],
          },
          {
            title: "Outros",
            rows: [
              { reply_id: "other", title: "Outra marca / não sei", next_node_key: "info_other" },
            ],
          },
        ],
      } as SendListNodeConfig,
    },
    {
      node_key: "info_a",
      node_type: "send_message",
      config: {
        text: "Perfeito! Para a *Marca A* temos o kit compatível e já testado. 👉 [descreva aqui o produto, o que inclui e o valor]",
        next_node_key: "want_more",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "info_b",
      node_type: "send_message",
      config: {
        text: "Perfeito! Para a *Marca B* temos o kit compatível e já testado. 👉 [descreva aqui o produto, o que inclui e o valor]",
        next_node_key: "want_more",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "info_c",
      node_type: "send_message",
      config: {
        text: "Perfeito! Para a *Marca C* temos o kit compatível e já testado. 👉 [descreva aqui o produto, o que inclui e o valor]",
        next_node_key: "want_more",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "info_d",
      node_type: "send_message",
      config: {
        text: "Perfeito! Para a *Marca D* temos o kit compatível e já testado. 👉 [descreva aqui o produto, o que inclui e o valor]",
        next_node_key: "want_more",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "info_other",
      node_type: "send_message",
      config: {
        text: "Sem problema! Me conta o modelo exato (ou manda uma foto da etiqueta) que eu confirmo a compatibilidade pra você. 📸",
        next_node_key: "specialist",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "want_more",
      node_type: "send_buttons",
      config: {
        text: "Quer que um especialista te ajude a fechar ou tirar dúvidas?",
        buttons: [
          { reply_id: "yes", title: "Falar com especialista", next_node_key: "specialist" },
          { reply_id: "no", title: "Só olhando por enquanto", next_node_key: "bye" },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: "specialist",
      node_type: "handoff",
      config: {
        customer_message:
          "Combinado! Já estou te passando para um especialista. Um instante 🙂",
        note: "Lead qualificado pelo fluxo de produto — veja o modelo escolhido acima antes de responder.",
      } as HandoffNodeConfig,
    },
    {
      node_key: "bye",
      node_type: "send_message",
      config: {
        text: "Tranquilo! Quando quiser, é só mandar *produtos* aqui de novo. 😉",
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "end",
      node_type: "end",
      config: {},
    },
  ],
};

// ============================================================
// Registry
// ============================================================

const TEMPLATES: Record<string, FlowTemplate> = {
  comment_to_dm: COMMENT_TO_DM,
  welcome_menu: WELCOME_MENU,
  faq_bot: FAQ_BOT,
  lead_capture: LEAD_CAPTURE,
  product_qualifier: PRODUCT_QUALIFIER,
};

export function getFlowTemplate(slug: string): FlowTemplate | null {
  return TEMPLATES[slug] ?? null;
}

export function listFlowTemplates(): FlowTemplate[] {
  return Object.values(TEMPLATES);
}

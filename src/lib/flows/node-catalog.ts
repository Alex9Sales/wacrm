// ============================================================
// Catálogo dos tipos de nó do Fluxo — fonte única (runtime, sem React) usada
// por: a API pública v1 (validação + GET /api/v1/flows/node-types) e a
// documentação. Descreve TUDO que dá pra montar num fluxo, pra um agente de IA
// conseguir construir automações via API sem abrir o builder.
//
// Arestas do fluxo: NÃO existem linhas separadas — cada nó aponta pro próximo
// pelo `node_key` do destino (campos `next_node_key`, `true_next`, etc.). Um
// campo de aresta vazio ("") significa "sem próximo" (encerra aquele caminho).
// ============================================================

/** Todos os tipos de nó aceitos (lockstep com o CHECK de flow_nodes.node_type,
 *  FlowNodeType em types.ts e NodeType/NODE_META em components/flows/shared). */
export const FLOW_NODE_TYPES = [
  'start',
  'send_message',
  'send_buttons',
  'send_list',
  'send_media',
  'collect_input',
  'condition',
  'set_tag',
  'delay',
  'jump',
  'randomizer',
  'http_fetch',
  'action',
  'ai',
  'handoff',
  'end',
] as const;

export type FlowNodeTypeName = (typeof FLOW_NODE_TYPES)[number];

export function isFlowNodeType(v: unknown): v is FlowNodeTypeName {
  return typeof v === 'string' && (FLOW_NODE_TYPES as readonly string[]).includes(v);
}

export interface NodeConfigField {
  key: string;
  /** Tipo lógico do campo (string, number, enum, edge, edge[]...). */
  type: string;
  required: boolean;
  description: string;
}

export interface NodeCatalogEntry {
  type: FlowNodeTypeName;
  label: string;
  category: 'messaging' | 'logic' | 'flow';
  description: string;
  /** Campos do objeto `config`. Campos `edge`/`edge[]` guardam o `node_key`
   *  do próximo nó. */
  config: NodeConfigField[];
}

const EDGE = 'edge (node_key do próximo nó; "" = fim daquele caminho)';

export const FLOW_NODE_CATALOG: NodeCatalogEntry[] = [
  {
    type: 'start',
    label: 'Início',
    category: 'flow',
    description:
      'Ponto de entrada opcional. Normalmente o entry_node_id já aponta direto pro 1º nó de conteúdo; use start só se quiser um nó de entrada dedicado.',
    config: [{ key: 'next_node_key', type: EDGE, required: true, description: 'Próximo nó.' }],
  },
  {
    type: 'send_message',
    label: 'Enviar mensagem',
    category: 'messaging',
    description: 'Envia uma mensagem de texto. Avança sozinho pro próximo nó.',
    config: [
      { key: 'text', type: 'string', required: true, description: 'Texto da mensagem. Suporta {{vars.x}}.' },
      { key: 'next_node_key', type: EDGE, required: false, description: 'Próximo nó.' },
    ],
  },
  {
    type: 'send_buttons',
    label: 'Enviar botões',
    category: 'messaging',
    description:
      'Envia texto + 1 a 3 botões de resposta rápida. Cada botão RAMIFICA pro seu próprio próximo nó. É o nó que abre a janela do Instagram quando usado como entrada de um fluxo iniciado por comentário.',
    config: [
      { key: 'text', type: 'string', required: true, description: 'Texto acima dos botões.' },
      { key: 'header', type: 'string?', required: false, description: 'Cabeçalho (opcional).' },
      { key: 'footer', type: 'string?', required: false, description: 'Rodapé (opcional).' },
      {
        key: 'buttons',
        type: 'array de { reply_id: string, title: string (≤20), next_node_key: edge }',
        required: true,
        description: '1 a 3 botões. reply_id é único; title é o rótulo; next_node_key é o ramo.',
      },
    ],
  },
  {
    type: 'send_list',
    label: 'Enviar lista',
    category: 'messaging',
    description:
      'Envia uma lista tocável (até 10 opções em seções). Cada linha RAMIFICA pro seu próximo nó. (No WhatsApp não-oficial vira texto numerado.)',
    config: [
      { key: 'text', type: 'string', required: true, description: 'Texto de abertura.' },
      { key: 'button_label', type: 'string', required: true, description: 'Rótulo do botão que abre a lista (ex.: "Ver opções").' },
      {
        key: 'sections',
        type: 'array de { title?: string, rows: [{ reply_id, title, description?, next_node_key: edge }] }',
        required: true,
        description: 'Seções com linhas. Até 10 linhas no total.',
      },
    ],
  },
  {
    type: 'send_media',
    label: 'Enviar mídia',
    category: 'messaging',
    description: 'Envia imagem, vídeo ou documento por URL pública.',
    config: [
      { key: 'media_type', type: 'enum: image | video | document', required: true, description: 'Tipo de mídia.' },
      { key: 'media_url', type: 'string (URL pública)', required: true, description: 'URL do arquivo.' },
      { key: 'caption', type: 'string?', required: false, description: 'Legenda (opcional).' },
      { key: 'filename', type: 'string?', required: false, description: 'Nome do arquivo (documento).' },
      { key: 'next_node_key', type: EDGE, required: false, description: 'Próximo nó.' },
    ],
  },
  {
    type: 'collect_input',
    label: 'Coletar resposta',
    category: 'logic',
    description: 'Faz uma pergunta e salva a resposta do cliente numa variável (vars.<var_key>).',
    config: [
      { key: 'prompt_text', type: 'string', required: true, description: 'A pergunta.' },
      { key: 'var_key', type: 'string', required: true, description: 'Nome da variável onde salvar (ex.: "email").' },
      { key: 'validation', type: 'enum?: email | phone | number | none', required: false, description: 'Validação da resposta.' },
      { key: 'next_node_key', type: EDGE, required: false, description: 'Próximo nó.' },
    ],
  },
  {
    type: 'condition',
    label: 'Se / senão',
    category: 'logic',
    description: 'Ramifica em dois caminhos (verdadeiro/falso) por uma regra sobre variável, etiqueta ou campo do contato.',
    config: [
      { key: 'subject', type: 'enum: var | tag | contact_field', required: true, description: 'O que avaliar.' },
      { key: 'subject_key', type: 'string', required: true, description: 'Nome da variável/campo, ou o tag_id.' },
      { key: 'operator', type: 'enum: equals | contains | present | absent', required: true, description: 'Comparação.' },
      { key: 'value', type: 'string?', required: false, description: 'Valor a comparar (equals/contains).' },
      { key: 'true_next', type: EDGE, required: true, description: 'Ramo se verdadeiro.' },
      { key: 'false_next', type: EDGE, required: true, description: 'Ramo se falso.' },
    ],
  },
  {
    type: 'set_tag',
    label: 'Etiquetar contato',
    category: 'logic',
    description: 'Adiciona ou remove uma etiqueta do contato. Adicionar pode disparar outros fluxos (gatilho tag_added).',
    config: [
      { key: 'mode', type: 'enum: add | remove', required: true, description: 'Adicionar ou remover.' },
      { key: 'tag_id', type: 'string (uuid da etiqueta)', required: true, description: 'A etiqueta (ver GET /api/v1/tags).' },
      { key: 'next_node_key', type: EDGE, required: false, description: 'Próximo nó.' },
    ],
  },
  {
    type: 'delay',
    label: 'Esperar',
    category: 'flow',
    description: 'Espera um tempo antes de seguir (drip). Opcionalmente só conta dentro do horário comercial.',
    config: [
      { key: 'duration', type: '{ value: number, unit: minutes | hours | days }', required: true, description: 'Quanto esperar.' },
      { key: 'business_hours', type: 'objeto? (opcional)', required: false, description: 'Se presente, só avança no horário comercial.' },
      { key: 'next_node_key', type: EDGE, required: false, description: 'Próximo nó.' },
    ],
  },
  {
    type: 'jump',
    label: 'Pular para',
    category: 'flow',
    description: 'Salta pra outro nó (permite loops/reinício). Há um teto de saltos por execução.',
    config: [{ key: 'target_node_key', type: EDGE, required: true, description: 'Nó de destino.' }],
  },
  {
    type: 'randomizer',
    label: 'Randomizador',
    category: 'logic',
    description: 'Divide o fluxo em ramos por porcentagem (teste A/B).',
    config: [
      {
        key: 'branches',
        type: 'array de { id: string, weight: number, next_node_key: edge }',
        required: true,
        description: 'Ramos com pesos (proporção).',
      },
    ],
  },
  {
    type: 'http_fetch',
    label: 'Requisição HTTP',
    category: 'logic',
    description: 'Chama uma API externa e guarda a resposta numa variável. Bloqueia endereços internos (SSRF).',
    config: [
      { key: 'method', type: 'enum: GET | POST | PUT | PATCH | DELETE', required: true, description: 'Método HTTP.' },
      { key: 'url', type: 'string', required: true, description: 'URL pública.' },
      { key: 'headers', type: 'array de { key, value }?', required: false, description: 'Cabeçalhos.' },
      { key: 'body', type: 'string?', required: false, description: 'Corpo (POST/PUT/PATCH).' },
      { key: 'save_to', type: 'string?', required: false, description: 'Variável onde salvar a resposta (ex.: "http").' },
      { key: 'next_node_key', type: EDGE, required: false, description: 'Próximo nó (sucesso).' },
      { key: 'error_node_key', type: EDGE, required: false, description: 'Próximo nó em caso de erro.' },
    ],
  },
  {
    type: 'action',
    label: 'Ação',
    category: 'logic',
    description: 'Faz várias ações no contato (setar campo, +etiqueta, −etiqueta, avisar a equipe) sem mandar mensagem.',
    config: [
      {
        key: 'operations',
        type: 'array de { type: set_field | add_tag | remove_tag | notify, ... }',
        required: true,
        description: 'Operações a executar em sequência.',
      },
      { key: 'next_node_key', type: EDGE, required: false, description: 'Próximo nó.' },
    ],
  },
  {
    type: 'ai',
    label: 'Etapa de IA',
    category: 'messaging',
    description: 'Conversa com o agente de IA da conta (usa o prompt + base de conhecimento) por alguns turnos e depois segue.',
    config: [
      { key: 'prompt', type: 'string?', required: false, description: 'Instrução extra pra esta etapa.' },
      { key: 'use_knowledge', type: 'boolean?', required: false, description: 'Usar a base de conhecimento.' },
      { key: 'max_turns', type: 'number?', required: false, description: 'Máximo de turnos antes de seguir.' },
      { key: 'exit_node_key', type: EDGE, required: false, description: 'Próximo nó ao encerrar a etapa.' },
    ],
  },
  {
    type: 'handoff',
    label: 'Transferir para atendente',
    category: 'flow',
    description: 'Encerra a automação e passa a conversa pra um humano (opcionalmente atribui a alguém). Terminal.',
    config: [
      { key: 'customer_message', type: 'string?', required: false, description: 'Mensagem ao cliente antes de transferir.' },
      { key: 'note', type: 'string?', required: false, description: 'Nota interna pro atendente.' },
      { key: 'assign_to', type: 'string? (user_id)', required: false, description: 'Atribuir a um membro (ver GET /api/v1/members).' },
    ],
  },
  {
    type: 'end',
    label: 'Fim',
    category: 'flow',
    description: 'Encerra o fluxo. Terminal.',
    config: [],
  },
];

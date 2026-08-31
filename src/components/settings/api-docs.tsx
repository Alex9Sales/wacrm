"use client";

// ============================================================
// 📖 Documentação da API pública (v1) — vive em Configurações → Integrações.
//
// Feita pra DUAS audiências: o dev do cliente e o AGENTE DE IA do cliente
// (Hermes etc.) — por isso o bloco "prompt pronto" no fim: o cliente cola no
// agente dele e o agente passa a operar o CRM. Conteúdo 100% estático
// (espelha as rotas reais de src/app/api/v1); atualizar aqui quando criar
// rota nova.
// ============================================================

import { useMemo, useState } from "react";
import { toast } from "sonner";
import { BookOpen, Check, ChevronDown, Copy } from "lucide-react";

const BASE = "https://crm.salestecnologia.com.br/api/v1";

interface Endpoint {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  scope: string;
  desc: string;
  fields?: string;
  curl?: string;
}

interface Group {
  title: string;
  blurb: string;
  endpoints: Endpoint[];
}

const GROUPS: Group[] = [
  {
    title: "Contatos",
    blurb: "A base de clientes. Telefone é a chave (dedupe automático, 9º dígito tolerante).",
    endpoints: [
      { method: "GET", path: "/contacts", scope: "contacts:read", desc: "Lista contatos (paginado por cursor; ?q= busca por nome/telefone/e-mail).", fields: "?q, ?limit, ?cursor" },
      { method: "POST", path: "/contacts", scope: "contacts:write", desc: "Cria/atualiza contato pelo telefone.", fields: "name, phone, email, company, tags[], customer_codes[]", curl: `curl -X POST ${BASE}/contacts -H "Authorization: Bearer $CHAVE" -H "Content-Type: application/json" -d '{"name":"Maria Silva","phone":"+5567999990000","tags":["cliente"]}'` },
      { method: "GET", path: "/contacts/{id}", scope: "contacts:read", desc: "Detalhe de um contato." },
      { method: "PATCH", path: "/contacts/{id}", scope: "contacts:write", desc: "Atualiza campos do contato.", fields: "name, email, company, tags[]" },
    ],
  },
  {
    title: "Conversas & Mensagens",
    blurb: "O inbox. Mensagens de texto/mídia vão pro cliente pelo canal da conversa.",
    endpoints: [
      { method: "GET", path: "/conversations", scope: "conversations:read", desc: "Lista conversas (paginado; filtros por status/canal)." },
      { method: "POST", path: "/conversations", scope: "conversations:write", desc: "Abre (ou acha) a conversa de um telefone num canal.", fields: "phone, channel_id, name?, email?" },
      { method: "GET", path: "/conversations/{id}", scope: "conversations:read", desc: "Detalhe da conversa (contato, status, atribuição)." },
      { method: "PATCH", path: "/conversations/{id}", scope: "conversations:write", desc: "Muda status (aberta/resolvida) e campos da conversa." },
      { method: "GET", path: "/conversations/{id}/messages", scope: "messages:read", desc: "Histórico de mensagens (sem notas internas)." },
      { method: "POST", path: "/conversations/{id}/messages", scope: "messages:send", desc: "ENVIA mensagem ao cliente (texto ou mídia).", fields: "text | media_url (+filename, mimetype), reply_to_message_id?", curl: `curl -X POST ${BASE}/conversations/$CONV/messages -H "Authorization: Bearer $CHAVE" -H "Content-Type: application/json" -d '{"text":"Olá! Seu pedido saiu para entrega."}'` },
      { method: "POST", path: "/messages", scope: "messages:send", desc: "Atalho: envia direto pra um telefone (resolve/abre a conversa sozinho).", fields: "to, channel_id, text | media_url, type?, template?" },
      { method: "GET", path: "/conversations/{id}/tags", scope: "tags:read", desc: "Etiquetas da conversa." },
      { method: "POST", path: "/conversations/{id}/tags", scope: "tags:write", desc: "Adiciona etiqueta à conversa." },
      { method: "DELETE", path: "/conversations/{id}/tags/{tagId}", scope: "tags:write", desc: "Remove etiqueta da conversa." },
    ],
  },
  {
    title: "Equipe (falar com humanos) 🆕",
    blurb: "Pro agente escalar, avisar e coordenar com os atendentes — nada disso chega ao cliente.",
    endpoints: [
      { method: "POST", path: "/conversations/{id}/notes", scope: "conversations:write", desc: "Nota INTERNA no thread, com menção: @Nome no texto e/ou mention_member_ids — o mencionado recebe notificação com link direto.", fields: "text, mention_member_ids[]?", curl: `curl -X POST ${BASE}/conversations/$CONV/notes -H "Authorization: Bearer $CHAVE" -H "Content-Type: application/json" -d '{"text":"@Marcos cliente aguardando retorno há 20 min","mention_member_ids":["<user_id>"]}'` },
      { method: "POST", path: "/conversations/{id}/assign", scope: "conversations:write", desc: "Atribui a conversa a um membro (notifica) ou devolve pra fila/IA (member_id: null).", fields: "member_id | null" },
      { method: "POST", path: "/conversations/{id}/ai", scope: "conversations:write", desc: "Liga/desliga a IA da conta NESTA conversa. Ao ligar com mensagem parada do cliente, a IA responde na hora.", fields: "enabled: true|false" },
      { method: "GET", path: "/members", scope: "members:read", desc: "Lista os membros da conta (id + nome) — use os ids nas menções/atribuições." },
      { method: "POST", path: "/conversations/{id}/import-group", scope: "contacts:write", desc: "Grupo de WhatsApp → importa os participantes como CONTATOS etiquetados ('Grupo: <nome>' ou tag_name) — prontos pra segmentar um disparo.", fields: "tag_name?" },
    ],
  },
  {
    title: "Negócios & Funis",
    blurb: "Os cards do Kanban. Ganho registra a venda no histórico do cliente automaticamente.",
    endpoints: [
      { method: "GET", path: "/pipelines", scope: "deals:read", desc: "Funis e etapas (ids pra criar/mover cards)." },
      { method: "GET", path: "/deals", scope: "deals:read", desc: "Lista negócios (paginado; filtros)." },
      { method: "POST", path: "/deals", scope: "deals:write", desc: "Cria um negócio.", fields: "title, contact_id, value?, pipeline_id?, stage_id?, status?, origin?, source?, notes?, custom_fields?, create_conversation?", curl: `curl -X POST ${BASE}/deals -H "Authorization: Bearer $CHAVE" -H "Content-Type: application/json" -d '{"title":"Pedido P-13","contact_id":"$CONTATO","value":120,"origin":"Agente"}'` },
      { method: "GET", path: "/deals/{id}", scope: "deals:read", desc: "Detalhe do negócio." },
      { method: "PATCH", path: "/deals/{id}", scope: "deals:read", desc: "Atualiza (mover etapa, marcar won/lost, valor…).", fields: "stage_id?, status? (open|won|lost), value?, title?, notes?" },
      { method: "GET", path: "/deals/{id}/events", scope: "deals:read", desc: "Timeline do negócio (criado, mudanças, notas)." },
    ],
  },
  {
    title: "Tarefas",
    blurb: "Follow-ups e pendências da equipe.",
    endpoints: [
      { method: "GET", path: "/tasks", scope: "tasks:read", desc: "Lista tarefas (paginado)." },
      { method: "POST", path: "/tasks", scope: "tasks:write", desc: "Cria tarefa (pode ligar a contato/negócio e atribuir a um membro).", fields: "title, description?, due_at?, type?, contact_id?, deal_id?, assigned_to?" },
      { method: "PATCH", path: "/tasks/{id}", scope: "tasks:write", desc: "Atualiza/conclui (status: open|done|cancelled)." },
    ],
  },
  {
    title: "Memória & Reativação 🆕",
    blurb: "A memória comercial (CDL): quem é o cliente, quem chamar de volta hoje, e agir.",
    endpoints: [
      { method: "GET", path: "/customers/{contactId}/history", scope: "contacts:read", desc: "Histórico comercial completo: métricas (nº de compras, total, ticket, frequência, preferências), últimas transações e o bloco `facts` em texto — pronto pra colar no contexto do seu LLM." },
      { method: "GET", path: "/reactivation/signals", scope: "contacts:read", desc: '"Quem devo chamar hoje?" — sinais abertos de recompra atrasada, na hora de recomprar e clientes sumidos, com nome/telefone/conversa.', fields: "?type=repurchase_overdue|repurchase_due|inactive|high_value, ?limit", curl: `curl ${BASE}/reactivation/signals?type=repurchase_overdue -H "Authorization: Bearer $CHAVE"` },
      { method: "POST", path: "/reactivation/send", scope: "messages:send", desc: "Envia a mensagem de reativação e resolve o sinal (sai da lista). Respeita opt-out. Importado sem conversa: informe channel_id que a conversa é criada.", fields: "contact_id, signal_type, text, channel_id?" },
    ],
  },
  {
    title: "Leads & Captação",
    blurb: "A porta de entrada: um POST vira contato + card + tarefa + (opcional) primeiro WhatsApp automático.",
    endpoints: [
      { method: "POST", path: "/leads", scope: "contacts:write", desc: "Ingesta um lead completo. Com send_whatsapp:true + intro_text, o CRM manda a mensagem de abertura e a IA assume quando o lead responder.", fields: "name, phone, email?, company?, origin?, source?, pipeline_id?, stage_id?, send_whatsapp?, intro_text?, channel_id? (+ campos extras viram observações no card)", curl: `curl -X POST ${BASE}/leads -H "Authorization: Bearer $CHAVE" -H "Content-Type: application/json" -d '{"name":"João","phone":"+5511999998888","origin":"RD Station","send_whatsapp":true,"intro_text":"Oi João! Vi seu interesse — posso te explicar como funciona?","channel_id":"$CANAL"}'` },
    ],
  },
  {
    title: "Agendadas & Cadências 🆕",
    blurb: "Mensagem no futuro e sequências automáticas.",
    endpoints: [
      { method: "POST", path: "/scheduled-messages", scope: "messages:send", desc: '"Manda amanhã às 9h": agenda uma mensagem — o CRM envia na hora marcada.', fields: "conversation_id | (contact_id + channel_id), text, scheduled_at (ISO-8601 com fuso)", curl: `curl -X POST ${BASE}/scheduled-messages -H "Authorization: Bearer $CHAVE" -H "Content-Type: application/json" -d '{"conversation_id":"$CONV","text":"Bom dia! Posso confirmar seu pedido?","scheduled_at":"2026-09-01T09:00:00-04:00"}'` },
      { method: "GET", path: "/scheduled-messages", scope: "messages:read", desc: "Lista agendadas (?status=pending|sent|failed)." },
      { method: "DELETE", path: "/scheduled-messages/{id}", scope: "messages:send", desc: "Cancela uma agendada pendente." },
      { method: "GET", path: "/cadences", scope: "cadences:read", desc: "Lista as cadências da conta (id, nome, nº de degraus)." },
      { method: "POST", path: "/cadences/{id}/enroll", scope: "cadences:write", desc: "Inscreve um contato na cadência (pausa sozinha quando ele responde).", fields: "contact_id, conversation_id?, deal_id?" },
      { method: "POST", path: "/contacts/{id}/opt-out", scope: "contacts:write", desc: 'Marca/desmarca "não perturbe" — opted-out nunca recebe disparo/cadência/reativação.', fields: "opted_out: true|false, reason?" },
    ],
  },
  {
    title: "Disparos (broadcasts)",
    blurb: "Mensagem em massa com fila, ritmo e opt-out automático (quem responder SAIR nunca mais recebe).",
    endpoints: [
      { method: "POST", path: "/broadcasts/text", scope: "broadcasts:send", desc: "Cria um disparo de texto/mídia pra uma lista.", fields: "name, channel_id, body_text ({{nome}} funciona), recipients[]|contact_ids[], send_now?, daily_cap?, media_url?" },
      { method: "GET", path: "/broadcasts", scope: "broadcasts:send", desc: "Lista disparos e status." },
      { method: "GET", path: "/broadcasts/{id}", scope: "broadcasts:send", desc: "Detalhe/progresso do disparo." },
      { method: "POST", path: "/broadcasts/{id}/pause", scope: "broadcasts:send", desc: "Pausa." },
      { method: "POST", path: "/broadcasts/{id}/resume", scope: "broadcasts:send", desc: "Retoma." },
      { method: "POST", path: "/broadcasts/{id}/cancel", scope: "broadcasts:send", desc: "Cancela." },
      { method: "GET", path: "/broadcasts/{id}/recipients", scope: "broadcasts:send", desc: "Destinatários e status de entrega." },
    ],
  },
  {
    title: "Fluxos (chatbot visual)",
    blurb: "Criação e ativação de fluxos de atendimento por API.",
    endpoints: [
      { method: "GET", path: "/flows", scope: "flows:read", desc: "Lista fluxos." },
      { method: "POST", path: "/flows", scope: "flows:write", desc: "Cria um fluxo (nodes + edges JSON)." },
      { method: "GET", path: "/flows/node-types", scope: "flows:read", desc: "Tipos de nós disponíveis (o 'vocabulário' do builder)." },
      { method: "PATCH", path: "/flows/{id}", scope: "flows:write", desc: "Edita o fluxo." },
      { method: "POST", path: "/flows/{id}/activate", scope: "flows:write", desc: "Ativa/desativa." },
    ],
  },
  {
    title: "Canais, Etiquetas & Utilitários",
    blurb: "Infra de apoio.",
    endpoints: [
      { method: "GET", path: "/channels", scope: "broadcasts:send", desc: "Canais conectados (ids pra enviar/abrir conversa). ⚠️ resposta aninhada: data.data." },
      { method: "GET", path: "/tags", scope: "tags:read", desc: "Etiquetas da conta." },
      { method: "POST", path: "/tags", scope: "tags:write", desc: "Cria etiqueta.", fields: "name, color?" },
      { method: "GET", path: "/me", scope: "(qualquer chave)", desc: "Identidade da chave (conta, escopos) — bom pra testar a conexão." },
      { method: "GET", path: "/agent", scope: "agent:read", desc: "Config do agente de IA padrão da conta." },
      { method: "PUT", path: "/agent", scope: "agent:write", desc: "Atualiza o agente padrão (prompt etc.)." },
      { method: "GET", path: "/agents", scope: "agent:read", desc: "Lista TODOS os agentes da conta (id, nome, canais, ativo)." },
      { method: "POST", path: "/agents", scope: "agent:write", desc: "CRIA um agente novo herdando o motor do padrão (chave/modelo) — seu agente externo monta o time: nome, prompt, canais, ferramentas.", fields: "name, system_prompt, channel_ids[]?, tools[]?, active?, auto_reply?" },
    ],
  },
  {
    title: "Webhooks (o CRM te avisa)",
    blurb: "Receba eventos (ex.: message.received) no seu endpoint — assinados com HMAC.",
    endpoints: [
      { method: "GET", path: "/webhooks", scope: "webhooks:manage", desc: "Lista endpoints inscritos." },
      { method: "POST", path: "/webhooks", scope: "webhooks:manage", desc: "Inscreve um endpoint.", fields: "url, events[]" },
      { method: "PATCH", path: "/webhooks/{id}", scope: "webhooks:manage", desc: "Edita/pausa." },
      { method: "DELETE", path: "/webhooks/{id}", scope: "webhooks:manage", desc: "Remove." },
    ],
  },
];

/** Texto pronto pro cliente colar no prompt do agente de IA dele. */
function agentPrompt(): string {
  const lines: string[] = [
    "Você tem acesso à API do FluxiaCRM para operar o CRM da empresa.",
    `Base: ${BASE}`,
    'Autenticação: header "Authorization: Bearer <CHAVE>" em toda chamada (peça a chave ao administrador; ela começa com wacrm_live_).',
    "Regras: respostas vêm em JSON { data: ... }; erros em { error: { code, message } }. Nunca envie mensagem ao cliente final sem necessidade; para falar com a EQUIPE use as notas internas.",
    "",
    "Rotas disponíveis:",
  ];
  for (const g of GROUPS) {
    lines.push(`\n# ${g.title}`);
    for (const e of g.endpoints) {
      lines.push(
        `${e.method} ${e.path} — ${e.desc}${e.fields ? ` Campos: ${e.fields}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

const METHOD_STYLE: Record<Endpoint["method"], string> = {
  GET: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  POST: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  PATCH: "bg-amber-500/15 text-amber-600 dark:text-amber-500",
  PUT: "bg-amber-500/15 text-amber-600 dark:text-amber-500",
  DELETE: "bg-red-500/15 text-red-600 dark:text-red-400",
};

function CopyBtn({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          toast.success("Copiado!");
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {label ?? "Copiar"}
    </button>
  );
}

export function ApiDocs() {
  const [open, setOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const prompt = useMemo(agentPrompt, []);

  return (
    <div className="mt-8 rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left"
      >
        <span className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <BookOpen className="h-4 w-4" />
          </span>
          <span>
            <span className="block text-sm font-semibold text-foreground">
              Documentação da API
            </span>
            <span className="block text-xs text-muted-foreground">
              Todas as rotas pra integrar sistemas ou plugar o SEU agente de IA
              no CRM
            </span>
          </span>
        </span>
        <ChevronDown
          className={`h-4 w-4 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open && (
        <div className="space-y-4 border-t border-border px-4 py-4">
          {/* Começando */}
          <div className="rounded-lg bg-muted/40 p-3 text-xs leading-relaxed text-muted-foreground">
            <p>
              <strong className="text-foreground">Base:</strong>{" "}
              <code className="rounded bg-muted px-1.5 py-0.5">{BASE}</code>
            </p>
            <p className="mt-1">
              <strong className="text-foreground">Autenticação:</strong> crie
              uma chave na aba <strong>Chaves de API</strong> (escolhendo os
              escopos) e mande em toda chamada:{" "}
              <code className="rounded bg-muted px-1.5 py-0.5">
                Authorization: Bearer wacrm_live_…
              </code>
            </p>
            <p className="mt-1">
              <strong className="text-foreground">Formato:</strong> sucesso{" "}
              <code className="rounded bg-muted px-1.5 py-0.5">
                {"{ data: … }"}
              </code>{" "}
              · erro{" "}
              <code className="rounded bg-muted px-1.5 py-0.5">
                {"{ error: { code, message } }"}
              </code>{" "}
              · listas são paginadas por cursor. Teste a conexão com{" "}
              <code className="rounded bg-muted px-1.5 py-0.5">GET /me</code>.
            </p>
          </div>

          {/* Grupos */}
          {GROUPS.map((g) => (
            <div key={g.title} className="rounded-lg border border-border">
              <button
                type="button"
                onClick={() =>
                  setOpenGroup((cur) => (cur === g.title ? null : g.title))
                }
                className="flex w-full items-center justify-between px-3 py-2.5 text-left"
              >
                <span>
                  <span className="block text-sm font-medium text-foreground">
                    {g.title}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    {g.blurb}
                  </span>
                </span>
                <ChevronDown
                  className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${openGroup === g.title ? "rotate-180" : ""}`}
                />
              </button>
              {openGroup === g.title && (
                <div className="space-y-3 border-t border-border p-3">
                  {g.endpoints.map((e) => (
                    <div key={`${e.method} ${e.path}`} className="text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`rounded px-1.5 py-0.5 font-mono text-[10px] font-bold ${METHOD_STYLE[e.method]}`}
                        >
                          {e.method}
                        </span>
                        <code className="font-mono text-foreground">
                          {e.path}
                        </code>
                        <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                          {e.scope}
                        </span>
                      </div>
                      <p className="mt-1 text-muted-foreground">{e.desc}</p>
                      {e.fields && (
                        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/80">
                          {e.fields}
                        </p>
                      )}
                      {e.curl && (
                        <div className="mt-1.5 flex items-start gap-2">
                          <pre className="flex-1 overflow-x-auto rounded-md bg-muted p-2 font-mono text-[10px] leading-relaxed text-foreground/90">
                            {e.curl}
                          </pre>
                          <CopyBtn text={e.curl} />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Prompt pronto pro agente */}
          <div className="rounded-lg border border-primary/40 bg-primary/[0.04] p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-foreground">
                  🤖 Prompt pronto pro seu agente de IA
                </p>
                <p className="text-[11px] text-muted-foreground">
                  Cole este texto no prompt do seu agente (Hermes, n8n, GPT…) e
                  ele passa a operar o CRM por você. Só troque a chave.
                </p>
              </div>
              <CopyBtn text={prompt} label="Copiar prompt" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

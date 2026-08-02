/**
 * Save-time validation for flows.
 *
 * Run before activation (not on every draft save) — drafts are
 * intentionally allowed to be incomplete so users can save progress
 * mid-build. The builder calls these from BOTH client (so the user
 * sees issues live) and server (so a broken POST/PUT can't slip in
 * via direct API call).
 *
 * Three rule categories:
 *   1. Trigger sanity — keyword flows need keywords, etc.
 *   2. Graph integrity — entry node exists, all next_node_key
 *      references resolve, no unreachable nodes, non-terminal nodes
 *      have an outgoing edge.
 *   3. Meta API limits — button title ≤20 chars, ≤3 buttons per
 *      send_buttons, ≤10 list rows total, ≤24 chars per list row
 *      title. Mirrors the runtime checks inside
 *      `src/lib/whatsapp/meta-api.ts` so save-time and send-time
 *      can never disagree.
 *
 * Issues carry enough field info that the builder can highlight the
 * exact input that triggered them. Node-scoped issues include
 * `node_key`; trigger-scoped use `scope: 'trigger'`.
 */

import { INTERACTIVE_LIMITS } from "@/lib/whatsapp/meta-api";

export interface ValidationIssue {
  severity: "error" | "warning";
  scope: "flow" | "trigger" | "node";
  /** Stable node_key the issue is attached to, when scope === 'node'. */
  node_key?: string;
  /** Dotted path to the bad field, e.g. 'buttons.0.title'. */
  field?: string;
  message: string;
}

interface FlowInput {
  name: string;
  trigger_type: "keyword" | "first_inbound_message" | "tag_added" | "manual";
  trigger_config: Record<string, unknown>;
  entry_node_id: string | null;
}

interface NodeInput {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
}

export function validateFlowForActivation(
  flow: FlowInput,
  nodes: NodeInput[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  // ---- name ----
  if (!flow.name || !flow.name.trim()) {
    issues.push({
      severity: "error",
      scope: "flow",
      field: "name",
      message: "O fluxo precisa de um nome.",
    });
  }

  // ---- trigger ----
  issues.push(...validateTrigger(flow.trigger_type, flow.trigger_config));

  // ---- graph integrity ----
  if (!flow.entry_node_id) {
    issues.push({
      severity: "error",
      scope: "flow",
      field: "entry_node_id",
      message: "Escolha o nó de entrada antes de ativar.",
    });
  }

  const keys = new Set(nodes.map((n) => n.node_key));
  if (nodes.length === 0) {
    issues.push({
      severity: "error",
      scope: "flow",
      message: "O fluxo precisa de pelo menos um nó para ser ativado.",
    });
  }

  if (flow.entry_node_id && !keys.has(flow.entry_node_id)) {
    issues.push({
      severity: "error",
      scope: "flow",
      field: "entry_node_id",
      message: `O nó de entrada "${flow.entry_node_id}" não existe.`,
    });
  }

  // Duplicate node_key (the DB UNIQUE constraint catches this on save
  // too, but surfacing it client-side gives a friendlier error path).
  const seen = new Set<string>();
  for (const n of nodes) {
    if (seen.has(n.node_key)) {
      issues.push({
        severity: "error",
        scope: "node",
        node_key: n.node_key,
        message: `node_key "${n.node_key}" duplicado.`,
      });
    }
    seen.add(n.node_key);
  }

  // Per-node rules (Meta limits + dead-end + edge resolution).
  for (const n of nodes) {
    issues.push(...validateNode(n, keys));
  }

  // Reachability — every non-orphan node must be reachable from the
  // entry. Done after per-node validation so we don't double-report
  // when a node has bad config AND is unreachable.
  if (flow.entry_node_id && keys.has(flow.entry_node_id)) {
    const reached = reachableFromEntry(flow.entry_node_id, nodes);
    for (const n of nodes) {
      if (!reached.has(n.node_key)) {
        issues.push({
          severity: "warning",
          scope: "node",
          node_key: n.node_key,
          message: `O nó "${n.node_key}" não é alcançável a partir do nó de entrada.`,
        });
      }
    }
  }

  return issues;
}

// ============================================================
// Trigger
// ============================================================

function validateTrigger(
  trigger_type: FlowInput["trigger_type"],
  trigger_config: Record<string, unknown>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (trigger_type === "keyword") {
    const keywords = Array.isArray(trigger_config.keywords)
      ? (trigger_config.keywords as unknown[])
      : null;
    if (!keywords || keywords.length === 0) {
      issues.push({
        severity: "error",
        scope: "trigger",
        field: "trigger_config.keywords",
        message: "O disparo por palavra-chave precisa de pelo menos uma palavra.",
      });
    } else {
      // Empty / whitespace-only keywords are silent no-ops at match
      // time — call them out so the user doesn't think they configured
      // a keyword that never fires.
      const blanks = keywords.filter(
        (k) => typeof k !== "string" || !k.trim(),
      ).length;
      if (blanks > 0) {
        issues.push({
          severity: "warning",
          scope: "trigger",
          field: "trigger_config.keywords",
          message: `${blanks} ${blanks === 1 ? "palavra-chave está" : "palavras-chave estão"} em branco — não casam com nada.`,
        });
      }
    }
  }

  if (trigger_type === "tag_added") {
    const tagId =
      typeof trigger_config.tag_id === "string" ? trigger_config.tag_id : "";
    if (!tagId.trim()) {
      issues.push({
        severity: "error",
        scope: "trigger",
        field: "trigger_config.tag_id",
        message: "Escolha a etiqueta que dispara o fluxo.",
      });
    }
  }
  // first_inbound_message / manual have no config; nothing to validate.

  return issues;
}

// ============================================================
// Per-node
// ============================================================

function validateNode(
  node: NodeInput,
  knownKeys: Set<string>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  switch (node.node_type) {
    case "start": {
      const cfg = node.config as { next_node_key?: string };
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "O nó de início precisa apontar para um próximo nó.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `O início aponta para um nó inexistente "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "send_message": {
      const cfg = node.config as { text?: string; next_node_key?: string };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "text",
          message: "O nó de mensagem precisa de um texto.",
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "O nó de mensagem precisa apontar para um próximo nó.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `A mensagem aponta para um nó inexistente "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "send_media": {
      const cfg = node.config as {
        media_type?: "image" | "video" | "document";
        media_url?: string;
        caption?: string;
        next_node_key?: string;
      };
      if (
        !cfg.media_type ||
        !["image", "video", "document"].includes(cfg.media_type)
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "media_type",
          message: "O nó de mídia precisa de um tipo (imagem, vídeo ou documento).",
        });
      }
      if (!cfg.media_url?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "media_url",
          message: "O nó de mídia precisa de um arquivo (envie um antes de ativar).",
        });
      }
      // Caption cap mirrors Meta's interactive body cap; documented as a
      // hard limit in the WhatsApp Cloud API media-message reference.
      if (cfg.caption && cfg.caption.length > INTERACTIVE_LIMITS.bodyMaxLength) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "caption",
          message: `A legenda passa de ${INTERACTIVE_LIMITS.bodyMaxLength} caracteres (limite do WhatsApp).`,
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "O nó de mídia precisa apontar para um próximo nó.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `A mídia aponta para um nó inexistente "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "send_buttons": {
      const cfg = node.config as {
        text?: string;
        buttons?: Array<{
          reply_id?: string;
          title?: string;
          next_node_key?: string;
        }>;
      };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "text",
          message: "O nó de botões precisa de um texto.",
        });
      }
      const btns = cfg.buttons ?? [];
      if (btns.length < 1) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "buttons",
          message: "O nó de botões precisa de pelo menos um botão.",
        });
      }
      if (btns.length > INTERACTIVE_LIMITS.maxButtons) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "buttons",
          message: `O WhatsApp permite no máximo ${INTERACTIVE_LIMITS.maxButtons} botões por mensagem.`,
        });
      }
      const seenIds = new Set<string>();
      btns.forEach((b, i) => {
        const field = `buttons.${i}`;
        if (!b.reply_id?.trim()) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.reply_id`,
            message: `O botão ${i + 1} precisa de um id de resposta.`,
          });
        } else if (seenIds.has(b.reply_id)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.reply_id`,
            message: `Id de resposta de botão duplicado "${b.reply_id}".`,
          });
        }
        if (b.reply_id) seenIds.add(b.reply_id);

        if (!b.title?.trim()) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.title`,
            message: `O botão ${i + 1} precisa de um título.`,
          });
        } else if (b.title.length > INTERACTIVE_LIMITS.buttonTitleMaxLength) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.title`,
            message: `O título do botão ${i + 1} passa de ${INTERACTIVE_LIMITS.buttonTitleMaxLength} caracteres (limite do WhatsApp).`,
          });
        }

        if (!b.next_node_key) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.next_node_key`,
            message: `O botão ${i + 1} precisa de um próximo nó.`,
          });
        } else if (!knownKeys.has(b.next_node_key)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.next_node_key`,
            message: `O botão ${i + 1} aponta para um nó inexistente "${b.next_node_key}".`,
          });
        }
      });
      break;
    }

    case "send_list": {
      const cfg = node.config as {
        text?: string;
        button_label?: string;
        sections?: Array<{
          title?: string;
          rows?: Array<{
            reply_id?: string;
            title?: string;
            description?: string;
            next_node_key?: string;
          }>;
        }>;
      };
      if (!cfg.text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "text",
          message: "O nó de lista precisa de um texto.",
        });
      }
      if (!cfg.button_label?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "button_label",
          message: "O nó de lista precisa de um rótulo de botão (o texto para abrir a lista).",
        });
      }
      const sections = cfg.sections ?? [];
      const totalRows = sections.reduce(
        (sum, s) => sum + (s.rows?.length ?? 0),
        0,
      );
      if (totalRows < 1) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "sections",
          message: "O nó de lista precisa de pelo menos uma linha.",
        });
      }
      if (totalRows > INTERACTIVE_LIMITS.maxListRowsTotal) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "sections",
          message: `A lista permite no máximo ${INTERACTIVE_LIMITS.maxListRowsTotal} linhas no total entre as seções.`,
        });
      }
      const seenIds = new Set<string>();
      sections.forEach((section, si) => {
        const rows = section.rows ?? [];
        rows.forEach((row, ri) => {
          const field = `sections.${si}.rows.${ri}`;
          if (!row.reply_id?.trim()) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.reply_id`,
              message: `A linha ${ri + 1} da seção ${si + 1} precisa de um id de resposta.`,
            });
          } else if (seenIds.has(row.reply_id)) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.reply_id`,
              message: `Id de linha de lista duplicado "${row.reply_id}".`,
            });
          }
          if (row.reply_id) seenIds.add(row.reply_id);

          if (!row.title?.trim()) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.title`,
              message: `A linha ${ri + 1} precisa de um título.`,
            });
          } else if (
            row.title.length > INTERACTIVE_LIMITS.listRowTitleMaxLength
          ) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.title`,
              message: `O título da linha ${ri + 1} passa de ${INTERACTIVE_LIMITS.listRowTitleMaxLength} caracteres.`,
            });
          }
          if (
            row.description &&
            row.description.length >
              INTERACTIVE_LIMITS.listRowDescriptionMaxLength
          ) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.description`,
              message: `A descrição da linha ${ri + 1} passa de ${INTERACTIVE_LIMITS.listRowDescriptionMaxLength} caracteres.`,
            });
          }
          if (!row.next_node_key) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.next_node_key`,
              message: `A linha ${ri + 1} precisa de um próximo nó.`,
            });
          } else if (!knownKeys.has(row.next_node_key)) {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: `${field}.next_node_key`,
              message: `A linha ${ri + 1} aponta para um nó inexistente "${row.next_node_key}".`,
            });
          }
        });
      });
      break;
    }

    case "collect_input": {
      const cfg = node.config as {
        prompt_text?: string;
        var_key?: string;
        next_node_key?: string;
      };
      if (!cfg.prompt_text?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "prompt_text",
          message: "O nó de coleta precisa de uma pergunta para enviar ao cliente.",
        });
      }
      if (!cfg.var_key?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "var_key",
          message: "O nó de coleta precisa de um var_key para guardar a resposta.",
        });
      } else if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cfg.var_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "var_key",
          message: `O var_key "${cfg.var_key}" deve ter só letras, números e underscore, começando com letra ou underscore.`,
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "O nó de coleta precisa apontar para um próximo nó.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `A coleta aponta para um nó inexistente "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "condition": {
      const cfg = node.config as {
        subject?: "var" | "tag" | "contact_field";
        subject_key?: string;
        operator?: "equals" | "contains" | "present" | "absent";
        value?: string;
        true_next?: string;
        false_next?: string;
      };
      if (!cfg.subject || !["var", "tag", "contact_field"].includes(cfg.subject)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "subject",
          message: "A condição precisa de um sujeito (variável / etiqueta / campo do contato).",
        });
      }
      if (!cfg.subject_key?.trim()) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "subject_key",
          message: "A condição precisa de um subject_key (nome da variável, id da etiqueta ou nome do campo).",
        });
      }
      if (
        !cfg.operator ||
        !["equals", "contains", "present", "absent"].includes(cfg.operator)
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "operator",
          message: "A condição precisa de um operador.",
        });
      } else if (
        (cfg.operator === "equals" || cfg.operator === "contains") &&
        (cfg.value === undefined || cfg.value === "")
      ) {
        issues.push({
          severity: "warning",
          scope: "node",
          node_key: node.node_key,
          field: "value",
          message: `O operador "${cfg.operator}" geralmente espera um valor de comparação — vazio só casa com sujeitos vazios.`,
        });
      }
      for (const branch of ["true_next", "false_next"] as const) {
        const key = cfg[branch];
        if (!key) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: branch,
            message: `A condição precisa de um nó para o caminho "${branch === "true_next" ? "verdadeiro" : "falso"}".`,
          });
        } else if (!knownKeys.has(key)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: branch,
            message: `O "${branch}" da condição aponta para um nó inexistente "${key}".`,
          });
        }
      }
      break;
    }

    case "set_tag": {
      const cfg = node.config as {
        mode?: "add" | "remove";
        tag_id?: string;
        next_node_key?: string;
      };
      if (!cfg.mode || !["add", "remove"].includes(cfg.mode)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "mode",
          message: "O nó de etiqueta precisa de um modo (adicionar ou remover).",
        });
      }
      if (!cfg.tag_id) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "tag_id",
          message: "O nó de etiqueta precisa de uma etiqueta para aplicar.",
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "O nó de etiqueta precisa apontar para um próximo nó.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `A etiqueta aponta para um nó inexistente "${cfg.next_node_key}".`,
        });
      }
      break;
    }

    case "delay": {
      const cfg = node.config as {
        duration?: { value?: number; unit?: string };
        next_node_key?: string;
        business_hours?: {
          timezone?: string;
          start?: string;
          end?: string;
          days?: number[];
        };
      };
      const value = cfg.duration?.value;
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "duration.value",
          message: "O tempo de espera precisa ser um número maior ou igual a 0.",
        });
      }
      if (
        !cfg.duration?.unit ||
        !["minutes", "hours", "days"].includes(cfg.duration.unit)
      ) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "duration.unit",
          message: "Escolha a unidade da espera (minutos, horas ou dias).",
        });
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: "O nó de espera precisa apontar para um próximo nó.",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `A espera aponta para um nó inexistente "${cfg.next_node_key}".`,
        });
      }
      // Optional business-hours window ("Atraso Inteligente"). Only
      // validated when present (the toggle is off by default).
      const bh = cfg.business_hours;
      if (bh) {
        const hhmm = /^\d{1,2}:\d{2}$/;
        const toMin = (s?: string) => {
          if (!s || !hhmm.test(s)) return null;
          const [h, m] = s.split(":").map(Number);
          if (h < 0 || h > 23 || m < 0 || m > 59) return null;
          return h * 60 + m;
        };
        const sMin = toMin(bh.start);
        const eMin = toMin(bh.end);
        if (sMin === null || eMin === null) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "business_hours",
            message:
              "O horário comercial precisa de início e fim válidos (HH:MM).",
          });
        } else if (eMin <= sMin) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "business_hours.end",
            message:
              "O fim do horário comercial precisa ser depois do início (janelas que viram a noite não são suportadas).",
          });
        }
        const days = Array.isArray(bh.days) ? bh.days : [];
        if (days.length === 0) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "business_hours.days",
            message: "Escolha pelo menos um dia da semana no horário comercial.",
          });
        }
        if (!bh.timezone?.trim()) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "business_hours.timezone",
            message: "Escolha o fuso horário do horário comercial.",
          });
        }
      }
      break;
    }

    case "jump": {
      const cfg = node.config as { target_node_key?: string };
      if (!cfg.target_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "target_node_key",
          message: "O nó de pular precisa apontar para um nó de destino.",
        });
      } else if (!knownKeys.has(cfg.target_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "target_node_key",
          message: `O pular aponta para um nó inexistente "${cfg.target_node_key}".`,
        });
      }
      break;
    }

    case "randomizer": {
      const cfg = node.config as {
        branches?: Array<{
          id?: string;
          weight?: number;
          next_node_key?: string;
        }>;
      };
      const branches = cfg.branches ?? [];
      if (branches.length < 2) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "branches",
          message: "O randomizador precisa de pelo menos 2 ramos.",
        });
      }
      const totalWeight = branches.reduce(
        (s, b) =>
          s + (typeof b.weight === "number" ? Math.max(0, b.weight) : 0),
        0,
      );
      if (totalWeight <= 0) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "branches",
          message: "Ao menos um ramo precisa de porcentagem maior que 0.",
        });
      }
      const seenIds = new Set<string>();
      branches.forEach((b, i) => {
        const field = `branches.${i}`;
        if (!b.id?.trim()) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.id`,
            message: `O ramo ${i + 1} precisa de um id.`,
          });
        } else if (seenIds.has(b.id)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.id`,
            message: `Id de ramo duplicado "${b.id}".`,
          });
        }
        if (b.id) seenIds.add(b.id);
        if (
          typeof b.weight !== "number" ||
          !Number.isFinite(b.weight) ||
          b.weight < 0
        ) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.weight`,
            message: `O ramo ${i + 1} precisa de uma porcentagem maior ou igual a 0.`,
          });
        }
        if (!b.next_node_key) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.next_node_key`,
            message: `O ramo ${i + 1} precisa apontar para um próximo nó.`,
          });
        } else if (!knownKeys.has(b.next_node_key)) {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: `${field}.next_node_key`,
            message: `O ramo ${i + 1} aponta para um nó inexistente "${b.next_node_key}".`,
          });
        }
      });
      break;
    }

    case "http_fetch": {
      const cfg = node.config as {
        method?: string;
        url?: string;
        next_node_key?: string;
        error_node_key?: string;
      };
      const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
      if (!cfg.method || !methods.includes(cfg.method)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "method",
          message: "Escolha o método HTTP (GET, POST, …).",
        });
      }
      const url = cfg.url?.trim() ?? "";
      if (!url) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "url",
          message: "A requisição HTTP precisa de uma URL.",
        });
      } else if (!/\{\{vars\./.test(url)) {
        // Static-check only when there's no interpolation — an
        // interpolated URL is unknown until run time.
        try {
          const u = new URL(url);
          if (u.protocol !== "https:" && u.protocol !== "http:") {
            issues.push({
              severity: "error",
              scope: "node",
              node_key: node.node_key,
              field: "url",
              message: "A URL precisa começar com http:// ou https://.",
            });
          }
        } catch {
          issues.push({
            severity: "error",
            scope: "node",
            node_key: node.node_key,
            field: "url",
            message: "A URL não é válida.",
          });
        }
      }
      if (!cfg.next_node_key) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message:
            "A requisição HTTP precisa apontar para um próximo nó (sucesso).",
        });
      } else if (!knownKeys.has(cfg.next_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "next_node_key",
          message: `O sucesso aponta para um nó inexistente "${cfg.next_node_key}".`,
        });
      }
      if (cfg.error_node_key && !knownKeys.has(cfg.error_node_key)) {
        issues.push({
          severity: "error",
          scope: "node",
          node_key: node.node_key,
          field: "error_node_key",
          message: `O caminho de erro aponta para um nó inexistente "${cfg.error_node_key}".`,
        });
      }
      break;
    }

    case "handoff":
    case "end":
      // Terminal nodes have no outgoing edges; nothing to validate
      // beyond their existence.
      break;

    default:
      issues.push({
        severity: "error",
        scope: "node",
        node_key: node.node_key,
        message: `Tipo de nó desconhecido "${node.node_type}".`,
      });
  }

  return issues;
}

// ============================================================
// Reachability — BFS from the entry, follow outgoing edges per node
// ============================================================

export function reachableFromEntry(
  entryKey: string,
  nodes: NodeInput[],
): Set<string> {
  const byKey = new Map<string, NodeInput>();
  for (const n of nodes) byKey.set(n.node_key, n);

  const visited = new Set<string>();
  const queue: string[] = [entryKey];
  while (queue.length > 0) {
    const key = queue.shift() as string;
    if (visited.has(key)) continue;
    visited.add(key);
    const node = byKey.get(key);
    if (!node) continue;
    for (const next of outgoingEdges(node)) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return visited;
}

function outgoingEdges(node: NodeInput): string[] {
  switch (node.node_type) {
    case "start":
    case "send_message":
    case "send_media":
    case "collect_input":
    case "set_tag":
    case "delay": {
      const cfg = node.config as { next_node_key?: string };
      return cfg.next_node_key ? [cfg.next_node_key] : [];
    }
    case "condition": {
      const cfg = node.config as {
        true_next?: string;
        false_next?: string;
      };
      const out: string[] = [];
      if (cfg.true_next) out.push(cfg.true_next);
      if (cfg.false_next) out.push(cfg.false_next);
      return out;
    }
    case "jump": {
      const cfg = node.config as { target_node_key?: string };
      return cfg.target_node_key ? [cfg.target_node_key] : [];
    }
    case "randomizer": {
      const cfg = node.config as {
        branches?: Array<{ next_node_key?: string }>;
      };
      return (cfg.branches ?? [])
        .map((b) => b.next_node_key)
        .filter((k): k is string => !!k);
    }
    case "http_fetch": {
      const cfg = node.config as {
        next_node_key?: string;
        error_node_key?: string;
      };
      const out: string[] = [];
      if (cfg.next_node_key) out.push(cfg.next_node_key);
      if (cfg.error_node_key) out.push(cfg.error_node_key);
      return out;
    }
    case "send_buttons": {
      const cfg = node.config as {
        buttons?: Array<{ next_node_key?: string }>;
      };
      return (cfg.buttons ?? [])
        .map((b) => b.next_node_key)
        .filter((k): k is string => !!k);
    }
    case "send_list": {
      const cfg = node.config as {
        sections?: Array<{ rows?: Array<{ next_node_key?: string }> }>;
      };
      const out: string[] = [];
      for (const s of cfg.sections ?? []) {
        for (const r of s.rows ?? []) {
          if (r.next_node_key) out.push(r.next_node_key);
        }
      }
      return out;
    }
    case "handoff":
    case "end":
    default:
      return [];
  }
}

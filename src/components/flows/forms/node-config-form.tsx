"use client";

/**
 * Per-node configuration form, dispatched by node_type.
 *
 * One component, ten branches. Each branch renders the inputs that
 * map onto the node's `config` JSONB shape (text + buttons for
 * send_buttons, prompt + var_key for collect_input, etc.) and forwards
 * edits up via `onUpdateConfig`.
 *
 * Why this lives in src/components/flows/forms/ instead of next to
 * the list editor: PR 2 (canvas editing) needs to mount the same
 * form in a side panel when a user clicks a node on the canvas.
 * Keeping the per-node forms here means there's exactly one place
 * where each form's behaviour and validation lives — drift between
 * "what the list editor shows" and "what the canvas side panel
 * shows" becomes impossible.
 *
 * `showAdvanced` is the disclosure that surfaces internal
 * identifiers (node_key, button reply_id, list row reply_id) — owned
 * by the host (NodeCard / SideSheet) so the toggle is rendered
 * outside this form alongside whatever delete/cancel buttons that
 * host wants. The form just reads the boolean and conditionally
 * renders the advanced rows.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Loader2,
  Paperclip,
  Plus,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { uploadAccountMedia, MEDIA_MAX_BYTES } from "@/lib/storage/upload-media";
import { slugify, type BuilderNode } from "../shared";
import { useFlowEditor } from "../flow-editor-state";
import { NextNodeRow, NodeKeySelect, TextRow } from "./fields";

// Sentinel for the handoff "Atribuir a" picker — Base UI Select can't use an
// empty string as an item value, so this maps to assign_to = null (sector queue).
const SECTOR_QUEUE = "__sector_queue__";

interface NodeConfigFormProps {
  node: BuilderNode;
  allNodes: BuilderNode[];
  showAdvanced: boolean;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}

export function NodeConfigForm({
  node,
  allNodes,
  showAdvanced,
  onUpdateConfig,
}: NodeConfigFormProps) {
  // Members drive the handoff "Atribuir a" picker. Always inside the editor
  // provider (both list card + canvas sheet), so this is safe.
  const { members } = useFlowEditor();
  const cfg = node.config;
  switch (node.node_type) {
    case "start":
      return (
        <NextNodeRow
          value={(cfg as { next_node_key?: string }).next_node_key ?? ""}
          allNodes={allNodes}
          currentKey={node.node_key}
          onChange={(v) => onUpdateConfig({ next_node_key: v })}
          label="Avança para"
        />
      );

    case "send_message":
      return (
        <>
          <TextRow
            label="Texto enviado ao cliente"
            value={(cfg as { text?: string }).text ?? ""}
            onChange={(v) => onUpdateConfig({ text: v })}
          />
          <NextNodeRow
            value={(cfg as { next_node_key?: string }).next_node_key ?? ""}
            allNodes={allNodes}
            currentKey={node.node_key}
            onChange={(v) => onUpdateConfig({ next_node_key: v })}
            label="Avança para"
          />
        </>
      );

    case "send_buttons":
      return (
        <SendButtonsForm
          cfg={cfg as SendButtonsCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          showAdvanced={showAdvanced}
        />
      );

    case "send_list":
      return (
        <SendListForm
          cfg={cfg as SendListCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
          showAdvanced={showAdvanced}
        />
      );

    case "send_media":
      return (
        <SendMediaForm
          cfg={cfg as SendMediaCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "collect_input":
      return (
        <>
          <TextRow
            label="Pergunta enviada ao cliente"
            value={(cfg as { prompt_text?: string }).prompt_text ?? ""}
            onChange={(v) => onUpdateConfig({ prompt_text: v })}
            rows={2}
          />
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Chave da variável (armazenada em flow_runs.vars; letras, números e sublinhado)
            </label>
            <Input
              value={(cfg as { var_key?: string }).var_key ?? ""}
              onChange={(e) =>
                onUpdateConfig({
                  var_key: e.target.value.replace(/[^a-zA-Z0-9_]/g, ""),
                })
              }
              placeholder="ex.: nome, email, empresa"
              className="bg-muted font-mono text-xs"
            />
            <p className="mt-1 text-[10px] text-muted-foreground">
              Interpole em perguntas e notas de transferência posteriores com{" "}
              <code className="rounded bg-muted px-1">
                {"{{vars."}
                {(cfg as { var_key?: string }).var_key || "name"}
                {"}}"}
              </code>
              .
            </p>
          </div>
          <NextNodeRow
            value={(cfg as { next_node_key?: string }).next_node_key ?? ""}
            allNodes={allNodes}
            currentKey={node.node_key}
            onChange={(v) => onUpdateConfig({ next_node_key: v })}
            label="Após capturar, avançar para"
          />
          <TimeoutSection
            timeout={(cfg as { timeout?: TimeoutCfg }).timeout}
            allNodes={allNodes}
            currentKey={node.node_key}
            onUpdateConfig={onUpdateConfig}
          />
        </>
      );

    case "condition":
      return (
        <ConditionForm
          cfg={cfg as ConditionCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "set_tag":
      return (
        <SetTagForm
          cfg={cfg as SetTagCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "delay":
      return (
        <DelayForm
          cfg={cfg as DelayCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "jump": {
      const jcfg = cfg as { target_node_key?: string };
      return (
        <div className="flex flex-col gap-2">
          <NextNodeRow
            value={jcfg.target_node_key ?? ""}
            allNodes={allNodes}
            currentKey={node.node_key}
            onChange={(v) => onUpdateConfig({ target_node_key: v })}
            label="Pular para o nó"
          />
          <p className="text-[11px] text-muted-foreground">
            O fluxo continua a partir desse nó. Bom para loops (com um
            <span className="font-medium"> Esperar</span> antes, pra não repetir
            sem parar). Limite de segurança: 25 saltos por execução.
          </p>
        </div>
      );
    }

    case "randomizer":
      return (
        <RandomizerForm
          cfg={cfg as RandomizerCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "http_fetch":
      return (
        <HttpFetchForm
          cfg={cfg as HttpFetchCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "action":
      return (
        <ActionForm
          cfg={cfg as ActionCfg}
          allNodes={allNodes}
          currentKey={node.node_key}
          onUpdateConfig={onUpdateConfig}
        />
      );

    case "handoff": {
      const hcfg = cfg as {
        note?: string;
        assign_to?: string;
        customer_message?: string;
      };
      const assignMissing =
        !!hcfg.assign_to &&
        !members.some((m) => m.user_id === hcfg.assign_to);
      // Render the label ourselves (name only) rather than Base UI's
      // <SelectValue>, which drops the cached text on the editor's heavy
      // re-renders and falls back to the raw user id.
      const assignedLabel = !hcfg.assign_to
        ? "Fila do setor (quem pegar primeiro)"
        : (members.find((m) => m.user_id === hcfg.assign_to)?.full_name ||
          "Atendente removido");
      return (
        <div className="flex flex-col gap-3">
          <TextRow
            label="Mensagem para o cliente (opcional)"
            value={hcfg.customer_message ?? ""}
            onChange={(v) => onUpdateConfig({ customer_message: v })}
            rows={2}
            placeholder="Ex.: Perfeito! Vou te transferir para um atendente. Um instante 🙂"
          />
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">
              Atribuir a
            </label>
            <Select
              value={hcfg.assign_to ?? SECTOR_QUEUE}
              onValueChange={(v) =>
                onUpdateConfig({ assign_to: v === SECTOR_QUEUE ? null : v })
              }
            >
              <SelectTrigger className="bg-muted">
                <span className="truncate">{assignedLabel}</span>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SECTOR_QUEUE}>
                  Fila do setor (quem pegar primeiro)
                </SelectItem>
                {members.map((m) => (
                  <SelectItem key={m.user_id} value={m.user_id}>
                    {m.full_name || "(sem nome)"}
                  </SelectItem>
                ))}
                {assignMissing && (
                  <SelectItem value={hcfg.assign_to!}>
                    Atendente removido — escolha outro
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {hcfg.assign_to
                ? "A conversa vai pra esse atendente e ele recebe uma notificação."
                : "A conversa fica pendente no setor para a equipe pegar."}
            </p>
          </div>
          <TextRow
            label="Nota interna (aparece na conversa para o atendente)"
            value={hcfg.note ?? ""}
            onChange={(v) => onUpdateConfig({ note: v })}
            rows={2}
          />
        </div>
      );
    }

    case "end":
      return (
        <p className="text-xs text-muted-foreground">
          Nó final. Quando o motor chega a este nó, a execução é marcada como
          concluída. Nenhuma configuração necessária.
        </p>
      );
  }
}

// ============================================================
// send_buttons
// ============================================================

interface SendButtonsCfg {
  text?: string;
  footer_text?: string;
  buttons?: Array<{ reply_id: string; title: string; next_node_key: string }>;
  timeout?: TimeoutCfg;
}

function SendButtonsForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  showAdvanced,
}: {
  cfg: SendButtonsCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  showAdvanced: boolean;
}) {
  const buttons = cfg.buttons ?? [];
  const updateButton = (
    idx: number,
    patch: Partial<NonNullable<SendButtonsCfg["buttons"]>[number]>,
  ) => {
    onUpdateConfig({
      buttons: buttons.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
    });
  };
  const addButton = () =>
    onUpdateConfig({
      buttons: [
        ...buttons,
        {
          reply_id: `btn_${buttons.length + 1}`,
          title: "Opção",
          next_node_key: "",
        },
      ],
    });
  const removeButton = (idx: number) =>
    onUpdateConfig({ buttons: buttons.filter((_, i) => i !== idx) });

  return (
    <>
      <TextRow
        label="Texto do corpo"
        value={cfg.text ?? ""}
        onChange={(v) => onUpdateConfig({ text: v })}
        rows={3}
      />
      <TextRow
        label="Rodapé (opcional, 60 caracteres)"
        value={cfg.footer_text ?? ""}
        onChange={(v) => onUpdateConfig({ footer_text: v })}
      />
      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="text-xs text-muted-foreground">
            Botões (1–3) — cada um leva a um próximo nó diferente
          </label>
        </div>
        <div className="flex flex-col gap-3">
          {buttons.map((b, i) => (
            <div
              key={i}
              className={cn(
                "grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/40 p-3",
                showAdvanced
                  ? "md:grid-cols-[1fr_2fr_2fr_auto]"
                  : "md:grid-cols-[2fr_2fr_auto]",
              )}
            >
              {showAdvanced && (
                <Input
                  value={b.reply_id}
                  onChange={(e) =>
                    updateButton(i, {
                      reply_id: slugify(e.target.value, `btn_${i + 1}`),
                    })
                  }
                  placeholder="reply_id"
                  className="bg-muted font-mono text-xs"
                />
              )}
              <Input
                value={b.title}
                onChange={(e) => updateButton(i, { title: e.target.value })}
                placeholder="Título visível (≤20 caracteres)"
                className="bg-muted"
                maxLength={20}
              />
              <NodeKeySelect
                value={b.next_node_key || null}
                nodes={allNodes}
                excludeKey={currentKey}
                onChange={(v) => updateButton(i, { next_node_key: v ?? "" })}
                placeholder="Próximo nó…"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeButton(i)}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
        {buttons.length < 3 && (
          <Button
            variant="ghost"
            size="sm"
            onClick={addButton}
            className="mt-2"
          >
            <Plus className="h-3.5 w-3.5" />
            Adicionar botão
          </Button>
        )}
      </div>
      <TimeoutSection
        timeout={cfg.timeout}
        allNodes={allNodes}
        currentKey={currentKey}
        onUpdateConfig={onUpdateConfig}
      />
    </>
  );
}

// ============================================================
// send_list
// ============================================================

interface SendListCfg {
  text?: string;
  button_label?: string;
  footer_text?: string;
  sections?: Array<{
    title?: string;
    rows: Array<{
      reply_id: string;
      title: string;
      description?: string;
      next_node_key: string;
    }>;
  }>;
  timeout?: TimeoutCfg;
}

function SendListForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
  showAdvanced,
}: {
  cfg: SendListCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
  showAdvanced: boolean;
}) {
  const sections = cfg.sections ?? [];
  const totalRows = sections.reduce((sum, s) => sum + s.rows.length, 0);

  const updateSection = (
    sIdx: number,
    patch: Partial<NonNullable<SendListCfg["sections"]>[number]>,
  ) => {
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx ? { ...s, ...patch } : s,
      ),
    });
  };
  const addSection = () =>
    onUpdateConfig({
      sections: [
        ...sections,
        {
          title: "",
          rows: [
            {
              reply_id: `row_${totalRows + 1}`,
              title: `Opção ${totalRows + 1}`,
              next_node_key: "",
            },
          ],
        },
      ],
    });
  const removeSection = (sIdx: number) =>
    onUpdateConfig({ sections: sections.filter((_, i) => i !== sIdx) });
  const updateRow = (
    sIdx: number,
    rIdx: number,
    patch: Partial<
      NonNullable<SendListCfg["sections"]>[number]["rows"][number]
    >,
  ) => {
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx
          ? {
              ...s,
              rows: s.rows.map((r, j) => (j === rIdx ? { ...r, ...patch } : r)),
            }
          : s,
      ),
    });
  };
  const addRow = (sIdx: number) =>
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx
          ? {
              ...s,
              rows: [
                ...s.rows,
                {
                  reply_id: `row_${totalRows + 1}`,
                  title: `Opção ${totalRows + 1}`,
                  next_node_key: "",
                },
              ],
            }
          : s,
      ),
    });
  const removeRow = (sIdx: number, rIdx: number) =>
    onUpdateConfig({
      sections: sections.map((s, i) =>
        i === sIdx ? { ...s, rows: s.rows.filter((_, j) => j !== rIdx) } : s,
      ),
    });

  return (
    <>
      <TextRow
        label="Texto do corpo"
        value={cfg.text ?? ""}
        onChange={(v) => onUpdateConfig({ text: v })}
        rows={3}
      />
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <TextRow
          label="Rótulo do botão de abrir a lista (≤20 caracteres)"
          value={cfg.button_label ?? ""}
          onChange={(v) => onUpdateConfig({ button_label: v })}
        />
        <TextRow
          label="Rodapé (opcional, 60 caracteres)"
          value={cfg.footer_text ?? ""}
          onChange={(v) => onUpdateConfig({ footer_text: v })}
        />
      </div>

      <div className="mt-2">
        <label className="mb-2 block text-xs text-muted-foreground">
          Linhas (1–10 no total entre todas as seções)
        </label>
        {sections.map((section, sIdx) => (
          <div
            key={sIdx}
            className="mb-3 rounded-md border border-border bg-muted/40 p-3"
          >
            <div className="mb-2 flex items-center gap-2">
              <Input
                value={section.title ?? ""}
                onChange={(e) =>
                  updateSection(sIdx, { title: e.target.value })
                }
                placeholder={`Título da seção ${sIdx + 1} (opcional)`}
                className="bg-muted text-xs"
              />
              {sections.length > 1 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeSection(sIdx)}
                  className="shrink-0 text-red-400 hover:bg-red-500/10 hover:text-red-300"
                  aria-label="Remover seção"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            {section.rows.map((row, rIdx) => (
              <div
                key={rIdx}
                className={cn(
                  "mb-2 grid grid-cols-1 gap-2",
                  showAdvanced
                    ? "md:grid-cols-[1fr_2fr_2fr_auto]"
                    : "md:grid-cols-[2fr_2fr_auto]",
                )}
              >
                {showAdvanced && (
                  <Input
                    value={row.reply_id}
                    onChange={(e) =>
                      updateRow(sIdx, rIdx, {
                        reply_id: slugify(
                          e.target.value,
                          `row_${rIdx + 1}`,
                        ),
                      })
                    }
                    placeholder="reply_id"
                    className="bg-muted font-mono text-xs"
                  />
                )}
                <Input
                  value={row.title}
                  onChange={(e) =>
                    updateRow(sIdx, rIdx, { title: e.target.value })
                  }
                  placeholder="Título da linha (≤24)"
                  className="bg-muted"
                  maxLength={24}
                />
                <NodeKeySelect
                  value={row.next_node_key || null}
                  nodes={allNodes}
                  excludeKey={currentKey}
                  onChange={(v) =>
                    updateRow(sIdx, rIdx, { next_node_key: v ?? "" })
                  }
                  placeholder="Próximo nó…"
                />
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeRow(sIdx, rIdx)}
                  className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {totalRows < 10 && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => addRow(sIdx)}
                className="mt-1"
              >
                <Plus className="h-3.5 w-3.5" />
                Adicionar linha
              </Button>
            )}
          </div>
        ))}
        {/* WhatsApp's interactive-list spec caps sections at 10. Group rows
            by category (Billing / Support / Sales etc.) to give customers a
            scannable menu. */}
        {sections.length < 10 && (
          <Button variant="outline" size="sm" onClick={addSection}>
            <Plus className="h-3.5 w-3.5" />
            Adicionar seção
          </Button>
        )}
      </div>
      <TimeoutSection
        timeout={cfg.timeout}
        allNodes={allNodes}
        currentKey={currentKey}
        onUpdateConfig={onUpdateConfig}
      />
    </>
  );
}

// ============================================================
// delay ("Esperar" + optional Atraso Inteligente / business hours)
// ============================================================

interface DelayCfg {
  duration?: { value?: number; unit?: "minutes" | "hours" | "days" };
  next_node_key?: string;
  business_hours?: {
    timezone?: string;
    start?: string;
    end?: string;
    days?: number[];
  };
}

const BH_TIMEZONES: { value: string; label: string }[] = [
  { value: "America/Sao_Paulo", label: "Brasília (GMT-3)" },
  { value: "America/Fortaleza", label: "Fortaleza / NE (GMT-3)" },
  { value: "America/Manaus", label: "Manaus / AM (GMT-4)" },
  { value: "America/Cuiaba", label: "Cuiabá / MT (GMT-4)" },
  { value: "America/Rio_Branco", label: "Rio Branco / AC (GMT-5)" },
  { value: "America/Noronha", label: "F. de Noronha (GMT-2)" },
];

const BH_DAYS: { value: number; label: string }[] = [
  { value: 0, label: "Dom" },
  { value: 1, label: "Seg" },
  { value: 2, label: "Ter" },
  { value: 3, label: "Qua" },
  { value: 4, label: "Qui" },
  { value: 5, label: "Sex" },
  { value: 6, label: "Sáb" },
];

const BH_DEFAULT = {
  timezone: "America/Sao_Paulo",
  start: "09:00",
  end: "18:00",
  days: [1, 2, 3, 4, 5],
};

function DelayForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: DelayCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const value =
    typeof cfg.duration?.value === "number" ? cfg.duration.value : 1;
  const unit = cfg.duration?.unit ?? "days";
  const unitLabel =
    unit === "days" ? "Dias" : unit === "hours" ? "Horas" : "Minutos";
  const bh = cfg.business_hours;
  const bhOn = !!bh;
  const tzLabel =
    BH_TIMEZONES.find((t) => t.value === bh?.timezone)?.label ??
    bh?.timezone ??
    "";

  const toggleDay = (d: number) => {
    const cur = Array.isArray(bh?.days) ? bh.days : [];
    const next = cur.includes(d)
      ? cur.filter((x) => x !== d)
      : [...cur, d].sort((a, b) => a - b);
    onUpdateConfig({ business_hours: { ...(bh ?? BH_DEFAULT), days: next } });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Esperar
          </label>
          <Input
            type="number"
            min={0}
            value={String(value)}
            onChange={(e) =>
              onUpdateConfig({
                duration: {
                  value: Math.max(0, Number(e.target.value) || 0),
                  unit,
                },
              })
            }
            className="bg-muted"
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Unidade
          </label>
          <Select
            value={unit}
            onValueChange={(v) =>
              onUpdateConfig({ duration: { value, unit: v } })
            }
          >
            <SelectTrigger className="bg-muted">
              <span className="truncate">{unitLabel}</span>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="minutes">Minutos</SelectItem>
              <SelectItem value="hours">Horas</SelectItem>
              <SelectItem value="days">Dias</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        O fluxo pausa e continua sozinho após esse tempo (sobrevive a reinício
        do servidor).
      </p>

      {/* Atraso Inteligente — optional daily business-hours window. */}
      <div className="rounded-md border border-border bg-muted/40 p-3">
        <label className="flex items-center gap-2 text-xs font-medium text-foreground">
          <input
            type="checkbox"
            checked={bhOn}
            onChange={(e) =>
              onUpdateConfig({
                business_hours: e.target.checked ? BH_DEFAULT : undefined,
              })
            }
            className="h-3.5 w-3.5 accent-primary"
          />
          Só entregar em horário comercial (Atraso Inteligente)
        </label>
        {bhOn && (
          <div className="mt-3 flex flex-col gap-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-[10px] text-muted-foreground">
                  Início
                </label>
                <Input
                  type="time"
                  value={bh?.start ?? "09:00"}
                  onChange={(e) =>
                    onUpdateConfig({
                      business_hours: {
                        ...(bh ?? BH_DEFAULT),
                        start: e.target.value,
                      },
                    })
                  }
                  className="bg-muted"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] text-muted-foreground">
                  Fim
                </label>
                <Input
                  type="time"
                  value={bh?.end ?? "18:00"}
                  onChange={(e) =>
                    onUpdateConfig({
                      business_hours: {
                        ...(bh ?? BH_DEFAULT),
                        end: e.target.value,
                      },
                    })
                  }
                  className="bg-muted"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-[10px] text-muted-foreground">
                Fuso horário
              </label>
              <Select
                value={bh?.timezone ?? "America/Sao_Paulo"}
                onValueChange={(v) =>
                  onUpdateConfig({
                    business_hours: { ...(bh ?? BH_DEFAULT), timezone: v },
                  })
                }
              >
                <SelectTrigger className="bg-muted">
                  <span className="truncate">{tzLabel}</span>
                </SelectTrigger>
                <SelectContent>
                  {BH_TIMEZONES.map((t) => (
                    <SelectItem key={t.value} value={t.value}>
                      {t.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="mb-1 block text-[10px] text-muted-foreground">
                Dias da semana
              </label>
              <div className="flex flex-wrap gap-1.5">
                {BH_DAYS.map((d) => {
                  const on =
                    Array.isArray(bh?.days) && bh.days.includes(d.value);
                  return (
                    <button
                      key={d.value}
                      type="button"
                      onClick={() => toggleDay(d.value)}
                      className={cn(
                        "rounded-md border px-2 py-1 text-[11px] transition-colors",
                        on
                          ? "border-primary bg-primary/15 text-foreground"
                          : "border-border bg-muted text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {d.label}
                    </button>
                  );
                })}
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground">
              Depois de esperar, se cair fora da janela, o fluxo segura até a
              próxima abertura. Ex.: uma espera que venceria às 3h da manhã só
              continua às {bh?.start ?? "09:00"}.
            </p>
          </div>
        )}
      </div>

      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Depois de esperar, ir para"
      />
    </div>
  );
}

// ============================================================
// randomizer (ManyChat-style A/B split)
// ============================================================

interface RandomizerCfg {
  branches?: Array<{ id: string; weight: number; next_node_key: string }>;
}

function RandomizerForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: RandomizerCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const branches = cfg.branches ?? [];
  const total = branches.reduce(
    (s, b) => s + (typeof b.weight === "number" ? Math.max(0, b.weight) : 0),
    0,
  );

  const updateBranch = (
    idx: number,
    patch: Partial<NonNullable<RandomizerCfg["branches"]>[number]>,
  ) => {
    onUpdateConfig({
      branches: branches.map((b, i) => (i === idx ? { ...b, ...patch } : b)),
    });
  };
  const addBranch = () => {
    // Stable, human-friendly ids (a, b, c…) — reused by the canvas edge
    // handles (`branch:<id>`), so they must stay unique within the node.
    const used = new Set(branches.map((b) => b.id));
    let id = "";
    for (let c = 0; c < 26; c += 1) {
      const cand = String.fromCharCode(97 + c);
      if (!used.has(cand)) {
        id = cand;
        break;
      }
    }
    if (!id) id = `r${branches.length + 1}`;
    onUpdateConfig({
      branches: [...branches, { id, weight: 0, next_node_key: "" }],
    });
  };
  const removeBranch = (idx: number) =>
    onUpdateConfig({ branches: branches.filter((_, i) => i !== idx) });

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground">
        Divide as execuções entre os ramos por sorteio. Bom para testar
        mensagens diferentes (teste A/B). Os pesos são relativos — não precisam
        somar 100.
      </p>
      <div className="flex flex-col gap-3">
        {branches.map((b, i) => {
          const w = typeof b.weight === "number" ? Math.max(0, b.weight) : 0;
          const pct = total > 0 ? Math.round((w / total) * 100) : 0;
          return (
            <div
              key={i}
              className="grid grid-cols-1 gap-2 rounded-md border border-border bg-muted/40 p-3 md:grid-cols-[7rem_1fr_auto]"
            >
              <div>
                <label className="mb-1 block text-[10px] text-muted-foreground">
                  Peso ({pct}%)
                </label>
                <Input
                  type="number"
                  min={0}
                  value={String(w)}
                  onChange={(e) =>
                    updateBranch(i, {
                      weight: Math.max(0, Number(e.target.value) || 0),
                    })
                  }
                  className="bg-muted"
                />
              </div>
              <div>
                <label className="mb-1 block text-[10px] text-muted-foreground">
                  Ramo {(b.id ?? "").toUpperCase()} → próximo nó
                </label>
                <NodeKeySelect
                  value={b.next_node_key || null}
                  nodes={allNodes}
                  excludeKey={currentKey}
                  onChange={(v) => updateBranch(i, { next_node_key: v ?? "" })}
                  placeholder="Próximo nó…"
                />
              </div>
              <div className="flex items-end">
                {branches.length > 2 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeBranch(i)}
                    className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                    aria-label="Remover ramo"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div>
        <Button variant="ghost" size="sm" onClick={addBranch}>
          <Plus className="h-3.5 w-3.5" />
          Adicionar ramo
        </Button>
      </div>
    </div>
  );
}

// ============================================================
// http_fetch (chamar API externa; guarda SSRF roda no servidor)
// ============================================================

interface HttpFetchCfg {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url?: string;
  headers?: Array<{ key: string; value: string }>;
  body?: string;
  save_to?: string;
  next_node_key?: string;
  error_node_key?: string;
}

const HTTP_METHODS: HttpFetchCfg["method"][] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
];

function HttpFetchForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: HttpFetchCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const method = cfg.method ?? "GET";
  const headers = cfg.headers ?? [];
  const hasBody = method !== "GET";
  const saveTo = cfg.save_to || "http";

  const updateHeader = (
    i: number,
    patch: Partial<{ key: string; value: string }>,
  ) =>
    onUpdateConfig({
      headers: headers.map((h, j) => (j === i ? { ...h, ...patch } : h)),
    });
  const addHeader = () =>
    onUpdateConfig({ headers: [...headers, { key: "", value: "" }] });
  const removeHeader = (i: number) =>
    onUpdateConfig({ headers: headers.filter((_, j) => j !== i) });

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-[7rem_1fr] gap-2">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Método
          </label>
          <Select
            value={method}
            onValueChange={(v) => onUpdateConfig({ method: v })}
          >
            <SelectTrigger className="bg-muted">
              <span className="truncate">{method}</span>
            </SelectTrigger>
            <SelectContent>
              {HTTP_METHODS.map((m) => (
                <SelectItem key={m} value={m as string}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">URL</label>
          <Input
            value={cfg.url ?? ""}
            onChange={(e) => onUpdateConfig({ url: e.target.value })}
            placeholder="https://api.exemplo.com/leads/{{vars.email}}"
            className="bg-muted font-mono text-xs"
          />
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Só URLs públicas http/https — endereços internos (localhost, IP privado,
        metadados de nuvem) são bloqueados no servidor. Timeout de 10s, resposta
        até 256 KB. Use{" "}
        <code className="rounded bg-muted px-1">{"{{vars.x}}"}</code> na URL,
        cabeçalhos e corpo.
      </p>

      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          Cabeçalhos (opcional)
        </label>
        <div className="flex flex-col gap-2">
          {headers.map((h, i) => (
            <div
              key={i}
              className="grid grid-cols-[1fr_1fr_auto] gap-2"
            >
              <Input
                value={h.key}
                onChange={(e) => updateHeader(i, { key: e.target.value })}
                placeholder="Authorization"
                className="bg-muted font-mono text-xs"
              />
              <Input
                value={h.value}
                onChange={(e) => updateHeader(i, { value: e.target.value })}
                placeholder="Bearer {{vars.token}}"
                className="bg-muted font-mono text-xs"
              />
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeHeader(i)}
                className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
                aria-label="Remover cabeçalho"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </div>
        <Button variant="ghost" size="sm" onClick={addHeader} className="mt-2">
          <Plus className="h-3.5 w-3.5" />
          Adicionar cabeçalho
        </Button>
      </div>

      {hasBody && (
        <TextRow
          label="Corpo (JSON ou texto — interpolado)"
          value={cfg.body ?? ""}
          onChange={(v) => onUpdateConfig({ body: v })}
          rows={4}
          placeholder={'{"nome": "{{vars.name}}"}'}
        />
      )}

      <div>
        <label className="mb-1 block text-xs text-muted-foreground">
          Guardar resposta em (prefixo da variável)
        </label>
        <Input
          value={cfg.save_to ?? ""}
          onChange={(e) =>
            onUpdateConfig({
              save_to: e.target.value.replace(/[^a-zA-Z0-9_]/g, ""),
            })
          }
          placeholder="http"
          className="bg-muted font-mono text-xs"
        />
        <p className="mt-1 text-[10px] text-muted-foreground">
          Guarda o corpo em{" "}
          <code className="rounded bg-muted px-1">
            {"{{vars."}
            {saveTo}
            {"}}"}
          </code>{" "}
          e o status em{" "}
          <code className="rounded bg-muted px-1">
            {"{{vars."}
            {saveTo}
            {"_status}}"}
          </code>
          . Um <span className="font-medium">Se / senão</span> pode ramificar
          por <code className="rounded bg-muted px-1">{saveTo}_status</code>.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <NextNodeRow
          value={cfg.next_node_key ?? ""}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => onUpdateConfig({ next_node_key: v })}
          label="Se OK (2xx) → avançar para"
        />
        <NextNodeRow
          value={cfg.error_node_key ?? ""}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => onUpdateConfig({ error_node_key: v })}
          label="Se erro → avançar para (opcional)"
        />
      </div>
    </div>
  );
}

// ============================================================
// action (Ações multi-op — set_field / add_tag / remove_tag / notify)
// ============================================================

type ActionOp =
  | { type: "set_field"; field?: "name" | "email" | "company"; value?: string }
  | { type: "add_tag"; tag_id?: string }
  | { type: "remove_tag"; tag_id?: string }
  | { type: "notify"; message?: string; assign_to?: string };

interface ActionCfg {
  operations?: ActionOp[];
  next_node_key?: string;
}

// Base UI Select can't use an empty string value — this maps to
// assign_to = undefined (notify the conversation's current assignee).
const ACTION_NOTIFY_ASSIGNEE = "__conversation_assignee__";

const ACTION_OP_LABELS: { value: ActionOp["type"]; label: string }[] = [
  { value: "set_field", label: "Definir campo do contato" },
  { value: "add_tag", label: "Adicionar etiqueta" },
  { value: "remove_tag", label: "Remover etiqueta" },
  { value: "notify", label: "Avisar atendente" },
];

function ActionForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: ActionCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const { members } = useFlowEditor();
  const tags = useUserTags();
  const ops = cfg.operations ?? [];

  const updateOp = (i: number, next: ActionOp) =>
    onUpdateConfig({ operations: ops.map((o, j) => (j === i ? next : o)) });
  const changeType = (i: number, type: ActionOp["type"]) => {
    const fresh: ActionOp =
      type === "set_field"
        ? { type, field: "name", value: "" }
        : type === "notify"
          ? { type, message: "" }
          : { type, tag_id: "" };
    updateOp(i, fresh);
  };
  const addOp = () =>
    onUpdateConfig({
      operations: [...ops, { type: "set_field", field: "name", value: "" }],
    });
  const removeOp = (i: number) =>
    onUpdateConfig({ operations: ops.filter((_, j) => j !== i) });

  const opTypeLabel = (t: ActionOp["type"]) =>
    ACTION_OP_LABELS.find((o) => o.value === t)?.label ?? t;

  return (
    <div className="flex flex-col gap-3">
      <p className="text-[11px] text-muted-foreground">
        Executa as ações em ordem, sem enviar mensagem ao cliente. Valores
        aceitam <code className="rounded bg-muted px-1">{"{{vars.x}}"}</code>.
      </p>
      <div className="flex flex-col gap-3">
        {ops.map((op, i) => (
          <div
            key={i}
            className="rounded-md border border-border bg-muted/40 p-3"
          >
            <div className="mb-2 flex items-center gap-2">
              <Select
                value={op.type}
                onValueChange={(v) => changeType(i, v as ActionOp["type"])}
              >
                <SelectTrigger className="bg-muted">
                  <span className="truncate">{opTypeLabel(op.type)}</span>
                </SelectTrigger>
                <SelectContent>
                  {ACTION_OP_LABELS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => removeOp(i)}
                aria-label="Remover ação"
                className="shrink-0 text-red-400 hover:bg-red-500/10 hover:text-red-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>

            {op.type === "set_field" && (
              <div className="grid grid-cols-[9rem_1fr] gap-2">
                <Select
                  value={op.field ?? "name"}
                  onValueChange={(v) =>
                    updateOp(i, {
                      ...op,
                      field: v as "name" | "email" | "company",
                    })
                  }
                >
                  <SelectTrigger className="bg-muted">
                    <span className="truncate">
                      {op.field === "email"
                        ? "Email"
                        : op.field === "company"
                          ? "Empresa"
                          : "Nome"}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="name">Nome</SelectItem>
                    <SelectItem value="email">Email</SelectItem>
                    <SelectItem value="company">Empresa</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  value={op.value ?? ""}
                  onChange={(e) => updateOp(i, { ...op, value: e.target.value })}
                  placeholder="Valor (ex.: {{vars.nome}})"
                  className="bg-muted"
                />
              </div>
            )}

            {(op.type === "add_tag" || op.type === "remove_tag") &&
              (tags.length > 0 ? (
                <Select
                  value={op.tag_id ?? ""}
                  onValueChange={(v) => updateOp(i, { ...op, tag_id: v ?? "" })}
                >
                  <SelectTrigger className="bg-muted">
                    <SelectValue placeholder="Escolha uma etiqueta…" />
                  </SelectTrigger>
                  <SelectContent>
                    {tags.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  value={op.tag_id ?? ""}
                  onChange={(e) => updateOp(i, { ...op, tag_id: e.target.value })}
                  placeholder="Tag UUID"
                  className="bg-muted font-mono text-xs"
                />
              ))}

            {op.type === "notify" && (
              <div className="flex flex-col gap-2">
                <Input
                  value={op.message ?? ""}
                  onChange={(e) =>
                    updateOp(i, { ...op, message: e.target.value })
                  }
                  placeholder="Mensagem do aviso (ex.: Lead quente: {{vars.nome}})"
                  className="bg-muted"
                />
                <Select
                  value={op.assign_to ?? ACTION_NOTIFY_ASSIGNEE}
                  onValueChange={(v) =>
                    updateOp(i, {
                      ...op,
                      assign_to:
                        v && v !== ACTION_NOTIFY_ASSIGNEE ? v : undefined,
                    })
                  }
                >
                  <SelectTrigger className="bg-muted">
                    <span className="truncate">
                      {!op.assign_to
                        ? "Responsável da conversa"
                        : members.find((m) => m.user_id === op.assign_to)
                            ?.full_name || "Atendente"}
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ACTION_NOTIFY_ASSIGNEE}>
                      Responsável da conversa
                    </SelectItem>
                    {members.map((m) => (
                      <SelectItem key={m.user_id} value={m.user_id}>
                        {m.full_name || "(sem nome)"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        ))}
      </div>
      <div>
        <Button variant="ghost" size="sm" onClick={addOp}>
          <Plus className="h-3.5 w-3.5" />
          Adicionar ação
        </Button>
      </div>
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Depois avançar para"
      />
    </div>
  );
}

// ============================================================
// Shared no-reply timeout section (send_buttons / send_list /
// collect_input) — the "se o cliente sumir, faz X" path.
// ============================================================

interface TimeoutCfg {
  duration?: { value?: number; unit?: "minutes" | "hours" | "days" };
  timeout_node_key?: string;
}

const TIMEOUT_DEFAULT: TimeoutCfg = {
  duration: { value: 1, unit: "hours" },
  timeout_node_key: "",
};

function TimeoutSection({
  timeout,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  timeout?: TimeoutCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const on = !!timeout;
  const value =
    typeof timeout?.duration?.value === "number" ? timeout.duration.value : 1;
  const unit = timeout?.duration?.unit ?? "hours";
  const unitLabel =
    unit === "days" ? "Dias" : unit === "minutes" ? "Minutos" : "Horas";
  return (
    <div className="rounded-md border border-border bg-muted/40 p-3">
      <label className="flex items-center gap-2 text-xs font-medium text-foreground">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) =>
            onUpdateConfig({
              timeout: e.target.checked ? TIMEOUT_DEFAULT : undefined,
            })
          }
          className="h-3.5 w-3.5 accent-primary"
        />
        Se o cliente não responder em…
      </label>
      {on && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-[10px] text-muted-foreground">
                Tempo
              </label>
              <Input
                type="number"
                min={1}
                value={String(value)}
                onChange={(e) =>
                  onUpdateConfig({
                    timeout: {
                      ...(timeout ?? TIMEOUT_DEFAULT),
                      duration: {
                        value: Math.max(1, Number(e.target.value) || 1),
                        unit,
                      },
                    },
                  })
                }
                className="bg-muted"
              />
            </div>
            <div>
              <label className="mb-1 block text-[10px] text-muted-foreground">
                Unidade
              </label>
              <Select
                value={unit}
                onValueChange={(v) =>
                  onUpdateConfig({
                    timeout: {
                      ...(timeout ?? TIMEOUT_DEFAULT),
                      duration: { value, unit: v },
                    },
                  })
                }
              >
                <SelectTrigger className="bg-muted">
                  <span className="truncate">{unitLabel}</span>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="minutes">Minutos</SelectItem>
                  <SelectItem value="hours">Horas</SelectItem>
                  <SelectItem value="days">Dias</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <NextNodeRow
            value={timeout?.timeout_node_key ?? ""}
            allNodes={allNodes}
            currentKey={currentKey}
            onChange={(v) =>
              onUpdateConfig({
                timeout: { ...(timeout ?? TIMEOUT_DEFAULT), timeout_node_key: v },
              })
            }
            label="…seguir por aqui (caminho “sem resposta”)"
          />
          <p className="text-[10px] text-muted-foreground">
            Prazo contado a partir do envio. Bom para um lembrete ou transferir
            se o cliente sumir. Se ele responder antes, o prazo é cancelado.
            (Verificado a cada ~1 min.)
          </p>
        </div>
      )}
    </div>
  );
}

// ============================================================
// condition
// ============================================================

interface ConditionCfg {
  subject?: "var" | "tag" | "contact_field";
  subject_key?: string;
  operator?: "equals" | "contains" | "present" | "absent";
  value?: string;
  true_next?: string;
  false_next?: string;
}

interface UserTag {
  id: string;
  name: string;
  color?: string;
}

function ConditionForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: ConditionCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const tags = useUserTags();

  const subject = cfg.subject ?? "var";
  const operator = cfg.operator ?? "equals";
  const showValue = operator === "equals" || operator === "contains";

  return (
    <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Se</label>
          <Select
            value={subject}
            onValueChange={(v) =>
              onUpdateConfig({ subject: v as ConditionCfg["subject"] })
            }
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="var">Variável capturada</SelectItem>
              <SelectItem value="tag">Contato tem a etiqueta</SelectItem>
              <SelectItem value="contact_field">Campo do contato</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="md:col-span-2">
          <label className="mb-1 block text-xs text-muted-foreground">
            {subject === "var"
              ? "nome da variável"
              : subject === "tag"
                ? "Etiqueta"
                : "Campo"}
          </label>
          {subject === "tag" && tags.length > 0 ? (
            <Select
              value={cfg.subject_key ?? ""}
              onValueChange={(v) => onUpdateConfig({ subject_key: v })}
            >
              <SelectTrigger className="bg-muted">
                <SelectValue placeholder="Escolha uma etiqueta…" />
              </SelectTrigger>
              <SelectContent>
                {tags.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : subject === "contact_field" ? (
            <Select
              value={cfg.subject_key ?? ""}
              onValueChange={(v) => onUpdateConfig({ subject_key: v })}
            >
              <SelectTrigger className="bg-muted">
                <SelectValue placeholder="Escolha um campo…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="name">nome</SelectItem>
                <SelectItem value="email">email</SelectItem>
                <SelectItem value="phone">telefone</SelectItem>
                <SelectItem value="company">empresa</SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={cfg.subject_key ?? ""}
              onChange={(e) =>
                onUpdateConfig({ subject_key: e.target.value })
              }
              placeholder={subject === "var" ? "ex.: email" : "tag UUID"}
              className="bg-muted font-mono text-xs"
            />
          )}
        </div>
      </div>

      <div
        className={cn(
          "grid grid-cols-1 gap-3",
          showValue ? "md:grid-cols-2" : "",
        )}
      >
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Operador</label>
          <Select
            value={operator}
            onValueChange={(v) =>
              onUpdateConfig({ operator: v as ConditionCfg["operator"] })
            }
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="present">está presente</SelectItem>
              <SelectItem value="absent">está ausente</SelectItem>
              <SelectItem value="equals">é igual a</SelectItem>
              <SelectItem value="contains">contém</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {showValue && (
          <div>
            <label className="mb-1 block text-xs text-muted-foreground">Valor</label>
            <Input
              value={cfg.value ?? ""}
              onChange={(e) => onUpdateConfig({ value: e.target.value })}
              className="bg-muted"
            />
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <NextNodeRow
          value={cfg.true_next ?? ""}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => onUpdateConfig({ true_next: v })}
          label="Se verdadeiro → avançar para"
        />
        <NextNodeRow
          value={cfg.false_next ?? ""}
          allNodes={allNodes}
          currentKey={currentKey}
          onChange={(v) => onUpdateConfig({ false_next: v })}
          label="Se falso → avançar para"
        />
      </div>
    </>
  );
}

// ============================================================
// set_tag
// ============================================================

interface SetTagCfg {
  mode?: "add" | "remove";
  tag_id?: string;
  next_node_key?: string;
}

function SetTagForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: SetTagCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const tags = useUserTags();

  return (
    <>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Ação</label>
          <Select
            value={cfg.mode ?? "add"}
            onValueChange={(v) =>
              onUpdateConfig({ mode: v as SetTagCfg["mode"] })
            }
          >
            <SelectTrigger className="bg-muted">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="add">Adicionar etiqueta</SelectItem>
              <SelectItem value="remove">Remover etiqueta</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">Etiqueta</label>
          {tags.length > 0 ? (
            <Select
              value={cfg.tag_id ?? ""}
              onValueChange={(v) => onUpdateConfig({ tag_id: v })}
            >
              <SelectTrigger className="bg-muted">
                <SelectValue placeholder="Escolha uma etiqueta…" />
              </SelectTrigger>
              <SelectContent>
                {tags.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    {t.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Input
              value={cfg.tag_id ?? ""}
              onChange={(e) => onUpdateConfig({ tag_id: e.target.value })}
              placeholder="Tag UUID"
              className="bg-muted font-mono text-xs"
            />
          )}
        </div>
      </div>
      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Depois avançar para"
      />
    </>
  );
}

/**
 * Shared loader for both `condition` (subject=tag) and `set_tag`.
 * Falls back to raw UUID input if the endpoint is absent on older
 * deployments — the form remains authorable in that case.
 */
function useUserTags(): UserTag[] {
  const [tags, setTags] = useState<UserTag[]>([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/tags").catch(() => null);
        if (!res || !res.ok) return;
        const json = (await res.json()) as { tags?: UserTag[] };
        if (!cancelled) setTags(json.tags ?? []);
      } catch {
        // Tags endpoint absent — caller falls back to raw input.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return tags;
}

// ============================================================
// send_media
// ============================================================

interface SendMediaCfg {
  media_type?: "image" | "video" | "document";
  media_url?: string;
  caption?: string;
  filename?: string;
  next_node_key?: string;
}

// Mirrors the bucket's allowed_mime_types from migration 016. Kept in
// sync with the storage policy so the picker rejects unsupported files
// before they hit the network rather than failing with a confusing
// Supabase RLS / mime-type error.
const MEDIA_ACCEPT: Record<NonNullable<SendMediaCfg["media_type"]>, string> = {
  image: "image/png,image/jpeg,image/webp",
  video: "video/mp4,video/3gpp",
  document:
    "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,text/plain",
};

const FLOW_MEDIA_BUCKET = "flow-media";

function SendMediaForm({
  cfg,
  allNodes,
  currentKey,
  onUpdateConfig,
}: {
  cfg: SendMediaCfg;
  allNodes: BuilderNode[];
  currentKey: string;
  onUpdateConfig: (patch: Record<string, unknown>) => void;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const mediaType = cfg.media_type ?? "image";
  const isDocument = mediaType === "document";
  const displayName =
    cfg.filename ||
    (cfg.media_url ? cfg.media_url.split("/").pop() ?? "" : "");

  const handleFile = useCallback(
    async (file: File) => {
      if (file.size > MEDIA_MAX_BYTES) {
        toast.error(
          `O arquivo tem ${(file.size / 1024 / 1024).toFixed(1)} MB — o limite é 16 MB.`,
        );
        return;
      }
      setUploading(true);
      try {
        // Account-scoped upload (path `account-<id>/...`) — see
        // uploadAccountMedia + migration 020's flow-media RLS policy.
        const { publicUrl } = await uploadAccountMedia(FLOW_MEDIA_BUCKET, file);
        // Patch all fields in one call so the form doesn't re-render
        // with a half-uploaded state.
        onUpdateConfig({
          media_url: publicUrl,
          filename: file.name,
        });
        toast.success("Arquivo enviado.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Falha no envio.";
        toast.error(msg);
      } finally {
        setUploading(false);
      }
    },
    [onUpdateConfig],
  );

  const handleClear = () => {
    onUpdateConfig({ media_url: "", filename: "" });
  };

  return (
    <>
      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Tipo de mídia</label>
        <Select
          value={mediaType}
          onValueChange={(v) => {
            // Changing type clears the existing file — the bucket
            // accepts different MIME sets per type and a previously
            // uploaded PDF can't be sent as an image.
            onUpdateConfig({
              media_type: v as NonNullable<SendMediaCfg["media_type"]>,
              media_url: "",
              filename: "",
            });
          }}
        >
          <SelectTrigger className="bg-muted">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="image">Imagem (PNG, JPEG, WebP)</SelectItem>
            <SelectItem value="video">Vídeo (MP4, 3GP)</SelectItem>
            <SelectItem value="document">
              Documento (PDF, Word, Excel, PowerPoint, TXT)
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <label className="mb-1 block text-xs text-muted-foreground">Arquivo</label>
        {cfg.media_url ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs">
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
            <a
              href={cfg.media_url}
              target="_blank"
              rel="noopener noreferrer"
              className="min-w-0 flex-1 truncate text-foreground hover:text-cyan-300"
              title={displayName || cfg.media_url}
            >
              {displayName || cfg.media_url}
            </a>
            <button
              type="button"
              onClick={handleClear}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Remover arquivo"
              disabled={uploading}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card px-3 py-4 text-xs text-muted-foreground transition-colors hover:border-border hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
          >
            {uploading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Enviando…
              </>
            ) : (
              <>
                <Upload className="h-3.5 w-3.5" />
                Clique para enviar (máx. 16 MB)
              </>
            )}
          </button>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept={MEDIA_ACCEPT[mediaType]}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            // Reset so picking the same file twice still fires onChange.
            e.target.value = "";
          }}
        />
      </div>

      <TextRow
        label="Legenda (opcional, exibida abaixo da mídia)"
        value={cfg.caption ?? ""}
        onChange={(v) => onUpdateConfig({ caption: v })}
        rows={2}
      />

      {isDocument && (
        <div>
          <label className="mb-1 block text-xs text-muted-foreground">
            Nome do arquivo exibido ao cliente (apenas documentos)
          </label>
          <Input
            value={cfg.filename ?? ""}
            onChange={(e) => onUpdateConfig({ filename: e.target.value })}
            placeholder="nota-fiscal.pdf"
            className="bg-muted text-xs"
          />
        </div>
      )}

      <NextNodeRow
        value={cfg.next_node_key ?? ""}
        allNodes={allNodes}
        currentKey={currentKey}
        onChange={(v) => onUpdateConfig({ next_node_key: v })}
        label="Após enviar, avançar para"
      />
    </>
  );
}

"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { listApprovedTemplates } from "@/app/(dashboard)/inbox/actions";
import type { MessageTemplate, TemplateButton } from "@/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft,
  ChevronRight,
  LayoutTemplate,
  Loader2,
  Phone,
  ExternalLink,
  Reply,
  Copy,
  Image as ImageIcon,
  FileText,
  Video,
} from "lucide-react";
import { extractVariableIndices } from "@/lib/whatsapp/template-validators";

export interface TemplateSendValues {
  body: string[];
  headerText?: string;
  buttonParams?: Record<number, string>;
}

interface TemplatePickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (template: MessageTemplate, values: TemplateSendValues) => void;
  /** Contato-alvo — usado para pré-preencher o {{1}} do corpo com o primeiro
   *  nome e para nomear o topo do mockup de celular. */
  contactName?: string | null;
}

function renderBodyPreview(body: string, params: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const idx = Number(raw) - 1;
    const value = params[idx];
    return value && value.trim().length > 0 ? value : `{{${raw}}}`;
  });
}

// Primeiro nome, para o auto-preenchimento amigável do {{1}} ("Oi João").
function firstNameOf(name?: string | null): string {
  return (name ?? "").trim().split(/\s+/)[0] ?? "";
}

// ------------------------------------------------------------
// Formatação estilo WhatsApp para a PRÉVIA: *negrito*, _itálico_,
// ~tachado~, ```mono``` e destaque das variáveis {{n}} ainda vazias.
// (Só visual — o texto enviado à Meta continua o cru.)
// ------------------------------------------------------------
function formatWhatsApp(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const regex = /(\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|```[^`]+```|\{\{\d+\}\})/g;
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("```")) {
      nodes.push(
        <code key={key++} className="rounded bg-black/25 px-1 font-mono text-[11px]">
          {tok.slice(3, -3)}
        </code>,
      );
    } else if (tok.startsWith("*")) {
      nodes.push(<strong key={key++}>{tok.slice(1, -1)}</strong>);
    } else if (tok.startsWith("_")) {
      nodes.push(<em key={key++}>{tok.slice(1, -1)}</em>);
    } else if (tok.startsWith("~")) {
      nodes.push(<s key={key++}>{tok.slice(1, -1)}</s>);
    } else {
      // Variável ainda não preenchida — realça em âmbar para saltar aos olhos.
      nodes.push(
        <span
          key={key++}
          className="rounded bg-amber-400/25 px-1 font-medium text-amber-200"
        >
          {tok}
        </span>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function ButtonIcon({ type }: { type: TemplateButton["type"] }) {
  const cls = "h-3.5 w-3.5 flex-shrink-0";
  if (type === "URL") return <ExternalLink className={cls} />;
  if (type === "PHONE_NUMBER") return <Phone className={cls} />;
  if (type === "COPY_CODE") return <Copy className={cls} />;
  return <Reply className={cls} />;
}

// ------------------------------------------------------------
// Mockup de celular (estilo WhatsApp) com a prévia ao vivo do template,
// como o CLIENTE recebe: bolha recebida, header/mídia, rodapé e botões.
// Cores fixas do WhatsApp (não seguem o tema do app — é uma "tela de celular").
// ------------------------------------------------------------
function TemplatePhonePreview({
  template,
  bodyParams,
  headerText,
  contactName,
}: {
  template: MessageTemplate;
  bodyParams: string[];
  headerText: string;
  contactName?: string | null;
}) {
  const body = renderBodyPreview(template.body_text, bodyParams);
  const headerTextResolved =
    template.header_type === "text" && template.header_content
      ? template.header_content.replace(
          /\{\{1\}\}/g,
          headerText.trim() || "{{1}}",
        )
      : null;
  const mediaType =
    template.header_type && template.header_type !== "text"
      ? template.header_type
      : null;
  const buttons = template.buttons ?? [];
  const initial = (contactName ?? "").trim().charAt(0).toUpperCase() || "?";

  return (
    <div className="mx-auto w-full max-w-[264px]">
      <div className="overflow-hidden rounded-[1.9rem] border-[7px] border-neutral-900 bg-[#0b141a] shadow-xl">
        {/* Barra superior do WhatsApp */}
        <div className="flex items-center gap-2 bg-[#008069] px-3 py-2 text-white">
          <ArrowLeft className="h-4 w-4 opacity-90" />
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/25 text-[11px] font-semibold">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-xs font-medium leading-tight">
              {contactName?.trim() || "Contato"}
            </p>
            <p className="text-[9px] leading-tight text-white/70">online</p>
          </div>
        </div>

        {/* Área da conversa */}
        <div className="min-h-[220px] space-y-1.5 bg-[#0b141a] px-2.5 py-3">
          <div className="flex justify-start">
            <div className="relative max-w-[88%] rounded-lg rounded-tl-sm bg-[#202c33] px-2.5 py-1.5 text-[12px] leading-snug text-neutral-100 shadow">
              {mediaType && (
                <div className="mb-1.5 flex h-20 flex-col items-center justify-center gap-1 rounded bg-black/30 text-neutral-400">
                  {mediaType === "image" && <ImageIcon className="h-6 w-6" />}
                  {mediaType === "video" && <Video className="h-6 w-6" />}
                  {mediaType === "document" && <FileText className="h-6 w-6" />}
                  <span className="text-[9px] uppercase tracking-wide">
                    {mediaType === "image"
                      ? "Imagem"
                      : mediaType === "video"
                        ? "Vídeo"
                        : "Documento"}
                  </span>
                </div>
              )}
              {headerTextResolved && (
                <p className="mb-1 font-semibold">
                  {formatWhatsApp(headerTextResolved)}
                </p>
              )}
              <p className="whitespace-pre-wrap break-words">
                {formatWhatsApp(body)}
              </p>
              {template.footer_text && (
                <p className="mt-1 text-[11px] text-neutral-400">
                  {template.footer_text}
                </p>
              )}
              <span className="mt-0.5 block text-right text-[9px] text-neutral-400">
                12:00
              </span>
            </div>
          </div>

          {/* Botões do template (abaixo da bolha, como no WhatsApp) */}
          {buttons.length > 0 && (
            <div className="flex justify-start">
              <div className="w-[88%] overflow-hidden rounded-lg bg-[#202c33] text-[12px] font-medium">
                {buttons.map((b, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-center gap-1.5 border-t border-white/10 py-2 text-[#00a5f4] first:border-t-0"
                  >
                    <ButtonIcon type={b.type} />
                    <span className="truncate">{b.text}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface UrlButtonSlot {
  index: number;
  text: string;
  url: string;
}

/**
 * Templates may need values for: body variables, a text-header
 * variable, and per-URL-button suffixes. Collect them all so the
 * send-message path doesn't 400 on missing parameters.
 */
function collectVariableSlots(template: MessageTemplate): {
  bodyVars: number[];
  headerVarCount: number;
  urlButtonSlots: UrlButtonSlot[];
} {
  const bodyVars = extractVariableIndices(template.body_text);
  const headerVarCount =
    template.header_type === "text" && template.header_content
      ? extractVariableIndices(template.header_content).length
      : 0;
  const urlButtonSlots: UrlButtonSlot[] = [];
  (template.buttons ?? []).forEach((b, i) => {
    if (b.type === "URL" && extractVariableIndices(b.url).length > 0) {
      urlButtonSlots.push({ index: i, text: b.text, url: b.url });
    }
  });
  return { bodyVars, headerVarCount, urlButtonSlots };
}

export function TemplatePicker({
  open,
  onOpenChange,
  onSelect,
  contactName,
}: TemplatePickerProps) {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<MessageTemplate | null>(null);
  const [params, setParams] = useState<string[]>([]);
  const [headerText, setHeaderText] = useState<string>("");
  const [buttonParams, setButtonParams] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    (async () => {
      setLoading(true);
      // Templates are account-owned; the server action derives the caller's
      // account from getCurrentAccount() and returns every APPROVED template
      // in it — so a teammate's approved templates are visible too.
      try {
        const data = await listApprovedTemplates();
        if (cancelled) return;
        setTemplates(data);
      } catch (error) {
        if (cancelled) return;
        console.error("Failed to fetch templates:", error);
        setTemplates([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open]);

  function resetSelection() {
    setSelected(null);
    setParams([]);
    setHeaderText("");
    setButtonParams({});
  }

  function handleOpenChange(next: boolean) {
    if (!next) resetSelection();
    onOpenChange(next);
  }

  function pickTemplate(template: MessageTemplate) {
    const slots = collectVariableSlots(template);
    const noInputsNeeded =
      slots.bodyVars.length === 0 &&
      slots.headerVarCount === 0 &&
      slots.urlButtonSlots.length === 0;
    if (noInputsNeeded) {
      onSelect(template, { body: [] });
      handleOpenChange(false);
      return;
    }
    setSelected(template);
    // Auto-preenche o {{1}} do corpo com o primeiro nome do contato (a
    // saudação "Oi {{1}}" é quase sempre o nome). Editável. As demais
    // variáveis ({{2}}+) são dados que o CRM não conhece → ficam em branco.
    const initial = new Array(slots.bodyVars.length).fill("");
    const first = firstNameOf(contactName);
    if (slots.bodyVars.length > 0 && slots.bodyVars[0] === 1 && first) {
      initial[0] = first;
    }
    setParams(initial);
    setHeaderText("");
    setButtonParams({});
  }

  function confirm() {
    if (!selected) return;
    const values: TemplateSendValues = { body: params };
    if (headerText.trim()) values.headerText = headerText.trim();
    if (Object.keys(buttonParams).length > 0) {
      values.buttonParams = Object.fromEntries(
        Object.entries(buttonParams).map(([k, v]) => [Number(k), v.trim()]),
      );
    }
    onSelect(selected, values);
    handleOpenChange(false);
  }

  const slots = useMemo(
    () => (selected ? collectVariableSlots(selected) : null),
    [selected],
  );
  const canConfirm =
    !!selected &&
    !!slots &&
    slots.bodyVars.every((_, i) => (params[i] ?? "").trim().length > 0) &&
    (slots.headerVarCount === 0 || headerText.trim().length > 0) &&
    slots.urlButtonSlots.every(
      (s) => (buttonParams[s.index] ?? "").trim().length > 0,
    );

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className={
          selected
            ? "border-border bg-popover sm:max-w-3xl"
            : "border-border bg-popover sm:max-w-lg"
        }
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-popover-foreground">
            <LayoutTemplate className="h-4 w-4 text-primary" />
            {selected ? selected.name : "Enviar template"}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {selected
              ? "Preencha os campos para montar este template. A Meta exige que toda variável seja definida."
              : "Escolha um template aprovado do WhatsApp para enviar a este contato."}
          </DialogDescription>
        </DialogHeader>

        {!selected ? (
          <div className="max-h-[60vh] space-y-2 overflow-y-auto">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              </div>
            ) : templates.length === 0 ? (
              <div className="rounded-md border border-border bg-background/50 p-6 text-center">
                <p className="text-sm text-popover-foreground">Nenhum template aprovado</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Aprove um template no Meta WhatsApp Manager e depois
                  sincronize em Configurações → Templates.
                </p>
              </div>
            ) : (
              templates.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => pickTemplate(t)}
                  className="w-full rounded-md border border-border bg-background/50 p-3 text-left transition-colors hover:border-primary/40 hover:bg-popover"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-popover-foreground">
                          {t.name}
                        </p>
                        <Badge className="border border-primary/30 bg-primary/20 text-[10px] text-primary">
                          {t.category}
                        </Badge>
                        {t.language && (
                          <span className="text-[10px] uppercase text-muted-foreground">
                            {t.language}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                        {t.body_text}
                      </p>
                    </div>
                    <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                  </div>
                </button>
              ))
            )}
          </div>
        ) : (
          <div className="grid gap-4 md:grid-cols-[264px_minmax(0,1fr)]">
            {/* Mockup de celular — em cima no mobile, à esquerda no desktop */}
            <div className="order-first">
              <TemplatePhonePreview
                template={selected}
                bodyParams={params}
                headerText={headerText}
                contactName={contactName}
              />
            </div>

            {/* Campos das variáveis */}
            <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
              {slots && slots.headerVarCount > 0 && (
                <div className="space-y-1">
                  <Label className="text-xs text-popover-foreground">
                    {`Cabeçalho {{1}}`}
                  </Label>
                  <Input
                    value={headerText}
                    onChange={(e) => setHeaderText(e.target.value)}
                    placeholder="Valor da variável do cabeçalho"
                    className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                  />
                </div>
              )}
              {slots?.bodyVars.map((v, i) => (
                <div key={v} className="space-y-1">
                  <Label className="text-xs text-popover-foreground">{`Corpo {{${v}}}`}</Label>
                  <Input
                    value={params[i] ?? ""}
                    onChange={(e) => {
                      const next = [...params];
                      next[i] = e.target.value;
                      setParams(next);
                    }}
                    placeholder={`Valor para {{${v}}}`}
                    className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                  />
                </div>
              ))}
              {slots?.urlButtonSlots.map((slot) => (
                <div key={slot.index} className="space-y-1">
                  <Label className="text-xs text-popover-foreground">
                    {`Botão de URL "${slot.text}" — valor para `}{`{{1}}`}
                  </Label>
                  <Input
                    value={buttonParams[slot.index] ?? ""}
                    onChange={(e) =>
                      setButtonParams((prev) => ({
                        ...prev,
                        [slot.index]: e.target.value,
                      }))
                    }
                    placeholder="Valor do sufixo da URL"
                    className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
                  />
                  <p className="text-[10px] text-muted-foreground break-all">
                    URL final: {slot.url.replace(/\{\{1\}\}/g, buttonParams[slot.index] || "{{1}}")}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        <DialogFooter className="gap-2">
          {selected ? (
            <>
              <Button
                variant="outline"
                onClick={resetSelection}
                className="border-border text-popover-foreground hover:bg-muted"
              >
                <ArrowLeft className="h-4 w-4" />
                Voltar
              </Button>
              <Button
                disabled={!canConfirm}
                onClick={confirm}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                Enviar template
              </Button>
            </>
          ) : (
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              className="border-border text-popover-foreground hover:bg-muted"
            >
              Cancelar
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

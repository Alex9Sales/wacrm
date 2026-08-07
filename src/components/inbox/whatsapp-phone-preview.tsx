"use client";

import { type ReactNode } from "react";
import type { MessageTemplate, TemplateButton } from "@/types";
import {
  ArrowLeft,
  Phone,
  ExternalLink,
  Reply,
  Copy,
  Image as ImageIcon,
  FileText,
  Video,
} from "lucide-react";

// Substitui {{n}} pelos valores dados; deixa {{n}} cru quando o valor está
// vazio (a prévia então realça a variável faltante).
export function substituteVars(text: string, values: string[]): string {
  return text.replace(/\{\{(\d+)\}\}/g, (_, raw) => {
    const v = values[Number(raw) - 1];
    return v && v.trim().length > 0 ? v : `{{${raw}}}`;
  });
}

// ------------------------------------------------------------
// Formatação estilo WhatsApp para a PRÉVIA: *negrito*, _itálico_,
// ~tachado~, ```mono``` e destaque das variáveis {{n}} ainda vazias.
// (Só visual — o texto real do template continua o cru.)
// ------------------------------------------------------------
export function formatWhatsApp(text: string): ReactNode[] {
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

export type PhoneHeaderType = MessageTemplate["header_type"] | "none";

interface WhatsAppPhonePreviewProps {
  /** Nome no topo do celular (contato-alvo). Default "Contato". */
  contactName?: string | null;
  headerType?: PhoneHeaderType;
  /** Texto do cabeçalho já resolvido (quando headerType === "text"). */
  headerText?: string | null;
  /** Corpo já resolvido (variáveis substituídas ou cruas p/ realce). */
  bodyText: string;
  footerText?: string | null;
  buttons?: TemplateButton[];
}

// ------------------------------------------------------------
// Mockup de celular (estilo WhatsApp) com a prévia ao vivo, como o
// CLIENTE recebe: bolha recebida, header de mídia/texto, rodapé e botões.
// Cores fixas do WhatsApp (não seguem o tema do app — é uma "tela de celular").
// ------------------------------------------------------------
export function WhatsAppPhonePreview({
  contactName,
  headerType = "none",
  headerText,
  bodyText,
  footerText,
  buttons = [],
}: WhatsAppPhonePreviewProps) {
  const mediaType =
    headerType && headerType !== "text" && headerType !== "none"
      ? headerType
      : null;
  const initial = (contactName ?? "").trim().charAt(0).toUpperCase() || "?";
  const hasBody = bodyText.trim().length > 0;

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
              {headerType === "text" && headerText && headerText.trim() && (
                <p className="mb-1 font-semibold">
                  {formatWhatsApp(headerText)}
                </p>
              )}
              {hasBody ? (
                <p className="whitespace-pre-wrap break-words">
                  {formatWhatsApp(bodyText)}
                </p>
              ) : (
                <p className="italic text-neutral-500">
                  Digite o texto do corpo…
                </p>
              )}
              {footerText && footerText.trim() && (
                <p className="mt-1 text-[11px] text-neutral-400">{footerText}</p>
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
                    <span className="truncate">{b.text?.trim() || "Botão"}</span>
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

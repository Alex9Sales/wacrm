// ============================================================
// Suporte — dispara o alerta de um chamado no WhatsApp da Fluxia.
// Server-only.
//
// Remetente: um canal DA FLUXIA (env PLATFORM_SUPPORT_CHANNEL_ID, com
// fallback pro canal de cobrança PLATFORM_BILLING_CHANNEL_ID). Destino:
// env PLATFORM_SUPPORT_ALERT_TO (fallback pro número oficial da Fluxia
// 556791806048 — o mesmo que os clientes já usam).
//
// Best-effort: NUNCA lança. Devolve {sent, error?} pra rota decidir se
// grava alerted_at. O chamado já foi registrado antes de chamar isto, então
// uma falha de WhatsApp não perde o chamado — só não notifica.
// ============================================================

import { loadChannel } from "@/lib/channels/channels";
import { getProvider } from "@/lib/channels/registry";
import {
  TICKET_TYPE_LABEL,
  type SupportContext,
  type SupportTicketType,
} from "./types";

/** Número oficial da Fluxia (destino padrão). Só dígitos, E.164 sem +. */
const DEFAULT_SUPPORT_TO = "556791806048";

export interface SupportAlertInput {
  ticketId: string;
  type: SupportTicketType;
  subject: string;
  description: string | null;
  screenshotUrls: string[];
  context: SupportContext;
  /** WhatsApp do cliente (só dígitos) — pra equipe responder direto. */
  whatsapp?: string | null;
}

/** Monta a mensagem pt-BR do alerta com todo o contexto do chamado. */
function composeAlert(t: SupportAlertInput): string {
  const lines: string[] = [];
  lines.push(`🆘 *Novo chamado de suporte* — ${TICKET_TYPE_LABEL[t.type]}`);
  lines.push("");
  if (t.context.orgName) lines.push(`*Cliente:* ${t.context.orgName}`);
  const who = [t.context.userName, t.context.userEmail]
    .filter(Boolean)
    .join(" · ");
  if (who) lines.push(`*Aberto por:* ${who}`);
  if (t.whatsapp) lines.push(`*WhatsApp:* ${t.whatsapp}`);
  lines.push(`*Assunto:* ${t.subject}`);
  if (t.description && t.description.trim()) {
    lines.push("");
    lines.push(t.description.trim());
  }
  lines.push("");
  if (t.context.url) lines.push(`*Tela:* ${t.context.url}`);
  if (t.context.userAgent) lines.push(`*Navegador:* ${t.context.userAgent}`);
  if (t.screenshotUrls.length > 0) {
    lines.push(`*Prints:* ${t.screenshotUrls.length} anexo(s) abaixo 👇`);
  }
  lines.push("");
  lines.push(`_id: ${t.ticketId}_`);
  return lines.join("\n");
}

export interface SupportAlertResult {
  sent: boolean;
  error?: string;
}

/**
 * Envia o alerta do chamado (texto + prints) no WhatsApp da Fluxia.
 * Best-effort — captura toda exceção.
 */
export async function sendSupportAlert(
  input: SupportAlertInput,
): Promise<SupportAlertResult> {
  try {
    const channelId =
      process.env.PLATFORM_SUPPORT_CHANNEL_ID?.trim() ||
      process.env.PLATFORM_BILLING_CHANNEL_ID?.trim();
    if (!channelId) {
      return {
        sent: false,
        error:
          "Configure PLATFORM_SUPPORT_CHANNEL_ID (ou PLATFORM_BILLING_CHANNEL_ID) para alertar no WhatsApp.",
      };
    }

    const to =
      process.env.PLATFORM_SUPPORT_ALERT_TO?.replace(/\D/g, "").trim() ||
      DEFAULT_SUPPORT_TO;

    const channel = await loadChannel(channelId);
    if (!channel) {
      return {
        sent: false,
        error: "Canal de suporte da Fluxia não encontrado (id inválido).",
      };
    }

    const provider = getProvider(channel.provider);

    // 1) Texto com todo o contexto.
    await provider.sendText(channel, to, composeAlert(input));

    // 2) Cada print como imagem (o cliente vê o erro que o cliente reportou).
    //    Falha num print não derruba o alerta — o texto já saiu.
    for (const url of input.screenshotUrls.slice(0, 6)) {
      try {
        await provider.sendMedia(channel, to, {
          kind: "image",
          url,
          mimetype: "image/png",
          caption: input.subject.slice(0, 120),
        });
      } catch (err) {
        console.error("[support/alert] screenshot send failed:", err);
      }
    }

    return { sent: true };
  } catch (err) {
    console.error("[support/alert] send failed:", err);
    return {
      sent: false,
      error: err instanceof Error ? err.message : "Falha ao enviar alerta.",
    };
  }
}

// ============================================================
// Aviso AO CLIENTE quando o chamado é resolvido.
//
// Sai pelo MESMO número da Fluxia que já recebe os chamados — é o número
// que o cliente conhece. Best-effort: nunca lança e nunca impede o chamado
// de virar 'resolvido'. Quem chama grava client_notified_at no sucesso,
// que serve de trava contra aviso repetido (reabrir + resolver de novo).
// ============================================================

export interface TicketResolvedInput {
  /** WhatsApp do cliente, só dígitos com DDI. */
  to: string;
  subject: string;
  /** Primeiro nome de quem abriu (opcional — deixa a mensagem humana). */
  clientName?: string | null;
  /** O que foi feito (opcional). */
  resolutionNote?: string | null;
}

/** Mensagem pt-BR de "seu chamado foi resolvido". */
function composeResolved(input: TicketResolvedInput): string {
  const first = (input.clientName ?? "").trim().split(/\s+/)[0] ?? "";
  const hi = first ? `Oi, ${first}!` : "Oi!";
  const lines: string[] = [];
  lines.push(`${hi} 😊 Seu chamado no Fluxia foi resolvido:`);
  lines.push("");
  lines.push(`*${input.subject.trim()}*`);
  const note = input.resolutionNote?.trim();
  if (note) {
    lines.push("");
    lines.push(note);
  }
  lines.push("");
  lines.push(
    "Pode conferir aí e, se ainda estiver acontecendo, é só responder esta mensagem que a gente volta nele. 🙏",
  );
  return lines.join("\n");
}

/** Avisa o cliente no WhatsApp que o chamado dele foi resolvido. */
export async function sendTicketResolvedToClient(
  input: TicketResolvedInput,
): Promise<SupportAlertResult> {
  try {
    const to = input.to.replace(/\D/g, "");
    if (to.length < 12) {
      return { sent: false, error: "WhatsApp do cliente inválido." };
    }
    const channelId =
      process.env.PLATFORM_SUPPORT_CHANNEL_ID?.trim() ||
      process.env.PLATFORM_BILLING_CHANNEL_ID?.trim();
    if (!channelId) {
      return { sent: false, error: "Canal de suporte da Fluxia não configurado." };
    }
    const channel = await loadChannel(channelId);
    if (!channel) {
      return { sent: false, error: "Canal de suporte não encontrado." };
    }
    await getProvider(channel.provider).sendText(
      channel,
      to,
      composeResolved(input),
    );
    return { sent: true };
  } catch (err) {
    console.error("[support/alert] aviso de resolução falhou:", err);
    return {
      sent: false,
      error: err instanceof Error ? err.message : "Falha ao avisar o cliente.",
    };
  }
}

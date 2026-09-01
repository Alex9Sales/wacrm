// ============================================================
// Suporte — tipos + rótulos compartilhados (cliente e servidor).
// Client-safe: NÃO importa nada server-only. Espelha os enums de
// support_tickets (migração 0083).
// ============================================================

export type SupportTicketType = "question" | "config" | "problem";
export type SupportTicketStatus = "open" | "in_progress" | "resolved";

export const SUPPORT_TICKET_TYPES: SupportTicketType[] = [
  "question",
  "config",
  "problem",
];

export const TICKET_TYPE_LABEL: Record<SupportTicketType, string> = {
  question: "Dúvida",
  config: "Ajuda com configuração",
  problem: "Problema / Bug",
};

/** Texto curto de apoio exibido em cada tipo no formulário. */
export const TICKET_TYPE_HINT: Record<SupportTicketType, string> = {
  question: "Uma pergunta sobre como usar o Fluxia.",
  config: "Ajuda pra configurar algo (canal, IA, funil…).",
  problem: "Algo com erro ou travando — mande o print.",
};

export const TICKET_STATUS_LABEL: Record<SupportTicketStatus, string> = {
  open: "Aberto",
  in_progress: "Em andamento",
  resolved: "Resolvido",
};

export function isSupportTicketType(v: unknown): v is SupportTicketType {
  return v === "question" || v === "config" || v === "problem";
}

export function isSupportTicketStatus(v: unknown): v is SupportTicketStatus {
  return v === "open" || v === "in_progress" || v === "resolved";
}

/** Contexto automático coletado no navegador do cliente + enriquecido no
 *  servidor. Tudo opcional — é diagnóstico, não formulário. */
export interface SupportContext {
  /** URL/tela onde o cliente estava ao abrir o chamado. */
  url?: string;
  userAgent?: string;
  language?: string;
  viewport?: string;
  referrer?: string;
  /** Preenchidos no servidor (autoritativos). */
  orgName?: string;
  userName?: string;
  userEmail?: string;
}

/** Chamado serializado para as respostas de API (cliente e admin). */
export interface SupportTicketDTO {
  id: string;
  type: SupportTicketType;
  subject: string;
  description: string | null;
  screenshotUrls: string[];
  context: SupportContext;
  status: SupportTicketStatus;
  alertedAt: string | null;
  /** WhatsApp do cliente (só dígitos) — por onde avisamos ao resolver. */
  whatsapp: string | null;
  /** O que foi feito, escrito por quem resolveu. Vai no aviso ao cliente. */
  resolutionNote: string | null;
  /** Quando o cliente foi avisado da resolução (trava contra aviso repetido). */
  clientNotifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Telefone BR digitado de qualquer jeito → só dígitos com DDI 55. */
export function normalizeSupportWhatsapp(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let d = raw.replace(/\D/g, "");
  if (!d) return null;
  // Sem DDI: 10 (fixo) ou 11 (celular) dígitos = número BR → prefixa 55.
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  // 12–13 já vem com DDI. Fora disso não é telefone válido pra nós.
  if (d.length < 12 || d.length > 13) return null;
  return d;
}

/** Linha do setor Suporte no /admin — o chamado + de quem/qual org veio. */
export interface AdminSupportTicketDTO extends SupportTicketDTO {
  org: { id: string; name: string } | null;
  createdByUser: { name: string; email: string } | null;
}

export interface SupportOverview {
  open: number;
  inProgress: number;
  resolved: number;
  total: number;
}

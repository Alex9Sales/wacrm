// Conversation priority presentation (Chatwoot-style). Single source of
// truth for the label + colours so the card badge, the right-click menu and
// the sidebar all agree. Colours per Alex/Felipe: baixa=azul, média=amarelo,
// alta=laranja, urgente=vermelho.

import type { ConversationPriority } from "@/types";

export interface PriorityMeta {
  label: string;
  /** Badge classes (bg + text) for the small chip on the card / menu. */
  badge: string;
  /** Dot colour class for a bare indicator. */
  dot: string;
}

export const PRIORITY_META: Record<
  Exclude<ConversationPriority, "none">,
  PriorityMeta
> = {
  low: {
    label: "Baixa",
    badge: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
    dot: "bg-sky-500",
  },
  medium: {
    label: "Média",
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
  },
  high: {
    label: "Alta",
    badge: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
    dot: "bg-orange-500",
  },
  urgent: {
    label: "Urgente",
    badge: "bg-red-500/15 text-red-600 dark:text-red-400",
    dot: "bg-red-500",
  },
};

/** Priority pick order for menus (excludes 'none', which is "remove"). */
export const PRIORITY_ORDER: Exclude<ConversationPriority, "none">[] = [
  "low",
  "medium",
  "high",
  "urgent",
];

export function priorityMeta(
  p: ConversationPriority | undefined | null,
): PriorityMeta | null {
  if (!p || p === "none") return null;
  return PRIORITY_META[p];
}

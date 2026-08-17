import { Radio } from "lucide-react";

import type { ChannelProvider } from "@/types";
import { cn } from "@/lib/utils";

// ============================================================
// ChannelBadge — o selinho do canal no card da conversa e no cabeçalho
// do thread. O Instagram ganha o degradê da marca (amarelo→rosa→azul) +
// o glifo da câmera; todos os provedores de WhatsApp (meta/waha/…) usam
// o look neutro. Fonte única do rótulo curto por provedor (pt-BR).
// ============================================================

/** Rótulos curtos por provedor (pt-BR). Compartilhado entre a lista de
 *  conversas e o cabeçalho do thread. */
export const CHANNEL_PROVIDER_LABELS: Record<ChannelProvider, string> = {
  meta: "Meta",
  waha: "WAHA",
  evolution: "Evolution",
  evogo: "EvoGo",
  instagram: "Instagram",
  messenger: "Messenger",
};

/** Glifo do Instagram (câmera em quadrado arredondado) como SVG inline —
 *  esta versão do lucide-react não traz o ícone `Instagram`. Usa
 *  `currentColor` pra herdar o branco por cima do degradê. */
function InstagramGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="2" y="2" width="20" height="20" rx="5" ry="5" />
      <path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" />
      <line x1="17.5" y1="6.5" x2="17.51" y2="6.5" />
    </svg>
  );
}

/** Glifo do Messenger (SVG inline — lucide 1.22 não tem). Branco por cima do azul. */
function MessengerGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M12 0C5.373 0 0 4.974 0 11.111c0 3.498 1.744 6.614 4.469 8.652V24l4.088-2.242c1.092.301 2.246.464 3.443.464 6.627 0 12-4.975 12-11.111C24 4.974 18.627 0 12 0zm1.191 14.963l-3.055-3.26-5.963 3.26L10.732 8l3.131 3.259L19.752 8l-6.561 6.963z" />
    </svg>
  );
}

interface ChannelBadgeProps {
  provider: ChannelProvider;
  /** Nome do canal (ex.: "Fluxia Insta"); cai no rótulo do provedor se vazio. */
  name?: string | null;
  /** `sm` = card da lista; `md` = cabeçalho do thread. */
  size?: "sm" | "md";
  className?: string;
}

export function ChannelBadge({
  provider,
  name,
  size = "sm",
  className,
}: ChannelBadgeProps) {
  const providerLabel = CHANNEL_PROVIDER_LABELS[provider] ?? provider;
  const label = name || providerLabel;

  const iconCls = size === "md" ? "h-3 w-3 shrink-0" : "h-2.5 w-2.5 shrink-0";
  const textCls = size === "md" ? "text-[10px]" : "text-[9px]";
  const maxW = size === "md" ? "max-w-28" : "max-w-16";

  // Cor oficial da marca por provedor (Instagram degradê, Messenger azul);
  // os de WhatsApp ficam no look neutro.
  let bg = "bg-muted text-muted-foreground";
  let glyph = <Radio className={iconCls} />;
  if (provider === "instagram") {
    bg = "bg-gradient-to-tr from-[#feda75] via-[#d62976] to-[#4f5bd5] text-white";
    glyph = <InstagramGlyph className={iconCls} />;
  } else if (provider === "messenger") {
    bg = "bg-gradient-to-br from-[#00C6FF] via-[#0068FF] to-[#A033FF] text-white";
    glyph = <MessengerGlyph className={iconCls} />;
  }

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 font-medium",
        textCls,
        bg,
        className,
      )}
      title={`Canal: ${label} (${providerLabel})`}
    >
      {glyph}
      <span className={cn("truncate", maxW)}>{label}</span>
    </span>
  );
}

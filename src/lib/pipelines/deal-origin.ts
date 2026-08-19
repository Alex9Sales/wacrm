// ============================================================
// Origem do negócio (de onde o lead veio) — lista padrão estruturada.
// Antes "Origem" era texto livre (quase ninguém preenchia); agora é um seletor
// com valores canônicos, então o funil/relatórios podem agrupar e filtrar.
// "Site" resolve o caso de leads de formulário do site (que não têm conversa).
//
// A origem é INFORMATIVA (de onde veio). O CANAL da conversa (WhatsApp/Instagram)
// continua vindo de channel_provider — são coisas diferentes: um lead pode ter
// origem "Site" e você falar com ele por WhatsApp.
// ============================================================

export const DEAL_ORIGINS = [
  "Site",
  "WhatsApp",
  "Instagram",
  "Messenger",
  "Indicação",
  "Campanha",
  "Anúncio",
  "Outro",
] as const;

export type DealOrigin = (typeof DEAL_ORIGINS)[number];

export function isDealOrigin(v: unknown): v is DealOrigin {
  return typeof v === "string" && (DEAL_ORIGINS as readonly string[]).includes(v);
}

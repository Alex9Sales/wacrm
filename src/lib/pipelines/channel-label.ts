// ============================================================
// Rótulo do canal de origem de um negócio, para os botões "Abrir conversa" do
// funil. O botão abre a conversa VINCULADA ao negócio (o canal de onde o lead
// veio), então o texto precisa dizer o canal REAL — não "WhatsApp" fixo (bug do
// Rafael: negócio veio do Instagram, mas o botão dizia WhatsApp e abria o IG).
//
// Instagram e Messenger são distintos; TODOS os provedores de WhatsApp
// (meta/waha/evolution/evogo) caem em "WhatsApp" (é o mesmo canal pro usuário).
// ============================================================

export function dealChannelLabel(provider: string | null | undefined): string {
  const p = (provider || "").toLowerCase();
  if (p === "instagram") return "Instagram";
  if (p === "messenger") return "Messenger";
  return "WhatsApp";
}

/** true quando o canal é Instagram (para escolher o ícone/cor do botão). */
export function isInstagramProvider(provider: string | null | undefined): boolean {
  return (provider || "").toLowerCase() === "instagram";
}

// ============================================================
// Provider registry (Phase 4).
//
// getProvider(id) returns the concrete WhatsAppProvider for a channel.
// All four adapters are implemented; nothing else in the codebase
// references concrete adapters — they all go through getProvider().
// ============================================================

import {
  type ProviderId,
  type WhatsAppProvider,
} from './provider';
import { metaProvider } from './providers/meta';
import { wahaProvider } from './providers/waha';
import { evolutionProvider } from './providers/evolution';
import { evogoProvider } from './providers/evogo';
import { instagramProvider } from './providers/instagram';

const PROVIDERS: Record<ProviderId, WhatsAppProvider> = {
  meta: metaProvider,
  waha: wahaProvider,
  evolution: evolutionProvider,
  evogo: evogoProvider,
  instagram: instagramProvider,
};

/** Resolve the provider implementation for a channel's provider id. */
export function getProvider(id: ProviderId): WhatsAppProvider {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(`Unknown provider "${id}"`);
  }
  return provider;
}

// ============================================================
// Provider registry (Phase 4, wave 1).
//
// getProvider(id) returns the concrete WhatsAppProvider for a channel.
// For THIS wave the registry holds STUB implementations: they expose the
// correct `capabilities` from CAPABILITIES (so capability checks and
// imports typecheck end-to-end) but every send / parse method throws
// "not implemented yet (wave 2)". The real adapters land in wave 2 —
// adding one is a single-line swap of the stub for the import in the
// PROVIDERS map below.
// ============================================================

import {
  CAPABILITIES,
  type ProviderId,
  type WhatsAppProvider,
} from './provider';

/** Build a stub provider that throws on every real operation. */
function makeStub(id: ProviderId): WhatsAppProvider {
  const notYet = (): never => {
    throw new Error(`provider ${id} not implemented yet (wave 2)`);
  };
  return {
    id,
    capabilities: CAPABILITIES[id],
    sendText: notYet,
    sendMedia: notYet,
    // Optional methods are present as stubs too so wave-2 wiring and
    // capability-gated callers have a stable shape to target.
    sendTemplate: notYet,
    sendInteractive: notYet,
    sendReaction: notYet,
    verifyWebhook: notYet,
    parseWebhook: notYet,
    fetchInboundMedia: notYet,
    startSession: notYet,
    getState: notYet,
  };
}

// The one place wave 2 edits: replace `makeStub('meta')` with the real
// `metaProvider`, etc. Nothing else in the codebase references concrete
// adapters — they all go through getProvider().
const PROVIDERS: Record<ProviderId, WhatsAppProvider> = {
  meta: makeStub('meta'),
  waha: makeStub('waha'),
  evolution: makeStub('evolution'),
  evogo: makeStub('evogo'),
};

/** Resolve the provider implementation for a channel's provider id. */
export function getProvider(id: ProviderId): WhatsAppProvider {
  const provider = PROVIDERS[id];
  if (!provider) {
    throw new Error(`Unknown provider "${id}"`);
  }
  return provider;
}

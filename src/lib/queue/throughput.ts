// ============================================================
// Per-channel throughput + jitter defaults (Phase 5 CORE).
//
// Each provider has a safe default send rate (messages/min). The
// official Meta Cloud API tolerates a much higher rate than the
// unofficial QR providers, which risk bans if pushed. A channel can
// override its rate via `channel.settings.throughputPerMin`.
//
// Jitter (a random pre-send delay) only applies to providers whose
// capabilities.needsJitter is true (the non-official ones). The window
// can be overridden per-channel via `channel.settings.jitterMs`.
//
// Next-independent (pure data + a ChannelCtx-shaped read) — safe to
// import from the standalone worker.
// ============================================================

import type { ProviderId } from '@/lib/channels/provider';

/** Safe default send rate per provider, in messages per minute. */
export const DEFAULT_THROUGHPUT_PER_MIN: Record<ProviderId, number> = {
  meta: 60,
  instagram: 60,
  messenger: 60,
  email: 60,
  waha: 10,
  evolution: 15,
  evogo: 10,
};

/** Default jitter window [min, max] ms for non-official providers. */
export const DEFAULT_JITTER_MS: [number, number] = [800, 2500];

const DURATION_MS = 60_000;

export interface Limiter {
  /** Max jobs processed per `duration`. */
  max: number;
  /** Window in ms (always 60_000 here — rate is expressed per minute). */
  duration: number;
}

/**
 * Resolve the BullMQ limiter for a channel: its explicit
 * `settings.throughputPerMin` if a positive number, else the provider
 * default. Expressed as `max` per 60_000ms.
 */
export function limiterForChannel(channel: {
  provider: ProviderId;
  settings?: Record<string, unknown> | null;
}): Limiter {
  const override = channel.settings?.throughputPerMin;
  const perMin =
    typeof override === 'number' && override > 0
      ? Math.floor(override)
      : DEFAULT_THROUGHPUT_PER_MIN[channel.provider] ?? 10;
  return { max: perMin, duration: DURATION_MS };
}

/**
 * Resolve the jitter window for a channel. `null` when jitter does not
 * apply (official provider). Reads `settings.jitterMs` = [min, max] when
 * present, else the default window.
 */
export function jitterForChannel(channel: {
  settings?: Record<string, unknown> | null;
  needsJitter: boolean;
}): [number, number] | null {
  if (!channel.needsJitter) return null;
  const override = channel.settings?.jitterMs;
  if (
    Array.isArray(override) &&
    override.length === 2 &&
    typeof override[0] === 'number' &&
    typeof override[1] === 'number' &&
    override[0] >= 0 &&
    override[1] >= override[0]
  ) {
    return [override[0], override[1]];
  }
  return DEFAULT_JITTER_MS;
}

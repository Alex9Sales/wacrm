// ============================================================
// Leg bookkeeping for the call modal.
//
// WhatsApp allows ONE active call per NUMBER, so two calls can only ever be
// live on DIFFERENT channels. When that happens one agent can end up holding
// several legs: exactly one is active (mic + speaker live) and the rest are
// held (mic cut, audio muted, RTCPeerConnection kept alive).
//
// "Held" is DERIVED from activeKey, never stored: a connected leg that is not
// the active one is on hold, by definition. Storing it separately meant every
// action had to keep two things in sync, and each place that forgot was a bug.
//
// The media objects (RTCPeerConnection / AudioContext / MediaStream) live in
// the component's refs. Everything here is pure so the rules can be tested
// without a DOM.
// ============================================================

import type { CallProvider, Phase } from './call-routing';

export interface Leg {
  /** Stable local id and map key. Outbound legs exist before the provider
   *  hands us a callId, so the callId can't be the key. */
  key: string;
  /** The provider's call id. '' until an outbound initiate returns. */
  callId: string;
  peer: string; // customer phone (E.164 digits) — display + Meta actions
  name?: string;
  provider: CallProvider;
  conversationId?: string; // for the call-log entry (waha outbound)
  channelId?: string; // waha: which channel's voice engine handles this call
  wahaFrom?: string; // waha inbound: the caller's raw chatId (reject needs it)
  phase: Phase;
  dir: 'in' | 'out';
  muted: boolean; // mic muted by the agent
  ringMuted: boolean; // this leg's ringtone silenced, still ringing
  seconds: number;
}

/** A leg fully up: the only kind eligible to be auto-resumed. */
export function isConnected(leg: Leg): boolean {
  return leg.phase === 'active';
}

/** A leg still waiting for the agent to pick up. */
export function isRinging(leg: Leg): boolean {
  return leg.phase === 'ringing';
}

/** Phases where the leg owns a mic and a speaker that must be gated.
 *  'connecting' counts: media is wired up there, and a leg the agent has
 *  already switched away from must not go live for even a moment when it
 *  finishes connecting. */
function ownsMedia(leg: Leg): boolean {
  return leg.phase === 'active' || leg.phase === 'connecting';
}

/** Parked: has audio, but someone else has the agent's ear. */
export function isHeld(leg: Leg, activeKey: string | null): boolean {
  return ownsMedia(leg) && leg.key !== activeKey;
}

/** Mic should reach the wire only for the leg the agent is actually on. */
export function micLive(leg: Leg, activeKey: string | null): boolean {
  return !leg.muted && !isHeld(leg, activeKey);
}

export function findByCallId(legs: Leg[], callId: string): Leg | undefined {
  if (!callId) return undefined;
  return legs.find((l) => l.callId === callId);
}

/**
 * True when this `call_incoming` is a redelivery of a leg we already hold.
 *
 * gows/waha can fire call.received twice for one call; without this the modal
 * double-rings and opens a second leg for the same conversation.
 */
export function isDuplicateIncoming(legs: Leg[], callId: string): boolean {
  return !!findByCallId(legs, callId);
}

/**
 * Who should take the agent's ear when nobody has it.
 *
 * Only auto-resumes when exactly ONE connected leg is left — the unambiguous
 * case (you hang up on B, you are obviously back with A). With several parked
 * legs the agent picks, so nobody is surprised by a mic going live on the
 * wrong customer. Returns null when the current activeKey is still valid.
 */
export function pickAutoResume(
  legs: Leg[],
  activeKey: string | null,
): string | null {
  if (activeKey && legs.some((l) => l.key === activeKey)) return null;
  const connected = legs.filter(isConnected);
  return connected.length === 1 ? connected[0].key : null;
}

/**
 * The leg the big modal should show: the active one, else whatever is
 * ringing (a new caller deserves the foreground), else the first parked one
 * so nobody is left forgotten in silence.
 */
export function pickForeground(
  legs: Leg[],
  activeKey: string | null,
): Leg | null {
  if (!legs.length) return null;
  const active = legs.find((l) => l.key === activeKey);
  if (active) return active;
  return legs.find(isRinging) ?? legs[0];
}

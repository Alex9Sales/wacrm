// ============================================================
// Pure routing decisions for the call modal's SSE handling.
//
// Extracted from incoming-call-modal.tsx so the branches can be tested
// without a DOM: they are subtle, account-wide, and have already caused
// production incidents (see routeCallStatus).
// ============================================================

export type Phase =
  | 'idle'
  | 'ringing' // inbound, waiting for the agent to answer
  | 'dialing' // outbound, setting up / waiting for the customer
  | 'connecting'
  | 'active'
  | 'permission'; // outbound blocked — needs the customer's permission

/** Which calling transport a call runs on. Meta = official Business Calling
 *  (permission + SSE answer); waha = unofficial waha-voip (no permission, the
 *  /webrtc endpoint returns the SDP answer synchronously). */
export type CallProvider = 'meta' | 'waha';

export type CallStatusAction =
  | 'ignore'
  | 'go-active' // outbound: the customer picked up — flip "chamando…" to live
  | 'teardown';

/**
 * Decide what a `call_status` event means for the leg the modal is on.
 *
 * The SSE stream is per-ACCOUNT, so statuses arrive for calls this modal has
 * nothing to do with — that is why the callId check comes first.
 */
export function routeCallStatus(params: {
  /** `callId` off the event. May be '' — Meta sends `call.id ?? ''`. */
  eventCallId: string;
  eventStatus: string;
  /** The callId this modal currently holds ('' when idle). */
  currentCallId: string;
  provider: CallProvider | undefined;
  dir: 'in' | 'out';
  phase: Phase;
}): CallStatusAction {
  const { eventCallId, eventStatus, currentCallId, provider, dir, phase } =
    params;

  // A status for ANOTHER call must never tear this one down. Real scenario:
  // a second customer calls a busy channel, the webhook rejects them, gows
  // fires call.rejected for THAT id — and the agent's live call dropped.
  // Lenient on an empty id: it can't belong to a different call either.
  if (eventCallId && eventCallId !== currentCallId) return 'ignore';

  if (eventStatus === 'ACCEPTED_ELSEWHERE' && provider === 'waha') {
    // Outbound: the browser↔server leg connects long before the customer
    // picks up, so this event is what makes the call genuinely live.
    if (dir === 'out' && phase === 'connecting') return 'go-active';
    // Our own accept echoes call.accepted back — never tear down a call
    // that is already past ringing.
    if (phase !== 'ringing') return 'ignore';
  }

  return 'teardown';
}

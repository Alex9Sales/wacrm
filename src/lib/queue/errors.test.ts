import { describe, it, expect } from 'vitest';

import { channelHaltReason, isPermanentSendError } from './errors';

// The strings below are the REAL errors captured in production on 22-23/07,
// when a cold 50-message blast got the Gas Alianca number flagged: WhatsApp
// first removed the linked device, then rejected every send with 463.
const ERR_463 =
  'waha sendText failed: {"statusCode":500,"timestamp":"2026-07-23T19:48:30.717Z",' +
  '"exception":{"message":"2 UNKNOWN: server returned error 463","code":2,' +
  '"details":"server returned error 463"}}';
const ERR_SESSION =
  'waha sendText failed: Session status is not as expected. Try again later.';

describe('channelHaltReason', () => {
  it('flags the WhatsApp 463 reputation block', () => {
    expect(channelHaltReason(ERR_463)).toBe('reputation');
  });

  it('flags a session that is not WORKING', () => {
    expect(channelHaltReason(ERR_SESSION)).toBe('session_down');
  });

  it('flags a logged-out / device-removed session', () => {
    expect(channelHaltReason('session logged out')).toBe('session_down');
    expect(channelHaltReason('Got device removed stream error')).toBe(
      'session_down',
    );
  });

  // The whole point of halting is to protect the SENDER's number, so a
  // problem with ONE recipient must never stop everyone else.
  it('does NOT halt on a per-recipient problem', () => {
    expect(channelHaltReason('invalid phone number')).toBeNull();
    expect(channelHaltReason('not a valid whatsapp number')).toBeNull();
    expect(channelHaltReason('template not approved')).toBeNull();
    expect(channelHaltReason('timeout')).toBeNull();
  });
});

describe('isPermanentSendError still holds for the halt errors', () => {
  // 463 must ALSO stay permanent: even before the broadcast pauses, this
  // recipient must not be retried — retrying a 463 is what burns the number.
  it('treats 463 as permanent (no retry)', () => {
    expect(isPermanentSendError(ERR_463)).toBe(true);
  });
});

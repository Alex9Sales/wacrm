import { describe, expect, it } from 'vitest';

import { routeCallStatus } from './call-routing';

const base = {
  eventCallId: 'call-1',
  eventStatus: 'REJECTED',
  currentCallId: 'call-1',
  provider: 'waha' as const,
  dir: 'in' as const,
  phase: 'active' as const,
};

describe('routeCallStatus', () => {
  it('ignores a status belonging to a different call', () => {
    // The incident: a second customer calls a busy channel → the webhook
    // rejects them → call.rejected for THEIR id → this must not drop the
    // agent's live call.
    expect(routeCallStatus({ ...base, eventCallId: 'call-2' })).toBe('ignore');
  });

  it('tears down on a status for the call it is on', () => {
    expect(routeCallStatus(base)).toBe('teardown');
  });

  it('falls through when the event carries no callId (Meta terminate)', () => {
    expect(
      routeCallStatus({
        ...base,
        eventCallId: '',
        eventStatus: 'COMPLETED',
        provider: 'meta',
      }),
    ).toBe('teardown');
  });

  it('ignores everything while idle if the event names a call', () => {
    expect(routeCallStatus({ ...base, currentCallId: '', phase: 'idle' })).toBe(
      'ignore',
    );
  });

  describe('waha ACCEPTED_ELSEWHERE', () => {
    const accepted = { ...base, eventStatus: 'ACCEPTED_ELSEWHERE' };

    it('goes active when the customer answers our outbound call', () => {
      expect(
        routeCallStatus({ ...accepted, dir: 'out', phase: 'connecting' }),
      ).toBe('go-active');
    });

    it('ignores the echo of our own accept on a live call', () => {
      expect(routeCallStatus({ ...accepted, phase: 'active' })).toBe('ignore');
    });

    it('tears down a still-ringing leg answered elsewhere', () => {
      expect(routeCallStatus({ ...accepted, phase: 'ringing' })).toBe(
        'teardown',
      );
    });

    it('does not apply the waha nuances to a Meta call', () => {
      expect(
        routeCallStatus({ ...accepted, provider: 'meta', phase: 'active' }),
      ).toBe('teardown');
    });
  });
});

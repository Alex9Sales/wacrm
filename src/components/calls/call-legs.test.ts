import { describe, expect, it } from 'vitest';

import {
  findByCallId,
  isDuplicateIncoming,
  isHeld,
  micLive,
  pickAutoResume,
  pickForeground,
  type Leg,
} from './call-legs';

function leg(over: Partial<Leg> & { key: string }): Leg {
  return {
    callId: `id-${over.key}`,
    peer: '5567999',
    provider: 'waha',
    phase: 'active',
    dir: 'in',
    muted: false,
    ringMuted: false,
    seconds: 0,
    ...over,
  };
}

describe('findByCallId', () => {
  it('finds the leg carrying that provider id', () => {
    const legs = [leg({ key: 'a' }), leg({ key: 'b' })];
    expect(findByCallId(legs, 'id-b')?.key).toBe('b');
  });

  it('never matches on an empty id — outbound legs start without one', () => {
    expect(findByCallId([leg({ key: 'a', callId: '' })], '')).toBeUndefined();
  });
});

describe('isDuplicateIncoming', () => {
  it('flags a redelivered call.received for a leg we already hold', () => {
    expect(isDuplicateIncoming([leg({ key: 'a' })], 'id-a')).toBe(true);
  });

  it('lets a genuinely new call through', () => {
    expect(isDuplicateIncoming([leg({ key: 'a' })], 'id-z')).toBe(false);
  });
});

describe('isHeld', () => {
  it('parks a connected leg that is not the active one', () => {
    expect(isHeld(leg({ key: 'a' }), 'b')).toBe(true);
  });

  it('does not park the active leg', () => {
    expect(isHeld(leg({ key: 'a' }), 'a')).toBe(false);
  });

  it('does not park a ringing leg — it has no audio yet', () => {
    expect(isHeld(leg({ key: 'r', phase: 'ringing' }), 'a')).toBe(false);
  });

  it('parks a leg still connecting that the agent already switched away from', () => {
    // Its media is already wired: if it were not parked, the moment it
    // finished connecting both customers would hear the agent at once.
    expect(isHeld(leg({ key: 'b', phase: 'connecting' }), 'a')).toBe(true);
  });

  it('parks everything connected when nobody is active', () => {
    expect(isHeld(leg({ key: 'a' }), null)).toBe(true);
  });
});

describe('micLive', () => {
  it('is live only on the active, unmuted leg', () => {
    expect(micLive(leg({ key: 'a' }), 'a')).toBe(true);
  });

  it('is cut on a parked leg — the other customer must not hear this call', () => {
    expect(micLive(leg({ key: 'a' }), 'b')).toBe(false);
  });

  it('is cut when the agent muted the active leg', () => {
    expect(micLive(leg({ key: 'a', muted: true }), 'a')).toBe(false);
  });
});

describe('pickAutoResume', () => {
  it('resumes the survivor when only one connected leg is left', () => {
    expect(pickAutoResume([leg({ key: 'a' })], null)).toBe('a');
  });

  it('picks nobody when several are parked — the agent chooses', () => {
    expect(pickAutoResume([leg({ key: 'a' }), leg({ key: 'b' })], null)).toBeNull();
  });

  it('leaves a still-valid activeKey alone', () => {
    const legs = [leg({ key: 'a' }), leg({ key: 'b' })];
    expect(pickAutoResume(legs, 'b')).toBeNull();
  });

  it('does not promote a ringing leg — it was never answered', () => {
    expect(pickAutoResume([leg({ key: 'r', phase: 'ringing' })], null)).toBeNull();
  });

  it('picks nobody when nothing is left', () => {
    expect(pickAutoResume([], null)).toBeNull();
  });
});

describe('pickForeground', () => {
  it('shows the active leg', () => {
    const legs = [leg({ key: 'a' }), leg({ key: 'b' })];
    expect(pickForeground(legs, 'b')?.key).toBe('b');
  });

  it('brings a new caller to the front when nothing is active', () => {
    const legs = [leg({ key: 'a' }), leg({ key: 'r', phase: 'ringing' })];
    expect(pickForeground(legs, null)?.key).toBe('r');
  });

  it('falls back to a parked leg so nobody is left forgotten in silence', () => {
    expect(pickForeground([leg({ key: 'a' })], null)?.key).toBe('a');
  });

  it('shows nothing when there are no legs', () => {
    expect(pickForeground([], null)).toBeNull();
  });
});

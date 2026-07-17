import { describe, expect, it } from 'vitest';

import { formatDisplay, isDialable, toDialDigits } from './dialer-format';

describe('toDialDigits', () => {
  it('adds 55 to a bare mobile (DDD + 9 digits)', () => {
    expect(toDialDigits('67991646764')).toBe('5567991646764');
  });

  it('adds 55 to a bare landline (DDD + 8 digits)', () => {
    expect(toDialDigits('6733214567')).toBe('556733214567');
  });

  it('leaves a number that already has 55 alone', () => {
    expect(toDialDigits('5567991646764')).toBe('5567991646764');
  });

  it('strips formatting from a pasted number', () => {
    expect(toDialDigits('+55 (67) 99164-6764')).toBe('5567991646764');
  });

  it('does not double-prefix a formatted number that already has 55', () => {
    expect(toDialDigits('+55 67 99164-6764')).toBe('5567991646764');
  });

  it('is empty for empty input', () => {
    expect(toDialDigits('')).toBe('');
    expect(toDialDigits('abc')).toBe('');
  });
});

describe('isDialable', () => {
  it('accepts a full mobile', () => {
    expect(isDialable('67991646764')).toBe(true);
  });

  it('accepts a full landline', () => {
    expect(isDialable('6733214567')).toBe(true);
  });

  it('rejects a half-typed number', () => {
    expect(isDialable('6799')).toBe(false);
  });

  it('rejects empty', () => {
    expect(isDialable('')).toBe(false);
  });
});

describe('formatDisplay', () => {
  it('formats a full mobile as +55 (DD) NNNNN-NNNN', () => {
    expect(formatDisplay('5567991646764')).toBe('+55 (67) 99164-6764');
  });

  it('formats progressively as the agent types', () => {
    expect(formatDisplay('67')).toBe('+55 (67');
    expect(formatDisplay('679916')).toBe('+55 (67) 9916'); // no hyphen until >4 digits
    // partial mid-type: last 4 always split off (cosmetic while typing)
    expect(formatDisplay('6799164')).toBe('+55 (67) 9-9164');
  });

  it('is empty for empty input', () => {
    expect(formatDisplay('')).toBe('');
  });
});

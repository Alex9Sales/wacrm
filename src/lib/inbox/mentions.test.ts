import { describe, expect, it } from 'vitest';

import { activeMentionQuery, parseMentions } from './mentions';

const members = [
  { id: 'u-ana', name: 'Ana' },
  { id: 'u-anapaula', name: 'Ana Paula' },
  { id: 'u-joao', name: 'João' },
  { id: 'u-noname', name: null },
];

describe('parseMentions', () => {
  it('resolves a simple mention', () => {
    expect(parseMentions('oi @João assume aí', members)).toEqual(['u-joao']);
  });

  it('prefers the longer name — "@Ana Paula" is NOT also Ana', () => {
    expect(parseMentions('@Ana Paula vê isso', members)).toEqual(['u-anapaula']);
  });

  it('still matches the short name on its own', () => {
    expect(parseMentions('@Ana vê isso', members)).toEqual(['u-ana']);
  });

  it('resolves several mentions in one message', () => {
    const r = parseMentions('@João e @Ana Paula, olhem', members);
    expect(r).toContain('u-joao');
    expect(r).toContain('u-anapaula');
    expect(r).not.toContain('u-ana');
  });

  it('is case-insensitive', () => {
    expect(parseMentions('@joão', members)).toEqual(['u-joao']);
  });

  it('does not fire inside a longer word', () => {
    expect(parseMentions('mande e-mail para ana@empresa.com', members)).toEqual(
      [],
    );
  });

  it('does not fire on a name that is a prefix of another word', () => {
    // "@Anabela" must not resolve to Ana
    expect(parseMentions('oi @Anabela', members)).toEqual([]);
  });

  it('returns empty when there is no @', () => {
    expect(parseMentions('bom dia equipe', members)).toEqual([]);
  });

  it('dedupes a repeated mention', () => {
    expect(parseMentions('@Ana @Ana de novo', members)).toEqual(['u-ana']);
  });
});

describe('activeMentionQuery', () => {
  it('returns the partial query while typing after @', () => {
    const t = 'oi @Ana';
    expect(activeMentionQuery(t, t.length)).toBe('Ana');
  });

  it('is null when there is no open @ token', () => {
    expect(activeMentionQuery('oi Ana', 6)).toBeNull();
  });

  it('is null right after a completed mention + space', () => {
    const t = 'oi @Ana ';
    expect(activeMentionQuery(t, t.length)).toBeNull();
  });

  it('requires the @ to start a token (not mid-email)', () => {
    const t = 'ana@empresa';
    expect(activeMentionQuery(t, t.length)).toBeNull();
  });

  it('fires with an empty query right after typing @', () => {
    const t = 'oi @';
    expect(activeMentionQuery(t, t.length)).toBe('');
  });
});

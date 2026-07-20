import { describe, it, expect } from 'vitest';
import { isGroupJid, groupJidDigits, prefixGroupAuthor } from './group';

describe('isGroupJid', () => {
  it('matches the @g.us suffixed form', () => {
    expect(isGroupJid('120363400053019227@g.us')).toBe(true);
    expect(isGroupJid('120363400053019227@G.US')).toBe(true);
  });

  it('matches a bare numeric group id that lost its suffix', () => {
    expect(isGroupJid('120363400053019227')).toBe(true);
    // exactly 16 digits is the lower bound (E.164 max is 15)
    expect(isGroupJid('1234567890123456')).toBe(true);
  });

  it('rejects direct phones (any known suffix)', () => {
    expect(isGroupJid('5567999887766@s.whatsapp.net')).toBe(false);
    expect(isGroupJid('5567999887766@c.us')).toBe(false);
    expect(isGroupJid('5567999887766@lid')).toBe(false);
    expect(isGroupJid('5567999887766')).toBe(false); // 13 digits → phone
  });

  it('rejects newsletters, broadcast and status', () => {
    expect(isGroupJid('120363111@newsletter')).toBe(false);
    expect(isGroupJid('120363111@broadcast')).toBe(false);
    expect(isGroupJid('status@broadcast')).toBe(false);
  });

  it('rejects empty / garbage', () => {
    expect(isGroupJid('')).toBe(false);
    expect(isGroupJid('abc')).toBe(false);
    // 15-or-fewer bare digits is a phone, never a group
    expect(isGroupJid('123456789012345')).toBe(false);
  });
});

describe('groupJidDigits', () => {
  it('strips the suffix and non-digits', () => {
    expect(groupJidDigits('120363400053019227@g.us')).toBe('120363400053019227');
    expect(groupJidDigits('120363400053019227')).toBe('120363400053019227');
  });

  it('matches across the @g.us-vs-bare mismatch (opt-in lookup robustness)', () => {
    expect(groupJidDigits('120363400053019227@g.us')).toBe(
      groupJidDigits('120363400053019227'),
    );
  });
});

describe('prefixGroupAuthor', () => {
  it('prefixes the author name', () => {
    expect(prefixGroupAuthor('Fulano', 'bom dia')).toBe('Fulano: bom dia');
  });

  it('leaves the text unchanged for a blank author (e.g. our own echo)', () => {
    expect(prefixGroupAuthor('', 'bom dia')).toBe('bom dia');
    expect(prefixGroupAuthor('   ', 'bom dia')).toBe('bom dia');
  });

  it('trims the author', () => {
    expect(prefixGroupAuthor('  Ana Paula  ', 'oi')).toBe('Ana Paula: oi');
  });
});

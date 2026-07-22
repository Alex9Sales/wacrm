import { describe, it, expect } from 'vitest';
import {
  isGroupJid,
  groupJidDigits,
  prefixGroupAuthor,
  mentionUsers,
  parseGroupParticipants,
  resolveGroupMentions,
} from './group';

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

describe('mentionUsers', () => {
  it('extracts the user-part of LID and phone jids', () => {
    expect(
      mentionUsers(['146089705500852@lid', '5513992126485@s.whatsapp.net']),
    ).toEqual(['146089705500852', '5513992126485']);
  });

  it('strips the :device tag', () => {
    expect(mentionUsers(['146089705500852:4@lid'])).toEqual(['146089705500852']);
  });

  it('returns [] for non-arrays / garbage', () => {
    expect(mentionUsers(undefined)).toEqual([]);
    expect(mentionUsers(null)).toEqual([]);
    expect(mentionUsers([42, '', '@lid'])).toEqual([]);
  });
});

describe('parseGroupParticipants', () => {
  it('pairs the @lid mention token with the phone jid (gows shape)', () => {
    expect(
      parseGroupParticipants([
        { JID: '146089705500852@lid', PhoneNumber: '5513992126485@s.whatsapp.net' },
      ]),
    ).toEqual([{ lidUser: '146089705500852', phone: '5513992126485' }]);
  });

  it('accepts @c.us phones and the :device tag', () => {
    expect(
      parseGroupParticipants([
        { JID: '146089705500852:4@lid', PN: '5513992126485@c.us' },
      ]),
    ).toEqual([{ lidUser: '146089705500852', phone: '5513992126485' }]);
  });

  it('falls back to bare PhoneNumber/LID field names', () => {
    expect(
      parseGroupParticipants([
        { LID: '146089705500852', PhoneNumber: '5513992126485' },
      ]),
    ).toEqual([{ lidUser: '146089705500852', phone: '5513992126485' }]);
  });

  it('keeps a participant with only one id resolvable', () => {
    expect(
      parseGroupParticipants([
        { JID: '5513992126485@s.whatsapp.net' },
        { JID: '146089705500852@lid' },
      ]),
    ).toEqual([{ phone: '5513992126485' }, { lidUser: '146089705500852' }]);
  });

  it('skips empty/garbage participants and non-arrays', () => {
    expect(parseGroupParticipants(undefined)).toEqual([]);
    expect(parseGroupParticipants(null)).toEqual([]);
    expect(parseGroupParticipants([{}, 42, null, { foo: 'bar' }])).toEqual([]);
  });
});

describe('resolveGroupMentions', () => {
  it('rewrites a known mention to its name', () => {
    expect(
      resolveGroupMentions(
        '@146089705500852 obrigado!',
        ['146089705500852'],
        { '146089705500852': 'Guilherme Andrade' },
      ),
    ).toBe('@Guilherme Andrade obrigado!');
  });

  it('leaves an unknown mention as the raw number', () => {
    expect(
      resolveGroupMentions('@999 e @146089705500852', ['999', '146089705500852'], {
        '146089705500852': 'Guilherme Andrade',
      }),
    ).toBe('@999 e @Guilherme Andrade');
  });

  it('does not rewrite a shorter user inside a longer one', () => {
    // "@12345" must not corrupt "@123456789" — longest-first guards it.
    expect(
      resolveGroupMentions('@123456789', ['12345', '123456789'], {
        '12345': 'Curto',
        '123456789': 'Longo',
      }),
    ).toBe('@Longo');
  });

  it('no-ops with no mentions or empty text', () => {
    expect(resolveGroupMentions('oi', [], {})).toBe('oi');
    expect(resolveGroupMentions('', ['1'], { '1': 'x' })).toBe('');
  });
});

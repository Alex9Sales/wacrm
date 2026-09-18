import { describe, it, expect } from 'vitest';
import {
  isGroupJid,
  groupJidDigits,
  prefixGroupAuthor,
  mentionUsers,
  parseGroupParticipants,
  buildOutboundGroupMentions,
  resolveGroupMentions,
} from './group';

describe('isGroupJid', () => {
  it('matches the @g.us suffixed form', () => {
    expect(isGroupJid('120363000000000001@g.us')).toBe(true);
    expect(isGroupJid('120363000000000001@G.US')).toBe(true);
  });

  it('matches a bare numeric group id that lost its suffix', () => {
    expect(isGroupJid('120363000000000001')).toBe(true);
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
    expect(groupJidDigits('120363000000000001@g.us')).toBe('120363000000000001');
    expect(groupJidDigits('120363000000000001')).toBe('120363000000000001');
  });

  it('matches across the @g.us-vs-bare mismatch (opt-in lookup robustness)', () => {
    expect(groupJidDigits('120363000000000001@g.us')).toBe(
      groupJidDigits('120363000000000001'),
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
      mentionUsers(['140000000000001@lid', '5513990001234@s.whatsapp.net']),
    ).toEqual(['140000000000001', '5513990001234']);
  });

  it('strips the :device tag', () => {
    expect(mentionUsers(['140000000000001:4@lid'])).toEqual(['140000000000001']);
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
        { JID: '140000000000001@lid', PhoneNumber: '5513990001234@s.whatsapp.net' },
      ]),
    ).toEqual([{ lidUser: '140000000000001', phone: '5513990001234' }]);
  });

  it('accepts @c.us phones and the :device tag', () => {
    expect(
      parseGroupParticipants([
        { JID: '140000000000001:4@lid', PN: '5513990001234@c.us' },
      ]),
    ).toEqual([{ lidUser: '140000000000001', phone: '5513990001234' }]);
  });

  it('falls back to bare PhoneNumber/LID field names', () => {
    expect(
      parseGroupParticipants([
        { LID: '140000000000001', PhoneNumber: '5513990001234' },
      ]),
    ).toEqual([{ lidUser: '140000000000001', phone: '5513990001234' }]);
  });

  it('keeps a participant with only one id resolvable', () => {
    expect(
      parseGroupParticipants([
        { JID: '5513990001234@s.whatsapp.net' },
        { JID: '140000000000001@lid' },
      ]),
    ).toEqual([{ phone: '5513990001234' }, { lidUser: '140000000000001' }]);
  });

  it('skips empty/garbage participants and non-arrays', () => {
    expect(parseGroupParticipants(undefined)).toEqual([]);
    expect(parseGroupParticipants(null)).toEqual([]);
    expect(parseGroupParticipants([{}, 42, null, { foo: 'bar' }])).toEqual([]);
  });
});

describe('buildOutboundGroupMentions', () => {
  const nameToUser = { 'Ana Paula': '111@x', Ana: '222', João: '140000000000001' };
  const jidByUser = {
    '111@x': '111@lid', // (won't be used — Ana Paula's user is odd on purpose)
    '222': '5567990001234@c.us',
    '140000000000001': '140000000000001@lid',
  };

  it('rewrites @Name to @<user> and collects the jid', () => {
    const r = buildOutboundGroupMentions(
      'bom dia @João, confirma?',
      { João: '140000000000001' },
      { '140000000000001': '140000000000001@lid' },
    );
    expect(r.text).toBe('bom dia @140000000000001, confirma?');
    expect(r.mentions).toEqual(['140000000000001@lid']);
  });

  it('prefers the longest name (Ana Paula over Ana)', () => {
    const r = buildOutboundGroupMentions('oi @Ana Paula', nameToUser, jidByUser);
    // "Ana Paula" matched first; its jid resolves so it rewrites.
    expect(r.text).toBe('oi @111@x');
    expect(r.mentions).toEqual(['111@lid']);
  });

  it('leaves an unknown @name untouched, no mentions', () => {
    const r = buildOutboundGroupMentions('oi @Fulano', nameToUser, jidByUser);
    expect(r.text).toBe('oi @Fulano');
    expect(r.mentions).toEqual([]);
  });

  it('no-ops without an @', () => {
    expect(buildOutboundGroupMentions('bom dia', nameToUser, jidByUser)).toEqual({
      text: 'bom dia',
      mentions: [],
    });
  });
});

describe('resolveGroupMentions', () => {
  it('rewrites a known mention to its name', () => {
    expect(
      resolveGroupMentions(
        '@140000000000001 obrigado!',
        ['140000000000001'],
        { '140000000000001': 'Paulo Exemplo' },
      ),
    ).toBe('@Paulo Exemplo obrigado!');
  });

  it('leaves an unknown mention as the raw number', () => {
    expect(
      resolveGroupMentions('@999 e @140000000000001', ['999', '140000000000001'], {
        '140000000000001': 'Paulo Exemplo',
      }),
    ).toBe('@999 e @Paulo Exemplo');
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

describe('parseGroupParticipants — resposta REAL do gows (04/09)', () => {
  // Formato capturado da API do WAHA num grupo da conta do Alex (dados trocados por fictícios).
  // Chaves em MAIÚSCULAS e JID em @lid: era exatamente isso que o parser do
  // wahaGroupParticipants não lia, e o import respondia "privacidade do grupo".
  const real = [
    {
      JID: '70000000000001@lid',
      PhoneNumber: '556790001234@s.whatsapp.net',
      LID: '70000000000001@lid',
      IsAdmin: false,
      IsSuperAdmin: false,
      DisplayName: '',
      Error: 0,
      AddRequest: null,
    },
    {
      JID: '30000000000002@lid',
      PhoneNumber: '556790005678@s.whatsapp.net',
      LID: '30000000000002@lid',
      IsAdmin: false,
      IsSuperAdmin: false,
      DisplayName: '',
      Error: 0,
      AddRequest: null,
    },
  ]

  it('extrai o telefone real de cada membro', () => {
    const out = parseGroupParticipants(real)
    expect(out.map((p) => p.phone)).toEqual(['556790001234', '556790005678'])
  })

  it('guarda o LID junto, para quem não tiver telefone visível', () => {
    const out = parseGroupParticipants(real)
    expect(out[0].lidUser).toBe('70000000000001')
  })

  it('membro que só tem @lid não é descartado — vira lid para resolver depois', () => {
    const out = parseGroupParticipants([{ JID: '999888777@lid', LID: '999888777@lid' }])
    expect(out).toHaveLength(1)
    expect(out[0].phone).toBeUndefined()
    expect(out[0].lidUser).toBe('999888777')
  })
})

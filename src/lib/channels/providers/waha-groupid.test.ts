import { describe, it, expect } from 'vitest';
import { wahaProvider } from './waha';

// Regression: a GROUP message id from gows has a trailing participant jid
// (`false_<groupJid>_<HASH>_<participantLid>`). The dedup key must be the HASH,
// not the participant jid — otherwise every message from one author collapses to
// their constant lid and gets dropped by the inbound dedup after the first.
function groupMessage(hash: string, participantLid: string) {
  const from = '556790001234-1480000000@g.us';
  return {
    event: 'message',
    payload: {
      id: `false_${from}_${hash}_${participantLid}@lid`,
      from,
      fromMe: false,
      body: '@11110000000001 oi',
      _data: {
        Info: {
          Chat: from,
          Sender: `${participantLid}@lid`,
          IsGroup: true,
          SenderAlt: '556790005678@s.whatsapp.net',
          PushName: 'Carla Teste',
        },
        Message: {
          extendedTextMessage: {
            text: '@11110000000001 oi',
            contextInfo: { mentionedJID: ['11110000000001@lid'] },
          },
        },
      },
    },
  };
}

describe('waha group message id dedup key', () => {
  it('uses the message HASH, not the trailing participant jid', () => {
    const a = wahaProvider.parseWebhook(groupMessage('AAAA1111', '222200000000001'));
    const b = wahaProvider.parseWebhook(groupMessage('BBBB2222', '222200000000001'));
    // Same author, two different messages → two DIFFERENT dedup keys.
    expect(a.messages[0].externalMessageId).toBe('AAAA1111');
    expect(b.messages[0].externalMessageId).toBe('BBBB2222');
    expect(a.messages[0].externalMessageId).not.toBe(b.messages[0].externalMessageId);
  });

  it('still handles a 1:1 id (`<bool>_<chat>_<HASH>`)', () => {
    const out = wahaProvider.parseWebhook({
      event: 'message',
      payload: { id: 'false_556799999999@c.us_HASH1:1', from: '556799999999@c.us', fromMe: false, body: 'oi' },
    });
    expect(out.messages[0]?.externalMessageId).toBe('HASH1:1');
  });
});

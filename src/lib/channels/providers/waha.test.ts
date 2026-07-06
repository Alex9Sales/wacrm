import { describe, expect, it } from 'vitest';
import { wahaProvider } from './waha';

describe('wahaProvider.parseWebhook', () => {
  it('normalizes the serialized id to its last _-segment on inbound message', () => {
    const { messages } = wahaProvider.parseWebhook({
      event: 'message',
      payload: {
        id: 'true_5567992539584@c.us_ABCDEF123456',
        from: '5567992539584@c.us',
        fromMe: false,
        body: 'oi',
      },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].externalMessageId).toBe('ABCDEF123456');
    expect(messages[0].fromPhoneE164).toBe('5567992539584');
    expect(messages[0].contentType).toBe('text');
    expect(messages[0].contentText).toBe('oi');
    expect(messages[0].fromMe).toBe(false);
  });

  it('unwraps a {_serialized} id object', () => {
    const { messages } = wahaProvider.parseWebhook({
      event: 'message',
      payload: {
        id: { _serialized: 'false_551199999999@c.us_HASH999' },
        from: '551199999999@c.us',
        body: 'ola',
      },
    });
    expect(messages[0].externalMessageId).toBe('HASH999');
  });

  it('prefers remoteJidAlt (@s.whatsapp.net) when the chat is @lid', () => {
    const { messages } = wahaProvider.parseWebhook({
      event: 'message',
      payload: {
        id: 'true_123@lid_HASH',
        from: '123456@lid',
        _data: { key: { remoteJidAlt: '5567992539584@s.whatsapp.net' } },
        body: 'via lid',
      },
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].fromPhoneE164).toBe('5567992539584');
  });

  it('drops a @lid chat with no @s.whatsapp.net alt', () => {
    const { messages } = wahaProvider.parseWebhook({
      event: 'message',
      payload: { id: 'x_y_H', from: '123456@lid', body: 'no alt' },
    });
    expect(messages).toHaveLength(0);
  });

  it('ignores group chats (@g.us)', () => {
    const { messages } = wahaProvider.parseWebhook({
      event: 'message',
      payload: { id: 'a_b_H', from: '12345-67890@g.us', body: 'grupo' },
    });
    expect(messages).toHaveLength(0);
  });

  it('ignores group ids delivered without a @g.us suffix (bare numeric)', () => {
    // WAHA NOWEB sometimes sends a group message with the chat as a raw
    // 18-digit id (prefixed 120363) and no suffix — must still be dropped.
    const bare = wahaProvider.parseWebhook({
      event: 'message',
      payload: { id: 'g_b_H', from: '120363400053019227', body: 'grupo raw' },
    });
    expect(bare.messages).toHaveLength(0);

    const suffixed = wahaProvider.parseWebhook({
      event: 'message',
      payload: { id: 'g_c_H', from: '120363400053019227@g.us', body: 'grupo' },
    });
    expect(suffixed.messages).toHaveLength(0);

    // A normal E.164 phone (≤15 digits) must still pass through.
    const direct = wahaProvider.parseWebhook({
      event: 'message',
      payload: { id: 'd_e_H', from: '5567999998888@c.us', body: 'oi' },
    });
    expect(direct.messages).toHaveLength(1);
  });

  it('processes fromMe on message.any but skips non-fromMe echoes', () => {
    const skipped = wahaProvider.parseWebhook({
      event: 'message.any',
      payload: { id: 't_c_H', from: '5511@c.us', fromMe: false, body: 'dup' },
    });
    expect(skipped.messages).toHaveLength(0);

    const kept = wahaProvider.parseWebhook({
      event: 'message.any',
      payload: { id: 't_c_MINE', from: '5511@c.us', fromMe: true, body: 'sent' },
    });
    expect(kept.messages).toHaveLength(1);
    expect(kept.messages[0].fromMe).toBe(true);
    expect(kept.messages[0].externalMessageId).toBe('MINE');
  });

  it('maps inbound media with a rewrite-able fetchKey', () => {
    const { messages } = wahaProvider.parseWebhook({
      event: 'message',
      payload: {
        id: 'a_b_MEDIA',
        from: '5511@c.us',
        hasMedia: true,
        media: {
          mimetype: 'image/jpeg',
          url: 'http://localhost:3000/api/files/abc.jpg',
          filename: 'abc.jpg',
        },
      },
    });
    expect(messages[0].contentType).toBe('image');
    expect(messages[0].media?.kind).toBe('image');
    expect(messages[0].media?.fetchKey).toEqual({
      mediaUrl: 'http://localhost:3000/api/files/abc.jpg',
    });
  });

  it('parses message.ack: ack>=3 => level 3, ack===2 => level 2, id normalized', () => {
    const read = wahaProvider.parseWebhook({
      event: 'message.ack',
      payload: { id: 'true_5511@c.us_ACKID', ack: 3 },
    });
    expect(read.statuses).toEqual([{ externalMessageId: 'ACKID', level: 3 }]);

    const delivered = wahaProvider.parseWebhook({
      event: 'message.ack',
      payload: { id: 'true_5511@c.us_ACKID', ack: 2 },
    });
    expect(delivered.statuses[0].level).toBe(2);

    const sent = wahaProvider.parseWebhook({
      event: 'message.ack',
      payload: { id: 'true_5511@c.us_ACKID', ack: 1 },
    });
    expect(sent.statuses).toHaveLength(0);
  });

  it('returns empty for session.status (route handles it)', () => {
    const out = wahaProvider.parseWebhook({
      event: 'session.status',
      payload: { fromMe: false },
    });
    expect(out.messages).toHaveLength(0);
    expect(out.statuses).toHaveLength(0);
  });
});

describe('wahaProvider.verifyWebhook', () => {
  const ch = {
    id: 'c1',
    webhookSecret: 's3cr3t',
  } as unknown as Parameters<typeof wahaProvider.verifyWebhook>[1];

  it('accepts a matching x-webhook-secret header', async () => {
    const ok = await wahaProvider.verifyWebhook(
      { rawBody: '{}', headers: new Headers({ 'x-webhook-secret': 's3cr3t' }) },
      ch,
    );
    expect(ok).toBe(true);
  });

  it('rejects a wrong or missing secret', async () => {
    expect(
      await wahaProvider.verifyWebhook(
        { rawBody: '{}', headers: new Headers({ 'x-webhook-secret': 'nope' }) },
        ch,
      ),
    ).toBe(false);
    expect(
      await wahaProvider.verifyWebhook(
        { rawBody: '{}', headers: new Headers() },
        ch,
      ),
    ).toBe(false);
    expect(
      await wahaProvider.verifyWebhook(
        { rawBody: '{}', headers: new Headers({ 'x-webhook-secret': 's3cr3t' }) },
        null,
      ),
    ).toBe(false);
  });
});

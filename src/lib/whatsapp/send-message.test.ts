import { beforeEach, describe, expect, it, vi } from 'vitest';

// The global db must never be reached for invalid params — these tests
// cover the param validation that MUST short-circuit before any query
// runs. Any select records the touch and explodes with a plain Error
// (not a SendMessageError), so a validation gap fails the assertions.
const h = vi.hoisted(() => ({
  selectCalls: 0,
}));

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>();
  return {
    ...actual,
    db: {
      select: () => {
        h.selectCalls++;
        throw new Error('reached DB');
      },
    },
  };
});

import {
  sendMessageToConversation,
  SendMessageError,
  type SendMessageParams,
} from './send-message';

async function expectSendError(
  params: SendMessageParams,
  status: number,
  messageMatch?: RegExp
) {
  await expect(
    sendMessageToConversation('acct-1', params)
  ).rejects.toBeInstanceOf(SendMessageError);
  await sendMessageToConversation('acct-1', params).catch(
    (e: SendMessageError) => {
      expect(e.status).toBe(status);
      if (messageMatch) expect(e.message).toMatch(messageMatch);
    }
  );
}

describe('sendMessageToConversation — param validation (pre-DB)', () => {
  const base = { conversationId: 'cv-1' };

  beforeEach(() => {
    h.selectCalls = 0;
  });

  it('requires conversation_id and message_type', async () => {
    await expectSendError({ conversationId: '', messageType: 'text' }, 400);
    await expectSendError({ conversationId: 'cv-1', messageType: '' }, 400);
    expect(h.selectCalls).toBe(0);
  });

  it('rejects an unsupported message_type', async () => {
    await expectSendError(
      { ...base, messageType: 'carrier-pigeon' },
      400,
      /Unsupported message_type/
    );
    expect(h.selectCalls).toBe(0);
  });

  it('requires content_text for text messages', async () => {
    await expectSendError(
      { ...base, messageType: 'text' },
      400,
      /content_text is required/
    );
    expect(h.selectCalls).toBe(0);
  });

  it('requires template_name for template messages', async () => {
    await expectSendError(
      { ...base, messageType: 'template' },
      400,
      /template_name is required/
    );
    expect(h.selectCalls).toBe(0);
  });

  it('requires media_url for media kinds', async () => {
    for (const kind of ['image', 'video', 'document', 'audio']) {
      await expectSendError(
        { ...base, messageType: kind },
        400,
        /media_url is required/
      );
    }
    expect(h.selectCalls).toBe(0);
  });

  it('rejects an over-long media caption (non-audio)', async () => {
    await expectSendError(
      {
        ...base,
        messageType: 'image',
        mediaUrl: 'https://x/y.jpg',
        contentText: 'a'.repeat(1025),
      },
      400,
      /1024-character limit/
    );
    expect(h.selectCalls).toBe(0);
  });

  it('allows a long "caption" on audio (audio carries none) — so it reaches the DB', async () => {
    // Audio is exempt from the caption cap, so validation passes and we
    // proceed to the conversation lookup — proven by the select counter.
    // (The stub's throw is mapped to the same 404 a PostgREST error
    // produced, so the surfaced error is "Conversation not found".)
    await expect(
      sendMessageToConversation('acct-1', {
        ...base,
        messageType: 'audio',
        mediaUrl: 'https://x/y.ogg',
        contentText: 'a'.repeat(2000),
      })
    ).rejects.toThrow('Conversation not found');
    expect(h.selectCalls).toBe(1);
  });
});

describe('SendMessageError', () => {
  it('carries a machine code and an HTTP status', () => {
    const e = new SendMessageError('meta_error', 'boom', 502);
    expect(e.code).toBe('meta_error');
    expect(e.status).toBe(502);
    expect(e).toBeInstanceOf(Error);
  });
});

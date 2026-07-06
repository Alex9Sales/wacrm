import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the provider registry so we can assert exactly what the text-drip
// send path calls, without a real transport.
const sendText = vi.fn();
const sendMedia = vi.fn();
vi.mock('@/lib/channels/registry', () => ({
  getProvider: () => ({
    id: 'waha',
    capabilities: { needsJitter: true, templates: false },
    sendText,
    sendMedia,
  }),
}));

import { sendBroadcastRecipient, type BroadcastSendContext } from './broadcast-core';

// Minimal ChannelCtx stand-in — the mocked getProvider ignores it.
const channel = { provider: 'waha' } as never;

const baseCtx: BroadcastSendContext = {
  messageKind: 'text',
  bodyText: null,
  templateName: '',
  templateLanguage: 'pt_BR',
  templateRow: null,
};

beforeEach(() => {
  sendText.mockReset();
  sendMedia.mockReset();
});

describe('sendBroadcastRecipient — text drip', () => {
  it('renders {{vars}} and sends plain text', async () => {
    sendText.mockResolvedValue({ externalMessageId: 'wamid-1' });
    const res = await sendBroadcastRecipient(
      channel,
      { ...baseCtx, bodyText: 'Olá {{primeiro_nome|cliente}}!' },
      { phone: '+5567999998888', params: [], vars: { primeiro_nome: 'Ana' } },
    );
    expect(res).toEqual({ ok: true, externalMessageId: 'wamid-1' });
    expect(sendText).toHaveBeenCalledWith(channel, '+5567999998888', 'Olá Ana!', {});
    expect(sendMedia).not.toHaveBeenCalled();
  });

  it('uses the |fallback when a var is empty', async () => {
    sendText.mockResolvedValue({ externalMessageId: 'w' });
    await sendBroadcastRecipient(
      channel,
      { ...baseCtx, bodyText: 'Oi {{primeiro_nome|cliente}}' },
      { phone: '+55', params: [], vars: { primeiro_nome: '' } },
    );
    expect(sendText).toHaveBeenCalledWith(channel, '+55', 'Oi cliente', {});
  });

  it('sends media with the rendered text as caption', async () => {
    sendMedia.mockResolvedValue({ externalMessageId: 'wamid-2' });
    const res = await sendBroadcastRecipient(
      channel,
      {
        ...baseCtx,
        bodyText: 'Oi {{primeiro_nome}}',
        mediaUrl: 'https://x/img.jpg',
        mediaType: 'image',
        mediaFilename: 'img.jpg',
      },
      { phone: '+55', params: [], vars: { primeiro_nome: 'Ana' } },
    );
    expect(res.ok).toBe(true);
    expect(sendMedia).toHaveBeenCalledWith(channel, '+55', {
      kind: 'image',
      url: 'https://x/img.jpg',
      caption: 'Oi Ana',
      filename: 'img.jpg',
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it('sends audio without a caption', async () => {
    sendMedia.mockResolvedValue({ externalMessageId: 'w3' });
    await sendBroadcastRecipient(
      channel,
      { ...baseCtx, bodyText: 'texto ignorado', mediaUrl: 'https://x/a.ogg', mediaType: 'audio' },
      { phone: '+55', params: [], vars: {} },
    );
    expect(sendMedia.mock.calls[0][2].caption).toBeUndefined();
  });

  it('fails when there is neither text nor media', async () => {
    const res = await sendBroadcastRecipient(
      channel,
      { ...baseCtx, bodyText: '   ' },
      { phone: '+55', params: [], vars: {} },
    );
    expect(res.ok).toBe(false);
    expect(sendText).not.toHaveBeenCalled();
    expect(sendMedia).not.toHaveBeenCalled();
  });
});

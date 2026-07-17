import { describe, expect, it } from 'vitest';

import { formatPixMessage, PIX_PREFIX } from './pix';

describe('formatPixMessage', () => {
  it('formats key + type + name like the inbound Pix card', () => {
    expect(
      formatPixMessage({
        key: '30365250000196',
        keyType: 'CNPJ',
        name: 'Danyela Glayce Leite de Souza Ltda',
      }),
    ).toBe(
      '💠 Chave Pix • CNPJ\nDanyela Glayce Leite de Souza Ltda\n30365250000196',
    );
  });

  it('starts with the marker the bubble uses to render a copy card', () => {
    const msg = formatPixMessage({ key: 'x@y.com' });
    expect(msg?.startsWith(PIX_PREFIX)).toBe(true);
  });

  it('works with only a key (no type, no name)', () => {
    expect(formatPixMessage({ key: 'chave-aleatoria-123' })).toBe(
      '💠 Chave Pix\nchave-aleatoria-123',
    );
  });

  it('trims whitespace around the fields', () => {
    expect(
      formatPixMessage({ key: '  123  ', keyType: ' CPF ', name: ' Fulano ' }),
    ).toBe('💠 Chave Pix • CPF\nFulano\n123');
  });

  it('returns null when there is no key to send', () => {
    expect(formatPixMessage({ key: '' })).toBeNull();
    expect(formatPixMessage({ key: '   ' })).toBeNull();
  });
});

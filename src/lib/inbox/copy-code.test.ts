import { describe, expect, it } from 'vitest';

import { detectCopyCode } from './copy-code';

describe('detectCopyCode — Pix copia e cola', () => {
  const pix =
    '00020101021226960014br.gov.bcb.pix2574api.developer.btgpactual.com/pc/p/v2/cobv/2235d26ddab0472ca6cdd6ce3ea982fe5204000053039865802BR5925ISAAC LOGIA SERVICO6009SAO PAULO62070503***6304F2D6';

  it('detects a BR Code and strips whitespace', () => {
    const r = detectCopyCode(pix);
    expect(r?.label).toBe('Pix copia e cola');
    expect(r?.code).not.toMatch(/\s/);
    expect(r?.code).toContain('br.gov.bcb.pix');
  });

  it('is case-insensitive on the domain marker', () => {
    expect(detectCopyCode(pix.toUpperCase())?.label).toBe('Pix copia e cola');
  });
});

describe('detectCopyCode — boleto', () => {
  it('detects a linha digitável (47 digits, dotted/spaced)', () => {
    const linha =
      '23793.38128 60082.201234 56009.012345 6 91130000012345';
    // 47 digits total
    expect(detectCopyCode(linha)?.label).toBe('Código de barras');
    expect(detectCopyCode(linha)?.code).toMatch(/^\d{47}$/);
  });

  it('detects a 44-digit barcode', () => {
    expect(detectCopyCode('0'.repeat(44))?.label).toBe('Código de barras');
  });
});

describe('detectCopyCode — must NOT fire on normal messages', () => {
  it('ignores ordinary text', () => {
    expect(detectCopyCode('Boa tarde, o gás já foi entregue')).toBeNull();
  });

  it('ignores a short number like a phone or price', () => {
    expect(detectCopyCode('67991646764')).toBeNull();
    expect(detectCopyCode('125,00')).toBeNull();
  });

  it('ignores a message that merely mentions a long number in words', () => {
    expect(
      detectCopyCode('o pedido 12345678901234567890 saiu hoje'),
    ).toBeNull();
  });

  it('is null for empty input', () => {
    expect(detectCopyCode('')).toBeNull();
    expect(detectCopyCode('   ')).toBeNull();
  });
});

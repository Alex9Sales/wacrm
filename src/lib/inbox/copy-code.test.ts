import { describe, expect, it } from 'vitest';

import { detectCopyCode } from './copy-code';

describe('detectCopyCode — Pix copia e cola', () => {
  const pix =
    '00020101021226960014br.gov.bcb.pix2574api.developer.btgpactual.com/pc/p/v2/cobv/2235d26ddab0472ca6cdd6ce3ea982fe5204000053039865802BR5925ISAAC LOGIA SERVICO6009SAO PAULO62070503***6304F2D6';

  it('detects a BR Code and keeps it EXACTLY (spaces in name/city are part of the CRC)', () => {
    const r = detectCopyCode(pix);
    expect(r?.label).toBe('Pix copia e cola');
    expect(r?.code).toBe(pix);
    expect(r?.code).toContain('ISAAC LOGIA SERVICO');
  });

  it('a line break inserted by the chat is removed, nothing else', () => {
    const wrapped = `${pix.slice(0, 60)}\n${pix.slice(60)}`;
    expect(detectCopyCode(wrapped)?.code).toBe(pix);
  });

  it('text that merely CONTAINS a Pix stays text (the card used to hide the rest)', () => {
    expect(detectCopyCode(`Segue o Pix: ${pix}`)).toBeNull();
    expect(detectCopyCode(`${pix}\nVence dia 20`)).toBeNull();
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

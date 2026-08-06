import { describe, expect, it } from 'vitest';
import { parseVCard } from './parse-vcard';

describe('parseVCard', () => {
  it('parses a vCard 2.1 card (FN + CELL)', () => {
    const vcf = `BEGIN:VCARD
VERSION:2.1
N:;Lucineide;;;
FN:Lucineide
TEL;CELL:+5511968169134
END:VCARD`;
    const { rows } = parseVCard(vcf);
    expect(rows).toEqual([
      {
        phone: '+5511968169134',
        name: 'Lucineide',
        email: undefined,
        company: undefined,
        tagNames: [],
        codes: [],
      },
    ]);
  });

  it('dedupes the duplicated TEL inside a card', () => {
    const vcf = `BEGIN:VCARD
VERSION:2.1
FN:Bob
TEL;CELL:968169134
TEL;CELL:968169134
END:VCARD`;
    const { rows } = parseVCard(vcf);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Bob', phone: '968169134' });
  });

  it('emits one row per DISTINCT phone (a pessoa com 2 números)', () => {
    const vcf = `BEGIN:VCARD
VERSION:3.0
FN:Ana
TEL;TYPE=CELL:+5511990001111
TEL;TYPE=HOME:+551130002222
END:VCARD`;
    const { rows } = parseVCard(vcf);
    expect(rows.map((r) => r.phone)).toEqual([
      '+5511990001111',
      '+551130002222',
    ]);
    expect(rows.every((r) => r.name === 'Ana')).toBe(true);
  });

  it('reconstructs the name from N when there is no FN, reads ORG + EMAIL', () => {
    const vcf = `BEGIN:VCARD
VERSION:3.0
N:Silva;Maria;;;
ORG:ACME Ltda;Vendas
EMAIL:maria@acme.com
TEL:+5511955550000
END:VCARD`;
    const { rows, hasCompanyColumn } = parseVCard(vcf);
    expect(hasCompanyColumn).toBe(true);
    expect(rows[0]).toEqual({
      phone: '+5511955550000',
      name: 'Maria Silva',
      email: 'maria@acme.com',
      company: 'ACME Ltda',
      tagNames: [],
      codes: [],
    });
  });

  it('skips a card with no phone', () => {
    const vcf = `BEGIN:VCARD
VERSION:3.0
FN:Sem Telefone
EMAIL:x@y.com
END:VCARD`;
    expect(parseVCard(vcf).rows).toEqual([]);
  });

  it('parses several cards in one file', () => {
    const vcf = `BEGIN:VCARD
VERSION:2.1
FN:A
TEL;CELL:111111111
END:VCARD
BEGIN:VCARD
VERSION:2.1
FN:B
TEL;CELL:222222222
END:VCARD`;
    const { rows } = parseVCard(vcf);
    expect(rows.map((r) => r.name)).toEqual(['A', 'B']);
  });
});

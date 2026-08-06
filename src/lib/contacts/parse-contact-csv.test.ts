import { describe, expect, it } from 'vitest';
import { parseContactCsv, parseTagCell, parseCodeCell } from './parse-contact-csv';

describe('parseTagCell', () => {
  it('splits comma-separated tags and trims whitespace', () => {
    expect(parseTagCell(' VIP , Lead ,  ')).toEqual(['VIP', 'Lead']);
  });

  it('splits semicolon-separated tags', () => {
    expect(parseTagCell('VIP; Lead; Customer')).toEqual([
      'VIP',
      'Lead',
      'Customer',
    ]);
  });

  it('de-dupes case-insensitively', () => {
    expect(parseTagCell('vip, VIP, Lead')).toEqual(['vip', 'Lead']);
  });

  it('returns empty for blank values', () => {
    expect(parseTagCell('')).toEqual([]);
    expect(parseTagCell(undefined)).toEqual([]);
  });
});

describe('parseContactCsv', () => {
  it('parses optional tags column', () => {
    const csv = `phone,name,tags
+15551234567,Alice,"VIP, Lead"
+15559876543,Bob,Customer`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: true,
      hasCompanyColumn: false,
      hasCodesColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: ['VIP', 'Lead'],
          codes: [],
        },
        {
          phone: '+15559876543',
          name: 'Bob',
          email: undefined,
          company: undefined,
          tagNames: ['Customer'],
          codes: [],
        },
      ],
    });
  });

  it('returns empty tagNames when tags column is absent', () => {
    const csv = `phone,name
+15551234567,Alice`;

    expect(parseContactCsv(csv)).toEqual({
      hasTagsColumn: false,
      hasCompanyColumn: false,
      hasCodesColumn: false,
      rows: [
        {
          phone: '+15551234567',
          name: 'Alice',
          email: undefined,
          company: undefined,
          tagNames: [],
          codes: [],
        },
      ],
    });
  });

  it('accepts Portuguese headers (Telefone/Nome/E-mail/Empresa)', () => {
    const csv = `Nome,Telefone,E-mail,Empresa
Alice,+15551234567,alice@ex.com,ACME
Bob,+15559876543,,`;

    const result = parseContactCsv(csv);
    expect(result.hasCompanyColumn).toBe(true);
    expect(result.rows).toEqual([
      {
        phone: '+15551234567',
        name: 'Alice',
        email: 'alice@ex.com',
        company: 'ACME',
        tagNames: [],
        codes: [],
      },
      {
        // Optional cells left blank still import (só o telefone é obrigatório).
        phone: '+15559876543',
        name: 'Bob',
        email: undefined,
        company: undefined,
        tagNames: [],
        codes: [],
      },
    ]);
  });

  it('skips a leading title line before the header row', () => {
    const csv = `clientes-ddd11
Telefone,Nome
5511947650435,Carla`;

    const result = parseContactCsv(csv);
    expect(result.rows).toEqual([
      {
        phone: '5511947650435',
        name: 'Carla',
        email: undefined,
        company: undefined,
        tagNames: [],
        codes: [],
      },
    ]);
  });

  it('returns no rows when there is no recognizable phone column', () => {
    const csv = `foo,bar
1,2`;
    expect(parseContactCsv(csv).rows).toEqual([]);
  });

  it('parses the customer-code column (aliases + multiple codes)', () => {
    const csv = `phone,name,codigo_cliente
+15551234567,Alice,"31768; 31770"
+15559876543,Bob,10023`;

    const result = parseContactCsv(csv);
    expect(result.hasCodesColumn).toBe(true);
    expect(result.rows[0].codes).toEqual(['31768', '31770']);
    expect(result.rows[1].codes).toEqual(['10023']);
  });
});

describe('parseCodeCell', () => {
  it('splits by comma/semicolon, trims, de-dupes case-sensitively', () => {
    expect(parseCodeCell(' 31768 ; 31770, 31768 ')).toEqual(['31768', '31770']);
  });
  it('returns empty for blanks', () => {
    expect(parseCodeCell('')).toEqual([]);
    expect(parseCodeCell(undefined)).toEqual([]);
  });
});

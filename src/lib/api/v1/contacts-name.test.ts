import { beforeEach, describe, expect, it, vi } from 'vitest';

// 01/10: "Endereço pessoal de Fulano" (rótulo da agenda do Google numa
// exportação) entrou como nome com origem 'crm' — que nada automático troca —
// e a saudação saiu "Oi, Endereço!". Banco e dedupe trocados por stubs.
const h = vi.hoisted(() => ({
  inserted: [] as Record<string, unknown>[],
}));

vi.mock('@/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/db')>();
  const db = {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        h.inserted.push(values);
        return { returning: async () => [{ id: 'novo' }] };
      },
    }),
  };
  return { ...actual, db };
});

vi.mock('@/lib/contacts/dedupe', () => ({
  findExistingContact: async () => null,
  isUniqueViolation: () => false,
}));

import { findOrCreateContact } from './contacts';

const phone = '+14155550123';

beforeEach(() => {
  h.inserted = [];
});

describe('findOrCreateContact — nome com rótulo de exportação', () => {
  it('grava o nome SEM o rótulo, ainda com origem crm', async () => {
    const r = await findOrCreateContact('acc', 'user', { phone, name: 'Endereço pessoal de Fulano Exemplo' });
    expect(r).toEqual({ id: 'novo', created: true });
    expect(h.inserted[0]).toMatchObject({ name: 'Fulano Exemplo', nameSource: 'crm' });
  });

  it('nome normal (com "de/da" no meio) passa intacto', async () => {
    await findOrCreateContact('acc', 'user', { phone, name: 'Maria da Silva' });
    expect(h.inserted[0]).toMatchObject({ name: 'Maria da Silva', nameSource: 'crm' });
  });

  it('sem nome: telefone como nome e origem null (como sempre)', async () => {
    await findOrCreateContact('acc', 'user', { phone });
    // sanitizePhoneForMeta grava só os dígitos.
    expect(h.inserted[0]).toMatchObject({ name: '14155550123', nameSource: null });
  });
});

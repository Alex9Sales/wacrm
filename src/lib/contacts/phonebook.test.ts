import { describe, expect, it } from 'vitest';

import { identityKeyOf, planPhonebook } from './phonebook';

describe('agenda do celular — chave de identidade (09/09)', () => {
  it('id do WhatsApp sem o 9º dígito casa com o contato do CRM com o 9º dígito', () => {
    // O gows devolve "556791875477@c.us" (12 dígitos) pro mesmo assinante que
    // o CRM guarda como "5567991875477" (13, com o 9). Mesma pessoa.
    expect(identityKeyOf('556791875477')).toBe('6791875477');
    expect(identityKeyOf('5567991875477')).toBe('6791875477');
    expect(identityKeyOf('+55 (67) 99187-5477')).toBe('6791875477');
  });

  it('DDD faz parte da identidade (caso Vinícius 43 × 47)', () => {
    expect(identityKeyOf('5543996345005')).not.toBe(identityKeyOf('5547996345005'));
  });

  it('número estrangeiro usa os dígitos crus; vazio vira null', () => {
    expect(identityKeyOf('37063949836')).toBe('37063949836');
    expect(identityKeyOf('')).toBeNull();
    expect(identityKeyOf('abc')).toBeNull();
  });
});

describe('agenda do celular — plano (puro)', () => {
  const contacts = [
    { id: 'a', phone: '5567991875477', name: 'Lu 💕', nameSource: 'whatsapp' },
    { id: 'b', phone: '5567999990001', name: 'Poleana Editada', nameSource: 'crm' },
    { id: 'c', phone: '5567999990002', name: '5567999990002', nameSource: null },
    { id: 'd', phone: '5567999990003', name: 'Gerson', nameSource: null },
    { id: 'e', phone: '5567999990004', name: 'Igual', nameSource: 'phonebook' },
  ];
  const entries = [
    { phone: '556791875477', name: 'Luana Dentista' }, // sem o 9 — mesma pessoa que 'a'
    { phone: '556799990001', name: 'Poleana Agenda' },
    { phone: '556799990002', name: 'Cliente Novo Nome' },
    { phone: '556799990003', name: 'Gerson Gás' },
    { phone: '556799990004', name: 'Igual' },
    { phone: '556799990009', name: 'Só na Agenda' },
  ];

  it('modo fill: preenche vazio, troca perfil, mantém legado e CRM, conta quem falta', () => {
    const { summary, updates, creates } = planPhonebook(entries, contacts, {
      mode: 'fill',
      createMissing: true,
      dryRun: true,
    });
    expect(summary).toMatchObject({
      entries: 6, matched: 5, notInCrm: 1, created: 1,
      filled: 1, upgraded: 1, mirrored: 0, overridden: 0,
      keptCrm: 1, keptLegacy: 1, unchanged: 1,
    });
    expect(updates).toEqual([
      { id: 'a', name: 'Luana Dentista' },
      { id: 'c', name: 'Cliente Novo Nome' },
    ]);
    expect(creates).toEqual([{ phone: '556799990009', name: 'Só na Agenda' }]);
    expect(summary.examples).toEqual([{ from: 'Lu 💕', to: 'Luana Dentista' }]);
  });

  it('modo override: troca também o legado, nunca o editado no CRM', () => {
    const { summary, updates } = planPhonebook(entries, contacts, {
      mode: 'override',
      createMissing: false,
      dryRun: true,
    });
    expect(summary).toMatchObject({ overridden: 1, keptCrm: 1, keptLegacy: 0, created: 0 });
    expect(updates.map((u) => u.id).sort()).toEqual(['a', 'c', 'd']);
  });

  it('onlyPhones restringe ao que chegou (webhook da Meta)', () => {
    const { summary } = planPhonebook(entries, contacts, {
      mode: 'fill',
      createMissing: false,
      onlyPhones: ['+55 67 99999-0002'],
    });
    expect(summary).toMatchObject({ entries: 1, filled: 1 });
  });

  it('a 1ª entrada de cada pessoa vence (ordem = prioridade) e nome vazio é ignorado', () => {
    const { summary, updates } = planPhonebook(
      [
        { phone: '556791875477', name: 'Mais Recente' },
        { phone: '5567991875477', name: 'Mais Antigo' },
        { phone: '556799990003', name: '   ' },
      ],
      contacts,
      { mode: 'fill', createMissing: false },
    );
    expect(summary.entries).toBe(1);
    expect(updates).toEqual([{ id: 'a', name: 'Mais Recente' }]);
  });
});

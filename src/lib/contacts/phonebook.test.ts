import { describe, expect, it } from 'vitest';

import { identityKeyOf, planPhonebook } from './phonebook';

describe('agenda do celular — chave de identidade (09/09)', () => {
  it('id do WhatsApp sem o 9º dígito casa com o contato do CRM com o 9º dígito', () => {
    // O gows devolve "556790001234@c.us" (12 dígitos) pro mesmo assinante que
    // o CRM guarda como "5567990001234" (13, com o 9). Mesma pessoa.
    expect(identityKeyOf('556790001234')).toBe('6790001234');
    expect(identityKeyOf('5567990001234')).toBe('6790001234');
    expect(identityKeyOf('+55 (67) 99000-1234')).toBe('6790001234');
  });

  it('DDD faz parte da identidade (caso DDD 43 × 47)', () => {
    expect(identityKeyOf('5543990001234')).not.toBe(identityKeyOf('5547990001234'));
  });

  it('número estrangeiro usa os dígitos crus; vazio vira null', () => {
    expect(identityKeyOf('37063949836')).toBe('37063949836');
    expect(identityKeyOf('')).toBeNull();
    expect(identityKeyOf('abc')).toBeNull();
  });
});

describe('agenda do celular — plano (puro)', () => {
  const contacts = [
    { id: 'a', phone: '5567990001234', name: 'Ca 💕', nameSource: 'whatsapp' },
    { id: 'b', phone: '5567999990001', name: 'Paula Editada', nameSource: 'crm' },
    { id: 'c', phone: '5567999990002', name: '5567999990002', nameSource: null },
    { id: 'd', phone: '5567999990003', name: 'Paulo', nameSource: null },
    { id: 'e', phone: '5567999990004', name: 'Igual', nameSource: 'phonebook' },
  ];
  const entries = [
    { phone: '556790001234', name: 'Carla Dentista' }, // sem o 9 — mesma pessoa que 'a'
    { phone: '556799990001', name: 'Paula Agenda' },
    { phone: '556799990002', name: 'Cliente Novo Nome' },
    { phone: '556799990003', name: 'Paulo Gás' },
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
      { id: 'a', name: 'Carla Dentista' },
      { id: 'c', name: 'Cliente Novo Nome' },
    ]);
    expect(creates).toEqual([{ phone: '556799990009', name: 'Só na Agenda' }]);
    expect(summary.examples).toEqual([{ from: 'Ca 💕', to: 'Carla Dentista' }]);
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
        { phone: '556790001234', name: 'Mais Recente' },
        { phone: '5567990001234', name: 'Mais Antigo' },
        { phone: '556799990003', name: '   ' },
      ],
      contacts,
      { mode: 'fill', createMissing: false },
    );
    expect(summary.entries).toBe(1);
    expect(updates).toEqual([{ id: 'a', name: 'Mais Recente' }]);
  });
});

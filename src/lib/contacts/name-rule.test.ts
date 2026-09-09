import { describe, expect, it } from 'vitest';

import {
  asNameSource,
  decideContactName,
  hasRealName,
  isBarePhone,
  nameSourceLabel,
} from './name-rule';

const phone = '5567991875477';

describe('regra do nome do contato (09/09)', () => {
  it('telefone disfarçado de nome não conta como nome', () => {
    expect(isBarePhone('+55 67 99187-5477')).toBe(true);
    expect(isBarePhone('5567991875477')).toBe(true);
    expect(isBarePhone('Alex Sales')).toBe(false);
    expect(hasRealName('', phone)).toBe(false);
    expect(hasRealName(phone, phone)).toBe(false);
    expect(hasRealName('Alex', phone)).toBe(true);
  });

  it('sem nome de verdade: qualquer origem preenche', () => {
    for (const source of ['whatsapp', 'phonebook', null] as const) {
      expect(
        decideContactName({
          current: { name: phone, phone, source: null },
          incoming: { name: 'Alex', source },
        }),
      ).toEqual({ apply: true, reason: 'fill' });
    }
  });

  it('nome vindo vazio ou só telefone nunca grava', () => {
    expect(
      decideContactName({
        current: { name: '', phone, source: null },
        incoming: { name: '  ', source: 'phonebook' },
      }),
    ).toEqual({ apply: false, reason: 'empty-incoming' });
    expect(
      decideContactName({
        current: { name: '', phone, source: null },
        incoming: { name: '+55 67 99187-5477', source: 'whatsapp' },
      }),
    ).toEqual({ apply: false, reason: 'empty-incoming' });
  });

  it('nome digitado no CRM sempre vence (o caso do Alex)', () => {
    for (const source of ['whatsapp', 'phonebook', null] as const) {
      expect(
        decideContactName({
          current: { name: 'Luan Cliente', phone, source: 'crm' },
          incoming: { name: 'Lu 💕', source },
          mode: 'override',
        }),
      ).toEqual({ apply: false, reason: 'crm-wins' });
    }
  });

  it('nome de perfil do WhatsApp só preenche — nunca troca um nome existente', () => {
    expect(
      decideContactName({
        current: { name: 'Lu 💕', phone, source: 'whatsapp' },
        incoming: { name: 'Luana', source: 'whatsapp' },
      }),
    ).toEqual({ apply: false, reason: 'lower-priority' });
    expect(
      decideContactName({
        current: { name: 'Luana Dentista', phone, source: null },
        incoming: { name: 'Lu 💕', source: 'whatsapp' },
      }),
    ).toEqual({ apply: false, reason: 'lower-priority' });
  });

  it('agenda do celular troca nome de perfil e acompanha a própria agenda', () => {
    expect(
      decideContactName({
        current: { name: 'Lu 💕', phone, source: 'whatsapp' },
        incoming: { name: 'Luana Dentista', source: 'phonebook' },
      }),
    ).toEqual({ apply: true, reason: 'upgrade' });
    expect(
      decideContactName({
        current: { name: 'Luana Dentista', phone, source: 'phonebook' },
        incoming: { name: 'Luana Dentista Campo Grande', source: 'phonebook' },
      }),
    ).toEqual({ apply: true, reason: 'mirror' });
  });

  it('nome legado (origem desconhecida) só troca no modo "agenda do celular manda"', () => {
    const current = { name: 'Luana', phone, source: null };
    expect(
      decideContactName({ current, incoming: { name: 'Luana Dentista', source: 'phonebook' } }),
    ).toEqual({ apply: false, reason: 'legacy-kept' });
    expect(
      decideContactName({
        current,
        incoming: { name: 'Luana Dentista', source: 'phonebook' },
        mode: 'fill',
      }),
    ).toEqual({ apply: false, reason: 'legacy-kept' });
    expect(
      decideContactName({
        current,
        incoming: { name: 'Luana Dentista', source: 'phonebook' },
        mode: 'override',
      }),
    ).toEqual({ apply: true, reason: 'override' });
  });

  it('formulário/API troca perfil e legado (como sempre), mas não a agenda nem o CRM', () => {
    expect(
      decideContactName({
        current: { name: 'Lu 💕', phone, source: 'whatsapp' },
        incoming: { name: 'Luana Silva', source: null },
      }),
    ).toEqual({ apply: true, reason: 'override' });
    expect(
      decideContactName({
        current: { name: 'Luana Dentista', phone, source: 'phonebook' },
        incoming: { name: 'Luana Silva', source: null },
      }),
    ).toEqual({ apply: false, reason: 'phonebook-wins' });
  });

  it('mesmo nome = nada a fazer', () => {
    expect(
      decideContactName({
        current: { name: 'Luana', phone, source: 'whatsapp' },
        incoming: { name: ' Luana ', source: 'phonebook' },
      }),
    ).toEqual({ apply: false, reason: 'same' });
  });

  it('origem crua do banco vira enum seguro + rótulo', () => {
    expect(asNameSource('crm')).toBe('crm');
    expect(asNameSource('qualquer')).toBeNull();
    expect(asNameSource(null)).toBeNull();
    expect(nameSourceLabel('phonebook')).toBe('Nome da agenda do celular');
    expect(nameSourceLabel(null)).toBeNull();
  });
});

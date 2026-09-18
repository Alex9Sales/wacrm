import { describe, it, expect } from 'vitest';
import {
  renderMessageVars,
  renderForContact,
  contactTokenValues,
} from './message-vars';

describe('renderForContact', () => {
  const contact = {
    name: 'Maria Silva Souza',
    phone: '+5567999998888',
    email: 'maria@ex.com',
    company: 'Acme',
  };

  it('replaces supported tokens', () => {
    expect(renderForContact('Olá {{primeiro_nome}}!', contact)).toBe('Olá Maria!');
    expect(renderForContact('{{nome}} — {{empresa}}', contact)).toBe(
      'Maria Silva Souza — Acme',
    );
    expect(renderForContact('tel {{telefone}}', contact)).toBe('tel +5567999998888');
  });

  it('is case-insensitive and tolerates spaces', () => {
    expect(renderForContact('Oi {{ Primeiro_Nome }}', contact)).toBe('Oi Maria');
  });

  it('uses the |fallback when the value is empty', () => {
    expect(renderForContact('Olá {{primeiro_nome|cliente}}!', { name: '' })).toBe(
      'Olá cliente!',
    );
    // present value ignores the fallback
    expect(renderForContact('Olá {{primeiro_nome|cliente}}!', contact)).toBe(
      'Olá Maria!',
    );
  });

  it('drops a valueless token together with the separator before it', () => {
    expect(renderForContact('Olá {{primeiro_nome}}!', { name: null })).toBe('Olá!');
    expect(renderForContact('Boa tarde, {{primeiro_nome}}! Tudo bem?', { name: null })).toBe(
      'Boa tarde! Tudo bem?',
    );
    expect(renderForContact('Olá {{primeiro_nome}}, tudo bem?', { name: '' })).toBe(
      'Olá, tudo bem?',
    );
    // token no começo: a vírgula de depois some junto
    expect(renderForContact('{{primeiro_nome}}, tudo bem?', { name: '' })).toBe('tudo bem?');
    expect(renderForContact('Oi, {{primeiro_nome}}, tudo bem?', { name: '' })).toBe('Oi, tudo bem?');
    expect(renderForContact('{{primeiro_nome}}, tudo bem?', contact)).toBe('Maria, tudo bem?');
    // quebra de linha antes do token NÃO some
    expect(renderForContact('Linha\n{{primeiro_nome}}', { name: '' })).toBe('Linha\n');
    // com valor, o separador fica
    expect(renderForContact('Boa tarde, {{primeiro_nome}}!', contact)).toBe('Boa tarde, Maria!');
  });

  // Agenda real da GoLink (18/09): "Boa tarde, Dr.!" / "Boa tarde, +55!".
  it('never greets with a title alone, a number or an emoji', () => {
    const msg = 'Boa tarde, {{primeiro_nome}}!';
    expect(renderForContact(msg, { name: 'Dr. João Silva' })).toBe('Boa tarde, Dr. João!');
    expect(renderForContact(msg, { name: 'Dra. Ana' })).toBe('Boa tarde, Dra. Ana!');
    expect(renderForContact(msg, { name: 'Dr.' })).toBe('Boa tarde!');
    expect(renderForContact(msg, { name: '+55 12 99123-4567' })).toBe('Boa tarde!');
    expect(renderForContact(msg, { name: '💎 Carla Souza' })).toBe('Boa tarde, Carla!');
    expect(renderForContact(msg, { name: 'Google Ads Suporte' })).toBe('Boa tarde!');
    expect(renderForContact(msg, { name: 'XJZ Materiais' })).toBe('Boa tarde!');
    expect(renderForContact(msg, { name: 'FERNANDO LIMA' })).toBe('Boa tarde, Fernando!');
    expect(renderForContact('Olá {{primeiro_nome|cliente}}!', { name: 'Dr.' })).toBe('Olá cliente!');
  });

  it('leaves unknown tokens untouched', () => {
    expect(renderForContact('{{desconhecido}} fica', contact)).toBe(
      '{{desconhecido}} fica',
    );
  });

  it('replaces every occurrence', () => {
    expect(renderForContact('{{primeiro_nome}} {{primeiro_nome}}', contact)).toBe(
      'Maria Maria',
    );
  });
});

describe('contactTokenValues', () => {
  it('derives first name from the full name', () => {
    expect(contactTokenValues({ name: '  João  Pedro ' }).primeiro_nome).toBe('João');
    expect(contactTokenValues({ name: '' }).primeiro_nome).toBe('');
  });
});

describe('renderMessageVars', () => {
  it('works with a plain values map', () => {
    expect(renderMessageVars('x {{a}} y', { a: '1' })).toBe('x 1 y');
  });
});

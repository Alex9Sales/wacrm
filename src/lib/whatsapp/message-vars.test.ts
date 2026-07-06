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

  it('empties a valueless token with no fallback', () => {
    expect(renderForContact('Olá {{primeiro_nome}}!', { name: null })).toBe('Olá !');
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

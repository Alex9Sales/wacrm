import { describe, expect, it } from 'vitest';

import {
  asNameSource,
  decideContactName,
  hasRealName,
  isBarePhone,
  nameSourceLabel,
  stripContactExportPrefix,
} from './name-rule';

// 01/10: "Endereço pessoal de Fulano" entrou como nome com origem 'crm' (que
// nada automático troca) e a saudação saiu "Oi, Endereço!".
describe('stripContactExportPrefix', () => {
  it('tira o rótulo de exportação inteiro do começo', () => {
    expect(stripContactExportPrefix('Endereço pessoal de Fulano Exemplo')).toBe('Fulano Exemplo');
    expect(stripContactExportPrefix('Endereço comercial da Beltrana')).toBe('Beltrana');
    expect(stripContactExportPrefix('Endereço residencial do Ciclano')).toBe('Ciclano');
    expect(stripContactExportPrefix('Endereço profissional de Fulano')).toBe('Fulano');
    expect(stripContactExportPrefix('  Endereço pessoal de   Fulano  ')).toBe('Fulano');
  });

  it('sem acento, qualquer caixa, decomposto (NFD)', () => {
    expect(stripContactExportPrefix('Endereco pessoal de Fulano')).toBe('Fulano');
    expect(stripContactExportPrefix('ENDEREÇO COMERCIAL DE FULANO')).toBe('FULANO');
    expect(stripContactExportPrefix('Endereço pessoal de Fulano'.normalize('NFD'))).toBe('Fulano');
  });

  it('nunca remove "de/da/do" soltos nem rótulo fora do começo', () => {
    expect(stripContactExportPrefix('Maria da Silva')).toBe('Maria da Silva');
    expect(stripContactExportPrefix('Ana de Souza')).toBe('Ana de Souza');
    expect(stripContactExportPrefix('Fulano Endereço pessoal de Beltrano')).toBe(
      'Fulano Endereço pessoal de Beltrano',
    );
    // "Endereço" sem o tipo (pessoal/comercial…) não é o rótulo
    expect(stripContactExportPrefix('Endereço de Fulano')).toBe('Endereço de Fulano');
  });

  it('sem nada depois do rótulo, devolve o original (não grava nome vazio)', () => {
    expect(stripContactExportPrefix('Endereço pessoal de')).toBe('Endereço pessoal de');
    expect(stripContactExportPrefix('Endereço pessoal de   ')).toBe('Endereço pessoal de   ');
  });

  it('sem rótulo devolve o MESMO texto (não normaliza à toa)', () => {
    const nfd = 'João'.normalize('NFD');
    expect(stripContactExportPrefix(nfd)).toBe(nfd);
  });
});

const phone = '5567990001234';

describe('regra do nome do contato (09/09)', () => {
  it('telefone disfarçado de nome não conta como nome', () => {
    expect(isBarePhone('+55 67 99000-1234')).toBe(true);
    expect(isBarePhone('5567990001234')).toBe(true);
    expect(isBarePhone('Paulo Exemplo')).toBe(false);
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
        incoming: { name: '+55 67 99000-1234', source: 'whatsapp' },
      }),
    ).toEqual({ apply: false, reason: 'empty-incoming' });
  });

  it('nome digitado no CRM sempre vence (o caso do Alex)', () => {
    for (const source of ['whatsapp', 'phonebook', null] as const) {
      expect(
        decideContactName({
          current: { name: 'Carla Cliente', phone, source: 'crm' },
          incoming: { name: 'Cacá 🌷', source },
          mode: 'override',
        }),
      ).toEqual({ apply: false, reason: 'crm-wins' });
    }
  });

  it('nome de perfil do WhatsApp só preenche — nunca troca um nome existente', () => {
    expect(
      decideContactName({
        current: { name: 'Cacá 🌷', phone, source: 'whatsapp' },
        incoming: { name: 'Carla', source: 'whatsapp' },
      }),
    ).toEqual({ apply: false, reason: 'lower-priority' });
    expect(
      decideContactName({
        current: { name: 'Carla Professora', phone, source: null },
        incoming: { name: 'Cacá 🌷', source: 'whatsapp' },
      }),
    ).toEqual({ apply: false, reason: 'lower-priority' });
  });

  it('agenda do celular troca nome de perfil e acompanha a própria agenda', () => {
    expect(
      decideContactName({
        current: { name: 'Cacá 🌷', phone, source: 'whatsapp' },
        incoming: { name: 'Carla Professora', source: 'phonebook' },
      }),
    ).toEqual({ apply: true, reason: 'upgrade' });
    expect(
      decideContactName({
        current: { name: 'Carla Professora', phone, source: 'phonebook' },
        incoming: { name: 'Carla Professora Centro', source: 'phonebook' },
      }),
    ).toEqual({ apply: true, reason: 'mirror' });
  });

  it('nome legado (origem desconhecida) só troca no modo "agenda do celular manda"', () => {
    const current = { name: 'Carla', phone, source: null };
    expect(
      decideContactName({ current, incoming: { name: 'Carla Professora', source: 'phonebook' } }),
    ).toEqual({ apply: false, reason: 'legacy-kept' });
    expect(
      decideContactName({
        current,
        incoming: { name: 'Carla Professora', source: 'phonebook' },
        mode: 'fill',
      }),
    ).toEqual({ apply: false, reason: 'legacy-kept' });
    expect(
      decideContactName({
        current,
        incoming: { name: 'Carla Professora', source: 'phonebook' },
        mode: 'override',
      }),
    ).toEqual({ apply: true, reason: 'override' });
  });

  it('formulário/API troca perfil e legado (como sempre), mas não a agenda nem o CRM', () => {
    expect(
      decideContactName({
        current: { name: 'Cacá 🌷', phone, source: 'whatsapp' },
        incoming: { name: 'Carla Teste', source: null },
      }),
    ).toEqual({ apply: true, reason: 'override' });
    expect(
      decideContactName({
        current: { name: 'Carla Professora', phone, source: 'phonebook' },
        incoming: { name: 'Carla Teste', source: null },
      }),
    ).toEqual({ apply: false, reason: 'phonebook-wins' });
  });

  it('mesmo nome = nada a fazer', () => {
    expect(
      decideContactName({
        current: { name: 'Carla', phone, source: 'whatsapp' },
        incoming: { name: ' Carla ', source: 'phonebook' },
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

/**
 * O modo "trocar também os nomes que eu digitei aqui" (29/09, GoLink) afrouxa a
 * regra mais protegida do arquivo — a de 09/09, "nome digitado no CRM nunca é
 * trocado por nada automático". O que precisa de teste é o CONTORNO dele: que
 * só a agenda passe, que só passe quando alguém escolheu, e que o automático de
 * 6 em 6 h siga sem poder encostar.
 */
describe('modo "trocar também o que eu digitei" (override-crm)', () => {
  const crmAtual = {
    name: 'Abner',
    phone: '5512999998888',
    source: 'crm' as const,
  }

  it('o caso do João: a agenda passa a valer quando ELE escolhe', () => {
    const d = decideContactName({
      current: crmAtual,
      incoming: { name: 'Abner - Kero Shake & Açaí', source: 'phonebook' },
      mode: 'override-crm',
    })
    expect(d).toEqual({ apply: true, reason: 'override-crm' })
  })

  it('sem escolher o modo, o nome do CRM continua intocável', () => {
    for (const mode of ['fill', 'override', undefined] as const) {
      const d = decideContactName({
        current: crmAtual,
        incoming: { name: 'Abner - Kero Shake & Açaí', source: 'phonebook' },
        mode,
      })
      expect(d).toEqual({ apply: false, reason: 'crm-wins' })
    }
  })

  it('só a AGENDA derruba o nome do CRM — perfil e formulário, nunca', () => {
    // É o que a regra de 09/09 existia para barrar, e continua barrado mesmo
    // com o modo ligado: o nome de perfil do WhatsApp muda sozinho, o do
    // formulário vem de quem preencheu sem saber o que já havia.
    expect(
      decideContactName({
        current: crmAtual,
        incoming: { name: 'Abner 🔥', source: 'whatsapp' },
        mode: 'override-crm',
      }),
    ).toEqual({ apply: false, reason: 'crm-wins' })
    expect(
      decideContactName({
        current: crmAtual,
        incoming: { name: 'ABNER SILVA', source: null },
        mode: 'override-crm',
      }),
    ).toEqual({ apply: false, reason: 'crm-wins' })
  })

  it('não inventa mudança quando o nome já é o mesmo', () => {
    expect(
      decideContactName({
        current: crmAtual,
        incoming: { name: 'Abner', source: 'phonebook' },
        mode: 'override-crm',
      }),
    ).toEqual({ apply: false, reason: 'same' })
  })

  it('agenda vazia ou só com o número não apaga o nome do CRM', () => {
    for (const nome of ['', '  ', '5512999998888']) {
      expect(
        decideContactName({
          current: crmAtual,
          incoming: { name: nome, source: 'phonebook' },
          mode: 'override-crm',
        }).apply,
      ).toBe(false)
    }
  })
})

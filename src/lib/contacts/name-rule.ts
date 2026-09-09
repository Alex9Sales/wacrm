// ============================================================
// 📒 Regra do NOME do contato — quem pode trocar o quê (09/09/2026).
//
// Caso do Alex: "mudei o nome no CRM e voltou pro nome do WhatsApp" + "quero
// o contato no CRM do jeito que salvei no celular". A partir daqui todo nome
// carrega a ORIGEM (contacts.name_source) e a prioridade é fixa:
//
//   crm (digitado no CRM)  >  phonebook (agenda do celular)  >
//   formulário/API (origem null)  >  whatsapp (nome de perfil / pushName)  >
//   telefone (sem nome)
//
// * Nome digitado no CRM NUNCA é trocado por nada automático.
// * A agenda do celular troca nome de perfil e acompanha a própria agenda
//   (se mudou no celular, muda aqui). Nome legado sem origem conhecida só
//   é trocado no modo "agenda do celular manda" (escolha explícita no import).
// * Nome de perfil do WhatsApp só PREENCHE quem ainda não tem nome.
//
// Puro (sem banco) pra ser testável e usado no inbound, no import da agenda,
// no webhook da Meta e no resolve-conversation.
// ============================================================

/** Origem do nome gravado em contacts.name_source. null = legado/formulário/API. */
export type NameSource = 'crm' | 'phonebook' | 'whatsapp';

/**
 * Modo do import da agenda:
 *  - 'fill' (padrão, seguro): preenche vazio/telefone, troca nome de perfil e
 *    acompanha a agenda; nome legado (origem desconhecida) fica como está.
 *  - 'override' ("agenda do celular manda"): além do acima, troca também o
 *    nome legado. Nome digitado no CRM continua intocável.
 */
export type NameMode = 'fill' | 'override';

export type NameDecision =
  | { apply: true; reason: 'fill' | 'upgrade' | 'mirror' | 'override' }
  | {
      apply: false;
      reason:
        | 'empty-incoming'
        | 'same'
        | 'crm-wins'
        | 'phonebook-wins'
        | 'legacy-kept'
        | 'lower-priority';
    };

/** "+55 67 9999-9999", "5567999999999" — um telefone disfarçado de nome. */
export function isBarePhone(s: string | null | undefined): boolean {
  if (!s) return false;
  return /^\+?\d[\d\s()\-]{4,}$/.test(s.trim());
}

/** Tem um nome de verdade (não vazio, não o próprio telefone)? */
export function hasRealName(name: string | null | undefined, phone: string): boolean {
  const n = (name ?? '').trim();
  if (!n) return false;
  if (n === phone.trim()) return false;
  return !isBarePhone(n);
}

const KNOWN_SOURCES: ReadonlySet<string> = new Set(['crm', 'phonebook', 'whatsapp']);

/** Normaliza o valor cru do banco pra `NameSource | null`. */
export function asNameSource(v: unknown): NameSource | null {
  return typeof v === 'string' && KNOWN_SOURCES.has(v) ? (v as NameSource) : null;
}

/**
 * Decide se `incoming.name` (vindo de `incoming.source`) deve substituir o
 * nome atual do contato. Nunca grava — só decide.
 */
export function decideContactName(input: {
  current: { name: string | null | undefined; phone: string; source: NameSource | null | undefined };
  incoming: { name: string | null | undefined; source: NameSource | null };
  mode?: NameMode;
}): NameDecision {
  const incoming = (input.incoming.name ?? '').trim();
  if (!incoming || isBarePhone(incoming)) return { apply: false, reason: 'empty-incoming' };

  const current = (input.current.name ?? '').trim();
  if (!hasRealName(current, input.current.phone)) return { apply: true, reason: 'fill' };
  if (incoming === current) return { apply: false, reason: 'same' };

  const currentSource = asNameSource(input.current.source);
  if (currentSource === 'crm') return { apply: false, reason: 'crm-wins' };

  switch (input.incoming.source) {
    case 'whatsapp':
      // Nome de perfil só preenche — nunca troca um nome que já existe.
      return { apply: false, reason: 'lower-priority' };
    case 'phonebook':
      if (currentSource === 'phonebook') return { apply: true, reason: 'mirror' };
      if (currentSource === 'whatsapp') return { apply: true, reason: 'upgrade' };
      // Legado (origem desconhecida): pode ter sido digitado no CRM antes da
      // migração — só troca quando a pessoa escolheu "agenda do celular manda".
      return input.mode === 'override'
        ? { apply: true, reason: 'override' }
        : { apply: false, reason: 'legacy-kept' };
    default:
      // Formulário público / API / lead de anúncio: acima do nome de perfil e
      // do legado (comportamento de sempre), abaixo da agenda e do CRM.
      if (currentSource === 'phonebook') return { apply: false, reason: 'phonebook-wins' };
      return { apply: true, reason: 'override' };
  }
}

/** Rótulo curto da origem pra UI (ficha do contato). */
export function nameSourceLabel(source: unknown): string | null {
  switch (asNameSource(source)) {
    case 'crm':
      return 'Nome editado no CRM';
    case 'phonebook':
      return 'Nome da agenda do celular';
    case 'whatsapp':
      return 'Nome do perfil do WhatsApp';
    default:
      return null;
  }
}

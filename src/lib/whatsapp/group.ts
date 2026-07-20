// ============================================================
// Pure helpers for WhatsApp GROUP ingestion (Grupos Fase 1, etapa D).
//
// Getting group classification WRONG is dangerous in two directions:
//   - a false positive routes a real 1:1 customer into the group path
//     (customer lost from the normal inbox);
//   - a false negative drops a monitored group's messages.
// So the jid classification and the group "contact" key live here, pinned
// down by tests. The DB side (opt-in lookup, contact/conversation) stays in
// inbound.ts — this module is pure.
// ============================================================

/**
 * True only for a WhatsApp GROUP jid. Matches the suffixed form (`…@g.us`)
 * AND the bare numeric id shape that WAHA NOWEB sometimes delivers with the
 * `@g.us` suffix stripped (e.g. `120363400053019227`) — WhatsApp group ids are
 * long (16+ digits, usually prefixed `120363`) while an E.164 phone is at most
 * 15 digits.
 *
 * Deliberately EXCLUDES newsletters (`@newsletter`), broadcast (`@broadcast`),
 * status (`status@…`) and direct phones (`…@s.whatsapp.net` / `…@c.us` /
 * `…@lid`): those keep a non-`g.us` suffix, so anything carrying an `@` that
 * isn't `@g.us` is not a group here.
 */
export function isGroupJid(jid: string): boolean {
  if (!jid) return false;
  if (/@g\.us$/i.test(jid)) return true;
  // Any other suffix (newsletter/broadcast/status/phone/@lid) → not a group.
  if (jid.includes('@')) return false;
  // Bare, suffix-less numeric id too long to be a phone → group that lost its
  // suffix.
  return /^\d{16,}$/.test(jid);
}

/**
 * The digits of a group jid — the stable key we store in `contacts.phone`
 * for a group "contact" (and match against `monitored_groups.group_jid`).
 * Normalizing both sides to digits makes the opt-in lookup robust to the
 * `@g.us`-vs-bare mismatch between the picker (`GET /groups`) and inbound.
 */
export function groupJidDigits(jid: string): string {
  return jid.split('@')[0].replace(/\D/g, '');
}

/**
 * Prefix a group message with its author so a single group thread stays
 * legible ("Fulano: mensagem") — the agent reads one conversation, not N
 * anonymous lines. Empty/blank author (or our own echo) → text unchanged.
 */
export function prefixGroupAuthor(authorName: string, text: string): string {
  const a = (authorName ?? '').trim();
  if (!a) return text;
  return `${a}: ${text}`;
}

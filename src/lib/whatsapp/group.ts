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

/**
 * The "user" part of each mentioned jid — the LID user-part or the phone
 * digits (WhatsApp puts one of these, not a name, into the message text as
 * "@<user>"). Strips the `@suffix` and any `:device` tag; drops non-digits.
 */
export function mentionUsers(mentionedJids: unknown): string[] {
  if (!Array.isArray(mentionedJids)) return [];
  const out: string[] = [];
  for (const j of mentionedJids) {
    if (typeof j !== 'string') continue;
    const user = j.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (user) out.push(user);
  }
  return out;
}

/** One group participant reduced to the two ids we key on: the LID user-part
 *  (the @mention token in an @lid group) and the phone digits (the `contacts`
 *  key). Either may be absent. */
export interface GroupParticipantIds {
  /** LID user-part (digits only). */
  lidUser?: string;
  /** Phone digits (E.164 without the +). */
  phone?: string;
}

/**
 * Reduce a gows/WAHA group Participants array to (LID user-part, phone digits)
 * pairs. The engine gives each participant a jid carrying `@lid` (the mention
 * token) and a phone jid carrying `@s.whatsapp.net` (or `@c.us`), plus in some
 * serializations a bare `PhoneNumber`/`PN`/`LID` field. Classification is by
 * jid suffix first (robust to field-name drift), falling back to the field name
 * only for bare numeric values. Anything unrecognized is skipped. This is the
 * bridge that lets an @lid mention of someone who never posted resolve to a
 * saved contact by phone.
 */
export function parseGroupParticipants(raw: unknown): GroupParticipantIds[] {
  if (!Array.isArray(raw)) return [];
  const out: GroupParticipantIds[] = [];
  for (const p of raw) {
    if (!p || typeof p !== 'object') continue;
    let lidUser = '';
    let phone = '';
    for (const [key, val] of Object.entries(p as Record<string, unknown>)) {
      if (typeof val !== 'string' || !val) continue;
      const at = val.indexOf('@');
      const suffix = at >= 0 ? val.slice(at).toLowerCase() : '';
      const digits = val.split('@')[0].split(':')[0].replace(/\D/g, '');
      if (!digits) continue;
      if (suffix === '@lid') {
        if (!lidUser) lidUser = digits;
      } else if (suffix === '@s.whatsapp.net' || suffix === '@c.us') {
        if (!phone) phone = digits;
      } else if (!suffix) {
        // Bare numeric value — disambiguate by the field name.
        const k = key.toLowerCase();
        if (k === 'lid') {
          if (!lidUser) lidUser = digits;
        } else if (k === 'phonenumber' || k === 'pn' || k === 'phone') {
          if (!phone) phone = digits;
        }
      }
    }
    if (lidUser || phone) {
      out.push({ lidUser: lidUser || undefined, phone: phone || undefined });
    }
  }
  return out;
}

/**
 * Rewrite "@<user>" mention tokens in a group message to "@<name>", the way
 * WhatsApp shows them. `users` is the set of mentioned user-parts (from
 * mentionUsers); `nameByUser` maps a user-part to a known display name. An
 * unknown user is left as the raw number — exactly like WhatsApp when it
 * doesn't know the contact.
 */
export function resolveGroupMentions(
  text: string,
  users: string[],
  nameByUser: Record<string, string>,
): string {
  if (!text || !users.length) return text;
  let out = text;
  // Longest user-part first so "@12345" never rewrites inside "@123456789".
  for (const user of [...users].sort((a, b) => b.length - a.length)) {
    const name = nameByUser[user];
    if (!name) continue;
    out = out.split(`@${user}`).join(`@${name}`);
  }
  return out;
}

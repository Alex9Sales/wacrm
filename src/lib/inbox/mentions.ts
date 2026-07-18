// ============================================================
// Parse @mentions out of a message against the account's members. Pure +
// tested: mentioning the WRONG person (or missing one) is the failure mode.
//
// Longer names are matched first and consumed, so "@Ana Paula" resolves to
// Ana Paula only — not also to a separate "Ana". Matching is case-insensitive
// and requires a boundary after the name so "@Ana" doesn't fire inside
// "@Anabela".
// ============================================================

export interface MentionMember {
  id: string;
  name: string | null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The ids of members @-mentioned in `text`. Order follows first appearance
 *  of the longer names; duplicates removed. */
export function parseMentions(
  text: string,
  members: MentionMember[],
): string[] {
  if (!text || !text.includes('@')) return [];
  let remaining = text;
  const ids: string[] = [];
  // Longest names first: consume "@Ana Paula" before a bare "@Ana" can match.
  const sorted = [...members]
    .filter((m) => m.name && m.name.trim())
    .sort((a, b) => (b.name!.length ?? 0) - (a.name!.length ?? 0));
  for (const m of sorted) {
    const name = m.name!.trim();
    // Boundary after the name: not another letter/digit (so "@Ana" won't fire
    // in "@Anabela"), but a space/punctuation/end is fine.
    const re = new RegExp(`@${escapeRegex(name)}(?![\\p{L}\\p{N}])`, 'iu');
    if (re.test(remaining)) {
      ids.push(m.id);
      remaining = remaining.replace(re, ' '); // consume so shorter names inside don't re-match
    }
  }
  return Array.from(new Set(ids));
}

/** True when the caret is inside an active "@query" token — drives the
 *  autocomplete. Returns the partial query (after the @) or null. */
export function activeMentionQuery(
  text: string,
  caret: number,
): string | null {
  const upto = text.slice(0, caret);
  // The @ must start a token (start of string or after whitespace), and the
  // query so far can't contain whitespace (a name with a space is still being
  // typed word-by-word — we match on the first word and let the list narrow).
  const m = upto.match(/(?:^|\s)@([\p{L}\p{N}]*)$/u);
  return m ? m[1] : null;
}

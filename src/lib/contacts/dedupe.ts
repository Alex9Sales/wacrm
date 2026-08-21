import { and, eq, inArray, sql } from "drizzle-orm";

import { db, contacts } from "@/db";
import { normalizePhone, phonesMatch } from "@/lib/whatsapp/phone-utils";

/** Last-8 suffix — the fuzzy (9th-digit / trunk-tolerant) match key. */
export function last8(phone: string): string {
  const n = normalizePhone(phone);
  return n.length >= 8 ? n.slice(-8) : n;
}

/**
 * Contact de-duplication helpers, shared by the WhatsApp webhook, the
 * manual contact form, and CSV import so all paths agree on what
 * "same number" means (issue #212).
 *
 * The canonical key is `normalizePhone` (digits-only) — the same form
 * the DB stores in the generated `contacts.phone_normalized` column
 * and enforces unique per account. `phonesMatch` adds trunk-prefix
 * tolerance (last-8-digit match) for the softer "possible duplicate"
 * surfaces.
 */

/** Canonical de-dup key for a phone string (digits only). */
export function normalizeKey(phone: string): string {
  return normalizePhone(phone);
}

/** Minimal shape we need back from a contacts lookup. */
export interface ExistingContact {
  id: string;
  phone: string;
  name?: string | null;
  [key: string]: unknown;
}

/**
 * Find an existing contact in `accountId` whose phone matches `phone`,
 * or null. Pre-filters in SQL by the last-8-digit suffix (so we don't
 * pull every contact), then applies the strict `phonesMatch` in JS on
 * the small candidate set — the exact approach the webhook has used.
 */
export async function findExistingContact(
  accountId: string,
  phone: string,
): Promise<ExistingContact | null> {
  const normalized = normalizePhone(phone);
  if (!normalized) return null;

  const suffix = normalized.length >= 8 ? normalized.slice(-8) : normalized;

  let data: ExistingContact[];
  try {
    data = (await db
      .select()
      .from(contacts)
      .where(
        and(
          eq(contacts.accountId, accountId),
          // Índice idx_contacts_account_phone_suffix (migr 0111): mata o Seq
          // Scan por-inbound. Mesmo padrão do caminho em lote (right(...,8)).
          sql`right(${contacts.phoneNormalized}, 8) = ${suffix}`,
        ),
      )) as unknown as ExistingContact[];
  } catch {
    return null;
  }

  return data.find((c) => phonesMatch(c.phone, phone)) ?? null;
}

/**
 * True when an existing contact is an *exact* normalized match for
 * `phone` (vs only a fuzzy trunk-variant match). The form hard-blocks
 * exact matches but only warns on fuzzy ones.
 */
export function isExactMatch(existing: ExistingContact, phone: string): boolean {
  return normalizeKey(existing.phone) === normalizeKey(phone);
}

/**
 * True for a Postgres unique-constraint violation (SQLSTATE 23505).
 * Used as the backstop when the DB unique index rejects a racing or
 * format-equal insert that slipped past the in-app check. Drizzle may
 * wrap the driver error, so `cause` is checked too.
 */
export function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ((error as { code?: string }).code === "23505") return true;
  const cause = (error as { cause?: unknown }).cause;
  if (cause && typeof cause === "object") {
    return (cause as { code?: string }).code === "23505";
  }
  return false;
}

/**
 * Resolve a batch of phones to contact ids in `accountId`, creating the ones
 * that don't already exist — using the SAME fuzzy (last-8) dedup the WhatsApp
 * webhook uses. This is the fix for CSV/broadcast imports spawning a duplicate
 * when a Brazilian 9th-digit / trunk variant ("+55DDD9XXXXXXXX") is imported
 * against an existing "55DDDXXXXXXXX" (or vice-versa): exact-phone matching
 * missed it, fuzzy matching finds it. Also collapses variants that appear
 * within the same batch, so importing both forms at once creates one contact.
 *
 * Returns a Map keyed by the ORIGINAL phone string → contact id (only phones
 * that resolved/created; blanks are skipped). `userId` fills the NOT NULL
 * contacts.user_id on rows this creates.
 */
export async function resolveOrCreateContactIdsByPhone(
  accountId: string,
  userId: string,
  rows: { phone: string; name?: string | null }[],
): Promise<Map<string, string>> {
  const byInputPhone = new Map<string, string>();

  // Unique input phones (raw string), first name-per-phone wins.
  const nameByPhone = new Map<string, string | null>();
  const phones: string[] = [];
  for (const r of rows) {
    const phone = (r.phone ?? "").trim();
    if (!phone || !normalizePhone(phone)) continue;
    if (!nameByPhone.has(phone)) {
      nameByPhone.set(phone, r.name ?? null);
      phones.push(phone);
    }
  }
  if (phones.length === 0) return byInputPhone;

  // One query: pull every account contact sharing a last-8 suffix with the
  // batch, then match with the shared fuzzy rule (keeps it 9th-digit tolerant).
  const suffixes = [...new Set(phones.map(last8).filter(Boolean))];
  let existing: { id: string; phone: string }[] = [];
  try {
    existing = (await db
      .select({ id: contacts.id, phone: contacts.phone })
      .from(contacts)
      .where(
        and(
          eq(contacts.accountId, accountId),
          inArray(sql`right(${contacts.phoneNormalized}, 8)`, suffixes),
        ),
      )) as { id: string; phone: string }[];
  } catch {
    existing = [];
  }
  const resolve = (phone: string) =>
    existing.find((c) => c.phone && phonesMatch(c.phone, phone)) ?? null;

  // Insert the genuinely-missing, deduped by last-8 within the batch so two
  // forms of the same person imported together don't both insert.
  const seenNew = new Set<string>();
  const toCreate: {
    userId: string;
    accountId: string;
    phone: string;
    name: string | null;
  }[] = [];
  for (const phone of phones) {
    if (resolve(phone)) continue;
    const key = last8(phone);
    if (!key || seenNew.has(key)) continue;
    seenNew.add(key);
    toCreate.push({ userId, accountId, phone, name: nameByPhone.get(phone) ?? null });
  }
  if (toCreate.length > 0) {
    const inserted = await db
      .insert(contacts)
      .values(toCreate)
      .returning({ id: contacts.id, phone: contacts.phone });
    existing.push(...inserted);
  }

  for (const phone of phones) {
    const hit = resolve(phone);
    if (hit) byInputPhone.set(phone, hit.id);
  }
  return byInputPhone;
}

/**
 * De-duplicate parsed CSV rows by normalized phone, keeping the first
 * occurrence of each. Rows with an empty normalized phone are dropped
 * (they can't be a valid contact). Returns the unique rows plus the
 * count removed as in-file duplicates.
 */
export function dedupeByPhone<T extends { phone: string }>(
  rows: T[],
): { unique: T[]; duplicates: number } {
  const seen = new Set<string>();
  const unique: T[] = [];
  let duplicates = 0;

  for (const row of rows) {
    const key = normalizeKey(row.phone);
    if (!key) {
      duplicates++;
      continue;
    }
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    unique.push(row);
  }

  return { unique, duplicates };
}

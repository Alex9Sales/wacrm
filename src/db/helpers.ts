// ============================================================
// Small helpers that bridge the gap between Supabase's PostgREST
// result semantics and Drizzle's plain-array returns, so converted
// call sites keep their original control flow.
//
//   supabase .single()      → firstOrThrow(rows, msg)
//   supabase .maybeSingle() → firstOrNull(rows)
// ============================================================

/** Equivalent of PostgREST `.maybeSingle()`: first row or null. */
export function firstOrNull<T>(rows: T[]): T | null {
  return rows.length > 0 ? rows[0] : null;
}

/**
 * Equivalent of PostgREST `.single()`: first row or throw.
 * Use where the old code treated "no row" as a hard error.
 */
export function firstOrThrow<T>(rows: T[], message = "Expected a row, got none"): T {
  if (rows.length === 0) throw new Error(message);
  return rows[0];
}

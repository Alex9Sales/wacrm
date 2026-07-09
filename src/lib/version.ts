// ============================================================
// Build identity — used by the "nova versão disponível" banner.
//
// Next writes a unique id to `.next/BUILD_ID` on every build. The running
// server reads it here; the client captured the id it loaded with and polls
// `/api/version` — when the server reports a different id, a new version was
// deployed and the client offers a one-click refresh. Server-only (touches
// the filesystem); never import from a client component.
// ============================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cached: string | null = null;

/** The current deployment's build id (stable until the next deploy). */
export function getBuildId(): string {
  if (cached) return cached;
  try {
    cached = readFileSync(join(process.cwd(), '.next', 'BUILD_ID'), 'utf8').trim();
  } catch {
    // `next dev` has no BUILD_ID file — fall back to a dev sentinel so the
    // banner stays dormant locally.
    cached = process.env.NEXT_PUBLIC_BUILD_ID || 'dev';
  }
  return cached || 'dev';
}

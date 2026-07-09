import { NextResponse } from 'next/server';

import { getBuildId } from '@/lib/version';

// Always reflect the running server's build — never cache this response, or a
// stale CDN/proxy copy would defeat the update check.
export const dynamic = 'force-dynamic';
export const revalidate = 0;

export function GET() {
  return NextResponse.json(
    { buildId: getBuildId() },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}

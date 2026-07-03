import { NextResponse, type NextRequest } from 'next/server'

// ============================================================
// Phase 1 TEMPORARY middleware.
//
// The Supabase session-refresh middleware was removed with the rest
// of Supabase auth. Better Auth lands in Phase 2 and reinstates real
// session checks here (cookie → session, redirects for /login etc.).
//
// Until then, route protection is enforced at the data layer:
// every API route resolves the session via requireRole()/
// getCurrentAccount(), which in dev authenticates the DEV_SEED_USER_ID
// stub and otherwise returns 401. Pages render for everyone; their
// data calls fail closed.
// ============================================================

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Auth pages are dead ends until Phase 2 — send visitors to the
  // dashboard, which works against the dev session stub.
  if (
    pathname === '/login' ||
    pathname === '/signup' ||
    pathname === '/forgot-password'
  ) {
    const url = request.nextUrl.clone()
    url.pathname = '/dashboard'
    url.search = ''
    return NextResponse.redirect(url)
  }

  return NextResponse.next()
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}

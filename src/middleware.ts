import { NextResponse, type NextRequest } from 'next/server'
import { getSessionCookie } from 'better-auth/cookies'

// ============================================================
// Better Auth route-protection middleware (Phase 2).
//
// Lightweight, DB-free: it only checks for the PRESENCE of the Better
// Auth session cookie (real session validation still happens in the
// data layer via getCurrentAccount / requireRole). Middleware runs on
// the edge and must not hit the DB.
//
//   - Auth pages (/login, /signup, /forgot-password) → redirect to
//     /dashboard when a session cookie is present.
//   - Protected paths (/dashboard/**, authed /api/**) → redirect to
//     /login when the session cookie is absent.
// ============================================================

const AUTH_PAGES = new Set(['/login', '/signup', '/forgot-password'])

// API prefixes that must remain reachable WITHOUT a session cookie.
// Everything else under /api is treated as authed.
const PUBLIC_API_PREFIXES = [
  '/api/auth', // Better Auth's own endpoints (sign-in/up/out, org, …)
  '/api/webhooks', // inbound provider webhooks (verified by signature)
  '/api/invitations', // public invite peek; redeem self-guards the session
]

function isProtectedPath(pathname: string): boolean {
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
    return true
  }
  if (pathname.startsWith('/api/')) {
    return !PUBLIC_API_PREFIXES.some(
      (p) => pathname === p || pathname.startsWith(`${p}/`),
    )
  }
  return false
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  // Presence check only — no network / DB. getSessionCookie reads the
  // Better Auth cookie straight off the request.
  const hasSession = Boolean(getSessionCookie(request))

  // Already signed in → keep them out of the auth pages.
  if (AUTH_PAGES.has(pathname)) {
    if (hasSession) {
      const url = request.nextUrl.clone()
      url.pathname = '/dashboard'
      url.search = ''
      return NextResponse.redirect(url)
    }
    return NextResponse.next()
  }

  // Protected path without a session → send to /login.
  if (!hasSession && isProtectedPath(pathname)) {
    // API routes get a 401 JSON rather than an HTML redirect.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    const url = request.nextUrl.clone()
    url.pathname = '/login'
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

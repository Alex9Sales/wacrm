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
  '/api/health', // liveness/readiness probe (Docker HEALTHCHECK, Traefik)
  '/api/version', // build-id poll for the "nova versão"/auto-reload banner —
  //                must answer even a lapsed-session tab so it can still detect
  //                a new deploy and self-recover from a stale bundle (returns
  //                only an opaque build id; no data).
  '/api/files', // public media proxy (browser + Meta fetch media by URL)
  '/api/v1', // public API — auths per-request via API key (requireApiKey),
  //            not the session cookie, so the middleware must let it through
  //            and let each route enforce its own key + scope.
  '/api/internal', // server-to-server (voice bridge) — auths per-request via a
  //            bearer service token, not the session cookie.
  '/api/instagram/oauth/callback', // OAuth callback do Instagram — o browser
  //            volta do instagram.com; autentica pelo `state` assinado, não pela
  //            sessão (o /start segue protegido).
  '/api/instagram/deauthorize', // deauthorize callback do Instagram — a Meta
  //            faz POST com signed_request; autentica pela assinatura (app
  //            secret), não pela sessão.
]

function isProtectedPath(pathname: string): boolean {
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/')) {
    return true
  }
  // Phase 8: super-admin panel. Cookie presence only here; the real
  // platform-admin allowlist check runs server-side in each /admin
  // page / route via requirePlatformAdmin (middleware can't read the DB).
  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
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

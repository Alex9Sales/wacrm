import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/**
 * Baseline security headers applied to every response.
 *
 * CSP ships as `Content-Security-Policy-Report-Only` so the browser
 * surfaces violations in the console without blocking anything — once
 * we have confidence nothing legit trips it (two deploys, a pass on
 * every route), flip the key to `Content-Security-Policy` to enforce.
 *
 * The rest of the headers are straight blocks, safe to enforce today:
 *   - HSTS: only meaningful on HTTPS (no-op on http://localhost).
 *   - X-Content-Type-Options / X-Frame-Options / Referrer-Policy:
 *     baseline OWASP hardening, no behavioural cost.
 *   - Permissions-Policy: we don't use camera / microphone / etc, so
 *     deny them. A supply-chain compromise or a forgotten plugin
 *     can't silently opt back in.
 */
const SECURITY_HEADERS = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    // Microphone is allowed for same-origin (`self`) so the inbox
    // composer can record voice notes via MediaRecorder. Everything
    // else stays denied — a compromised dependency can't silently grab
    // the camera / geolocation / etc.
    key: "Permissions-Policy",
    value: "camera=(), microphone=(self), geolocation=(), payment=(), usb=()",
  },
  {
    key: "Content-Security-Policy-Report-Only",
    value: [
      "default-src 'self'",
      // Next.js needs 'unsafe-inline' for its inline hydration script
      // and 'unsafe-eval' in dev + some production optimisations.
      // Nonce-based CSP is a later project.
      "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      // Tailwind + inline style attributes on lots of components.
      "style-src 'self' 'unsafe-inline'",
      // Supabase public-bucket avatars, contact avatars (arbitrary
      // https URLs paste-able from the UI), OG images, data URLs for
      // tiny inline assets.
      "img-src 'self' data: blob: https:",
      // Outbound media previews (blob: from MediaRecorder + file picker)
      // and Supabase public-bucket audio/video the inbox renders.
      "media-src 'self' blob: https://*.supabase.co",
      "font-src 'self' data:",
      // Supabase REST + realtime (WSS). All Meta API calls happen
      // server-side, so graph.facebook.com does not belong here.
      "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
] as const;

const nextConfig: NextConfig = {
  /**
   * Standalone output for Docker.
   *
   * Emits `.next/standalone/` — a self-contained server bundle (server.js
   * + only the node_modules actually traced as reachable) plus
   * `.next/static`. The Docker runner copies those three trees instead of
   * the whole node_modules, giving a much smaller web image. The web
   * container runs `node server.js` from that standalone tree.
   *
   * Note: the standalone bundle covers the Next WEB server only. The
   * BullMQ worker (`tsx src/worker/index.ts`) is NOT part of the Next
   * build and needs the raw src/ + tsx at runtime — the Dockerfile keeps
   * a full `node_modules` (with tsx) in the image for that. See Dockerfile.
   */
  output: 'standalone',

  /**
   * Teto do corpo bufferizado quando o middleware ("proxy") lê a requisição.
   * Default deste Next = 10MB: acima disso ele TRUNCA o corpo e o route handler
   * recebe um corpo incompleto. Isso quebrava DOIS caminhos de e-mail:
   *   - SAÍDA: upload de mídia > 10MB → multipart cortado → "Expected
   *     multipart/form-data" (anexo de e-mail vai até 25MB).
   *   - ENTRADA: webhook /api/webhooks/email recebe o MIME cru; um anexo de
   *     ~20MB vira ~27MB em base64 → seria truncado e o anexo se perdia.
   * 40MB cobre os dois com folga (bate com o total do Resend). Ver
   * MEDIA_MAX_BYTES / EMAIL_MAX_BYTES em lib/storage/upload-media.ts.
   */
  experimental: {
    proxyClientMaxBodySize: '40mb',
  },

  /**
   * Pin the file-tracing root to THIS project directory.
   *
   * Next infers the monorepo root by walking up for a lockfile. There's a
   * stray package-lock.json in a parent dir on some machines (and none in
   * the Docker context), so without pinning, `output: 'standalone'` nests
   * server.js under `.next/standalone/<projectName>/` on one host and at
   * `.next/standalone/` in Docker — a moving target the Dockerfile can't
   * COPY reliably. Pinning to __dirname forces server.js to the standalone
   * root everywhere, which is what the Dockerfile's COPY + `node server.js`
   * assume.
   */
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),

  /**
   * Cache-Control policy.
   *
   * Why this exists:
   *   Hostinger's CDN was applying `s-maxage=31536000` (1 year) to
   *   prerendered HTML pages by default. When a new deploy shipped
   *   fresh Turbopack chunk hashes, the edge kept serving year-old
   *   HTML referencing chunk filenames that no longer existed on
   *   disk — result: HTML 200, every /_next/static/*.js and .css
   *   came back 404, the page rendered unstyled. Private/incognito
   *   did nothing because the cache is server-side.
   *
   * Strategy:
   *   - /_next/static/* — leave to Next. Turbopack dev chunks can go
   *     stale if we force immutable caching here; Next already emits
   *     the correct production headers for hashed assets.
   *   - /api/*          — no-store. API responses are per-user and
   *     must never be shared across requests at the edge.
   *   - Everything else — public, brief s-maxage + generous
   *     stale-while-revalidate. The edge serves instantly from cache
   *     for the first 5 min, then returns cached content while
   *     refreshing in the background for up to 24 h. A deploy's
   *     chunk-hash drift self-heals within ~5 min with no user-
   *     visible latency.
   *
   *   Note: dynamic dashboard routes (/inbox, /contacts, /pipelines,
   *   /broadcasts, etc.) are server-rendered per request — Next.js
   *   and Supabase auth already prevent them from being served
   *   from a shared cache. The s-maxage here is a ceiling; Next.js
   *   and auth middleware still set `private` / `no-store` for
   *   per-user responses.
   *
   * Security headers are appended via a separate catch-all rule
   * below — Next.js merges headers from every matching rule, so
   * they apply to every response regardless of which cache rule
   * matched.
   */
  async headers() {
    return [
      {
        // Public media proxy (GET /api/files/:bucket/*key) re-serves
        // immutable MinIO objects (timestamped / UUID keys) over the app's
        // https origin to dodge mixed-content. Unlike the rest of /api,
        // these ARE cacheable — carve them out of the no-store rule below
        // and let the browser/CDN cache them for a day.
        source: "/api/files/:path*",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=86400, immutable",
          },
        ],
      },
      {
        // Everything else under /api is per-user — never share at the edge.
        // The negative lookahead excludes /api/files so the media rule
        // above wins (Next merges same-key headers; a single match keeps
        // this deterministic).
        source: "/api/:path((?!files/).*)",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
      {
        // App HTML pages (everything except /_next/static, /_next/image, /api).
        // Per-user, authenticated, server-rendered → MUST be `private,
        // no-store`, for two reasons discovered 11/08:
        //   1. Stale-bundle blank page. The previous value
        //      `public, max-age=0, s-maxage=300, stale-while-revalidate=86400`
        //      let the browser serve up-to-24h-STALE HTML after a deploy. The
        //      stale HTML references Turbopack chunk hashes that 404 on the new
        //      build → blank page a soft reload couldn't fix (only a hard
        //      Ctrl+Shift+R bypassed the cache). `no-store` makes every
        //      navigation fetch fresh HTML that always matches the live chunks,
        //      so the stale bundle self-heals on a NORMAL refresh.
        //   2. Security. `public` on an authenticated per-user page is unsafe —
        //      a shared cache could hand one user's dashboard to another. The
        //      old comment assumed Next/auth would override this to `private`;
        //      the shipped header proved that false (it went out as `public`).
        // Cloudflare already treats every HTML route as DYNAMIC (never cached),
        // so this loses no edge caching — the s-maxage/SWR were inert anyway.
        // widget.js is carved out: it's a public static script embedded on
        // client sites — its route handler sets public/max-age itself.
        source: "/:path((?!_next/static|_next/image|api|widget\\.js).*)",
        headers: [{ key: "Cache-Control", value: "private, no-store" }],
      },
      {
        // Security headers on every response, including /_next/static
        // assets (nosniff matters there) and /api/* (HSTS + referrer-
        // policy don't hurt). /f/* is carved out (rule below) so the
        // capture pages can live inside the embeddable widget's iframe.
        source: "/:path((?!f/).*)",
        headers: [...SECURITY_HEADERS],
      },
      {
        // Capture pages (/f/*): same protections MINUS X-Frame-Options —
        // the "🧩 Widget pro seu site" embeds these pages in an <iframe>
        // on the client's own website.
        source: "/f/:path*",
        headers: SECURITY_HEADERS.filter((h) => h.key !== "X-Frame-Options"),
      },
    ];
  },
};

export default nextConfig;

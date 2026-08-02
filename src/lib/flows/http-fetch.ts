// ============================================================
// Flow `http_fetch` node — SSRF-guarded outbound request.
//
// The URL comes from a flow author (any account admin, and signup is
// open) and the SERVER makes the request, so an unguarded fetch is a
// Server-Side Request Forgery primitive. Every request goes through:
//   1. Scheme allow-list — only http(s) (blocks file:/gopher:/…).
//   2. `isDeliverableUrl` — resolves the host and refuses loopback /
//      private / link-local / cloud-metadata targets (shared with the
//      webhook-delivery guard).
//   3. `redirect: 'manual'` — a public URL can't 3xx-bounce to an
//      internal one (treated as a failure).
//   4. A timeout and a response-size cap so a slow / huge / streaming
//      response can't hang the run or bloat the vars JSONB.
//
// Residual risk (documented in ssrf.ts): DNS rebinding between the
// resolve and the connect. Mitigated by the short timeout; full
// prevention needs socket-level IP pinning, which fetch doesn't expose.
// ============================================================

import { isDeliverableUrl } from "@/lib/webhooks/ssrf";
import type { HttpFetchNodeConfig } from "./types";

/** Response body is read up to this many bytes, then truncated. */
export const HTTP_FETCH_MAX_BYTES = 256 * 1024; // 256 KB
/** Per-request timeout. Kept modest — the fetch blocks the dispatch loop. */
export const HTTP_FETCH_TIMEOUT_MS = 10_000;

export interface HttpFetchResult {
  ok: boolean;
  /** HTTP status, or 0 for a network error / refused target / redirect. */
  status: number;
  /** Response body text, truncated to HTTP_FETCH_MAX_BYTES. */
  bodyText: string;
  /** Short machine-ish reason when ok === false. */
  error?: string;
}

/** `{{vars.foo}}` interpolation — mirrors the engine's interpolateVars. */
function interpolate(template: string, vars: Record<string, unknown>): string {
  if (!template) return "";
  return template.replace(/\{\{vars\.([a-zA-Z0-9_]+)\}\}/g, (_, key) => {
    const v = vars[key];
    return v === undefined || v === null ? "" : String(v);
  });
}

export async function runHttpFetch(
  cfg: HttpFetchNodeConfig,
  vars: Record<string, unknown>,
): Promise<HttpFetchResult> {
  const url = interpolate(cfg.url ?? "", vars).trim();

  let scheme = "";
  try {
    scheme = new URL(url).protocol;
  } catch {
    return { ok: false, status: 0, bodyText: "", error: "url_invalida" };
  }
  if (scheme !== "https:" && scheme !== "http:") {
    return {
      ok: false,
      status: 0,
      bodyText: "",
      error: "esquema_nao_permitido",
    };
  }

  // SSRF guard — resolves the host and refuses non-public targets.
  if (!(await isDeliverableUrl(url))) {
    return {
      ok: false,
      status: 0,
      bodyText: "",
      error: "destino_bloqueado_ssrf",
    };
  }

  const method = (cfg.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = {};
  for (const h of cfg.headers ?? []) {
    const key = (h?.key ?? "").trim();
    if (!key) continue;
    headers[key] = interpolate(h?.value ?? "", vars);
  }

  const hasBody = method !== "GET" && method !== "HEAD" && !!cfg.body;
  const body = hasBody ? interpolate(cfg.body ?? "", vars) : undefined;

  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(HTTP_FETCH_TIMEOUT_MS),
    });
    const bodyText = await readCapped(res, HTTP_FETCH_MAX_BYTES);
    return {
      ok: res.ok,
      status: res.status,
      bodyText,
      error: res.ok ? undefined : `http_${res.status}`,
    };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 0,
      bodyText: "",
      error: isTimeout ? "timeout" : msg.slice(0, 200),
    };
  }
}

/** Read a response body, stopping once `maxBytes` have been buffered. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) {
    const t = await res.text().catch(() => "");
    return t.length > maxBytes ? t.slice(0, maxBytes) : t;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } catch {
    // Partial read — return whatever we buffered.
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  const size = Math.min(total, maxBytes);
  const merged = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) {
    if (off >= size) break;
    const take = Math.min(c.byteLength, size - off);
    merged.set(c.subarray(0, take), off);
    off += take;
  }
  return new TextDecoder().decode(merged);
}

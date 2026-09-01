"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { RotateCw, Sparkles } from "lucide-react";

import { isEmbeddedSignupActive } from "@/lib/embedded-signup-flag";

/** True when the user is mid-typing in a field with content — don't yank the
 *  page out from under a draft; show the banner instead. */
function isEditingDirtyText(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  // Campo com rascunho PERSISTIDO (ex.: caixa do inbox salva em
  // sessionStorage) — recarregar não perde nada, então não segura o reload.
  if (el.getAttribute?.("data-draft-safe") === "true") return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  // Só TEXTO LONGO segura o auto-reload. Campo de BUSCA/FILTRO com texto
  // (ex.: "Buscar conversas…") não é rascunho — e prendia a aba no bundle
  // velho a manhã inteira (caso Dentai: funcionária busca o cliente, deixa o
  // texto no campo, e o auto-reload nunca acontecia).
  if (tag === "TEXTAREA") {
    return !!(el as HTMLTextAreaElement).value;
  }
  if (tag === "INPUT") {
    const input = el as HTMLInputElement;
    const kind = (input.type || "text").toLowerCase();
    if (kind === "search" || input.getAttribute("role") === "searchbox") {
      return false;
    }
    return !!input.value;
  }
  return false;
}

/** Recarrega FURANDO caches intermediários: muda a URL com `?_v=<build>` —
 *  qualquer cache de HTML (proxy/navegador) vira miss e busca a origem. O
 *  parâmetro é limpo no boot seguinte (stripVersionParam). Foi a causa do
 *  "só resolve com reload forçado" (Dentai/Felipe, 31/08): reload normal às
 *  vezes reaproveitava HTML cacheado e voltava no bundle velho. */
function reloadBusted(build: string): void {
  try {
    const u = new URL(window.location.href);
    u.searchParams.set("_v", build);
    window.location.replace(u.toString());
  } catch {
    window.location.reload();
  }
}

// "Nova versão disponível" — o servidor rendeu esta página no build
// `initialBuildId`; a gente sonda /api/version e, quando o servidor reporta
// outro id, a aba num bundle velho está efetivamente QUEBRADA (Server Actions
// falham, páginas novas renderizam o componente antigo). Política "nunca
// deixar bundle velho ativo" (pedido do Alex, 31/08):
//   1. auto-reload silencioso quando é seguro (campo com rascunho persistido
//      incluso) — com CACHE-BUSTING e re-tentativa a cada 5 min (self-heal);
//   2. quando não dá (rascunho não-persistido em edição), barra fixa no TOPO,
//      SEM botão de dispensar;
//   3. persistindo por mais de 3 min, vira OVERLAY bloqueante — o cliente só
//      segue depois de atualizar.
const AUTO_RELOAD_RETRY_MS = 5 * 60_000;
const BLOCK_AFTER_MS = 3 * 60_000;

export function UpdateBanner({ initialBuildId }: { initialBuildId: string }) {
  const [latest, setLatest] = useState<string | null>(null);
  const [blocked, setBlocked] = useState(false);
  const staleSince = useRef<number | null>(null);
  const checking = useRef(false);
  const pathname = usePathname();

  const check = useCallback(async () => {
    // Dormant in dev (no BUILD_ID) — nothing to compare against.
    if (!initialBuildId || initialBuildId === "dev") return;
    // ⚠️ NÃO pule quando a aba está oculta. Era exatamente aí que o bundle
    // velho sobrevivia: a pessoa deixa o CRM numa aba de fundo, a gente
    // deploya, e quando ela volta e clica numa conversa a Server Action já
    // falha ANTES do primeiro check (o de visibilitychange é assíncrono).
    // Checando de fundo, a aba se recarrega sozinha e a pessoa volta pro
    // CRM já atualizado — sem ver banner nenhum (caso Dentai, 01/09).
    if (checking.current) return;
    checking.current = true;
    try {
      const res = await fetch("/api/version", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { buildId?: string };
      if (typeof data.buildId !== "string") return;
      const build = data.buildId;
      if (build === initialBuildId) return;
      // Bundle velho no ar. Primeiro tenta se recuperar sozinho — guard
      // TEMPORAL (não once-per-build): se um reload anterior não colou (cache
      // servindo HTML velho), tenta de novo a cada 5 min em vez de desistir.
      if (!isEditingDirtyText() && !isEmbeddedSignupActive()) {
        const KEY = "fluxia:autoReload";
        let last: { build?: string; at?: number } = {};
        try {
          last = JSON.parse(sessionStorage.getItem(KEY) || "{}") as typeof last;
        } catch {
          /* corrompido → trata como nunca tentado */
        }
        const retryOk =
          last.build !== build ||
          Date.now() - (last.at ?? 0) > AUTO_RELOAD_RETRY_MS;
        if (retryOk) {
          try {
            sessionStorage.setItem(
              KEY,
              JSON.stringify({ build, at: Date.now() }),
            );
          } catch {
            /* sem storage — segue mesmo assim */
          }
          reloadBusted(build);
          return;
        }
      }
      if (staleSince.current == null) staleSince.current = Date.now();
      setLatest(build);
      if (Date.now() - staleSince.current > BLOCK_AFTER_MS) setBlocked(true);
    } catch {
      // offline / transient — try again on the next edge.
    } finally {
      checking.current = false;
    }
  }, [initialBuildId]);

  // Poll + focus/visibility + a global catch for the stale Server-Action error.
  useEffect(() => {
    if (!initialBuildId || initialBuildId === "dev") return;

    // Limpa o `?_v=` cosmético do reload cache-busted anterior.
    try {
      const u = new URL(window.location.href);
      if (u.searchParams.has("_v")) {
        u.searchParams.delete("_v");
        window.history.replaceState(null, "", u.toString());
      }
    } catch {
      /* cosmético */
    }

    // Belt-and-suspenders: a click that fires a Server Action whose id changed
    // across a deploy throws "Failed to find Server Action … older or newer
    // deployment" and the page looks frozen. Catch that exact error globally
    // and reload immediately — time-guarded (60s) so a non-bundle cause can't
    // loop us.
    const STALE_ACTION_RE =
      /Failed to find Server Action|older or newer deployment/i;
    const reloadForStaleAction = (msg: unknown) => {
      if (typeof msg !== "string" || !STALE_ACTION_RE.test(msg)) return;
      if (isEmbeddedSignupActive()) return;
      const KEY = "fluxia:staleActionReloadAt";
      const last = Number(sessionStorage.getItem(KEY) || 0);
      if (Date.now() - last < 60_000) return; // just reloaded — don't loop
      sessionStorage.setItem(KEY, String(Date.now()));
      window.location.reload();
    };
    const onError = (e: ErrorEvent) =>
      reloadForStaleAction(e.message || (e.error as { message?: string })?.message);
    const onRejection = (e: PromiseRejectionEvent) => {
      const r = e.reason as { message?: string } | string | undefined;
      reloadForStaleAction(typeof r === "string" ? r : r?.message);
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    void check();
    // Poll agressivo (20s): detecta o deploy novo rápido e auto-recarrega a aba
    // ociosa antes de o usuário clicar numa ação de bundle velho.
    const id = window.setInterval(() => void check(), 20_000);
    const onVisibility = () => {
      if (!document.hidden) void check();
    };
    const onFocus = () => void check();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, [initialBuildId, check]);

  // Re-check on EVERY client-side navigation. Landing on a page the new build
  // changed while running the old bundle renders the old component with no
  // error to catch (e.g. a just-added button is missing) — so we verify the
  // build the instant the route changes, not up to 20s later.
  useEffect(() => {
    void check();
  }, [pathname, check]);

  const hasUpdate = !!latest && latest !== initialBuildId;
  if (!hasUpdate) return null;

  const refresh = () => reloadBusted(latest as string);

  // 🚧 Stale há 3+ min: overlay BLOQUEANTE — nada de operar num bundle velho.
  if (blocked) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm">
        <div className="mx-4 flex max-w-md flex-col items-center gap-4 rounded-2xl border border-border bg-card p-8 text-center shadow-2xl">
          <span className="flex size-12 items-center justify-center rounded-full bg-primary/15 text-primary">
            <Sparkles className="size-6" />
          </span>
          <div>
            <p className="text-lg font-semibold text-foreground">
              Atualização necessária
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Uma nova versão do FluxiaCRM está no ar. Atualize para continuar —
              leva 2 segundos e suas conversas ficam onde estão.
            </p>
          </div>
          <button
            type="button"
            onClick={refresh}
            className="inline-flex h-11 items-center gap-2 rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <RotateCw className="size-4" />
            Atualizar agora
          </button>
        </div>
      </div>
    );
  }

  // Barra fixa no topo — SEM dispensar (bundle velho não fica ativo por opção).
  return (
    <div className="fixed inset-x-0 top-0 z-[90] flex items-center justify-center gap-3 border-b border-primary/30 bg-primary px-4 py-2 text-primary-foreground shadow-md">
      <Sparkles className="size-4 shrink-0" />
      <p className="min-w-0 truncate text-sm font-medium">
        Nova versão disponível — atualize para continuar sem erros.
      </p>
      <button
        type="button"
        onClick={refresh}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary-foreground px-3.5 text-sm font-semibold text-primary transition-colors hover:opacity-90"
      >
        <RotateCw className="size-3.5" />
        Atualizar agora
      </button>
    </div>
  );
}

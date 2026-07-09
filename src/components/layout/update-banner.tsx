"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, RotateCw, X } from "lucide-react";

// "Nova versão disponível" banner. The server rendered this page from build
// `initialBuildId`; we poll /api/version and, when the running server reports
// a newer id, surface a one-click refresh so clients pick up new features
// without a manual hard-reload. Dismiss hides it until an even newer build
// ships.
export function UpdateBanner({ initialBuildId }: { initialBuildId: string }) {
  const [latest, setLatest] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const checking = useRef(false);

  useEffect(() => {
    // Dormant in dev (no BUILD_ID) — nothing to compare against.
    if (!initialBuildId || initialBuildId === "dev") return;
    let stopped = false;

    const check = async () => {
      if (checking.current || document.hidden) return;
      checking.current = true;
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { buildId?: string };
        if (!stopped && typeof data.buildId === "string") setLatest(data.buildId);
      } catch {
        // offline / transient — try again on the next tick.
      } finally {
        checking.current = false;
      }
    };

    void check();
    const id = window.setInterval(check, 60_000);
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", check);
    return () => {
      stopped = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", check);
    };
  }, [initialBuildId]);

  const hasUpdate =
    !!latest && latest !== initialBuildId && latest !== dismissed;
  if (!hasUpdate) return null;

  return (
    <div className="fixed inset-x-0 bottom-4 z-[60] flex justify-center px-4">
      <div className="flex items-center gap-3 rounded-full border border-primary/30 bg-card/95 px-4 py-2.5 shadow-lg shadow-black/10 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          <Sparkles className="size-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">
            Nova versão disponível
          </p>
          <p className="hidden text-xs text-muted-foreground sm:block">
            Atualize para pegar as últimas melhorias.
          </p>
        </div>
        <button
          type="button"
          onClick={() => window.location.reload()}
          className="ml-1 inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full bg-primary px-3.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <RotateCw className="size-3.5" />
          Atualizar
        </button>
        <button
          type="button"
          onClick={() => setDismissed(latest)}
          aria-label="Depois"
          className="flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}

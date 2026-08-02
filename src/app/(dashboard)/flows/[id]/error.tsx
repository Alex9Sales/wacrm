"use client";

/**
 * Route-level error boundary for the flow editor.
 *
 * Replaces Next's opaque "This page couldn't load" with the actual
 * error message + digest, so a runtime crash in the builder (e.g. a bad
 * node render) is diagnosable from a screenshot instead of a guess. The
 * "Tentar de novo" button calls Next's `reset()` to re-render the
 * segment without a full reload.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle } from "lucide-react";

export default function FlowEditorError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    // Surfaces the full stack in the browser console for deeper debugging.
    console.error("[flow-editor] erro de runtime:", error);
  }, [error]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      <AlertTriangle className="h-8 w-8 text-amber-400" />
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">
          Algo quebrou no editor de fluxo.
        </p>
        <p className="text-xs text-muted-foreground">
          Mande um print desta mensagem para o suporte:
        </p>
      </div>
      <pre className="max-w-[640px] overflow-x-auto rounded-lg border border-border bg-muted px-4 py-3 text-left text-[12px] leading-relaxed text-red-300">
        {error.message || "Erro sem mensagem."}
        {error.digest ? `\n\ndigest: ${error.digest}` : ""}
      </pre>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => reset()}
          className="rounded-md bg-primary px-3.5 py-2 text-[13px] font-medium text-primary-foreground transition-colors hover:bg-primary-hover"
        >
          Tentar de novo
        </button>
        <button
          type="button"
          onClick={() => router.push("/flows")}
          className="rounded-md border border-border px-3.5 py-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          Voltar para Fluxos
        </button>
      </div>
    </div>
  );
}

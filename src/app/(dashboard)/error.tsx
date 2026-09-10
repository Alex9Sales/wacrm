'use client';

// ============================================================
// Tela de erro da área logada (error boundary do Next). Antes não existia:
// um erro no render virava página em branco ou o "Não foi possível carregar
// esta página" do Chrome, sem saída. Aqui o usuário ganha um botão de
// recarregar, e sessão perdida vai direto pro login.
//
// 09/09/2026 (Renato/Limpeza com Zelo e Wilian/GoLink viam isto "toda hora"):
//  1. erro de CHUNK (pedaço do código de uma versão antiga que o servidor já
//     não tem) → recarrega sozinho UMA vez, sem mostrar a tela;
//  2. todo erro é reportado em /api/client-errors → aparece no log do web,
//     que antes ficava zerado enquanto o cliente via a tela.
// ============================================================

import { useEffect } from 'react';

/** Pedaço de JS de um build antigo que o servidor já não serve. */
function isStaleChunkError(err: Error | undefined): boolean {
  const s = `${err?.name ?? ''} ${err?.message ?? ''}`;
  return /ChunkLoadError|Loading chunk|Loading CSS chunk|dynamically imported module|Importing a module script failed|Failed to fetch dynamically/i.test(s);
}

function report(error: Error & { digest?: string }, kind: string) {
  try {
    const buildId = (document.querySelector('meta[name="x-build-id"]') as HTMLMetaElement | null)?.content ?? '';
    void fetch('/api/client-errors', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        message: `${kind}: ${error?.message ?? ''}`,
        digest: error?.digest ?? '',
        stack: (error?.stack ?? '').slice(0, 1500),
        url: window.location.href,
        buildId,
      }),
    });
  } catch {
    /* reportar nunca pode quebrar a tela de erro */
  }
}

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const unauthorized = /unauthorized|401|sess[aã]o/i.test(error?.message ?? '');
  const staleChunk = isStaleChunkError(error);

  useEffect(() => {
    console.error('[dashboard error]', error);
    if (unauthorized) {
      report(error, 'unauthorized');
      // Sessão inválida/expirada: sem drama, volta pro login.
      window.location.replace('/login');
      return;
    }
    if (staleChunk) {
      // Versão antiga da página: recarregar resolve. Uma vez só (marca na
      // sessão), senão um chunk que sumiu de vez viraria loop de reload.
      const key = 'crm:chunk-reload:' + window.location.pathname;
      if (!sessionStorage.getItem(key)) {
        sessionStorage.setItem(key, String(Date.now()));
        report(error, 'stale-chunk (auto-reload)');
        window.location.reload();
        return;
      }
    }
    report(error, staleChunk ? 'stale-chunk (2ª vez)' : 'render');
  }, [error, unauthorized, staleChunk]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md rounded-xl border border-border bg-card p-6 text-center">
        <p className="text-base font-semibold text-foreground">
          {unauthorized ? 'Sua sessão expirou' : staleChunk ? 'Atualizando a página…' : 'Algo deu errado ao carregar esta tela'}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {unauthorized
            ? 'Vamos te levar pro login.'
            : staleChunk
              ? 'Saiu uma versão nova do CRM. Estamos recarregando esta tela para você.'
              : 'Já registramos o erro. Recarregar resolve na maioria das vezes; se voltar, avise o suporte com o código abaixo.'}
        </p>
        {/* O que quebrou, em texto: o suporte lê na foto da tela sem precisar
            do console do navegador (Renato/Zelo mandou foto às 22h e a gente
            não tinha como saber o erro). Erro de servidor em produção vem sem
            mensagem — aí fica só o código. */}
        {(error?.digest || (!staleChunk && error?.message)) && (
          <p className="mt-3 max-h-24 overflow-y-auto break-words rounded bg-muted/60 px-2 py-1.5 text-left font-mono text-[11px] leading-snug text-muted-foreground">
            {error?.digest ? `código: ${error.digest}` : null}
            {error?.digest && error?.message && !/omitted in production|Server Components render/i.test(error.message) ? ' · ' : null}
            {!staleChunk && error?.message && !/omitted in production|Server Components render/i.test(error.message)
              ? error.message.slice(0, 240)
              : null}
          </p>
        )}
        <div className="mt-4 flex justify-center gap-2">
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            Recarregar
          </button>
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-muted"
          >
            Tentar de novo
          </button>
          <a
            href="/login"
            className="rounded-md border border-border px-4 py-2 text-sm text-foreground hover:bg-muted"
          >
            Ir para o login
          </a>
        </div>
      </div>
    </div>
  );
}

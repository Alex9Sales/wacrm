'use client';

// ============================================================
// Tela de erro da área logada (error boundary do Next). Antes não existia:
// um erro no render virava página em branco ou o "Não foi possível carregar
// esta página" do Chrome, sem saída. Aqui o usuário ganha um botão de
// recarregar, e sessão perdida vai direto pro login.
// ============================================================

import { useEffect } from 'react';

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const unauthorized = /unauthorized|401|sess[aã]o/i.test(error?.message ?? '');

  useEffect(() => {
    console.error('[dashboard error]', error);
    if (unauthorized) {
      // Sessão inválida/expirada: sem drama, volta pro login.
      window.location.replace('/login');
    }
  }, [error, unauthorized]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="max-w-md rounded-xl border border-border bg-card p-6 text-center">
        <p className="text-base font-semibold text-foreground">
          {unauthorized ? 'Sua sessão expirou' : 'Algo deu errado ao carregar esta tela'}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          {unauthorized
            ? 'Vamos te levar pro login.'
            : 'Pode ser uma versão antiga da página aberta no navegador. Recarregar resolve na maioria das vezes.'}
        </p>
        {error?.digest && (
          <p className="mt-2 text-[11px] text-muted-foreground">código: {error.digest}</p>
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

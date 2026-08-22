"use client";

import { useEffect, useState } from "react";

/**
 * Ações da proposta pública: dispara o beacon de VISUALIZAÇÃO uma vez (no
 * navegador real, pra não contar bots/prefetch) e oferece o ACEITE digital
 * (nome + CPF/CNPJ). Depois de aceita, mostra o selo de aceite — que aparece
 * inclusive no PDF (o botão/form não). Tema "papel" (claro), igual ao documento.
 */
export function ProposalActions({
  id,
  accepted,
}: {
  id: string;
  accepted: { at: string; name: string } | null;
}) {
  const [info, setInfo] = useState(accepted);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [doc, setDoc] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  // Beacon de visualização (uma vez por carregamento).
  useEffect(() => {
    fetch("/api/public/proposta/view", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id }),
    }).catch(() => {});
  }, [id]);

  async function submit() {
    if (!name.trim()) {
      setError("Informe seu nome para aceitar.");
      return;
    }
    setSending(true);
    setError("");
    try {
      const r = await fetch("/api/public/proposta/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, name, document: doc }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!r.ok || !j.ok) {
        setError(j.error || "Não foi possível registrar o aceite.");
        setSending(false);
        return;
      }
      setInfo({ at: new Date().toISOString(), name: name.trim() });
    } catch {
      setError("Erro de conexão. Tente novamente.");
      setSending(false);
    }
  }

  if (info) {
    const when = new Date(info.at).toLocaleString("pt-BR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    return (
      <section className="mt-8 rounded-lg border border-emerald-300 bg-emerald-50 px-5 py-4">
        <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800">
          <span className="text-lg leading-none">✓</span>
          Proposta aceita
        </div>
        <p className="mt-1 text-sm text-emerald-700">
          Aceita por <strong>{info.name}</strong> em {when}.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-8 rounded-lg border border-slate-200 bg-slate-50 px-5 py-4 print:hidden">
      {!open ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-sm font-semibold text-slate-900">
              Tudo certo com a proposta?
            </div>
            <p className="text-sm text-slate-600">
              Confirme o aceite aqui mesmo — é rápido e vale como confirmação.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700"
          >
            Aceitar proposta
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="text-sm font-semibold text-slate-900">
            Confirmar aceite da proposta
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1">
              <label className="text-xs font-medium text-slate-500">
                Seu nome completo
              </label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Nome de quem aceita"
                className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-500"
              />
            </div>
            <div className="grid gap-1">
              <label className="text-xs font-medium text-slate-500">
                CPF ou CNPJ (opcional)
              </label>
              <input
                value={doc}
                onChange={(e) => setDoc(e.target.value)}
                placeholder="Documento"
                className="h-10 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-emerald-500"
              />
            </div>
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={submit}
              disabled={sending}
              className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-700 disabled:opacity-60"
            >
              {sending ? "Registrando..." : "Confirmar aceite"}
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={sending}
              className="rounded-lg px-3 py-2 text-sm text-slate-600 hover:text-slate-900"
            >
              Cancelar
            </button>
          </div>
          <p className="text-[11px] text-slate-400">
            Ao confirmar, registramos seu nome, documento (se informado), data e
            IP como comprovação do aceite.
          </p>
        </div>
      )}
    </section>
  );
}

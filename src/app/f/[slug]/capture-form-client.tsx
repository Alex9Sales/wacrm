"use client";

import { useState } from "react";

import {
  CAPTURE_FIELD_DEFS,
  type CaptureField,
} from "@/lib/capture/shared";

/**
 * Formulário público de captação (/f/[slug]). Limpo e neutro — é o formulário
 * da CONTA, não da Fluxia. Honeypot anti-bot + POST pro endpoint público, que
 * joga o lead no funil. Tema claro (papel), responsivo.
 */
export function CaptureFormClient({
  slug,
  headline,
  description,
  fields,
  submitLabel,
  successMessage,
  accent,
  embedded,
  successOffer,
  successWaHref,
}: {
  slug: string;
  headline: string;
  description: string | null;
  fields: CaptureField[];
  submitLabel: string;
  successMessage: string;
  /** Cor de destaque (hex). Default = roxo Fluxia. */
  accent?: string;
  /** Embutido numa landing → renderiza só o card, sem o fundo de tela cheia. */
  embedded?: boolean;
  /** Obrigado que Vende: bloco de oferta na tela de sucesso. */
  successOffer?: { title: string | null; text: string | null } | null;
  /** Obrigado que Vende: botão "Chamar no WhatsApp" (wa.me com ref rastreado). */
  successWaHref?: string | null;
}) {
  const brand = accent || "#7c3aed";
  const [values, setValues] = useState<Record<string, string>>({});
  const [site, setSite] = useState(""); // honeypot
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  function set(k: string, v: string) {
    setValues((prev) => ({ ...prev, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    // Validação leve no cliente (o servidor revalida).
    for (const f of fields) {
      if (f.required && !(values[f.key] ?? "").trim()) {
        setError(`Preencha: ${f.label}`);
        return;
      }
    }
    setSending(true);
    try {
      const r = await fetch("/api/public/capture/submit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, site, ...values }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (!r.ok || !j.ok) {
        setError(j.error || "Não foi possível enviar. Tente de novo.");
        setSending(false);
        return;
      }
      setDone(true);
    } catch {
      setError("Erro de conexão. Tente de novo.");
      setSending(false);
    }
  }

  const card = (
    <div
      className={
        embedded
          ? "w-full rounded-2xl border border-slate-200 bg-white p-6 shadow-lg sm:p-8"
          : "w-full max-w-md rounded-2xl border border-slate-200 bg-white p-6 shadow-xl sm:p-8"
      }
    >
      {done ? (
          <div className="py-6 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl">
              ✓
            </div>
            <h1 className="text-lg font-semibold text-slate-900">
              Tudo certo!
            </h1>
            <p className="mt-2 text-sm text-slate-600">{successMessage}</p>

            {/* Obrigado que Vende: oferta + próximo passo no WhatsApp. */}
            {successOffer ? (
              <div
                className="mt-5 rounded-xl border px-4 py-3 text-left"
                style={{ borderColor: `${brand}55`, background: `${brand}0d` }}
              >
                {successOffer.title ? (
                  <p className="text-sm font-semibold text-slate-900">
                    {successOffer.title}
                  </p>
                ) : null}
                {successOffer.text ? (
                  <p className="mt-1 whitespace-pre-wrap text-sm text-slate-600">
                    {successOffer.text}
                  </p>
                ) : null}
              </div>
            ) : null}

            {successWaHref ? (
              <a
                href={successWaHref}
                target="_blank"
                rel="noreferrer"
                className="mt-5 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-emerald-600"
              >
                💬 Chamar no WhatsApp agora
              </a>
            ) : null}
          </div>
        ) : (
          <>
            <h1 className="text-xl font-bold text-slate-900">{headline}</h1>
            {description ? (
              <p className="mt-1.5 text-sm text-slate-600">{description}</p>
            ) : null}

            <form onSubmit={submit} className="mt-5 space-y-3.5">
              {fields.map((f) => {
                const def = CAPTURE_FIELD_DEFS[f.key];
                const common =
                  "w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-violet-500 focus:ring-1 focus:ring-violet-500";
                return (
                  <div key={f.key} className="space-y-1">
                    <label className="text-xs font-medium text-slate-600">
                      {f.label}
                      {f.required ? (
                        <span className="text-rose-500"> *</span>
                      ) : null}
                    </label>
                    {def.inputType === "textarea" ? (
                      <textarea
                        rows={3}
                        value={values[f.key] ?? ""}
                        onChange={(e) => set(f.key, e.target.value)}
                        className={`${common} resize-none py-2`}
                      />
                    ) : (
                      <input
                        type={def.inputType}
                        value={values[f.key] ?? ""}
                        onChange={(e) => set(f.key, e.target.value)}
                        className={`${common} h-10`}
                      />
                    )}
                  </div>
                );
              })}

              {/* Honeypot: invisível pra humanos, tentador pra bots. */}
              <input
                type="text"
                name="site"
                tabIndex={-1}
                autoComplete="off"
                value={site}
                onChange={(e) => setSite(e.target.value)}
                className="absolute -left-[9999px] h-0 w-0 opacity-0"
                aria-hidden="true"
              />

              {error ? (
                <p className="text-sm text-rose-600">{error}</p>
              ) : null}

              <button
                type="submit"
                disabled={sending}
                style={{ background: brand }}
                className="mt-1 w-full rounded-lg px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
              >
                {sending ? "Enviando..." : submitLabel}
              </button>
            </form>
          </>
        )}

        {!embedded && (
          <p className="mt-5 text-center text-[11px] text-slate-400">
            Feito com Fluxia
          </p>
        )}
      </div>
  );

  if (embedded) return card;

  return (
    <main className="flex min-h-screen items-center justify-center bg-gradient-to-b from-slate-100 to-slate-200 px-4 py-10">
      {card}
    </main>
  );
}

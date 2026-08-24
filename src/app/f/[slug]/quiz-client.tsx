"use client";

import { useState } from "react";

import {
  CAPTURE_FIELD_DEFS,
  type CaptureField,
  type QuizQuestion,
} from "@/lib/capture/shared";
import { trackLead } from "./tracking-scripts";

/**
 * Quiz público de captação (/f/[slug] com mode='quiz'). Fluxo: intro →
 * perguntas uma a uma (barra de progresso, escolha avança sozinha) → dados de
 * contato (o "portão" pra ver o resultado) → IA analisa → diagnóstico
 * personalizado na tela + oferta/WhatsApp/agenda. Tema claro na cor da marca;
 * o fundo mesh vem pronto do servidor.
 */
export function CaptureQuizClient({
  slug,
  headline,
  description,
  ctaStart,
  questions,
  fields,
  submitLabel,
  accent,
  logo,
  background,
  aiEnabled,
  successOffer,
  successWaHref,
  successSchedulerUrl,
}: {
  slug: string;
  headline: string;
  description: string | null;
  ctaStart: string;
  questions: QuizQuestion[];
  fields: CaptureField[];
  submitLabel: string;
  accent: string;
  logo: string | null;
  /** CSS `background` da página (mesh gradient na cor da marca). */
  background: string;
  aiEnabled: boolean;
  successOffer?: { title: string | null; text: string | null } | null;
  successWaHref?: string | null;
  successSchedulerUrl?: string | null;
}) {
  // 'intro' → índice da pergunta → 'contact' → 'loading' → 'done'
  const [step, setStep] = useState<"intro" | number | "contact" | "loading" | "done">(
    "intro",
  );
  const [answers, setAnswers] = useState<string[]>(
    () => questions.map(() => ""),
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [site, setSite] = useState(""); // honeypot
  const [error, setError] = useState("");
  const [result, setResult] = useState("");

  const total = questions.length;
  const answered =
    typeof step === "number" ? step : step === "intro" ? 0 : total;
  const progress = Math.round(
    (answered / (total + 1)) * 100 + (step === "contact" ? 100 / (total + 1) / 2 : 0),
  );

  function setAnswer(i: number, v: string) {
    setAnswers((prev) => prev.map((a, idx) => (idx === i ? v : a)));
  }

  function pick(i: number, option: string) {
    setAnswer(i, option);
    // Micro-pausa pro clique "assentar" antes de avançar.
    window.setTimeout(() => {
      setStep(i + 1 < total ? i + 1 : "contact");
    }, 180);
  }

  function set(k: string, v: string) {
    setValues((prev) => ({ ...prev, [k]: v }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    for (const f of fields) {
      if (f.required && !(values[f.key] ?? "").trim()) {
        setError(`Preencha: ${f.label}`);
        return;
      }
    }
    const telDigits = (values["telefone"] ?? "").replace(/\D/g, "");
    if (telDigits) {
      const national = telDigits.startsWith("55")
        ? telDigits.slice(2)
        : telDigits;
      if (national.length < 10 || national.length > 11) {
        setError("Informe o WhatsApp com DDD — ex.: (67) 99999-9999");
        return;
      }
    }
    setStep("loading");
    try {
      const r = await fetch("/api/public/capture/quiz", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, site, answers, ...values }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: string;
        error?: string;
      };
      if (!r.ok || !j.ok) {
        setError(j.error || "Não foi possível enviar. Tente de novo.");
        setStep("contact");
        return;
      }
      setResult(j.result || "Recebemos suas respostas! 🎉");
      setStep("done");
      trackLead();
    } catch {
      setError("Erro de conexão. Tente de novo.");
      setStep("contact");
    }
  }

  const inputCls =
    "w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none transition focus:border-violet-500 focus:ring-1 focus:ring-violet-500";

  return (
    <main
      className="flex min-h-screen items-center justify-center px-4 py-10"
      style={{ background }}
    >
      <div className="w-full max-w-lg">
        {/* Barra de progresso — só durante o fluxo. */}
        {step !== "intro" && step !== "done" ? (
          <div className="mb-3 h-1.5 overflow-hidden rounded-full bg-white/70 shadow-inner">
            <div
              className="h-full rounded-full transition-all duration-300"
              style={{ width: `${Math.min(progress, 100)}%`, background: accent }}
            />
          </div>
        ) : null}

        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-xl sm:p-8">
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={logo}
              alt="logo"
              className="mb-5 h-9 w-auto max-w-[160px] object-contain"
            />
          ) : null}

          {step === "intro" ? (
            <div>
              <h1 className="text-2xl font-extrabold leading-tight text-slate-900">
                {headline}
              </h1>
              {description ? (
                <p className="mt-2 text-sm text-slate-600">{description}</p>
              ) : null}
              <p className="mt-4 text-xs text-slate-400">
                {total} pergunta{total > 1 ? "s" : ""} · leva menos de 1 minuto
                {aiEnabled ? " · resultado personalizado na hora" : ""}
              </p>
              <button
                type="button"
                onClick={() => setStep(0)}
                className="mt-5 w-full rounded-xl px-5 py-3 text-sm font-semibold text-white transition hover:opacity-90"
                style={{ background: accent }}
              >
                {ctaStart}
              </button>
            </div>
          ) : null}

          {typeof step === "number" ? (
            <div>
              <p className="text-xs font-medium text-slate-400">
                Pergunta {step + 1} de {total}
              </p>
              <h2 className="mt-1.5 text-lg font-bold leading-snug text-slate-900">
                {questions[step].text}
              </h2>
              {questions[step].type === "choice" ? (
                <div className="mt-4 space-y-2">
                  {questions[step].options.map((op) => (
                    <button
                      key={op}
                      type="button"
                      onClick={() => pick(step, op)}
                      className="w-full rounded-xl border px-4 py-3 text-left text-sm font-medium transition"
                      style={
                        answers[step] === op
                          ? {
                              borderColor: accent,
                              background: `${accent}14`,
                              color: "#0f172a",
                            }
                          : { borderColor: "#e2e8f0", color: "#334155" }
                      }
                    >
                      {op}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="mt-4 space-y-3">
                  <textarea
                    rows={4}
                    value={answers[step]}
                    onChange={(e) => setAnswer(step, e.target.value)}
                    placeholder="Escreva aqui..."
                    className={`${inputCls} resize-none py-2`}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setStep(step + 1 < total ? step + 1 : "contact")
                    }
                    className="w-full rounded-xl px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
                    style={{ background: accent }}
                  >
                    Continuar
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={() => setStep(step === 0 ? "intro" : step - 1)}
                className="mt-4 text-xs text-slate-400 transition hover:text-slate-600"
              >
                ← Voltar
              </button>
            </div>
          ) : null}

          {step === "contact" ? (
            <div>
              <h2 className="text-lg font-bold text-slate-900">Quase lá! 🎯</h2>
              <p className="mt-1 text-sm text-slate-600">
                {aiEnabled
                  ? "Deixe seu contato pra ver seu resultado personalizado."
                  : "Deixe seu contato pra gente te chamar com as recomendações."}
              </p>
              <form onSubmit={submit} className="mt-4 space-y-3.5">
                {fields.map((f) => {
                  const def = CAPTURE_FIELD_DEFS[f.key];
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
                          className={`${inputCls} resize-none py-2`}
                        />
                      ) : (
                        <input
                          type={def.inputType}
                          value={values[f.key] ?? ""}
                          onChange={(e) => set(f.key, e.target.value)}
                          placeholder={
                            f.key === "telefone" ? "(67) 99999-9999" : undefined
                          }
                          className={`${inputCls} h-10`}
                        />
                      )}
                      {f.key === "telefone" ? (
                        <p className="text-[11px] text-slate-400">
                          Digite com DDD — é por ele que vamos te chamar.
                        </p>
                      ) : null}
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

                {error ? <p className="text-sm text-rose-600">{error}</p> : null}

                <button
                  type="submit"
                  style={{ background: accent }}
                  className="mt-1 w-full rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
                >
                  {aiEnabled ? "Ver meu resultado" : submitLabel}
                </button>
              </form>
              <button
                type="button"
                onClick={() => setStep(total - 1)}
                className="mt-4 text-xs text-slate-400 transition hover:text-slate-600"
              >
                ← Voltar
              </button>
            </div>
          ) : null}

          {step === "loading" ? (
            <div className="py-10 text-center">
              <div className="mx-auto flex h-14 w-14 animate-pulse items-center justify-center rounded-full text-3xl"
                style={{ background: `${accent}14` }}
              >
                🧠
              </div>
              <p className="mt-4 text-sm font-semibold text-slate-900">
                {aiEnabled
                  ? "Analisando suas respostas..."
                  : "Enviando..."}
              </p>
              {aiEnabled ? (
                <p className="mt-1 text-xs text-slate-500">
                  Preparando um resultado feito pra você.
                </p>
              ) : null}
            </div>
          ) : null}

          {step === "done" ? (
            <div>
              <div
                className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold"
                style={{ background: `${accent}14`, color: accent }}
              >
                ✨ Seu resultado
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                {result}
              </p>

              {successOffer ? (
                <div
                  className="mt-5 rounded-xl border px-4 py-3"
                  style={{ borderColor: `${accent}55`, background: `${accent}0d` }}
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

              {successSchedulerUrl ? (
                <a
                  href={successSchedulerUrl}
                  className="mt-2.5 inline-flex w-full items-center justify-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-semibold transition hover:opacity-80"
                  style={{ borderColor: accent, color: accent }}
                >
                  📅 Já quer garantir um horário? Agende agora
                </a>
              ) : null}
            </div>
          ) : null}
        </div>

        <p className="mt-5 text-center text-[11px] text-slate-500">
          Feito com Fluxia
        </p>
      </div>
    </main>
  );
}

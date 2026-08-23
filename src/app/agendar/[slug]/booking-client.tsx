"use client";

import { useState } from "react";

import type { DaySlots } from "@/lib/scheduling/public";

/**
 * Fluxo de reserva: dia → horário → dados → confirmado. Tema "papel" (claro),
 * mobile-first. Se o horário for tomado no meio do caminho (409), recarrega os
 * slots e avisa. Honeypot anti-bot no formulário.
 */
export function BookingClient({
  slug,
  name,
  description,
  durationMinutes,
  location,
  initialDays,
}: {
  slug: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  location: string | null;
  initialDays: DaySlots[];
}) {
  const [days, setDays] = useState<DaySlots[]>(initialDays);
  const [dayIdx, setDayIdx] = useState(0);
  const [picked, setPicked] = useState<{ iso: string; label: string } | null>(
    null,
  );
  const [nome, setNome] = useState("");
  const [telefone, setTelefone] = useState("");
  const [email, setEmail] = useState("");
  const [obs, setObs] = useState("");
  const [site, setSite] = useState(""); // honeypot
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [confirmed, setConfirmed] = useState<string | null>(null);

  const day = days[dayIdx] ?? null;

  async function refreshSlots() {
    try {
      const r = await fetch(
        `/api/public/agendar/slots?slug=${encodeURIComponent(slug)}`,
      );
      const j = (await r.json().catch(() => null)) as {
        ok?: boolean;
        days?: DaySlots[];
      } | null;
      if (j?.ok && Array.isArray(j.days)) {
        setDays(j.days);
        setDayIdx(0);
        setPicked(null);
      }
    } catch {}
  }

  async function book(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!picked) return;
    if (!nome.trim()) {
      setError("Informe seu nome.");
      return;
    }
    const telDigits = telefone.replace(/\D/g, "");
    const national = telDigits.startsWith("55")
      ? telDigits.slice(2)
      : telDigits;
    if (national.length < 10 || national.length > 11) {
      setError("Informe o WhatsApp com DDD — ex.: (67) 99999-9999");
      return;
    }
    setSending(true);
    try {
      const r = await fetch("/api/public/agendar/book", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          startIso: picked.iso,
          nome,
          telefone,
          email,
          obs,
          site,
        }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        ok?: boolean;
        slotTaken?: boolean;
        error?: string;
        whenLabel?: string;
      };
      if (r.ok && j.ok) {
        setConfirmed(j.whenLabel || `${day?.label} às ${picked.label}`);
        return;
      }
      if (j.slotTaken) {
        setError(j.error || "Este horário acabou de ser reservado. Escolha outro.");
        await refreshSlots();
      } else {
        setError(j.error || "Não foi possível agendar. Tente de novo.");
      }
      setSending(false);
    } catch {
      setError("Erro de conexão. Tente de novo.");
      setSending(false);
    }
  }

  return (
    <main className="flex min-h-screen items-start justify-center bg-gradient-to-b from-slate-100 to-slate-200 px-4 py-8 sm:py-12">
      <div className="w-full max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-xl sm:p-8">
        {confirmed ? (
          <div className="py-6 text-center">
            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-2xl">
              📅
            </div>
            <h1 className="text-xl font-bold text-slate-900">Agendado!</h1>
            <p className="mt-2 text-sm text-slate-600">
              Sua reunião ficou marcada para{" "}
              <strong className="text-slate-900">{confirmed}</strong>.
            </p>
            {location ? (
              <p className="mt-1 text-sm text-slate-600">{location}</p>
            ) : null}
            <p className="mt-4 text-sm text-slate-500">
              Você recebe a confirmação no seu WhatsApp. Até lá! 👋
            </p>
          </div>
        ) : (
          <>
            <h1 className="text-xl font-bold text-slate-900">{name}</h1>
            {description ? (
              <p className="mt-1.5 text-sm text-slate-600">{description}</p>
            ) : null}
            <p className="mt-2 text-xs text-slate-500">
              ⏱ {durationMinutes} min{location ? ` · ${location}` : ""}
            </p>

            {days.length === 0 ? (
              <p className="mt-6 rounded-lg bg-slate-50 px-4 py-6 text-center text-sm text-slate-500">
                Nenhum horário disponível no momento. Volte em breve!
              </p>
            ) : (
              <>
                {/* Dias */}
                <div className="mt-5 flex gap-2 overflow-x-auto pb-1">
                  {days.map((d, i) => (
                    <button
                      key={d.date}
                      type="button"
                      onClick={() => {
                        setDayIdx(i);
                        setPicked(null);
                      }}
                      className={`shrink-0 rounded-lg border px-3 py-2 text-sm transition ${
                        i === dayIdx
                          ? "border-violet-600 bg-violet-600 text-white"
                          : "border-slate-300 bg-white text-slate-700 hover:border-violet-400"
                      }`}
                    >
                      {d.label}
                    </button>
                  ))}
                </div>

                {/* Horários */}
                {day ? (
                  <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {day.slots.map((s) => (
                      <button
                        key={s.iso}
                        type="button"
                        onClick={() => setPicked(s)}
                        className={`rounded-lg border px-2 py-2 text-sm tabular-nums transition ${
                          picked?.iso === s.iso
                            ? "border-violet-600 bg-violet-600 text-white"
                            : "border-slate-300 bg-white text-slate-700 hover:border-violet-400"
                        }`}
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                ) : null}

                {/* Dados */}
                {picked ? (
                  <form onSubmit={book} className="mt-6 space-y-3.5 border-t border-slate-200 pt-5">
                    <p className="text-sm text-slate-700">
                      Confirmando{" "}
                      <strong>
                        {day?.label} às {picked.label}
                      </strong>
                      :
                    </p>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-600">
                        Seu nome <span className="text-rose-500">*</span>
                      </label>
                      <input
                        value={nome}
                        onChange={(e) => setNome(e.target.value)}
                        className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-violet-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-600">
                        WhatsApp <span className="text-rose-500">*</span>
                      </label>
                      <input
                        type="tel"
                        value={telefone}
                        onChange={(e) => setTelefone(e.target.value)}
                        placeholder="(67) 99999-9999"
                        className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-violet-500"
                      />
                      <p className="text-[11px] text-slate-400">
                        Digite com DDD — a confirmação chega por ele.
                      </p>
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-600">
                        E-mail (opcional)
                      </label>
                      <input
                        type="email"
                        value={email}
                        onChange={(e) => setEmail(e.target.value)}
                        className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 outline-none focus:border-violet-500"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-slate-600">
                        Sobre o que você quer falar? (opcional)
                      </label>
                      <textarea
                        rows={2}
                        value={obs}
                        onChange={(e) => setObs(e.target.value)}
                        className="w-full resize-none rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:border-violet-500"
                      />
                    </div>

                    {/* Honeypot */}
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
                      className="w-full rounded-lg bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-violet-700 disabled:opacity-60"
                    >
                      {sending ? "Agendando..." : "Confirmar agendamento"}
                    </button>
                  </form>
                ) : null}
              </>
            )}
          </>
        )}

        <p className="mt-5 text-center text-[11px] text-slate-400">
          Feito com Fluxia
        </p>
      </div>
    </main>
  );
}

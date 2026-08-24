"use client";

// ============================================================
// Captação self-serve (menu → Captação). Lista de formulários públicos + editor.
// Cada form tem um link /f/<slug> que joga o lead direto no funil da conta.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Plus,
  LayoutTemplate,
  Copy,
  Trash2,
  Pencil,
  ExternalLink,
  ClipboardList,
  Loader2,
  Brain,
  ArrowUp,
  ArrowDown,
  BarChart3,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  listCaptureForms,
  getCaptureForm,
  createCaptureForm,
  updateCaptureForm,
  deleteCaptureForm,
  listCapturePipelines,
  listCaptureChannels,
  listCaptureCadences,
  listCaptureMembers,
  generateCaptureLanding,
  getCaptureWaInfo,
  listSchedulers,
  getScheduler,
  createScheduler,
  updateScheduler,
  deleteScheduler,
  generateCaptureQuiz,
  getCaptureXray,
  type CaptureXray,
  type CaptureFormRow,
  type CaptureFormDetail,
  type CaptureWaInfo,
  type SchedulerRow,
  type SchedulerDetail,
  type SchedulerWindowInput,
} from "./actions";
import QRCode from "qrcode";
import {
  CAPTURE_FIELD_DEFS,
  CAPTURE_FIELD_ORDER,
  CAPTURE_TEMPLATES,
  DEFAULT_CAPTURE_FIELDS,
  DEFAULT_CAPTURE_CONTENT,
  DEFAULT_CAPTURE_HEADLINE,
  DEFAULT_CAPTURE_SUBMIT,
  DEFAULT_CAPTURE_SUCCESS,
  STARTER_QUIZ_QUESTIONS,
  type CaptureField,
  type CaptureFieldKey,
  type CaptureBenefit,
  type CaptureTestimonial,
  type QuizQuestion,
} from "@/lib/capture/shared";
import { uploadAccountMedia } from "@/lib/storage/upload-media";
import { getCompanyData } from "@/components/settings/actions";

/** Cor dominante da logo (client, canvas): ignora cinzas/branco/preto e pega o
 *  matiz saturado mais frequente. Logo vem do proxy same-origin (sem taint). */
async function dominantColorFromImage(url: string): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const size = 64;
        const c = document.createElement("canvas");
        c.width = size;
        c.height = size;
        const ctx = c.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, size, size);
        const data = ctx.getImageData(0, 0, size, size).data;
        const buckets = new Map<
          string,
          { count: number; r: number; g: number; b: number }
        >();
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const a = data[i + 3];
          if (a < 200) continue;
          const max = Math.max(r, g, b);
          const min = Math.min(r, g, b);
          const sat = max === 0 ? 0 : (max - min) / max;
          const lum = (r + g + b) / 3;
          if (sat < 0.25 || lum < 30 || lum > 235) continue;
          const key = `${r >> 5}-${g >> 5}-${b >> 5}`;
          const bk = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
          bk.count++;
          bk.r += r;
          bk.g += g;
          bk.b += b;
          buckets.set(key, bk);
        }
        let top: { count: number; r: number; g: number; b: number } | null =
          null;
        for (const v of buckets.values()) {
          if (!top || v.count > top.count) top = v;
        }
        if (!top) return resolve(null);
        const hx = (n: number) =>
          Math.round(n / top.count)
            .toString(16)
            .padStart(2, "0");
        resolve(`#${hx(top.r)}${hx(top.g)}${hx(top.b)}`);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

type Pipeline = { id: string; name: string; stages: { id: string; name: string }[] };

const XRAY_KIND: Record<
  "form" | "landing" | "quiz" | "whatsapp" | "agenda",
  { emoji: string; label: string }
> = {
  form: { emoji: "📝", label: "Formulário" },
  landing: { emoji: "🖼️", label: "Landing" },
  quiz: { emoji: "🧠", label: "Quiz" },
  whatsapp: { emoji: "📱", label: "Link Zap" },
  agenda: { emoji: "📅", label: "Agenda" },
};

function fmtBRL(v: number): string {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: v % 1 === 0 ? 0 : 2,
  }).format(v);
}

export default function CaptacaoPage() {
  const [forms, setForms] = useState<CaptureFormRow[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [cadences, setCadences] = useState<{ id: string; name: string }[]>([]);
  const [scheds, setScheds] = useState<SchedulerRow[]>([]);
  const [members, setMembers] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<
    CaptureFormDetail | { new: "form" | "landing" | "quiz" } | null
  >(null);
  const [editingSched, setEditingSched] = useState<SchedulerDetail | "new" | null>(
    null,
  );
  // 📊 Raio-X de campanha
  const [showXray, setShowXray] = useState(false);
  const [xrayDays, setXrayDays] = useState(30);
  const [xray, setXray] = useState<CaptureXray | null>(null);
  const [xrayLoading, setXrayLoading] = useState(false);

  const loadXray = useCallback(async (d: number) => {
    setXrayLoading(true);
    const res = await getCaptureXray(d).catch(() => null);
    setXray(res);
    setXrayLoading(false);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    const [f, p, ch, cad, sc, mb] = await Promise.all([
      listCaptureForms().catch(() => [] as CaptureFormRow[]),
      listCapturePipelines().catch(() => [] as Pipeline[]),
      listCaptureChannels().catch(() => [] as { id: string; name: string }[]),
      listCaptureCadences().catch(() => [] as { id: string; name: string }[]),
      listSchedulers().catch(() => [] as SchedulerRow[]),
      listCaptureMembers().catch(() => [] as { id: string; name: string }[]),
    ]);
    setForms(f);
    setPipelines(p);
    setChannels(ch);
    setCadences(cad);
    setScheds(sc);
    setMembers(mb);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function openEdit(id: string) {
    const detail = await getCaptureForm(id).catch(() => null);
    if (!detail) {
      toast.error("Não foi possível abrir o formulário.");
      return;
    }
    setEditing(detail);
  }

  async function handleDelete(id: string) {
    if (!confirm("Excluir este formulário? O link para de funcionar.")) return;
    const { error } = await deleteCaptureForm(id);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Formulário excluído.");
    void load();
  }

  function copyLink(url: string) {
    navigator.clipboard?.writeText(url);
    toast.success("Link copiado.");
  }

  async function openEditSched(id: string) {
    const detail = await getScheduler(id).catch(() => null);
    if (!detail) {
      toast.error("Não foi possível abrir a página de agendamento.");
      return;
    }
    setEditingSched(detail);
  }

  async function handleDeleteSched(id: string) {
    if (!confirm("Excluir esta página de agendamento? O link para de funcionar."))
      return;
    const { error } = await deleteScheduler(id);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Página excluída.");
    void load();
  }

  if (editingSched) {
    return (
      <SchedulerEditor
        initial={editingSched === "new" ? null : editingSched}
        pipelines={pipelines}
        channels={channels}
        members={members}
        onCancel={() => setEditingSched(null)}
        onSaved={() => {
          setEditingSched(null);
          void load();
        }}
      />
    );
  }

  if (editing) {
    const isNew = "new" in editing;
    return (
      <CaptureEditor
        initial={isNew ? null : (editing as CaptureFormDetail)}
        newMode={
          isNew
            ? (editing as { new: "form" | "landing" | "quiz" }).new
            : undefined
        }
        pipelines={pipelines}
        channels={channels}
        cadences={cadences}
        scheds={scheds}
        onCancel={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void load();
        }}
      />
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-foreground">Captação</h1>
          <p className="text-sm text-muted-foreground">
            Formulários públicos que jogam o lead direto no seu funil.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant={showXray ? "default" : "outline"}
            onClick={() => {
              const next = !showXray;
              setShowXray(next);
              if (next && !xray) void loadXray(xrayDays);
            }}
          >
            <BarChart3 className="mr-1.5 h-4 w-4" /> Raio-X
          </Button>
          <Button variant="outline" onClick={() => setEditing({ new: "form" })}>
            <Plus className="mr-1.5 h-4 w-4" /> Novo formulário
          </Button>
          <Button variant="outline" onClick={() => setEditing({ new: "quiz" })}>
            <Brain className="mr-1.5 h-4 w-4" /> Novo quiz
          </Button>
          <Button onClick={() => setEditing({ new: "landing" })}>
            <LayoutTemplate className="mr-1.5 h-4 w-4" /> Nova landing page
          </Button>
        </div>
      </div>

      {/* 📊 Raio-X de campanha: cohort dos leads captados no período */}
      {showXray ? (
        <div className="space-y-4 rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-semibold text-foreground">
              📊 Raio-X de campanha
            </div>
            <span className="text-xs text-muted-foreground">
              leads captados no período — e no que deu
            </span>
            <div className="ml-auto flex gap-1">
              {(
                [
                  [7, "7 dias"],
                  [30, "30 dias"],
                  [90, "90 dias"],
                  [0, "Tudo"],
                ] as const
              ).map(([d, label]) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => {
                    setXrayDays(d);
                    void loadXray(d);
                  }}
                  className={`rounded-lg border px-2.5 py-1 text-xs transition ${
                    xrayDays === d
                      ? "border-primary bg-primary/10 text-foreground"
                      : "border-border text-muted-foreground hover:border-primary/40"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {xrayLoading ? (
            <div className="flex justify-center py-8 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : !xray || xray.totals.leads === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Nenhum lead de captação no período — compartilhe seus links e o
              raio-x acende. 📡
            </p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                {(
                  [
                    ["Leads captados", String(xray.totals.leads), ""],
                    ["Em negociação", String(xray.totals.open), ""],
                    [
                      "🏆 Ganhos",
                      String(xray.totals.won),
                      fmtBRL(xray.totals.wonValue),
                    ],
                    ["Perdidos", String(xray.totals.lost), ""],
                    [
                      "Conversão",
                      xray.totals.leads
                        ? `${Math.round((xray.totals.won / xray.totals.leads) * 100)}%`
                        : "0%",
                      "",
                    ],
                  ] as const
                ).map(([label, value, extra]) => (
                  <div
                    key={label}
                    className="rounded-lg border border-border bg-muted/30 p-3"
                  >
                    <div className="text-lg font-bold text-foreground">
                      {value}
                    </div>
                    <div className="text-xs text-muted-foreground">{label}</div>
                    {extra ? (
                      <div className="mt-0.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        {extra}
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>

              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted-foreground">
                      <th className="py-2 pr-3 font-medium">Origem</th>
                      <th className="px-2 py-2 text-right font-medium">Leads</th>
                      <th className="px-2 py-2 text-right font-medium">
                        Em aberto
                      </th>
                      <th className="px-2 py-2 text-right font-medium">Ganhos</th>
                      <th className="px-2 py-2 text-right font-medium">
                        Perdidos
                      </th>
                      <th className="px-2 py-2 text-right font-medium">
                        Conversão
                      </th>
                      <th className="py-2 pl-2 text-right font-medium">
                        Valor ganho
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {xray.rows.map((r) => {
                      const meta = XRAY_KIND[r.kind];
                      return (
                        <tr
                          key={r.source}
                          className="border-b border-border/60 last:border-0"
                        >
                          <td className="py-2 pr-3">
                            <div className="flex items-center gap-1.5">
                              <span>{meta.emoji}</span>
                              <span className="font-medium text-foreground">
                                {r.label}
                              </span>
                              <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                {meta.label}
                              </span>
                            </div>
                            {r.quiz ? (
                              <div className="mt-0.5 text-[11px] text-muted-foreground">
                                🔥 {r.quiz.quente} quente
                                {r.quiz.quente === 1 ? "" : "s"} · 🌤️{" "}
                                {r.quiz.morno} morno
                                {r.quiz.morno === 1 ? "" : "s"} · ❄️{" "}
                                {r.quiz.frio} frio{r.quiz.frio === 1 ? "" : "s"}
                              </div>
                            ) : null}
                          </td>
                          <td className="px-2 py-2 text-right font-medium text-foreground">
                            {r.leads}
                          </td>
                          <td className="px-2 py-2 text-right text-muted-foreground">
                            {r.open}
                          </td>
                          <td className="px-2 py-2 text-right text-emerald-600 dark:text-emerald-400">
                            {r.won}
                          </td>
                          <td className="px-2 py-2 text-right text-muted-foreground">
                            {r.lost}
                          </td>
                          <td className="px-2 py-2 text-right text-foreground">
                            {r.leads
                              ? `${Math.round((r.won / r.leads) * 100)}%`
                              : "—"}
                          </td>
                          <td className="py-2 pl-2 text-right font-medium text-foreground">
                            {r.wonValue > 0 ? fmtBRL(r.wonValue) : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : forms.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
          <ClipboardList className="mx-auto h-8 w-8 text-muted-foreground" />
          <p className="mt-3 text-sm text-muted-foreground">
            Nenhum formulário ainda. Crie um e compartilhe o link na bio do
            Instagram, no site ou onde quiser.
          </p>
          <Button className="mt-4" onClick={() => setEditing({ new: "landing" })}>
            <Plus className="mr-1.5 h-4 w-4" /> Criar o primeiro
          </Button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {forms.map((f) => (
            <div
              key={f.id}
              className="rounded-xl border border-border bg-card p-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-sm font-semibold text-foreground">
                      {f.name}
                    </h2>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                        f.mode === "landing"
                          ? "bg-violet-500/15 text-violet-600 dark:text-violet-400"
                          : f.mode === "quiz"
                            ? "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400"
                            : "bg-sky-500/15 text-sky-600 dark:text-sky-400"
                      }`}
                    >
                      {f.mode === "landing"
                        ? "Landing"
                        : f.mode === "quiz"
                          ? "🧠 Quiz"
                          : "Formulário"}
                    </span>
                    <span
                      className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                        f.active
                          ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {f.active ? "Ativo" : "Inativo"}
                    </span>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {f.pipelineName ? `Funil: ${f.pipelineName} · ` : ""}
                    {f.submissions} envio(s)
                  </p>
                </div>
              </div>

              <div className="mt-3 flex items-center gap-1 rounded-lg border border-border bg-muted/50 px-2 py-1.5">
                <span className="flex-1 truncate text-xs text-muted-foreground">
                  {f.publicUrl}
                </span>
                <button
                  type="button"
                  onClick={() => copyLink(f.publicUrl)}
                  title="Copiar link"
                  className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <a
                  href={f.publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Abrir"
                  className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>

              <div className="mt-3 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void openEdit(f.id)}
                >
                  <Pencil className="mr-1.5 h-3.5 w-3.5" /> Editar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleDelete(f.id)}
                  className="text-muted-foreground hover:text-red-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Páginas de agendamento (tipo Calendly) */}
      <div className="mt-8 flex items-center gap-3 border-t border-border pt-6">
        <div className="flex-1">
          <h2 className="text-lg font-bold text-foreground">
            🗓️ Páginas de agendamento
          </h2>
          <p className="text-sm text-muted-foreground">
            Link público onde o lead escolhe o horário — vira reunião na agenda
            e card no funil, com confirmação no WhatsApp.
          </p>
        </div>
        <Button onClick={() => setEditingSched("new")}>
          <Plus className="mr-1.5 h-4 w-4" /> Nova página
        </Button>
      </div>

      {!loading && scheds.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 p-6 text-center">
          <p className="text-sm text-muted-foreground">
            Nenhuma página ainda. Crie uma e coloque o link na bio, na
            assinatura de e-mail ou mande direto pro lead.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {scheds.map((s) => (
            <div key={s.id} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center gap-2">
                <h3 className="truncate text-sm font-semibold text-foreground">
                  {s.name}
                </h3>
                <span
                  className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                    s.active
                      ? "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                      : "bg-muted text-muted-foreground"
                  }`}
                >
                  {s.active ? "Ativa" : "Inativa"}
                </span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {s.ownerName ? `Agenda de ${s.ownerName} · ` : ""}
                {s.bookings} agendamento(s)
              </p>
              <div className="mt-3 flex items-center gap-1 rounded-lg border border-border bg-muted/50 px-2 py-1.5">
                <span className="flex-1 truncate text-xs text-muted-foreground">
                  {s.publicUrl}
                </span>
                <button
                  type="button"
                  onClick={() => copyLink(s.publicUrl)}
                  title="Copiar link"
                  className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <a
                  href={s.publicUrl}
                  target="_blank"
                  rel="noreferrer"
                  title="Abrir"
                  className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </a>
              </div>
              <div className="mt-3 flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => void openEditSched(s.id)}>
                  <Pencil className="mr-1.5 h-3.5 w-3.5" /> Editar
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void handleDeleteSched(s.id)}
                  className="text-muted-foreground hover:text-red-500"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------
// Editor da página de agendamento.
// ------------------------------------------------------------
const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const DEFAULT_AVAILABILITY: SchedulerWindowInput[] = [
  { open: null, close: null },
  { open: "09:00", close: "18:00" },
  { open: "09:00", close: "18:00" },
  { open: "09:00", close: "18:00" },
  { open: "09:00", close: "18:00" },
  { open: "09:00", close: "18:00" },
  { open: null, close: null },
];

function SchedulerEditor({
  initial,
  pipelines,
  channels,
  members,
  onCancel,
  onSaved,
}: {
  initial: SchedulerDetail | null;
  pipelines: Pipeline[];
  channels: { id: string; name: string }[];
  members: { id: string; name: string }[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [headline, setHeadline] = useState(initial?.headline ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [userId, setUserId] = useState(initial?.userId ?? members[0]?.id ?? "");
  const [duration, setDuration] = useState(initial?.durationMinutes ?? 30);
  const [availability, setAvailability] = useState<SchedulerWindowInput[]>(
    initial?.availability?.length === 7
      ? initial.availability
      : DEFAULT_AVAILABILITY,
  );
  const [minNotice, setMinNotice] = useState(initial?.minNoticeHours ?? 12);
  const [horizon, setHorizon] = useState(initial?.horizonDays ?? 14);
  const [location, setLocation] = useState(initial?.location ?? "");
  const [pipelineId, setPipelineId] = useState(initial?.pipelineId ?? "");
  const [stageId, setStageId] = useState(initial?.stageId ?? "");
  const [origin, setOrigin] = useState(initial?.origin ?? "Agendamento");
  const [confirmWhatsapp, setConfirmWhatsapp] = useState(
    initial?.confirmWhatsapp ?? true,
  );
  const [confirmChannelId, setConfirmChannelId] = useState(
    initial?.confirmChannelId ?? "",
  );
  const [active, setActive] = useState(initial?.active ?? true);
  const [saving, setSaving] = useState(false);

  const stages = pipelines.find((p) => p.id === pipelineId)?.stages ?? [];

  function setDay(i: number, patch: Partial<SchedulerWindowInput>) {
    setAvailability((prev) =>
      prev.map((w, idx) => (idx === i ? { ...w, ...patch } : w)),
    );
  }

  async function handleSave() {
    if (!name.trim()) {
      toast.error("Dê um nome à página.");
      return;
    }
    if (!userId) {
      toast.error("Escolha o dono da agenda.");
      return;
    }
    const input = {
      name: name.trim(),
      headline: headline.trim() || null,
      description: description.trim() || null,
      userId,
      durationMinutes: duration,
      availability,
      minNoticeHours: minNotice,
      horizonDays: horizon,
      location: location.trim() || null,
      pipelineId: pipelineId || null,
      stageId: stageId || null,
      origin: origin.trim() || "Agendamento",
      confirmWhatsapp,
      confirmChannelId: confirmChannelId || null,
      active,
    };
    setSaving(true);
    const res = initial
      ? await updateScheduler(initial.id, input)
      : await createScheduler(input);
    setSaving(false);
    if ("error" in res && res.error) {
      toast.error(res.error);
      return;
    }
    toast.success(initial ? "Página salva." : "Página criada — link pronto.");
    onSaved();
  }

  const selectCls =
    "h-10 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";
  const timeCls =
    "h-8 w-[92px] rounded-lg border border-border bg-muted px-2 text-sm text-foreground outline-none focus:border-primary";

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-foreground">
            {initial ? "Editar página de agendamento" : "Nova página de agendamento"}
          </h1>
          <p className="text-sm text-muted-foreground">
            O lead escolhe o horário; a reunião cai na agenda e o card no funil.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Ativa
          <Switch checked={active} onCheckedChange={setActive} />
        </label>
      </div>

      <div className="space-y-4 rounded-xl border border-border bg-card p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>Nome (interno)</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex.: Demonstração da Fluxia"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Dono da agenda</Label>
            <select
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              className={selectCls}
            >
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label>Título público</Label>
            <Input
              value={headline}
              onChange={(e) => setHeadline(e.target.value)}
              placeholder="Ex.: Agende sua demonstração gratuita"
            />
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label>Descrição (opcional)</Label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full resize-none rounded-lg border border-border bg-muted px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Duração</Label>
            <select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className={selectCls}
            >
              {[15, 30, 45, 60, 90].map((d) => (
                <option key={d} value={d}>
                  {d} minutos
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5">
            <Label>Local / como será</Label>
            <Input
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              placeholder="Ex.: Chamada pelo WhatsApp"
            />
          </div>
        </div>
      </div>

      {/* Disponibilidade semanal */}
      <div className="space-y-2 rounded-xl border border-border bg-card p-4">
        <div className="text-sm font-semibold text-foreground">
          Horários disponíveis
        </div>
        {WEEKDAYS.map((label, i) => {
          const w = availability[i];
          const on = !!(w?.open && w?.close);
          return (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <label className="flex w-20 items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    setDay(
                      i,
                      e.target.checked
                        ? { open: "09:00", close: "18:00" }
                        : { open: null, close: null },
                    )
                  }
                  className="size-4 accent-primary"
                />
                {label}
              </label>
              {on ? (
                <>
                  <input
                    type="time"
                    value={w.open ?? "09:00"}
                    onChange={(e) => setDay(i, { open: e.target.value })}
                    className={timeCls}
                  />
                  <span className="text-xs text-muted-foreground">às</span>
                  <input
                    type="time"
                    value={w.close ?? "18:00"}
                    onChange={(e) => setDay(i, { close: e.target.value })}
                    className={timeCls}
                  />
                </>
              ) : (
                <span className="text-xs text-muted-foreground">indisponível</span>
              )}
            </div>
          );
        })}
        <p className="text-[11px] text-muted-foreground">
          Horários no fuso da conta. Reuniões já marcadas na agenda do dono
          (inclusive do Google) bloqueiam o horário automaticamente.
        </p>
        <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3 text-sm">
          <label className="flex items-center gap-2 text-muted-foreground">
            Antecedência mínima
            <Input
              type="number"
              min={0}
              max={168}
              value={minNotice}
              onChange={(e) => setMinNotice(Number(e.target.value) || 0)}
              className="h-8 w-20 text-center"
            />
            horas
          </label>
          <label className="flex items-center gap-2 text-muted-foreground">
            Mostrar próximos
            <Input
              type="number"
              min={1}
              max={60}
              value={horizon}
              onChange={(e) => setHorizon(Number(e.target.value) || 14)}
              className="h-8 w-20 text-center"
            />
            dias
          </label>
        </div>
      </div>

      {/* Destino + confirmação */}
      <div className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label>Funil de destino</Label>
          <select
            value={pipelineId}
            onChange={(e) => {
              setPipelineId(e.target.value);
              setStageId("");
            }}
            className={selectCls}
          >
            <option value="">Primeiro funil</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label>Etapa</Label>
          <select
            value={stageId}
            onChange={(e) => setStageId(e.target.value)}
            disabled={!pipelineId}
            className={selectCls}
          >
            <option value="">Primeira etapa</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-1.5">
          <Label>Origem do lead</Label>
          <Input value={origin} onChange={(e) => setOrigin(e.target.value)} />
        </div>
        <div className="grid gap-1.5">
          <Label>Canal da confirmação</Label>
          <select
            value={confirmChannelId}
            onChange={(e) => setConfirmChannelId(e.target.value)}
            className={selectCls}
          >
            <option value="">Canal padrão</option>
            {channels.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm text-foreground sm:col-span-2">
          <input
            type="checkbox"
            checked={confirmWhatsapp}
            onChange={(e) => setConfirmWhatsapp(e.target.checked)}
            className="size-4 accent-primary"
          />
          Enviar confirmação no WhatsApp do lead ao agendar
        </label>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={() => void handleSave()} disabled={saving}>
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
          Salvar
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------
// Editor (criar/editar). Estado local; salva via create/update.
// ------------------------------------------------------------
function CaptureEditor({
  initial,
  newMode,
  pipelines,
  channels,
  cadences,
  scheds,
  onCancel,
  onSaved,
}: {
  initial: CaptureFormDetail | null;
  /** Ao criar: modo pré-escolhido pelo botão (form | landing | quiz). */
  newMode?: "form" | "landing" | "quiz";
  pipelines: Pipeline[];
  channels: { id: string; name: string }[];
  cadences: { id: string; name: string }[];
  scheds: SchedulerRow[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [headline, setHeadline] = useState(
    initial?.headline ?? DEFAULT_CAPTURE_HEADLINE,
  );
  const [description, setDescription] = useState(initial?.description ?? "");
  const [submitLabel, setSubmitLabel] = useState(
    initial?.submitLabel ?? DEFAULT_CAPTURE_SUBMIT,
  );
  const [successMessage, setSuccessMessage] = useState(
    initial?.successMessage ?? DEFAULT_CAPTURE_SUCCESS,
  );
  const [origin, setOrigin] = useState(initial?.origin ?? "Formulário");
  const [active, setActive] = useState(initial?.active ?? true);
  const [pipelineId, setPipelineId] = useState(initial?.pipelineId ?? "");
  const [stageId, setStageId] = useState(initial?.stageId ?? "");
  // IA no Segundo Zero: primeira mensagem da IA no WhatsApp após o envio.
  const [aiIntro, setAiIntro] = useState(initial?.aiIntro ?? false);
  const [introChannelId, setIntroChannelId] = useState(
    initial?.introChannelId ?? "",
  );
  // Obrigado que Vende: oferta + botão de zap + cadência na tela de sucesso.
  const [offerTitle, setOfferTitle] = useState(initial?.successOfferTitle ?? "");
  const [offerText, setOfferText] = useState(initial?.successOfferText ?? "");
  const [successWhatsapp, setSuccessWhatsapp] = useState(
    initial?.successWhatsapp ?? false,
  );
  const [cadenceId, setCadenceId] = useState(initial?.cadenceId ?? "");
  const [saving, setSaving] = useState(false);

  // Conteúdo da landing page.
  const initContent = initial?.content ?? DEFAULT_CAPTURE_CONTENT;
  const [mode, setMode] = useState<"form" | "landing" | "quiz">(
    initial ? initContent.mode : newMode ?? initContent.mode,
  );
  const [heroImage, setHeroImage] = useState(initContent.heroImage ?? "");
  const [landingLogo, setLandingLogo] = useState(initContent.logo ?? "");
  const [brandColor, setBrandColor] = useState(initContent.brandColor ?? "#7c3aed");
  const [ctaText, setCtaText] = useState(initContent.ctaText ?? "");
  const [benefitsTitle, setBenefitsTitle] = useState(initContent.benefitsTitle ?? "");
  const [benefits, setBenefits] = useState<CaptureBenefit[]>(initContent.benefits);
  const [testimonials, setTestimonials] = useState<CaptureTestimonial[]>(
    initContent.testimonials,
  );
  const [uploadingHero, setUploadingHero] = useState(false);
  const [uploadingLandingLogo, setUploadingLandingLogo] = useState(false);
  // Mini-site: botão de WhatsApp + agendamento na landing.
  const [showWhatsapp, setShowWhatsapp] = useState(
    initContent.showWhatsapp ?? false,
  );
  const [schedulerSlug, setSchedulerSlug] = useState(
    initContent.schedulerSlug ?? "",
  );
  // Identidade da marca: fundo do hero + puxar logo/cor da empresa.
  const [heroStyle, setHeroStyle] = useState<
    "gradient" | "mesh" | "waves" | "blobs" | "grid" | "lowpoly"
  >(initContent.heroStyle ?? "gradient");
  const [brandBusy, setBrandBusy] = useState(false);
  // Quiz com IA: perguntas + diagnóstico.
  const [quizQuestions, setQuizQuestions] = useState<QuizQuestion[]>(() =>
    initContent.quiz?.questions?.length
      ? initContent.quiz.questions
      : newMode === "quiz"
        ? STARTER_QUIZ_QUESTIONS
        : [],
  );
  const [quizAiResult, setQuizAiResult] = useState(
    initContent.quiz?.aiResult ?? true,
  );
  const [quizResultPrompt, setQuizResultPrompt] = useState(
    initContent.quiz?.resultPrompt ?? "",
  );
  const [quizResultFallback, setQuizResultFallback] = useState(
    initContent.quiz?.resultFallback ?? "",
  );

  function patchQuestion(i: number, patch: Partial<QuizQuestion>) {
    setQuizQuestions((prev) =>
      prev.map((q, idx) => (idx === i ? { ...q, ...patch } : q)),
    );
  }

  function moveQuestion(i: number, dir: -1 | 1) {
    setQuizQuestions((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function useCompanyLogo() {
    setBrandBusy(true);
    try {
      const d = await getCompanyData();
      if (!d.logo) {
        toast.error(
          "Sua empresa ainda não tem logo — suba em Config → Dados da empresa.",
        );
        return;
      }
      setLandingLogo(d.logo);
      toast.success("Logo da empresa aplicada.");
    } catch {
      toast.error("Falha ao buscar os dados da empresa.");
    } finally {
      setBrandBusy(false);
    }
  }

  async function useLogoColor() {
    setBrandBusy(true);
    try {
      let src = landingLogo;
      if (!src) {
        const d = await getCompanyData().catch(() => null);
        src = d?.logo ?? "";
        if (src) setLandingLogo(src);
      }
      if (!src) {
        toast.error(
          "Nenhuma logo pra extrair a cor — suba a logo aqui ou em Dados da empresa.",
        );
        return;
      }
      const color = await dominantColorFromImage(src);
      if (!color) {
        toast.error(
          "Não consegui achar uma cor forte na logo — escolha manualmente.",
        );
        return;
      }
      setBrandColor(color);
      toast.success(`Cor da marca extraída da logo: ${color}`);
    } finally {
      setBrandBusy(false);
    }
  }

  // Modelos prontos (a "galeria" do RD, já escrita): 1 clique preenche tudo.
  function applyTemplate(id: string) {
    const t = CAPTURE_TEMPLATES.find((x) => x.id === id);
    if (!t) return;
    setHeadline(t.headline);
    setDescription(t.description);
    setCtaText(t.ctaText);
    setBenefitsTitle(t.benefitsTitle);
    setBenefits(t.benefits);
    setSubmitLabel(t.submitLabel);
    setSuccessMessage(t.successMessage);
    setOfferTitle(t.offerTitle ?? "");
    setOfferText(t.offerText ?? "");
    setOrigin(t.origin);
    if (!name.trim()) setName(`${t.label}`);
    toast.success(`Modelo "${t.label}" aplicado — ajuste e salve. ✨`);
  }

  // Landing em 1 clique: a IA escreve a página inteira (o dono revisa e salva).
  const [genBriefing, setGenBriefing] = useState("");
  const [generating, setGenerating] = useState(false);

  // Link Zap + QR rastreado (só de formulário já salvo).
  const [waInfo, setWaInfo] = useState<CaptureWaInfo | null>(null);
  const [qrUrl, setQrUrl] = useState("");

  useEffect(() => {
    if (!initial) return;
    let alive = true;
    getCaptureWaInfo(initial.id)
      .then((res) => alive && setWaInfo(res.data))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [initial]);

  useEffect(() => {
    if (!waInfo) {
      setQrUrl("");
      return;
    }
    const dark = /^#[0-9a-fA-F]{6}$/.test(brandColor) ? brandColor : "#7c3aed";
    QRCode.toDataURL(waInfo.link, {
      width: 512,
      margin: 2,
      color: { dark, light: "#ffffff" },
    })
      .then(setQrUrl)
      .catch(() => setQrUrl(""));
  }, [waInfo, brandColor]);

  async function handleGenerate() {
    setGenerating(true);
    const res = await generateCaptureLanding(genBriefing);
    setGenerating(false);
    if (res.error || !res.data) {
      toast.error(res.error ?? "Falha ao gerar com a IA.");
      return;
    }
    const d = res.data;
    setHeadline(d.headline);
    if (d.description) setDescription(d.description);
    if (d.ctaText) setCtaText(d.ctaText);
    if (d.benefitsTitle) setBenefitsTitle(d.benefitsTitle);
    setBenefits(d.benefits);
    if (d.submitLabel) setSubmitLabel(d.submitLabel);
    if (d.successMessage) setSuccessMessage(d.successMessage);
    if (!name.trim()) setName(d.headline.slice(0, 60));
    toast.success("Landing escrita pela IA — revise, ajuste e salve. ✨");
  }

  // Quiz em 1 clique: a IA escreve título + perguntas + instruções do diagnóstico.
  async function handleGenerateQuiz() {
    setGenerating(true);
    const res = await generateCaptureQuiz(genBriefing);
    setGenerating(false);
    if (res.error || !res.data) {
      toast.error(res.error ?? "Falha ao gerar com a IA.");
      return;
    }
    const d = res.data;
    setHeadline(d.headline);
    if (d.description) setDescription(d.description);
    if (d.ctaStart) setCtaText(d.ctaStart);
    setQuizQuestions(d.questions);
    if (d.resultPrompt) setQuizResultPrompt(d.resultPrompt);
    if (!name.trim()) setName(d.headline.slice(0, 60));
    toast.success("Quiz escrito pela IA — revise, ajuste e salve. ✨");
  }

  async function uploadTo(
    file: File | null,
    set: (url: string) => void,
    setBusy: (b: boolean) => void,
  ) {
    if (!file) return;
    setBusy(true);
    try {
      const { publicUrl } = await uploadAccountMedia("media", file);
      set(publicUrl);
    } catch {
      toast.error("Falha ao enviar a imagem.");
    } finally {
      setBusy(false);
    }
  }

  // Campos: map key → {enabled, required, label}.
  const initFields = initial?.fields ?? DEFAULT_CAPTURE_FIELDS;
  const [fieldState, setFieldState] = useState<
    Record<CaptureFieldKey, { enabled: boolean; required: boolean; label: string }>
  >(() => {
    const base = {} as Record<
      CaptureFieldKey,
      { enabled: boolean; required: boolean; label: string }
    >;
    for (const k of CAPTURE_FIELD_ORDER) {
      const found = initFields.find((f) => f.key === k);
      base[k] = {
        enabled: !!found,
        required: found?.required ?? false,
        label: found?.label ?? CAPTURE_FIELD_DEFS[k].label,
      };
    }
    // nome + telefone sempre presentes; telefone sempre obrigatório.
    base.nome.enabled = true;
    base.telefone.enabled = true;
    base.telefone.required = true;
    return base;
  });

  const stages =
    pipelines.find((p) => p.id === pipelineId)?.stages ?? [];

  function setField(
    k: CaptureFieldKey,
    patch: Partial<{ enabled: boolean; required: boolean; label: string }>,
  ) {
    setFieldState((prev) => ({ ...prev, [k]: { ...prev[k], ...patch } }));
  }

  async function handleSave() {
    if (!name.trim()) {
      toast.error("Dê um nome ao formulário.");
      return;
    }
    const cleanQuestions = quizQuestions
      .map((q) => ({
        text: q.text.trim(),
        type: q.type,
        options:
          q.type === "text"
            ? []
            : q.options.map((op) => op.trim()).filter(Boolean),
      }))
      .filter((q) => q.text && (q.type === "text" || q.options.length >= 2));
    if (mode === "quiz" && cleanQuestions.length === 0) {
      toast.error(
        "Adicione pelo menos 1 pergunta (múltipla escolha precisa de 2+ opções).",
      );
      return;
    }
    const fields: CaptureField[] = CAPTURE_FIELD_ORDER.filter(
      (k) => fieldState[k].enabled,
    ).map((k) => ({
      key: k,
      label: fieldState[k].label.trim() || CAPTURE_FIELD_DEFS[k].label,
      required: k === "telefone" ? true : fieldState[k].required,
    }));

    const input = {
      name: name.trim(),
      headline: headline.trim() || null,
      description: description.trim() || null,
      successMessage: successMessage.trim() || null,
      submitLabel: submitLabel.trim() || null,
      fields,
      content: {
        mode,
        heroImage: heroImage.trim() || null,
        logo: landingLogo.trim() || null,
        brandColor: /^#[0-9a-fA-F]{6}$/.test(brandColor) ? brandColor : null,
        benefitsTitle: benefitsTitle.trim() || null,
        benefits,
        testimonials,
        ctaText: ctaText.trim() || null,
        showWhatsapp,
        schedulerSlug: schedulerSlug || null,
        heroStyle,
        quiz: {
          questions: cleanQuestions,
          aiResult: quizAiResult,
          resultPrompt: quizResultPrompt.trim() || null,
          resultFallback: quizResultFallback.trim() || null,
        },
      },
      aiIntro,
      introChannelId: introChannelId || null,
      successOfferTitle: offerTitle.trim() || null,
      successOfferText: offerText.trim() || null,
      successWhatsapp,
      cadenceId: cadenceId || null,
      pipelineId: pipelineId || null,
      stageId: stageId || null,
      origin: origin.trim() || "Formulário",
      active,
    };

    setSaving(true);
    const res = initial
      ? await updateCaptureForm(initial.id, input)
      : await createCaptureForm(input);
    setSaving(false);
    if ("error" in res && res.error) {
      toast.error(res.error);
      return;
    }
    toast.success(initial ? "Formulário salvo." : "Formulário criado.");
    onSaved();
  }

  const selectCls =
    "h-10 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <h1 className="text-2xl font-bold text-foreground">
            {(initial ? "Editar " : mode === "landing" ? "Nova " : "Novo ") +
              (mode === "landing"
                ? "landing page"
                : mode === "quiz"
                  ? "quiz"
                  : "formulário")}
          </h1>
          <p className="text-sm text-muted-foreground">
            O link fica pronto assim que você salvar.
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Ativo
          <Switch checked={active} onCheckedChange={setActive} />
        </label>
      </div>

      <div className="space-y-4 rounded-xl border border-border bg-card p-4">
        <div className="grid gap-2">
          <Label>Nome (interno)</Label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ex.: Formulário do Instagram"
          />
        </div>
        <div className="grid gap-2">
          <Label>Título público</Label>
          <Input
            value={headline}
            onChange={(e) => setHeadline(e.target.value)}
            placeholder={DEFAULT_CAPTURE_HEADLINE}
          />
        </div>
        <div className="grid gap-2">
          <Label>Descrição (opcional)</Label>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            placeholder="Um texto curto abaixo do título."
            className="w-full resize-none rounded-lg border border-border bg-muted px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary"
          />
        </div>
      </div>

      {/* Campos */}
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="text-sm font-semibold text-foreground">Campos</div>
        {CAPTURE_FIELD_ORDER.map((k) => {
          const locked = k === "nome" || k === "telefone";
          const st = fieldState[k];
          return (
            <div
              key={k}
              className="flex flex-wrap items-center gap-3 border-b border-border/60 pb-2 last:border-0"
            >
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={st.enabled}
                  disabled={locked}
                  onChange={(e) => setField(k, { enabled: e.target.checked })}
                  className="size-4 accent-primary"
                />
                {CAPTURE_FIELD_DEFS[k].label}
              </label>
              <Input
                value={st.label}
                onChange={(e) => setField(k, { label: e.target.value })}
                disabled={!st.enabled}
                className="h-8 w-44"
              />
              <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={st.required}
                  disabled={!st.enabled || k === "telefone"}
                  onChange={(e) => setField(k, { required: e.target.checked })}
                  className="size-3.5 accent-primary"
                />
                Obrigatório
              </label>
            </div>
          );
        })}
        <p className="text-[11px] text-muted-foreground">
          WhatsApp é sempre pedido e obrigatório — é a chave do lead no funil.
        </p>
      </div>

      {/* Página */}
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="text-sm font-semibold text-foreground">Página</div>
        <div className="flex overflow-hidden rounded-lg border border-border">
          {(
            [
              ["form", "Formulário simples"],
              ["landing", "Landing page"],
              ["quiz", "🧠 Quiz"],
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => {
                setMode(m);
                if (m === "quiz" && quizQuestions.length === 0) {
                  setQuizQuestions(STARTER_QUIZ_QUESTIONS);
                }
              }}
              className={`flex-1 px-3 py-2 text-sm transition ${
                mode === m
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {mode === "landing" && (
          <div className="space-y-4 border-t border-border pt-3">
            {/* Modelos prontos */}
            <div className="space-y-2">
              <Label>Começar por um modelo</Label>
              <div className="flex flex-wrap gap-2">
                {CAPTURE_TEMPLATES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => applyTemplate(t.id)}
                    className="rounded-lg border border-border bg-muted px-3 py-1.5 text-sm text-foreground transition hover:border-primary hover:bg-primary/10"
                  >
                    {t.emoji} {t.label}
                  </button>
                ))}
              </div>
              <p className="text-[11px] text-muted-foreground">
                Um clique preenche título, benefícios, botões e oferta — depois
                use o &quot;Criar com IA&quot; pra adaptar ao seu negócio.
              </p>
            </div>

            {/* Landing em 1 clique */}
            <div className="space-y-2 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
              <div className="text-sm font-semibold text-foreground">
                ✨ Criar com IA
              </div>
              <p className="text-xs text-muted-foreground">
                A IA escreve a página inteira (título, benefícios, botões) usando
                o que ela já sabe do seu negócio. Você só revisa e salva.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={genBriefing}
                  onChange={(e) => setGenBriefing(e.target.value)}
                  placeholder="Objetivo da página (opcional) — ex.: captar clínicas"
                  className="min-w-[200px] flex-1"
                />
                <Button
                  type="button"
                  onClick={() => void handleGenerate()}
                  disabled={generating}
                >
                  {generating ? (
                    <>
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      Escrevendo...
                    </>
                  ) : (
                    "Criar com IA"
                  )}
                </Button>
              </div>
            </div>

            {/* Identidade da marca: logo + cor da logo + fundo do hero */}
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
              <div className="text-sm font-semibold text-foreground">
                🎨 Identidade da marca
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void useCompanyLogo()}
                  disabled={brandBusy}
                >
                  🖼️ Usar logo da empresa
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void useLogoColor()}
                  disabled={brandBusy}
                >
                  {brandBusy ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  🎯 Usar cor da logo
                </Button>
                <span
                  className="h-6 w-6 rounded-full border border-border"
                  style={{ background: brandColor }}
                  title={brandColor}
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Fundo do topo</Label>
                <div className="flex flex-wrap gap-2">
                  {(
                    [
                      ["gradient", "Gradiente"],
                      ["mesh", "🎨 Mesh"],
                      ["waves", "🌊 Ondas"],
                      ["blobs", "🫧 Bolhas"],
                      ["grid", "▦ Grade"],
                      ["lowpoly", "🔷 Low-poly"],
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setHeroStyle(v)}
                      className={`rounded-lg border px-3 py-1.5 text-sm transition ${
                        heroStyle === v
                          ? "border-primary bg-primary/10 text-foreground"
                          : "border-border text-muted-foreground hover:border-primary/40"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-foreground">
                  Formas geradas por código na cor da marca — cara de designer,
                  sem cara de template.
                </p>
              </div>
            </div>

            {/* Mini-site: WhatsApp + agendamento na página */}
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
              <label className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={showWhatsapp}
                  onChange={(e) => setShowWhatsapp(e.target.checked)}
                  className="size-4 accent-primary"
                />
                Botão &quot;💬 WhatsApp&quot; na página
                <span className="text-xs text-muted-foreground">
                  (com o código de rastreio — quem chamar já vem identificado)
                </span>
              </label>
              <div className="grid gap-1.5 sm:max-w-md">
                <Label>Botão &quot;📅 Agendar horário&quot;</Label>
                <select
                  value={schedulerSlug}
                  onChange={(e) => setSchedulerSlug(e.target.value)}
                  className={selectCls}
                >
                  <option value="">Sem agendamento</option>
                  {scheds
                    .filter((s) => s.active)
                    .map((s) => (
                      <option key={s.id} value={s.slug}>
                        {s.name}
                      </option>
                    ))}
                </select>
                <p className="text-[11px] text-muted-foreground">
                  Aparece no topo da página e na tela de sucesso. Crie páginas
                  de agendamento na seção 🗓️ abaixo.
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-1.5">
                <Label>Imagem do topo (hero)</Label>
                <div className="flex items-center gap-2">
                  {heroImage ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={heroImage} alt="" className="h-10 w-16 rounded object-cover" />
                  ) : null}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) =>
                      void uploadTo(e.target.files?.[0] ?? null, setHeroImage, setUploadingHero)
                    }
                    className="text-xs text-muted-foreground"
                  />
                  {uploadingHero ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {heroImage ? (
                    <button
                      type="button"
                      onClick={() => setHeroImage("")}
                      className="text-xs text-muted-foreground hover:text-red-500"
                    >
                      remover
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label>Logo</Label>
                <div className="flex items-center gap-2">
                  {landingLogo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={landingLogo} alt="" className="h-10 w-auto max-w-[80px] object-contain" />
                  ) : null}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) =>
                      void uploadTo(e.target.files?.[0] ?? null, setLandingLogo, setUploadingLandingLogo)
                    }
                    className="text-xs text-muted-foreground"
                  />
                  {uploadingLandingLogo ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {landingLogo ? (
                    <button
                      type="button"
                      onClick={() => setLandingLogo("")}
                      className="text-xs text-muted-foreground hover:text-red-500"
                    >
                      remover
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label>Cor de destaque</Label>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={brandColor}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="h-9 w-12 cursor-pointer rounded border border-border bg-transparent"
                  />
                  <Input
                    value={brandColor}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="h-9 w-28"
                  />
                </div>
              </div>
              <div className="grid gap-1.5">
                <Label>Texto do botão do topo</Label>
                <Input
                  value={ctaText}
                  onChange={(e) => setCtaText(e.target.value)}
                  placeholder="Ex.: Quero começar"
                />
              </div>
            </div>

            {/* Benefícios */}
            <div className="space-y-2">
              <Label>Benefícios</Label>
              <Input
                value={benefitsTitle}
                onChange={(e) => setBenefitsTitle(e.target.value)}
                placeholder="Título da seção (ex.: Por que a gente?)"
              />
              {benefits.map((b, i) => (
                <div key={i} className="flex flex-wrap items-start gap-2">
                  <Input
                    value={b.title}
                    onChange={(e) =>
                      setBenefits((prev) =>
                        prev.map((x, idx) => (idx === i ? { ...x, title: e.target.value } : x)),
                      )
                    }
                    placeholder="Título"
                    className="w-40"
                  />
                  <Input
                    value={b.description}
                    onChange={(e) =>
                      setBenefits((prev) =>
                        prev.map((x, idx) =>
                          idx === i ? { ...x, description: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder="Descrição"
                    className="min-w-[160px] flex-1"
                  />
                  <button
                    type="button"
                    onClick={() => setBenefits((prev) => prev.filter((_, idx) => idx !== i))}
                    className="mt-1.5 rounded p-1 text-muted-foreground hover:text-red-500"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))}
              {benefits.length < 6 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setBenefits((prev) => [...prev, { title: "", description: "" }])}
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Adicionar benefício
                </Button>
              ) : null}
            </div>

            {/* Depoimentos */}
            <div className="space-y-2">
              <Label>Depoimentos (prova social)</Label>
              {testimonials.map((t, i) => (
                <div key={i} className="space-y-1.5 rounded-lg border border-border/60 p-2">
                  <textarea
                    value={t.quote}
                    onChange={(e) =>
                      setTestimonials((prev) =>
                        prev.map((x, idx) => (idx === i ? { ...x, quote: e.target.value } : x)),
                      )
                    }
                    rows={2}
                    placeholder="O que o cliente disse"
                    className="w-full resize-none rounded-lg border border-border bg-muted px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-primary"
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      value={t.author}
                      onChange={(e) =>
                        setTestimonials((prev) =>
                          prev.map((x, idx) => (idx === i ? { ...x, author: e.target.value } : x)),
                        )
                      }
                      placeholder="Nome"
                      className="h-8 w-36"
                    />
                    <Input
                      value={t.role}
                      onChange={(e) =>
                        setTestimonials((prev) =>
                          prev.map((x, idx) => (idx === i ? { ...x, role: e.target.value } : x)),
                        )
                      }
                      placeholder="Empresa / cargo"
                      className="h-8 w-44"
                    />
                    <button
                      type="button"
                      onClick={() => setTestimonials((prev) => prev.filter((_, idx) => idx !== i))}
                      className="ml-auto rounded p-1 text-muted-foreground hover:text-red-500"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              ))}
              {testimonials.length < 6 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setTestimonials((prev) => [...prev, { quote: "", author: "", role: "" }])
                  }
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Adicionar depoimento
                </Button>
              ) : null}
            </div>
          </div>
        )}

        {mode === "quiz" && (
          <div className="space-y-4 border-t border-border pt-3">
            {/* Quiz em 1 clique */}
            <div className="space-y-2 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
              <div className="text-sm font-semibold text-foreground">
                ✨ Criar com IA
              </div>
              <p className="text-xs text-muted-foreground">
                A IA escreve o quiz inteiro (título, perguntas que qualificam e
                as instruções do diagnóstico) usando o que ela já sabe do seu
                negócio. Você só revisa e salva.
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={genBriefing}
                  onChange={(e) => setGenBriefing(e.target.value)}
                  placeholder="Objetivo do quiz (opcional) — ex.: qualificar clínicas"
                  className="min-w-[200px] flex-1"
                />
                <Button
                  type="button"
                  onClick={() => void handleGenerateQuiz()}
                  disabled={generating}
                >
                  {generating ? (
                    <>
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                      Escrevendo...
                    </>
                  ) : (
                    "Criar com IA"
                  )}
                </Button>
              </div>
            </div>

            {/* Identidade da marca (o quiz usa logo + cor no fundo mesh) */}
            <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
              <div className="text-sm font-semibold text-foreground">
                🎨 Identidade da marca
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void useCompanyLogo()}
                  disabled={brandBusy}
                >
                  🖼️ Usar logo da empresa
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => void useLogoColor()}
                  disabled={brandBusy}
                >
                  {brandBusy ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : null}
                  🎯 Usar cor da logo
                </Button>
                <input
                  type="color"
                  value={brandColor}
                  onChange={(e) => setBrandColor(e.target.value)}
                  className="h-8 w-10 cursor-pointer rounded border border-border bg-transparent"
                  title={brandColor}
                />
                {landingLogo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={landingLogo}
                    alt=""
                    className="h-8 w-auto max-w-[70px] object-contain"
                  />
                ) : null}
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) =>
                    void uploadTo(
                      e.target.files?.[0] ?? null,
                      setLandingLogo,
                      setUploadingLandingLogo,
                    )
                  }
                  className="text-xs text-muted-foreground"
                />
                {uploadingLandingLogo ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
              </div>
              <p className="text-[11px] text-muted-foreground">
                A página do quiz ganha um fundo mesh gradient na cor da marca,
                com a logo no topo do card.
              </p>
            </div>

            {/* Perguntas */}
            <div className="space-y-2">
              <Label>Perguntas ({quizQuestions.length}/10)</Label>
              {quizQuestions.map((q, i) => (
                <div
                  key={i}
                  className="space-y-2 rounded-lg border border-border bg-muted/30 p-3"
                >
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-muted-foreground">
                      {i + 1}.
                    </span>
                    <select
                      value={q.type}
                      onChange={(e) =>
                        patchQuestion(i, {
                          type: e.target.value === "text" ? "text" : "choice",
                        })
                      }
                      className="h-8 rounded-lg border border-border bg-muted px-2 text-xs text-foreground outline-none"
                    >
                      <option value="choice">Múltipla escolha</option>
                      <option value="text">Resposta livre</option>
                    </select>
                    <div className="ml-auto flex items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => moveQuestion(i, -1)}
                        disabled={i === 0}
                        className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() => moveQuestion(i, 1)}
                        disabled={i === quizQuestions.length - 1}
                        className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setQuizQuestions((prev) =>
                            prev.filter((_, idx) => idx !== i),
                          )
                        }
                        className="rounded p-1 text-muted-foreground hover:text-red-500"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                  <Input
                    value={q.text}
                    onChange={(e) => patchQuestion(i, { text: e.target.value })}
                    placeholder="Texto da pergunta"
                  />
                  {q.type === "choice" ? (
                    <div className="space-y-1.5 pl-4">
                      {q.options.map((op, oi) => (
                        <div key={oi} className="flex items-center gap-2">
                          <Input
                            value={op}
                            onChange={(e) =>
                              patchQuestion(i, {
                                options: q.options.map((x, xi) =>
                                  xi === oi ? e.target.value : x,
                                ),
                              })
                            }
                            placeholder={`Opção ${oi + 1}`}
                            className="h-8"
                          />
                          <button
                            type="button"
                            onClick={() =>
                              patchQuestion(i, {
                                options: q.options.filter((_, xi) => xi !== oi),
                              })
                            }
                            className="rounded p-1 text-muted-foreground hover:text-red-500"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                      {q.options.length < 6 ? (
                        <button
                          type="button"
                          onClick={() =>
                            patchQuestion(i, { options: [...q.options, ""] })
                          }
                          className="text-xs font-medium text-primary hover:underline"
                        >
                          + Adicionar opção
                        </button>
                      ) : null}
                    </div>
                  ) : (
                    <p className="pl-4 text-[11px] text-muted-foreground">
                      O lead escreve livremente — ótimo pra última pergunta
                      (&quot;conte mais&quot;).
                    </p>
                  )}
                </div>
              ))}
              {quizQuestions.length < 10 ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setQuizQuestions((prev) => [
                      ...prev,
                      { text: "", type: "choice", options: ["", ""] },
                    ])
                  }
                >
                  <Plus className="mr-1.5 h-3.5 w-3.5" /> Adicionar pergunta
                </Button>
              ) : null}
            </div>

            {/* Diagnóstico com IA */}
            <div className="space-y-3 rounded-lg border border-violet-500/30 bg-violet-500/5 p-3">
              <label className="flex items-start gap-2.5">
                <input
                  type="checkbox"
                  checked={quizAiResult}
                  onChange={(e) => setQuizAiResult(e.target.checked)}
                  className="mt-0.5 size-4 accent-primary"
                />
                <span>
                  <span className="text-sm font-semibold text-foreground">
                    🧠 Diagnóstico com IA na tela
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Assim que o lead deixa o contato, a IA lê as respostas e
                    mostra um resultado personalizado na hora — e ainda
                    qualifica o lead (🔥 quente / 🌤️ morno / ❄️ frio) com
                    etiqueta no contato e resumo pro vendedor no card.
                  </span>
                </span>
              </label>
              {quizAiResult ? (
                <div className="grid gap-1.5">
                  <Label>Instruções do diagnóstico (opcional)</Label>
                  <textarea
                    value={quizResultPrompt}
                    onChange={(e) => setQuizResultPrompt(e.target.value)}
                    rows={2}
                    placeholder='Ex.: "Você é consultora de estética. Recomende o protocolo ideal e convide pra avaliação gratuita."'
                    className="w-full resize-none rounded-lg border border-border bg-muted px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary"
                  />
                </div>
              ) : null}
              <div className="grid gap-1.5">
                <Label>
                  {quizAiResult
                    ? "Texto reserva (se a IA falhar)"
                    : "Texto mostrado no final"}
                </Label>
                <textarea
                  value={quizResultFallback}
                  onChange={(e) => setQuizResultFallback(e.target.value)}
                  rows={2}
                  placeholder="Ex.: Recebemos suas respostas! Vamos te chamar no WhatsApp com as recomendações."
                  className="w-full resize-none rounded-lg border border-border bg-muted px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary"
                />
              </div>
            </div>

            <div className="grid gap-1.5 sm:max-w-xs">
              <Label>Texto do botão inicial</Label>
              <Input
                value={ctaText}
                onChange={(e) => setCtaText(e.target.value)}
                placeholder="Começar"
              />
            </div>
          </div>
        )}
      </div>

      {/* IA no Segundo Zero */}
      <div className="space-y-3 rounded-xl border border-violet-500/30 bg-violet-500/5 p-4">
        <label className="flex items-start gap-2.5">
          <input
            type="checkbox"
            checked={aiIntro}
            onChange={(e) => setAiIntro(e.target.checked)}
            className="mt-0.5 size-4 accent-primary"
          />
          <span>
            <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
              ⚡ IA no Segundo Zero
            </span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              Segundos após o envio, o lead recebe no WhatsApp a primeira
              mensagem escrita pela sua IA — chamando pelo nome e citando o que
              ele pediu. Quando ele responder, o agente do canal continua a
              conversa.
            </span>
          </span>
        </label>
        {aiIntro && channels.length > 1 && (
          <div className="grid gap-1.5 sm:max-w-xs">
            <Label>Enviar pelo canal</Label>
            <select
              value={introChannelId}
              onChange={(e) => setIntroChannelId(e.target.value)}
              className={selectCls}
            >
              <option value="">Canal padrão</option>
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {aiIntro && channels.length === 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Conecte um canal de WhatsApp para a mensagem sair.
          </p>
        )}
      </div>

      {/* Link Zap + QR rastreado */}
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="text-sm font-semibold text-foreground">
          📱 Link do WhatsApp + QR rastreado
        </div>
        {!initial ? (
          <p className="text-xs text-muted-foreground">
            Salve o formulário para gerar o link e o QR — cada um carrega um
            código invisível: quando o &quot;Oi&quot; chegar, o lead vira card
            no funil com a origem exata.
          </p>
        ) : !waInfo ? (
          <p className="text-xs text-muted-foreground">
            Nenhum canal WhatsApp com número encontrado — conecte um canal para
            gerar o link.
          </p>
        ) : (
          <div className="flex flex-wrap items-start gap-4">
            <div className="min-w-[220px] flex-1 space-y-2">
              <p className="text-xs text-muted-foreground">
                Quem clicar (ou escanear) abre o WhatsApp de{" "}
                <strong className="text-foreground">{waInfo.channelName}</strong>{" "}
                com a mensagem pronta:
              </p>
              <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-foreground">
                {waInfo.message}
              </p>
              <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/50 px-2 py-1.5">
                <span className="flex-1 truncate text-xs text-muted-foreground">
                  {waInfo.link}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard?.writeText(waInfo.link);
                    toast.success("Link do WhatsApp copiado.");
                  }}
                  title="Copiar link"
                  className="rounded p-1 text-muted-foreground hover:bg-background hover:text-foreground"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                O <strong>#{waInfo.ref}</strong> na mensagem é o rastreador:
                quando ela chega, o card nasce com a origem &quot;{origin ||
                "Formulário"}&quot; e a fonte deste formulário. Use o link no
                story/bio e o QR em material impresso ou no balcão.
              </p>
            </div>
            {qrUrl ? (
              <div className="space-y-2 text-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={qrUrl}
                  alt="QR do WhatsApp"
                  className="h-36 w-36 rounded-lg border border-border bg-white p-1"
                />
                <a
                  href={qrUrl}
                  download={`qr-whatsapp-${initial.slug}.png`}
                  className="block text-xs font-medium text-primary hover:underline"
                >
                  Baixar QR (PNG)
                </a>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {/* Obrigado que Vende */}
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="text-sm font-semibold text-foreground">
          🎁 Obrigado que Vende
        </div>
        <p className="text-xs text-muted-foreground">
          Depois do envio, a tela de sucesso pode oferecer um próximo passo:
          um bônus/oferta, o botão de chamar no WhatsApp e uma sequência
          automática de mensagens.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>Título da oferta (opcional)</Label>
            <Input
              value={offerTitle}
              onChange={(e) => setOfferTitle(e.target.value)}
              placeholder="Ex.: 🎁 Bônus de boas-vindas"
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Cadência pra quem envia</Label>
            <select
              value={cadenceId}
              onChange={(e) => setCadenceId(e.target.value)}
              className={selectCls}
            >
              <option value="">Nenhuma</option>
              {cadences.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-1.5 sm:col-span-2">
            <Label>Texto da oferta (opcional)</Label>
            <textarea
              value={offerText}
              onChange={(e) => setOfferText(e.target.value)}
              rows={2}
              placeholder="Ex.: Chame no WhatsApp agora e ganhe a implantação gratuita."
              className="w-full resize-none rounded-lg border border-border bg-muted px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary"
            />
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={successWhatsapp}
            onChange={(e) => setSuccessWhatsapp(e.target.checked)}
            className="size-4 accent-primary"
          />
          Botão &quot;Chamar no WhatsApp agora&quot; na tela de sucesso
          <span className="text-xs text-muted-foreground">
            (com o código de rastreio — o lead que chamar já vem identificado)
          </span>
        </label>
        {cadenceId ? (
          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            ⚠️ A cadência agenda mensagens reais pra quem enviar o formulário.
            Ela pausa sozinha quando o lead responder.
          </p>
        ) : null}
      </div>

      {/* Destino */}
      <div className="grid gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label>Funil de destino</Label>
          <select
            value={pipelineId}
            onChange={(e) => {
              setPipelineId(e.target.value);
              setStageId("");
            }}
            className={selectCls}
          >
            <option value="">Primeiro funil da conta</option>
            {pipelines.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <Label>Etapa</Label>
          <select
            value={stageId}
            onChange={(e) => setStageId(e.target.value)}
            disabled={!pipelineId}
            className={selectCls}
          >
            <option value="">Primeira etapa</option>
            {stages.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="grid gap-2">
          <Label>Origem do lead</Label>
          <Input
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            placeholder="Formulário"
          />
        </div>
        <div className="grid gap-2">
          <Label>Texto do botão</Label>
          <Input
            value={submitLabel}
            onChange={(e) => setSubmitLabel(e.target.value)}
            placeholder={DEFAULT_CAPTURE_SUBMIT}
          />
        </div>
        <div className="grid gap-2 sm:col-span-2">
          <Label>Mensagem de sucesso</Label>
          <textarea
            value={successMessage}
            onChange={(e) => setSuccessMessage(e.target.value)}
            rows={2}
            className="w-full resize-none rounded-lg border border-border bg-muted px-2.5 py-2 text-sm text-foreground outline-none focus:border-primary"
          />
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={() => void handleSave()} disabled={saving}>
          {saving ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
          Salvar
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}

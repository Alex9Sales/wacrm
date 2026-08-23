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
  generateCaptureLanding,
  getCaptureWaInfo,
  type CaptureFormRow,
  type CaptureFormDetail,
  type CaptureWaInfo,
} from "./actions";
import QRCode from "qrcode";
import {
  CAPTURE_FIELD_DEFS,
  CAPTURE_FIELD_ORDER,
  DEFAULT_CAPTURE_FIELDS,
  DEFAULT_CAPTURE_CONTENT,
  DEFAULT_CAPTURE_HEADLINE,
  DEFAULT_CAPTURE_SUBMIT,
  DEFAULT_CAPTURE_SUCCESS,
  type CaptureField,
  type CaptureFieldKey,
  type CaptureBenefit,
  type CaptureTestimonial,
} from "@/lib/capture/shared";
import { uploadAccountMedia } from "@/lib/storage/upload-media";

type Pipeline = { id: string; name: string; stages: { id: string; name: string }[] };

export default function CaptacaoPage() {
  const [forms, setForms] = useState<CaptureFormRow[]>([]);
  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [cadences, setCadences] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<
    CaptureFormDetail | { new: "form" | "landing" } | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [f, p, ch, cad] = await Promise.all([
      listCaptureForms().catch(() => [] as CaptureFormRow[]),
      listCapturePipelines().catch(() => [] as Pipeline[]),
      listCaptureChannels().catch(() => [] as { id: string; name: string }[]),
      listCaptureCadences().catch(() => [] as { id: string; name: string }[]),
    ]);
    setForms(f);
    setPipelines(p);
    setChannels(ch);
    setCadences(cad);
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

  if (editing) {
    const isNew = "new" in editing;
    return (
      <CaptureEditor
        initial={isNew ? null : (editing as CaptureFormDetail)}
        newMode={isNew ? (editing as { new: "form" | "landing" }).new : undefined}
        pipelines={pipelines}
        channels={channels}
        cadences={cadences}
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
          <Button variant="outline" onClick={() => setEditing({ new: "form" })}>
            <Plus className="mr-1.5 h-4 w-4" /> Novo formulário
          </Button>
          <Button onClick={() => setEditing({ new: "landing" })}>
            <LayoutTemplate className="mr-1.5 h-4 w-4" /> Nova landing page
          </Button>
        </div>
      </div>

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
                          : "bg-sky-500/15 text-sky-600 dark:text-sky-400"
                      }`}
                    >
                      {f.mode === "landing" ? "Landing" : "Formulário"}
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
  onCancel,
  onSaved,
}: {
  initial: CaptureFormDetail | null;
  /** Ao criar: modo pré-escolhido pelo botão (form | landing). */
  newMode?: "form" | "landing";
  pipelines: Pipeline[];
  channels: { id: string; name: string }[];
  cadences: { id: string; name: string }[];
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
  const [mode, setMode] = useState<"form" | "landing">(
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
            {initial
              ? mode === "landing"
                ? "Editar landing page"
                : "Editar formulário"
              : mode === "landing"
                ? "Nova landing page"
                : "Novo formulário"}
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
            ] as const
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
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

"use client";

import { useEffect, useRef, useState } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  savePipelineSettings,
  addStage,
  countDealsInStage,
  deleteStage,
  deletePipeline,
  listStageTaskTemplates,
  addStageTaskTemplate,
  updateStageTaskTemplate,
  removeStageTaskTemplate,
  type StageTaskTemplate,
} from "@/app/(dashboard)/pipelines/actions";
import type { Pipeline, PipelineStage } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  Trash2,
  Plus,
  GripVertical,
  AlertTriangle,
  ListChecks,
  CalendarClock,
} from "lucide-react";
import { toast } from "sonner";

const STAGE_COLORS = [
  "#3b82f6",
  "#6366f1",
  "#8b5cf6",
  "#ec4899",
  "#f43f5e",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#06b6d4",
];

interface PipelineSettingsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pipeline: Pipeline;
  stages: PipelineStage[];
  onPipelinesChanged: () => void;
  onStagesChanged: () => void;
  onCreateNewPipeline: () => void;
}

export function PipelineSettings({
  open,
  onOpenChange,
  pipeline,
  stages,
  onPipelinesChanged,
  onStagesChanged,
  onCreateNewPipeline,
}: PipelineSettingsProps) {
  const [name, setName] = useState(pipeline.name);
  const [localStages, setLocalStages] = useState<PipelineStage[]>(stages);
  const [newStageName, setNewStageName] = useState("");
  const [newStageColor, setNewStageColor] = useState(STAGE_COLORS[0]);
  const [stepperStyle, setStepperStyle] = useState<"pills" | "chevrons">(
    pipeline.stepper_style === "chevrons" ? "chevrons" : "pills",
  );
  const [saving, setSaving] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Atividades automáticas por etapa: fonte única aqui, editor controlado.
  const [templatesByStage, setTemplatesByStage] = useState<
    Record<string, StageTaskTemplate[]>
  >({});
  // Marca que o usuário já mexeu nos templates nesta abertura — evita que uma
  // carga que resolve TARDE sobrescreva edições recém-feitas (persistidas).
  const templatesTouched = useRef(false);

  // Carrega os templates de atividade do funil ao abrir.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    templatesTouched.current = false;
    listStageTaskTemplates(pipeline.id)
      .then((rows) => {
        if (!alive || templatesTouched.current) return;
        const map: Record<string, StageTaskTemplate[]> = {};
        for (const t of rows) (map[t.stage_id] ??= []).push(t);
        setTemplatesByStage(map);
      })
      .catch(() => {
        // Não zera o mapa (senão o usuário pode recriar templates que existem);
        // só avisa da falha de carga.
        if (alive && !templatesTouched.current) {
          toast.error("Não foi possível carregar as atividades das etapas.");
        }
      });
    return () => {
      alive = false;
    };
  }, [open, pipeline.id]);

  async function handleAddTemplate(
    stageId: string,
    input: { title: string; dueOffsetDays: number; type: string | null },
  ) {
    templatesTouched.current = true;
    const { template, error } = await addStageTaskTemplate(stageId, input);
    if (error || !template) {
      toast.error(error ?? "Falha ao adicionar a atividade");
      return;
    }
    setTemplatesByStage((prev) => ({
      ...prev,
      [stageId]: [...(prev[stageId] ?? []), template],
    }));
  }

  async function handleRemoveTemplate(stageId: string, id: string) {
    templatesTouched.current = true;
    // Remoção otimista guardando o estado p/ reverter se o servidor falhar.
    let snapshot: StageTaskTemplate[] = [];
    setTemplatesByStage((prev) => {
      snapshot = prev[stageId] ?? [];
      return { ...prev, [stageId]: snapshot.filter((t) => t.id !== id) };
    });
    const { error } = await removeStageTaskTemplate(id);
    if (error) {
      toast.error(error);
      setTemplatesByStage((prev) => ({ ...prev, [stageId]: snapshot }));
    }
  }

  async function handleToggleTemplate(
    stageId: string,
    id: string,
    active: boolean,
  ) {
    templatesTouched.current = true;
    setTemplatesByStage((prev) => ({
      ...prev,
      [stageId]: (prev[stageId] ?? []).map((t) =>
        t.id === id ? { ...t, active } : t,
      ),
    }));
    const { error } = await updateStageTaskTemplate(id, { active });
    if (error) {
      toast.error(error);
      // Reverte o checkbox pro estado real do servidor.
      setTemplatesByStage((prev) => ({
        ...prev,
        [stageId]: (prev[stageId] ?? []).map((t) =>
          t.id === id ? { ...t, active: !active } : t,
        ),
      }));
    }
  }

  // Reset form state when the dialog opens or its prop inputs change
  // — legitimate prop-driven sync.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setName(pipeline.name);
    setLocalStages([...stages].sort((a, b) => a.position - b.position));
    setStepperStyle(pipeline.stepper_style === "chevrons" ? "chevrons" : "pills");
    setShowDeleteConfirm(false);
  }, [open, pipeline, stages]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function handleReorder(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = localStages.findIndex((s) => s.id === active.id);
    const newIndex = localStages.findIndex((s) => s.id === over.id);
    if (oldIndex < 0 || newIndex < 0) return;
    setLocalStages(arrayMove(localStages, oldIndex, newIndex));
  }

  async function handleSave() {
    setSaving(true);

    // One upsert for all stages — batches N stage writes into a single
    // round-trip. Previous implementation did N sequential UPDATEs which
    // latency-scaled linearly with stage count.
    const stageRows = localStages.map((s, i) => ({
      id: s.id,
      name: s.name,
      color: s.color,
      position: i,
      objective: s.objective ?? null,
      guidance: s.guidance ?? null,
      probability: s.probability ?? 50,
    }));

    const { error } = await savePipelineSettings(
      pipeline.id,
      name.trim(),
      stageRows,
      stepperStyle,
    );

    setSaving(false);

    if (error) {
      toast.error("Falha ao salvar o funil");
      return;
    }

    onOpenChange(false);
    onPipelinesChanged();
    onStagesChanged();
    toast.success("Funil salvo");
  }

  async function handleAddStage() {
    const trimmed = newStageName.trim();
    if (!trimmed) return;
    const { stage, error } = await addStage(pipeline.id, {
      name: trimmed,
      color: newStageColor,
      position: localStages.length,
    });
    if (error || !stage) {
      toast.error("Falha ao adicionar a etapa");
      return;
    }
    setLocalStages([...localStages, stage]);
    setNewStageName("");
    setNewStageColor(STAGE_COLORS[(localStages.length + 1) % STAGE_COLORS.length]);
  }

  async function handleRemoveStage(stageId: string) {
    // Refuse to delete if deals still reference the stage (FK would fail).
    const dealCount = await countDealsInStage(stageId);
    if (dealCount > 0) {
      toast.error("Mova ou exclua os negócios desta etapa primeiro");
      return;
    }
    const { error } = await deleteStage(stageId);
    if (error) {
      toast.error("Falha ao excluir a etapa");
      return;
    }
    setLocalStages(localStages.filter((s) => s.id !== stageId));
  }

  async function handleDeletePipeline() {
    setDeleting(true);
    // ON DELETE CASCADE handles deals + stages.
    const { error } = await deletePipeline(pipeline.id);
    setDeleting(false);
    if (error) {
      toast.error("Falha ao excluir o funil");
      return;
    }
    onOpenChange(false);
    onPipelinesChanged();
    toast.success("Funil excluído");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl bg-popover border-border max-h-[88vh] flex flex-col overflow-hidden">
        <DialogHeader className="shrink-0">
          <DialogTitle className="text-popover-foreground">Gerenciar funil</DialogTitle>
        </DialogHeader>

        {showDeleteConfirm ? (
          <div className="py-4">
            <div className="flex items-center gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-4">
              <AlertTriangle className="h-5 w-5 shrink-0 text-red-400" />
              <div>
                <p className="text-sm font-medium text-red-400">
                  Excluir funil
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Isso vai arquivar todos os negócios deste funil. Não é
                  possível desfazer.
                </p>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setShowDeleteConfirm(false)}
                className="border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleDeletePipeline}
                disabled={deleting}
                className="bg-red-600 text-white hover:bg-red-700"
              >
                {deleting ? "Excluindo..." : "Excluir funil"}
              </Button>
            </div>
          </div>
        ) : (
          <>
            <div className="grid gap-4 overflow-y-auto py-2 pr-1 flex-1 min-h-0">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Nome do funil</Label>
                <Input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="border-border bg-muted text-foreground"
                />
              </div>

              <div className="grid gap-2">
                <Label className="text-muted-foreground">Etapas</Label>
                <DndContext
                  sensors={sensors}
                  collisionDetection={closestCenter}
                  onDragEnd={handleReorder}
                >
                  <SortableContext
                    items={localStages.map((s) => s.id)}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="space-y-2">
                      {localStages.map((stage, index) => (
                        <SortableStageRow
                          key={stage.id}
                          stage={stage}
                          onNameChange={(v) => {
                            const updated = [...localStages];
                            updated[index] = { ...updated[index], name: v };
                            setLocalStages(updated);
                          }}
                          onColorChange={(v) => {
                            const updated = [...localStages];
                            updated[index] = { ...updated[index], color: v };
                            setLocalStages(updated);
                          }}
                          onObjectiveChange={(v) => {
                            const updated = [...localStages];
                            updated[index] = { ...updated[index], objective: v };
                            setLocalStages(updated);
                          }}
                          onGuidanceChange={(v) => {
                            const updated = [...localStages];
                            updated[index] = { ...updated[index], guidance: v };
                            setLocalStages(updated);
                          }}
                          onProbabilityChange={(v) => {
                            const updated = [...localStages];
                            updated[index] = { ...updated[index], probability: v };
                            setLocalStages(updated);
                          }}
                          onRemove={() => handleRemoveStage(stage.id)}
                          colors={STAGE_COLORS}
                          templates={templatesByStage[stage.id] ?? []}
                          onAddTemplate={(input) =>
                            handleAddTemplate(stage.id, input)
                          }
                          onRemoveTemplate={(id) =>
                            handleRemoveTemplate(stage.id, id)
                          }
                          onToggleTemplate={(id, active) =>
                            handleToggleTemplate(stage.id, id, active)
                          }
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>

                {/* Add new stage — presets + cor personalizada (seletor completo) */}
                <div className="mt-1 flex flex-wrap items-center gap-1">
                  {STAGE_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setNewStageColor(color)}
                      className="h-5 w-5 rounded-full border-2 transition-transform hover:scale-110"
                      style={{
                        backgroundColor: color,
                        borderColor:
                          newStageColor === color
                            ? "var(--foreground)"
                            : "transparent",
                      }}
                      aria-label={`Escolher cor ${color}`}
                    />
                  ))}
                  <input
                    type="color"
                    value={
                      /^#[0-9a-fA-F]{6}$/.test(newStageColor)
                        ? newStageColor
                        : "#6d28d9"
                    }
                    onChange={(e) => setNewStageColor(e.target.value)}
                    className="ml-1 h-5 w-6 cursor-pointer rounded border border-border bg-transparent p-0"
                    aria-label="Cor personalizada"
                    title="Cor personalizada"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Input
                    value={newStageName}
                    onChange={(e) => setNewStageName(e.target.value)}
                    placeholder="Nome da nova etapa"
                    className="border-border bg-muted text-sm text-foreground"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleAddStage();
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleAddStage}
                    disabled={!newStageName.trim()}
                    className="shrink-0 border-border bg-transparent text-muted-foreground hover:bg-muted"
                  >
                    <Plus className="mr-1 h-3 w-3" />
                    Adicionar
                  </Button>
                </div>
              </div>

              {/* Estilo da barra de etapas (no detalhe do negócio) + prévia */}
              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  Estilo das etapas (no detalhe do negócio)
                </Label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setStepperStyle("pills")}
                    className={cn(
                      "flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors",
                      stepperStyle === "pills"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:bg-muted",
                    )}
                  >
                    Pílulas
                  </button>
                  <button
                    type="button"
                    onClick={() => setStepperStyle("chevrons")}
                    className={cn(
                      "flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition-colors",
                      stepperStyle === "chevrons"
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border text-muted-foreground hover:bg-muted",
                    )}
                  >
                    Setas (estilo RD)
                  </button>
                </div>
                {/* Prévia */}
                <div className="rounded-lg border border-border bg-muted/40 p-3">
                  <p className="mb-2 text-[10px] uppercase tracking-wide text-muted-foreground">
                    Prévia
                  </p>
                  {stepperStyle === "pills" ? (
                    <div className="flex flex-wrap gap-1">
                      {localStages.map((s, i) => (
                        <span
                          key={s.id}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium",
                            i === 0
                              ? "text-white"
                              : "border border-border bg-background text-muted-foreground",
                          )}
                          style={i === 0 ? { backgroundColor: s.color } : undefined}
                        >
                          <span
                            className="size-1.5 rounded-full"
                            style={{ backgroundColor: i === 0 ? "#fff" : s.color }}
                          />
                          {s.name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="flex overflow-x-auto pb-1">
                      {localStages.map((s, i) => (
                        <div
                          key={s.id}
                          className="relative flex h-7 shrink-0 items-center whitespace-nowrap pl-4 pr-3 text-xs font-medium text-white"
                          style={{
                            backgroundColor: s.color,
                            marginLeft: i === 0 ? 0 : -9,
                            clipPath:
                              i === 0
                                ? "polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%)"
                                : "polygon(0 0, calc(100% - 10px) 0, 100% 50%, calc(100% - 10px) 100%, 0 100%, 10px 50%)",
                          }}
                        >
                          {s.name}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <Button
                variant="outline"
                onClick={onCreateNewPipeline}
                className="w-full border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                <Plus className="mr-1 h-3 w-3" />
                Criar um novo funil
              </Button>
            </div>

            <DialogFooter className="shrink-0 border-t border-border bg-popover/50 pt-3">
              <Button
                variant="destructive"
                onClick={() => setShowDeleteConfirm(true)}
                className="mr-auto bg-red-600 text-white hover:bg-red-700"
              >
                Excluir funil
              </Button>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                className="border-border bg-transparent text-muted-foreground hover:bg-muted"
              >
                Cancelar
              </Button>
              <Button
                onClick={handleSave}
                disabled={saving || !name.trim()}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {saving ? "Salvando..." : "Salvar alterações"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function SortableStageRow({
  stage,
  onNameChange,
  onColorChange,
  onObjectiveChange,
  onGuidanceChange,
  onProbabilityChange,
  onRemove,
  colors,
  templates,
  onAddTemplate,
  onRemoveTemplate,
  onToggleTemplate,
}: {
  stage: PipelineStage;
  onNameChange: (v: string) => void;
  onColorChange: (v: string) => void;
  onObjectiveChange: (v: string) => void;
  onGuidanceChange: (v: string) => void;
  onProbabilityChange: (v: number) => void;
  onRemove: () => void;
  colors: string[];
  templates: StageTaskTemplate[];
  onAddTemplate: (input: {
    title: string;
    dueOffsetDays: number;
    type: string | null;
  }) => void;
  onRemoveTemplate: (id: string) => void;
  onToggleTemplate: (id: string, active: boolean) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: stage.id });
  const [showGuide, setShowGuide] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const hasGuide = !!(stage.objective?.trim() || stage.guidance?.trim());
  const activeCount = templates.filter((t) => t.active).length;

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="rounded-lg border border-border bg-muted p-2"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="cursor-grab touch-none text-muted-foreground hover:text-foreground active:cursor-grabbing"
          aria-label="Arraste para reordenar"
        >
          <GripVertical className="h-4 w-4" />
        </button>
        <ColorSwatch value={stage.color} onChange={onColorChange} colors={colors} />
        <Input
          value={stage.name}
          onChange={(e) => onNameChange(e.target.value)}
          className="h-7 flex-1 border-transparent bg-transparent text-sm text-foreground focus:border-border"
        />
        <button
          type="button"
          onClick={() => setShowTasks((v) => !v)}
          title="Atividades automáticas ao entrar na etapa"
          className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] transition-colors ${
            activeCount > 0 || showTasks
              ? "text-primary hover:bg-primary/10"
              : "text-muted-foreground hover:bg-background"
          }`}
        >
          <ListChecks className="h-3 w-3" />
          Atividades{activeCount > 0 ? ` (${activeCount})` : ""}
        </button>
        <button
          type="button"
          onClick={() => setShowGuide((v) => !v)}
          title="Orientações da etapa (objetivo + descrição)"
          className={`rounded px-1.5 py-0.5 text-[11px] transition-colors ${
            hasGuide || showGuide
              ? "text-primary hover:bg-primary/10"
              : "text-muted-foreground hover:bg-background"
          }`}
        >
          Orientações{hasGuide ? " ✓" : ""}
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onRemove}
          className="text-muted-foreground hover:text-red-400"
        >
          <Trash2 className="h-3 w-3" />
        </Button>
      </div>

      {showTasks && (
        <StageTasksEditor
          templates={templates}
          onAdd={onAddTemplate}
          onRemove={onRemoveTemplate}
          onToggle={onToggleTemplate}
        />
      )}

      {showGuide && (
        <div className="mt-2 space-y-2 border-t border-border pt-2">
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              Objetivo da etapa
            </label>
            <textarea
              value={stage.objective ?? ""}
              onChange={(e) => onObjectiveChange(e.target.value)}
              placeholder="Ex.: Registrar leads que já receberam contato e precisam avançar."
              rows={2}
              className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-muted-foreground">
              Descrição / orientação
            </label>
            <textarea
              value={stage.guidance ?? ""}
              onChange={(e) => onGuidanceChange(e.target.value)}
              placeholder="Ex.: Usar quando já iniciou contato. Próximo passo: obter resposta e contexto."
              rows={2}
              className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs text-foreground outline-none focus:border-primary"
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="text-[11px] font-medium text-muted-foreground">
              Probabilidade de fechamento
            </label>
            <div className="flex items-center gap-1">
              <input
                type="number"
                min={0}
                max={100}
                value={stage.probability ?? 50}
                onChange={(e) =>
                  onProbabilityChange(
                    Math.max(0, Math.min(100, Number(e.target.value) || 0)),
                  )
                }
                className="h-7 w-16 rounded-md border border-border bg-background px-2 text-center text-xs text-foreground outline-none focus:border-primary"
              />
              <span className="text-xs text-muted-foreground">%</span>
            </div>
            <span className="text-[11px] text-muted-foreground">
              usada na previsão de receita do funil
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

// Editor das atividades automáticas de UMA etapa. Controlado: recebe a lista
// atual + callbacks (persistem no servidor via o pai). Só guarda o form novo.
function StageTasksEditor({
  templates,
  onAdd,
  onRemove,
  onToggle,
}: {
  templates: StageTaskTemplate[];
  onAdd: (input: {
    title: string;
    dueOffsetDays: number;
    type: string | null;
  }) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string, active: boolean) => void;
}) {
  const [title, setTitle] = useState("");
  const [days, setDays] = useState("");
  const [type, setType] = useState("");

  function submit() {
    const t = title.trim();
    if (!t) return;
    onAdd({
      title: t,
      dueOffsetDays: Math.max(0, parseInt(days, 10) || 0),
      type: type.trim() || null,
    });
    setTitle("");
    setDays("");
    setType("");
  }

  return (
    <div className="mt-2 space-y-2 border-t border-border pt-2">
      <p className="text-[11px] text-muted-foreground">
        Tarefas criadas automaticamente para o responsável quando o negócio
        entra nesta etapa.
      </p>
      {templates.length > 0 && (
        <ul className="space-y-1">
          {templates.map((tpl) => (
            <li
              key={tpl.id}
              className={cn(
                "flex items-center gap-2 rounded-md border border-border bg-background px-2 py-1",
                !tpl.active && "opacity-50",
              )}
            >
              <input
                type="checkbox"
                checked={tpl.active}
                onChange={(e) => onToggle(tpl.id, e.target.checked)}
                className="h-3.5 w-3.5 accent-primary"
                title={tpl.active ? "Ativa (desmarque p/ pausar)" : "Inativa"}
              />
              <span className="flex-1 truncate text-xs text-foreground">
                {tpl.title}
                {tpl.type ? (
                  <span className="ml-1 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                    {tpl.type}
                  </span>
                ) : null}
              </span>
              <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-[10px] text-muted-foreground">
                <CalendarClock className="h-3 w-3" />
                {tpl.due_offset_days === 0 ? "hoje" : `+${tpl.due_offset_days}d`}
              </span>
              <button
                type="button"
                onClick={() => onRemove(tpl.id)}
                className="text-muted-foreground hover:text-red-400"
                title="Remover atividade"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-1.5">
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Nova atividade (ex.: Ligar para o lead)"
          className="h-7 flex-1 text-xs"
        />
        <Input
          value={type}
          onChange={(e) => setType(e.target.value)}
          placeholder="tipo"
          className="h-7 w-16 text-xs"
          title="Rótulo opcional (ligar, enviar, cobrar…)"
        />
        <div className="flex items-center gap-0.5">
          <Input
            value={days}
            onChange={(e) => setDays(e.target.value)}
            type="number"
            min={0}
            placeholder="0"
            className="h-7 w-12 text-xs"
            title="Prazo em dias a partir da entrada na etapa"
          />
          <span className="text-[10px] text-muted-foreground">d</span>
        </div>
        <Button
          size="icon-xs"
          variant="ghost"
          onClick={submit}
          className="text-primary"
          title="Adicionar atividade"
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function ColorSwatch({
  value,
  onChange,
  colors,
}: {
  value: string;
  onChange: (v: string) => void;
  colors: string[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="h-4 w-4 rounded-full border border-border"
        style={{ backgroundColor: value }}
        aria-label="Alterar cor"
      />
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-6 z-20 w-44 space-y-2 rounded-lg border border-border bg-popover p-2 shadow-lg">
            <div className="flex flex-wrap gap-1">
              {colors.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    onChange(c);
                    setOpen(false);
                  }}
                  className="h-5 w-5 rounded-full border-2 transition-transform hover:scale-110"
                  style={{
                    backgroundColor: c,
                    borderColor:
                      c === value ? "var(--foreground)" : "transparent",
                  }}
                />
              ))}
            </div>
            {/* Cor personalizada — seletor completo (arrasta no espectro/gradiente
                e escolhe qualquer tom). */}
            <label className="flex items-center gap-2 border-t border-border pt-2 text-xs text-muted-foreground">
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#6d28d9"}
                onChange={(e) => onChange(e.target.value)}
                className="h-6 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
                aria-label="Cor personalizada"
              />
              Personalizada
            </label>
          </div>
        </>
      )}
    </div>
  );
}

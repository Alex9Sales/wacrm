"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, Users, Pencil, Hash, Phone } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { cn } from "@/lib/utils";
import { isStaleActionError, reloadForStaleAction } from "@/lib/stale-action";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { SettingsPanelHead } from "./settings-panel-head";
import {
  listSectorsWithMembers,
  createSector,
  updateSector,
  setSectorMembers,
  deleteSector,
  listChannelsForRouting,
  setChannelDefaultSector,
  setChannelDedicatedUser,
  type SectorWithMembers,
  type ChannelRouting,
} from "./actions";
import { listTeamMembers } from "@/app/(dashboard)/internal-chat/actions";
import type { TeamMemberOption } from "@/lib/internal-chat/types";

const COLORS = ["#6d4bd8", "#0e8a5f", "#c0392b", "#9a6a00", "#2563eb", "#db2777", "#0891b2", "#4b5563"];

export function SectorsPanel() {
  const { canEditSettings } = useAuth();
  const [sectors, setSectors] = useState<SectorWithMembers[]>([]);
  const [members, setMembers] = useState<TeamMemberOption[]>([]);
  const [channelsList, setChannelsList] = useState<ChannelRouting[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<SectorWithMembers | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = () =>
    Promise.all([listSectorsWithMembers(), listChannelsForRouting()])
      .then(([s, c]) => {
        setSectors(s);
        setChannelsList(c);
      })
      .catch(() => {});

  useEffect(() => {
    Promise.all([
      listSectorsWithMembers(),
      listTeamMembers(),
      listChannelsForRouting(),
    ])
      .then(([s, m, c]) => {
        setSectors(s);
        setMembers(m);
        setChannelsList(c);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const nameOf = (id: string) =>
    members.find((m) => m.id === id)?.name ?? "?";

  return (
    <div>
      <SettingsPanelHead
        title="Setores"
        description="Organize as conversas por time (Vendas, Financeiro, Suporte…). Cada atendente só vê os setores dele — o resto fica privado."
        action={
          canEditSettings ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              Novo setor
            </Button>
          ) : undefined
        }
      />

      <div className="mt-4 space-y-3">
        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : sectors.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <Users className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-2 text-sm font-medium text-foreground">
              Nenhum setor ainda
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Crie setores para separar as conversas por equipe e manter o
              financeiro/admin privado.
            </p>
          </div>
        ) : (
          sectors.map((s) => (
            <div
              key={s.id}
              className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
            >
              <span
                className="h-3.5 w-3.5 shrink-0 rounded-full"
                style={{ backgroundColor: s.color }}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="truncate text-sm font-medium text-foreground">
                    {s.name}
                  </p>
                  {!s.autoAssign && (
                    <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                      fila manual
                    </span>
                  )}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {s.memberIds.length === 0
                    ? "Sem atendentes — ninguém vê este setor (só admin)"
                    : s.memberIds.map(nameOf).join(", ")}
                </p>
                {s.keywords.length > 0 && (
                  <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground/80">
                    <Hash className="size-3 shrink-0" />
                    {s.keywords.join(", ")}
                  </p>
                )}
              </div>
              {canEditSettings && (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setEditing(s)}
                    title="Editar"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm(`Excluir o setor "${s.name}"? As conversas dele voltam para a fila geral.`)) return;
                      try {
                        await deleteSector(s.id);
                        toast.success("Setor excluído.");
                        void reload();
                      } catch {
                        toast.error("Não foi possível excluir.");
                      }
                    }}
                    title="Excluir"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {!loading && sectors.length > 0 && channelsList.length > 0 && (
        <div className="mt-8">
          <h3 className="text-sm font-semibold text-foreground">
            Roteamento por número
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Escolha para qual setor cai cada número de WhatsApp por padrão.
            Palavras-chave na 1ª mensagem ainda podem redirecionar.
          </p>
          <div className="mt-3 space-y-2">
            {channelsList.map((ch) => (
              <div
                key={ch.id}
                className="flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3"
              >
                <Phone className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-foreground">
                    {ch.name}
                  </p>
                  {ch.phoneNumber && (
                    <p className="truncate text-xs text-muted-foreground">
                      {ch.phoneNumber}
                    </p>
                  )}
                </div>
                <Select
                  value={ch.defaultSectorId ?? "none"}
                  disabled={!canEditSettings}
                  onValueChange={async (v) => {
                    const next = v === "none" ? null : v;
                    setChannelsList((prev) =>
                      prev.map((c) =>
                        c.id === ch.id ? { ...c, defaultSectorId: next } : c,
                      ),
                    );
                    try {
                      await setChannelDefaultSector(ch.id, next);
                      toast.success("Roteamento atualizado.");
                    } catch {
                      toast.error("Não foi possível salvar.");
                      void reload();
                    }
                  }}
                >
                  <SelectTrigger className="w-44 shrink-0">
                    <SelectValue placeholder="Fila geral">
                      {ch.defaultSectorId
                        ? (sectors.find((s) => s.id === ch.defaultSectorId)
                            ?.name ?? "Fila geral")
                        : "Fila geral"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Fila geral</SelectItem>
                    {sectors.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/* 📌 Canal dedicado a UM membro: só ele vê as conversas deste
                    canal (admin/owner e supervisor veem tudo). Pra mais de uma
                    pessoa, usa setor. */}
                <Select
                  value={ch.dedicatedUserId ?? "none"}
                  disabled={!canEditSettings}
                  onValueChange={async (v) => {
                    const next = v === "none" ? null : v;
                    setChannelsList((prev) =>
                      prev.map((c) =>
                        c.id === ch.id ? { ...c, dedicatedUserId: next } : c,
                      ),
                    );
                    try {
                      await setChannelDedicatedUser(ch.id, next);
                      toast.success(
                        next
                          ? `Canal dedicado a ${nameOf(next)}: só essa pessoa vê as conversas dele.`
                          : "Canal liberado: volta a seguir a regra do setor.",
                      );
                    } catch {
                      toast.error("Não foi possível salvar.");
                      void reload();
                    }
                  }}
                >
                  <SelectTrigger
                    className="w-44 shrink-0"
                    title="Dedicar este canal a um membro: só ele vê as conversas que chegam por aqui"
                  >
                    <SelectValue placeholder="Dedicado a ninguém">
                      {ch.dedicatedUserId
                        ? `Dedicado: ${nameOf(ch.dedicatedUserId)}`
                        : "Dedicado a ninguém"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Dedicado a ninguém</SelectItem>
                    {members.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))}
          </div>
        </div>
      )}

      <SectorDialog
        open={creating}
        onOpenChange={setCreating}
        members={members}
        onSaved={() => void reload()}
      />
      <SectorDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        members={members}
        sector={editing}
        onSaved={() => void reload()}
      />
    </div>
  );
}

function SectorDialog({
  open,
  onOpenChange,
  members,
  sector,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  members: TeamMemberOption[];
  sector?: SectorWithMembers | null;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  const [keywords, setKeywords] = useState("");
  const [autoAssign, setAutoAssign] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(sector?.name ?? "");
    setColor(sector?.color ?? COLORS[0]);
    setKeywords((sector?.keywords ?? []).join(", "));
    setAutoAssign(sector?.autoAssign ?? true);
    setSelected(new Set(sector?.memberIds ?? []));
  }, [open, sector]);

  const parseKeywords = (raw: string) =>
    raw
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

  const toggle = (id: string) =>
    setSelected((p) => {
      const n = new Set(p);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const save = async () => {
    if (!name.trim()) {
      toast.error("Dê um nome ao setor.");
      return;
    }
    setSaving(true);
    try {
      const kws = parseKeywords(keywords);
      if (sector) {
        await updateSector(sector.id, { name, color, keywords: kws, autoAssign });
        await setSectorMembers(sector.id, [...selected]);
        toast.success("Setor atualizado.");
      } else {
        await createSector({
          name,
          color,
          keywords: kws,
          autoAssign,
          memberIds: [...selected],
        });
        toast.success(`Setor "${name.trim()}" criado.`);
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      if (isStaleActionError(err)) {
        toast.info("Atualizando o sistema…");
        reloadForStaleAction();
        return;
      }
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88svh] flex-col sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>{sector ? "Editar setor" : "Novo setor"}</DialogTitle>
          <DialogDescription>
            Escolha um nome, uma cor e quem participa. Só os membros do setor
            veem as conversas dele.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 flex-1 space-y-4 overflow-y-auto px-1">
          <div className="space-y-1.5">
            <Label htmlFor="sector-name">Nome</Label>
            <Input
              id="sector-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Vendas, Financeiro, Suporte…"
              maxLength={40}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label>Cor</Label>
            <div className="flex flex-wrap gap-2">
              {COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setColor(c)}
                  className={cn(
                    "h-7 w-7 rounded-full ring-2 ring-offset-2 ring-offset-background transition",
                    color === c ? "ring-foreground" : "ring-transparent",
                  )}
                  style={{ backgroundColor: c }}
                  aria-label={`Cor ${c}`}
                />
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="sector-keywords">Palavras-chave (roteamento)</Label>
            <Input
              id="sector-keywords"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="financeiro, segunda via, boleto"
            />
            <p className="text-xs text-muted-foreground">
              Se a 1ª mensagem do cliente contiver uma destas palavras, a
              conversa cai neste setor (vale mais que o número). Separe por
              vírgula.
            </p>
          </div>

          <label className="flex items-start gap-3 rounded-lg border border-border px-3 py-2.5">
            <Checkbox
              checked={autoAssign}
              onCheckedChange={(v) => setAutoAssign(v === true)}
              aria-label="Atribuir automaticamente"
              className="mt-0.5"
            />
            <span className="min-w-0">
              <span className="block text-sm text-foreground">
                Atribuir automaticamente
              </span>
              <span className="block text-xs text-muted-foreground">
                A conversa vai direto para o atendente do setor com menos
                conversas abertas. Desligado: fica na fila do setor para alguém
                pegar.
              </span>
            </span>
          </label>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <Label>Atendentes do setor</Label>
              {selected.size > 0 && (
                <span className="text-xs text-muted-foreground">
                  {selected.size} selecionado{selected.size > 1 ? "s" : ""}
                </span>
              )}
            </div>
            <div className="max-h-56 overflow-y-auto overscroll-contain rounded-lg border border-border">
              <ul className="divide-y divide-border">
                {members.map((m) => (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() => toggle(m.id)}
                      className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/60"
                    >
                      <Checkbox
                        checked={selected.has(m.id)}
                        onCheckedChange={() => toggle(m.id)}
                        aria-label={`Selecionar ${m.name}`}
                      />
                      <div className="min-w-0">
                        <p className="truncate text-sm text-foreground">{m.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {m.email}
                        </p>
                      </div>
                    </button>
                  </li>
                ))}
                {members.length === 0 && (
                  <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                    Nenhum membro na equipe.
                  </li>
                )}
              </ul>
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving || !name.trim()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {sector ? "Salvar" : "Criar setor"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

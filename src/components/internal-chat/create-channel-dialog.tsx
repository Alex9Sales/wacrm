"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Lock, Hash } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import {
  createInternalChannel,
  updateInternalChannel,
  listTeamMembers,
  listInternalChannelMemberIds,
} from "@/app/(dashboard)/internal-chat/actions";
import type {
  InternalChannel,
  TeamMemberOption,
} from "@/lib/internal-chat/types";

interface CreateChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (channel: InternalChannel) => void;
  /** When set, the dialog edits this channel instead of creating a new one. */
  channel?: InternalChannel | null;
  onUpdated?: (channel: InternalChannel) => void;
}

export function CreateChannelDialog({
  open,
  onOpenChange,
  onCreated,
  channel,
  onUpdated,
}: CreateChannelDialogProps) {
  const isEdit = !!channel;
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [members, setMembers] = useState<TeamMemberOption[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Reset (or prefill in edit mode) each time it opens; lazy-load the team
  // roster for the picker and, when editing a private channel, its members.
  useEffect(() => {
    if (!open) return;
    setName(channel?.name ?? "");
    setDescription(channel?.description ?? "");
    setIsPrivate(!!channel?.is_private);
    setSelected(new Set());
    setLoadingMembers(true);
    listTeamMembers()
      .then(setMembers)
      .catch(() => setMembers([]))
      .finally(() => setLoadingMembers(false));
    if (channel?.id && channel.is_private) {
      listInternalChannelMemberIds(channel.id)
        .then((ids) => setSelected(new Set(ids)))
        .catch(() => {});
    }
  }, [open, channel]);

  const toggleMember = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const submit = async () => {
    if (!name.trim()) {
      toast.error("Dê um nome ao canal.");
      return;
    }
    setSaving(true);
    try {
      if (isEdit && channel) {
        const updated = await updateInternalChannel({
          channelId: channel.id,
          name,
          description,
          isPrivate,
          memberIds: [...selected],
        });
        toast.success(`Canal "${updated.name}" atualizado.`);
        onUpdated?.(updated);
      } else {
        const created = await createInternalChannel({
          name,
          description,
          isPrivate,
          memberIds: [...selected],
        });
        toast.success(`Canal "${created.name}" criado.`);
        onCreated(created);
      }
      onOpenChange(false);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : `Não foi possível ${isEdit ? "atualizar" : "criar"} o canal.`,
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88svh] flex-col sm:max-w-md">
        <DialogHeader className="shrink-0">
          <DialogTitle>{isEdit ? "Editar canal" : "Novo canal"}</DialogTitle>
          <DialogDescription>
            Um espaço para a equipe conversar. Canais públicos aparecem para
            todos; privados, só para quem você escolher.
          </DialogDescription>
        </DialogHeader>

        <div className="-mx-1 flex-1 space-y-4 overflow-y-auto px-1">
          <div className="space-y-1.5">
            <Label htmlFor="channel-name">Nome do canal</Label>
            <div className="relative">
              <Hash className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="channel-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="geral, vendas, suporte…"
                maxLength={60}
                className="pl-8"
                autoFocus
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="channel-desc">Descrição (opcional)</Label>
            <Textarea
              id="channel-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Para que serve esse canal?"
              rows={2}
              maxLength={200}
            />
          </div>

          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
            <div className="min-w-0">
              <Label className="flex items-center gap-1.5 text-sm font-medium">
                <Lock className="h-3.5 w-3.5" />
                Privado
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {isPrivate
                  ? "Só os membros selecionados verão este canal."
                  : "Visível para todos da equipe."}
              </p>
            </div>
            <Switch checked={isPrivate} onCheckedChange={setIsPrivate} />
          </div>

          {isPrivate && (
            <div className="space-y-1.5">
              <Label>Membros do canal</Label>
              <div className="max-h-56 overflow-y-auto overscroll-contain rounded-lg border border-border">
                <ul className="divide-y divide-border">
                  {members.map((m) => (
                    <li key={m.id}>
                      <button
                        type="button"
                        onClick={() => toggleMember(m.id)}
                        className="flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-muted/60"
                      >
                        <Checkbox
                          checked={selected.has(m.id)}
                          onCheckedChange={() => toggleMember(m.id)}
                          aria-label={`Selecionar ${m.name}`}
                        />
                        <Avatar className="size-7 shrink-0">
                          {m.image ? (
                            <AvatarImage src={m.image} alt={m.name} />
                          ) : null}
                          <AvatarFallback className="bg-primary/10 text-xs text-primary">
                            {m.name?.charAt(0)?.toUpperCase() ?? "U"}
                          </AvatarFallback>
                        </Avatar>
                        <div className="min-w-0">
                          <p className="truncate text-sm text-foreground">
                            {m.name}
                          </p>
                          <p className="truncate text-xs text-muted-foreground">
                            {m.email}
                          </p>
                        </div>
                      </button>
                    </li>
                  ))}
                  {members.length === 0 && (
                    <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                      {loadingMembers
                        ? "Carregando equipe…"
                        : "Nenhum outro membro na equipe ainda. Crie membros em Configurações › Membros da equipe."}
                    </li>
                  )}
                </ul>
              </div>
              <p className="text-xs text-muted-foreground">
                Você entra automaticamente no canal que criar.
              </p>
            </div>
          )}
        </div>

        <DialogFooter className="shrink-0">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancelar
          </Button>
          <Button onClick={submit} disabled={saving || !name.trim()}>
            {saving && <Loader2 className={cn("mr-2 h-4 w-4 animate-spin")} />}
            {isEdit ? "Salvar" : "Criar canal"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

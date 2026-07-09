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
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import {
  createInternalChannel,
  listTeamMembers,
} from "@/app/(dashboard)/internal-chat/actions";
import type {
  InternalChannel,
  TeamMemberOption,
} from "@/lib/internal-chat/types";

interface CreateChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (channel: InternalChannel) => void;
}

export function CreateChannelDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateChannelDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [isPrivate, setIsPrivate] = useState(false);
  const [members, setMembers] = useState<TeamMemberOption[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // Reset each time it opens; lazy-load the team roster for the picker.
  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setIsPrivate(false);
    setSelected(new Set());
    listTeamMembers()
      .then(setMembers)
      .catch(() => setMembers([]));
  }, [open]);

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
      const channel = await createInternalChannel({
        name,
        description,
        isPrivate,
        memberIds: [...selected],
      });
      toast.success(`Canal "${channel.name}" criado.`);
      onCreated(channel);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível criar o canal.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Novo canal</DialogTitle>
          <DialogDescription>
            Um espaço para a equipe conversar. Canais públicos aparecem para
            todos; privados, só para quem você escolher.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
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
              <ScrollArea className="max-h-48 rounded-lg border border-border">
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
                      Carregando equipe…
                    </li>
                  )}
                </ul>
              </ScrollArea>
              <p className="text-xs text-muted-foreground">
                Você entra automaticamente no canal que criar.
              </p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancelar
          </Button>
          <Button onClick={submit} disabled={saving || !name.trim()}>
            {saving && <Loader2 className={cn("mr-2 h-4 w-4 animate-spin")} />}
            Criar canal
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus, Trash2, Pencil, Zap } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  listQuickRepliesAdmin,
  createQuickReply,
  updateQuickReply,
  deleteQuickReply,
  type QuickReply,
} from "./actions";

export function QuickRepliesPanel() {
  const { canEditSettings } = useAuth();
  const [items, setItems] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<QuickReply | null>(null);
  const [creating, setCreating] = useState(false);

  const reload = () =>
    listQuickRepliesAdmin()
      .then(setItems)
      .catch(() => setItems([]));

  useEffect(() => {
    listQuickRepliesAdmin()
      .then(setItems)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <SettingsPanelHead
        title="Respostas rápidas"
        description="Mensagens prontas que o atendente insere no chat pelo atalho (ex.: /preco). Padroniza e agiliza o atendimento."
        action={
          canEditSettings ? (
            <Button onClick={() => setCreating(true)}>
              <Plus className="size-4" />
              Nova resposta
            </Button>
          ) : undefined
        }
      />

      <div className="mt-4 space-y-3">
        {loading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-8 text-center">
            <Zap className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-2 text-sm font-medium text-foreground">
              Nenhuma resposta rápida ainda
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Crie respostas prontas (preços, horário, endereço…) pra sua equipe
              enviar em um clique.
            </p>
          </div>
        ) : (
          items.map((q) => (
            <div
              key={q.id}
              className="flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3"
            >
              <span className="mt-0.5 shrink-0 rounded-md bg-primary/10 px-2 py-0.5 font-mono text-xs font-medium text-primary">
                /{q.shortcut}
              </span>
              <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
                {q.content}
              </p>
              {canEditSettings && (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setEditing(q)}
                    title="Editar"
                    className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Pencil className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!confirm(`Excluir a resposta "/${q.shortcut}"?`)) return;
                      try {
                        await deleteQuickReply(q.id);
                        toast.success("Resposta excluída.");
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

      <QuickReplyDialog
        open={creating}
        onOpenChange={setCreating}
        onSaved={() => void reload()}
      />
      <QuickReplyDialog
        open={!!editing}
        onOpenChange={(o) => !o && setEditing(null)}
        item={editing}
        onSaved={() => void reload()}
      />
    </div>
  );
}

function QuickReplyDialog({
  open,
  onOpenChange,
  item,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  item?: QuickReply | null;
  onSaved: () => void;
}) {
  const [shortcut, setShortcut] = useState("");
  const [content, setContent] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setShortcut(item?.shortcut ?? "");
    setContent(item?.content ?? "");
  }, [open, item]);

  const save = async () => {
    if (!shortcut.trim() || !content.trim()) {
      toast.error("Preencha o atalho e o conteúdo.");
      return;
    }
    setSaving(true);
    try {
      if (item) {
        await updateQuickReply(item.id, { shortcut, content });
        toast.success("Resposta atualizada.");
      } else {
        await createQuickReply({ shortcut, content });
        toast.success("Resposta criada.");
      }
      onSaved();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Não foi possível salvar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{item ? "Editar resposta" : "Nova resposta rápida"}</DialogTitle>
          <DialogDescription>
            O atalho é o que o atendente digita depois da "/". O conteúdo é a
            mensagem que entra no chat.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="qr-shortcut">Atalho</Label>
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground">/</span>
              <Input
                id="qr-shortcut"
                value={shortcut}
                onChange={(e) => setShortcut(e.target.value)}
                placeholder="preco"
                maxLength={30}
                autoFocus
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Sem espaços. Ex.: preco, horario, endereco.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="qr-content">Conteúdo</Label>
            <textarea
              id="qr-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Nossos planos começam em R$ 99/mês. Quer que eu te envie a tabela completa?"
              rows={5}
              className="w-full resize-y rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary/50"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving || !shortcut.trim() || !content.trim()}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {item ? "Salvar" : "Criar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

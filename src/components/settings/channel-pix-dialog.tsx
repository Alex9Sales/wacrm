'use client';

// ============================================================
// Set a channel's Pix key — the key that "Pix" in the attach menu sends to
// customers from that number. Stored on channels.provider_meta.pix via
// PATCH /api/channels/:id.
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ChannelSummary } from './channels-tab';

interface StoredPix {
  key: string;
  keyType?: string;
  name?: string;
}

const KEY_TYPES = ['CNPJ', 'CPF', 'E-mail', 'Telefone', 'Aleatória'];

export function ChannelPixDialog({
  channel,
  onClose,
  onSaved,
}: {
  channel: ChannelSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const current = (channel.provider_meta as { pix?: StoredPix }).pix;
  const [key, setKey] = useState(current?.key ?? '');
  const [keyType, setKeyType] = useState(current?.keyType ?? '');
  const [name, setName] = useState(current?.name ?? '');
  const [saving, setSaving] = useState(false);

  const patch = async (pix: StoredPix | null): Promise<boolean> => {
    setSaving(true);
    try {
      const res = await fetch(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { pix } }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(d.error || 'Não foi possível salvar a chave Pix.');
        return false;
      }
      return true;
    } catch {
      toast.error('Não foi possível salvar a chave Pix.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!key.trim()) {
      toast.error('Informe a chave Pix.');
      return;
    }
    const ok = await patch({
      key: key.trim(),
      keyType: keyType.trim() || undefined,
      name: name.trim() || undefined,
    });
    if (ok) {
      toast.success('Chave Pix salva.');
      onSaved();
    }
  };

  const clear = async () => {
    const ok = await patch(null);
    if (ok) {
      toast.success('Chave Pix removida.');
      onSaved();
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Chave Pix de {channel.name}</DialogTitle>
          <DialogDescription>
            A chave que este número envia ao cliente. Ele recebe como texto e
            copia com um toque.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              Tipo da chave
            </label>
            <select
              value={keyType}
              onChange={(e) => setKeyType(e.target.value)}
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            >
              <option value="">— Selecione —</option>
              {KEY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              Chave
            </label>
            <input
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="Ex: 30365250000196"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              Nome do titular (opcional)
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ex: Danyela Glayce Leite de Souza Ltda"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {current ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={clear}
              disabled={saving}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
              Remover
            </Button>
          ) : (
            <span />
          )}
          <Button onClick={save} disabled={saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Salvar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

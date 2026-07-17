'use client';

// ============================================================
// Set a channel's business location — the fixed pin that "Enviar localização"
// sends to customers from that number. Paste a Google Maps link (or "lat, lng")
// and an optional label; parseLocation pulls the coordinates. Saved onto
// channels.provider_meta.location via PATCH /api/channels/:id.
// ============================================================

import { useState } from 'react';
import { toast } from 'sonner';
import { MapPin, Loader2, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { parseLocation } from '@/lib/whatsapp/location';
import type { ChannelSummary } from './channels-tab';

interface StoredLocation {
  latitude: number;
  longitude: number;
  label?: string;
}

export function ChannelLocationDialog({
  channel,
  onClose,
  onSaved,
}: {
  channel: ChannelSummary;
  onClose: () => void;
  onSaved: () => void;
}) {
  const current = (channel.provider_meta as { location?: StoredLocation })
    .location;
  const [input, setInput] = useState('');
  const [label, setLabel] = useState(current?.label ?? '');
  const [saving, setSaving] = useState(false);

  const patch = async (
    location: StoredLocation | null,
  ): Promise<boolean> => {
    setSaving(true);
    try {
      const res = await fetch(`/api/channels/${channel.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: { location } }),
      });
      if (!res.ok) {
        const d = (await res.json().catch(() => ({}))) as { error?: string };
        toast.error(d.error || 'Não foi possível salvar a localização.');
        return false;
      }
      return true;
    } catch {
      toast.error('Não foi possível salvar a localização.');
      return false;
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    const coords = parseLocation(input);
    if (!coords) {
      toast.error(
        'Cole um link do Google Maps ou as coordenadas "latitude, longitude".',
      );
      return;
    }
    const ok = await patch({
      latitude: coords.lat,
      longitude: coords.lng,
      label: label.trim() || undefined,
    });
    if (ok) {
      toast.success('Localização salva.');
      onSaved();
    }
  };

  const clear = async () => {
    const ok = await patch(null);
    if (ok) {
      toast.success('Localização removida.');
      onSaved();
    }
  };

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MapPin className="size-4" />
            Localização de {channel.name}
          </DialogTitle>
          <DialogDescription>
            O endereço que este número envia ao cliente. Ele recebe um mapa
            clicável que abre a rota no Google Maps.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-2">
          {current && (
            <p className="rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              Atual: {current.label ? `${current.label} — ` : ''}
              {current.latitude.toFixed(5)}, {current.longitude.toFixed(5)}
            </p>
          )}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              Link do Google Maps ou coordenadas
            </label>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="https://maps.google.com/… ou -20.41, -54.56"
              className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
            />
            <p className="text-[11px] text-muted-foreground">
              No Google Maps: toque no ponto → Compartilhar → Copiar link, e cole
              aqui. Links encurtados (maps.app.goo.gl) não funcionam — use o link
              completo.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium text-muted-foreground">
              Nome (opcional)
            </label>
            <input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Ex: Família do Gás — Av. Central, 123"
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

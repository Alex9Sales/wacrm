'use client';

// ============================================================
// Pick which of a channel's WhatsApp groups to MONITOR (ingest into the CRM).
// Opt-in per group — a busy group would flood the inbox, so only the ones
// toggled on here have their messages ingested. GET/POST/DELETE
// /api/channels/:id/groups.
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Users, Search } from 'lucide-react';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ChannelSummary } from './channels-tab';

interface GroupRow {
  jid: string;
  name: string;
  monitored: boolean;
}

export function ChannelGroupsDialog({
  channel,
  onClose,
}: {
  channel: ChannelSummary;
  onClose: () => void;
}) {
  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [busyJid, setBusyJid] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/channels/${channel.id}/groups`)
      .then(async (res) => {
        const d = (await res.json().catch(() => ({}))) as {
          groups?: GroupRow[];
          error?: string;
        };
        if (!res.ok) {
          toast.error(d.error || 'Não foi possível carregar os grupos.');
          return;
        }
        setGroups(d.groups ?? []);
      })
      .catch(() => toast.error('Não foi possível carregar os grupos.'))
      .finally(() => setLoading(false));
  }, [channel.id]);

  const toggle = async (g: GroupRow) => {
    if (busyJid) return;
    setBusyJid(g.jid);
    const turnOn = !g.monitored;
    try {
      const res = turnOn
        ? await fetch(`/api/channels/${channel.id}/groups`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jid: g.jid, name: g.name }),
          })
        : await fetch(
            `/api/channels/${channel.id}/groups?jid=${encodeURIComponent(g.jid)}`,
            { method: 'DELETE' },
          );
      if (!res.ok) {
        toast.error('Não foi possível salvar.');
        return;
      }
      setGroups((prev) =>
        prev.map((x) => (x.jid === g.jid ? { ...x, monitored: turnOn } : x)),
      );
    } catch {
      toast.error('Não foi possível salvar.');
    } finally {
      setBusyJid(null);
    }
  };

  const q = query.trim().toLowerCase();
  const filtered = q
    ? groups.filter((g) => (g.name || g.jid).toLowerCase().includes(q))
    : groups;
  const monitoredCount = groups.filter((g) => g.monitored).length;

  // WhatsApp Communities expose several groups with the SAME name (the
  // community node + its "Avisos" announcement group, etc.). Disambiguate
  // those with a short jid tail so the user can tell which is which.
  const nameCounts = groups.reduce<Record<string, number>>((acc, g) => {
    const n = (g.name || g.jid.split('@')[0]).toLowerCase();
    acc[n] = (acc[n] || 0) + 1;
    return acc;
  }, {});
  const isDupName = (g: GroupRow) =>
    nameCounts[(g.name || g.jid.split('@')[0]).toLowerCase()] > 1;
  const jidTail = (g: GroupRow) => g.jid.replace(/\D/g, '').slice(-5);

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Users className="size-4" />
            Grupos de {channel.name}
          </DialogTitle>
          <DialogDescription>
            Escolha quais grupos o CRM deve monitorar. Só os marcados têm as
            mensagens trazidas para cá. {monitoredCount} monitorado
            {monitoredCount === 1 ? '' : 's'}.
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar grupo"
            className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-sm text-foreground"
          />
        </div>

        <div className="max-h-80 overflow-y-auto rounded-lg border border-border">
          {loading ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Carregando grupos…
            </p>
          ) : filtered.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {groups.length === 0
                ? 'Nenhum grupo neste número.'
                : 'Nenhum grupo encontrado.'}
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {filtered.map((g) => (
                <li
                  key={g.jid}
                  className="flex items-center gap-3 px-3 py-2.5"
                >
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <Users className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                    {g.name || g.jid.split('@')[0]}
                    {isDupName(g) && (
                      <span className="ml-1.5 text-xs text-muted-foreground">
                        ·{jidTail(g)}
                      </span>
                    )}
                  </span>
                  <button
                    type="button"
                    onClick={() => toggle(g)}
                    disabled={busyJid === g.jid}
                    className={`flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition ${
                      g.monitored ? 'bg-emerald-500' : 'bg-muted'
                    }`}
                    role="switch"
                    aria-checked={g.monitored}
                    title={g.monitored ? 'Monitorando' : 'Não monitorado'}
                  >
                    {busyJid === g.jid ? (
                      <Loader2 className="mx-auto size-3.5 animate-spin text-white" />
                    ) : (
                      <span
                        className={`size-5 rounded-full bg-white transition-transform ${
                          g.monitored ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

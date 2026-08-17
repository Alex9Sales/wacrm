'use client';

// ============================================================
// Home das automações de comentário do Instagram (comentário→DM), agora sob
// Automações (antes ficava escondido em Config→Canais). Lista as contas IG
// conectadas e abre o gerenciador de automações de cada uma (com seletor de
// post + mensagem). Reusa o ChannelCommentAutomationDialog.
// ============================================================

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Loader2, MessageCircle, Settings2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ChannelCommentAutomationDialog } from '@/components/settings/channel-comment-automation-dialog';
import type { ChannelSummary } from '@/components/settings/channels-tab';

export default function CommentAutomationsPage() {
  const router = useRouter();
  const [channels, setChannels] = useState<ChannelSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<ChannelSummary | null>(null);

  useEffect(() => {
    fetch('/api/channels')
      .then(async (r) => {
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(b?.error ?? 'Falha ao carregar canais');
        return b;
      })
      .then((b) =>
        setChannels(
          ((b.channels ?? []) as ChannelSummary[]).filter(
            (c) => c.provider === 'instagram',
          ),
        ),
      )
      .catch((e) =>
        setError(e instanceof Error ? e.message : 'Falha ao carregar'),
      );
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <button
          type="button"
          onClick={() => router.push('/automations')}
          className="mb-2 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Automações
        </button>
        <h1 className="text-2xl font-bold text-foreground">
          Automações de comentário
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          Alguém comenta uma palavra-chave num post do Instagram → o CRM responde
          o comentário e manda um DM com o link. Você escolhe o post e a mensagem
          de cada automação.
        </p>
      </div>

      {error ? (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : channels === null ? (
        <div className="flex h-40 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-primary" />
        </div>
      ) : channels.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
          <p className="text-sm font-medium text-foreground">
            Nenhuma conta do Instagram conectada
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Conecte o Instagram em Config → Canais para criar automações de
            comentário.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {channels.map((c) => (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card p-4"
            >
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-tr from-[#feda75] via-[#d62976] to-[#4f5bd5] text-white">
                  <MessageCircle className="size-5" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">
                    {c.name}
                  </p>
                  <p className="text-xs text-muted-foreground">Instagram</p>
                </div>
              </div>
              <Button onClick={() => setActive(c)}>
                <Settings2 className="size-4" /> Gerenciar automações
              </Button>
            </li>
          ))}
        </ul>
      )}

      {active && (
        <ChannelCommentAutomationDialog
          channel={active}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}

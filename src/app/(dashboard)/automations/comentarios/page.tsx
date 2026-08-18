'use client';

// ============================================================
// Galeria das automações de comentário do Instagram. Abre já listando os POSTS
// da conta (miniaturas) + um bloco "Qualquer post". Cada post mostra quantas
// automações tem; clicar abre o editor já com aquele post selecionado. Fica sob
// Automações (antes era escondido em Config→Canais).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, Image as ImageIcon, Loader2, Sparkles } from 'lucide-react';

import { ChannelCommentAutomationDialog } from '@/components/settings/channel-comment-automation-dialog';
import type { ChannelSummary } from '@/components/settings/channels-tab';
import type {
  CommentPost,
  CommentAutomation,
} from '@/components/settings/instagram-comments-actions';

export default function CommentAutomationsPage() {
  const router = useRouter();
  const [channels, setChannels] = useState<ChannelSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [posts, setPosts] = useState<CommentPost[]>([]);
  const [rules, setRules] = useState<CommentAutomation[]>([]);
  const [loadingData, setLoadingData] = useState(false);
  const [dialog, setDialog] = useState<{
    channel: ChannelSummary;
    mediaId: string;
  } | null>(null);

  useEffect(() => {
    fetch('/api/channels')
      .then(async (r) => {
        const b = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(b?.error ?? 'Falha ao carregar canais');
        return b;
      })
      .then((b) => {
        const igs = ((b.channels ?? []) as ChannelSummary[]).filter(
          (c) => c.provider === 'instagram',
        );
        setChannels(igs);
        if (igs[0]) setSelectedId(igs[0].id);
      })
      .catch((e) =>
        setError(e instanceof Error ? e.message : 'Falha ao carregar'),
      );
  }, []);

  const selected = channels?.find((c) => c.id === selectedId) ?? null;

  const loadData = useCallback(async (channelId: string) => {
    setLoadingData(true);
    try {
      // Rota de API estável (não quebra com bundle velho, ao contrário das
      // Server Actions) — é o que deixava a galeria sem listar os posts.
      const res = await fetch(
        `/api/instagram/comment-setup?channelId=${encodeURIComponent(channelId)}`,
      );
      const b = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(b?.error ?? 'Falha ao carregar posts');
      setPosts((b.posts ?? []) as CommentPost[]);
      setRules((b.rules ?? []) as CommentAutomation[]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao carregar posts.');
    } finally {
      setLoadingData(false);
    }
  }, []);

  useEffect(() => {
    if (selectedId) void loadData(selectedId);
  }, [selectedId, loadData]);

  const countFor = (mediaId: string | null) =>
    rules.filter((r) => (mediaId ? r.media_id === mediaId : !r.media_id)).length;

  const closeDialog = () => {
    setDialog(null);
    if (selectedId) void loadData(selectedId);
  };

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
          Escolha um post → quando alguém comentar uma palavra-chave nele, o CRM
          responde e manda um DM com o link. Ou use &ldquo;Qualquer post&rdquo;
          pra valer em todos.
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
            Conecte o Instagram em Config → Canais para criar automações.
          </p>
        </div>
      ) : (
        <>
          {channels.length > 1 && (
            <select
              className="h-9 w-full max-w-xs rounded-lg border border-input bg-transparent px-3 text-sm"
              value={selectedId ?? ''}
              onChange={(e) => setSelectedId(e.target.value)}
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}

          {loadingData ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="size-6 animate-spin text-primary" />
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {/* Qualquer post */}
              <button
                type="button"
                onClick={() =>
                  selected && setDialog({ channel: selected, mediaId: '' })
                }
                className="group relative flex aspect-square flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-card p-3 text-center transition-colors hover:border-primary/50"
              >
                <span className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <Sparkles className="size-5" />
                </span>
                <span className="text-xs font-medium text-foreground">
                  Qualquer post
                </span>
                <CountBadge n={countFor(null)} />
              </button>

              {posts.length === 0 && (
                <div className="col-span-full rounded-xl border border-dashed border-border bg-card/40 p-6 text-center text-xs text-muted-foreground">
                  Não consegui listar os posts agora (ou a conta não tem posts).
                  Você ainda pode criar uma regra em &ldquo;Qualquer post&rdquo;.
                </div>
              )}

              {posts.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() =>
                    selected && setDialog({ channel: selected, mediaId: p.id })
                  }
                  title={p.caption ?? ''}
                  className="group relative aspect-square overflow-hidden rounded-xl border border-border bg-muted transition-transform hover:scale-[1.02]"
                >
                  {p.thumbnail_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.thumbnail_url}
                      alt={p.caption ?? ''}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span className="flex h-full w-full items-center justify-center text-muted-foreground">
                      <ImageIcon className="size-6" />
                    </span>
                  )}
                  <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-1.5 text-left">
                    <span className="line-clamp-1 text-[10px] text-white/90">
                      {p.caption || 'Sem legenda'}
                    </span>
                  </span>
                  <CountBadge n={countFor(p.id)} />
                </button>
              ))}
            </div>
          )}
        </>
      )}

      {dialog && (
        <ChannelCommentAutomationDialog
          channel={dialog.channel}
          initialMediaId={dialog.mediaId}
          initialPosts={posts}
          onClose={closeDialog}
        />
      )}
    </div>
  );
}

/** Selo com o número de automações do post (só aparece se > 0). */
function CountBadge({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <span className="absolute right-1.5 top-1.5 z-10 inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground shadow">
      {n}
    </span>
  );
}

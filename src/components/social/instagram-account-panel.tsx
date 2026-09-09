'use client';

// ============================================================
// 📸 Conta conectada do Instagram: perfil ao vivo (@, nome, bio, seguidores),
// lista de mídias da conta e moderação de comentários por post (comentar,
// responder, ocultar/mostrar, apagar). Tudo lido na hora da Graph API — nada
// em cache — pra ficha refletir o que está no Instagram. (09/09/2026: é o que
// a revisão da Meta precisa ver no screencast de instagram_business_basic e
// instagram_business_manage_comments.)
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  AtSign,
  Eye,
  EyeOff,
  Loader2,
  MessageCircle,
  RefreshCw,
  Reply,
  Send,
  Trash2,
  Users,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import type { InstagramComment } from '@/lib/channels/providers/instagram';
import {
  createInstagramComment,
  deleteInstagramComment,
  getInstagramAccountPanel,
  hideInstagramComment,
  listInstagramMediaComments,
  replyInstagramComment,
  type InstagramAccountPanel as PanelData,
} from '@/app/(dashboard)/social/actions';
import type { IgChannelLite } from '@/components/settings/instagram-comments-actions';

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function fmtNum(n: number | null): string {
  if (n === null) return '—';
  return n.toLocaleString('pt-BR');
}

export function InstagramAccountPanel({ channels }: { channels: IgChannelLite[] }) {
  const [channelId, setChannelId] = useState<string>(channels[0]?.id ?? '');
  const [panel, setPanel] = useState<PanelData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mediaId, setMediaId] = useState<string | null>(null);

  useEffect(() => {
    if (!channelId && channels[0]) setChannelId(channels[0].id);
  }, [channels, channelId]);

  const load = useCallback(async () => {
    if (!channelId) return;
    setLoading(true);
    try {
      const r = await getInstagramAccountPanel(channelId);
      if (!r.ok) {
        setError(r.error);
        setPanel(null);
      } else {
        setError(null);
        setPanel(r.panel);
      }
    } catch {
      setError('Não foi possível ler a conta do Instagram. Recarregue a página (F5) e tente de novo.');
    } finally {
      setLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    setMediaId(null);
    void load();
  }, [load]);

  if (!channels.length) return null;
  const profile = panel?.profile ?? null;
  const handle = profile?.username ? `@${profile.username}` : null;
  const selectedMedia = panel?.media.find((m) => m.id === mediaId) ?? null;

  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <h2 className="flex items-center gap-2 text-base font-semibold text-foreground">
          <AtSign className="h-4 w-4 text-pink-500" />
          Conta conectada
          {handle ? <span className="text-muted-foreground">· {handle}</span> : null}
        </h2>
        <div className="flex items-center gap-2">
          {channels.length > 1 ? (
            <select
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
              aria-label="Canal do Instagram"
            >
              {channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : null}
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading} title="Buscar de novo no Instagram">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Atualizar
          </Button>
        </div>
      </div>

      {error ? (
        <p className="px-4 py-3 text-sm text-red-600 dark:text-red-300">{error}</p>
      ) : null}

      {!panel && loading ? (
        <p className="flex items-center gap-2 px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Lendo o perfil no Instagram…
        </p>
      ) : null}

      {profile ? (
        <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          {/* Perfil ao vivo */}
          <div className="flex gap-3">
            {profile.profilePictureUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={profile.profilePictureUrl}
                alt={handle ?? 'Perfil'}
                className="h-16 w-16 shrink-0 rounded-full border border-border object-cover"
              />
            ) : (
              <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Users className="h-6 w-6" />
              </div>
            )}
            <div className="min-w-0">
              <p className="truncate text-base font-semibold text-foreground">{handle ?? profile.id}</p>
              {profile.name ? <p className="truncate text-sm text-foreground">{profile.name}</p> : null}
              {profile.biography ? (
                <p className="mt-1 whitespace-pre-line text-sm text-muted-foreground">{profile.biography}</p>
              ) : null}
              {profile.website ? (
                <a
                  href={profile.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1 block truncate text-sm text-primary underline"
                >
                  {profile.website}
                </a>
              ) : null}
              <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-sm">
                <div>
                  <dt className="inline text-muted-foreground">Seguidores </dt>
                  <dd className="inline font-medium text-foreground tabular-nums">{fmtNum(profile.followersCount)}</dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">Seguindo </dt>
                  <dd className="inline font-medium text-foreground tabular-nums">{fmtNum(profile.followsCount)}</dd>
                </div>
                <div>
                  <dt className="inline text-muted-foreground">Publicações </dt>
                  <dd className="inline font-medium text-foreground tabular-nums">{fmtNum(profile.mediaCount)}</dd>
                </div>
              </dl>
              <p className="mt-1 text-xs text-muted-foreground">
                Lido no Instagram às {fmtDate(panel?.fetchedAt ?? null)}
              </p>
            </div>
          </div>

          {/* Mídias da conta */}
          <div>
            <p className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Publicações de {handle ?? 'conta'} · clique para ver os comentários
            </p>
            {panel && panel.media.length === 0 ? (
              <p className="text-sm text-muted-foreground">Nenhuma publicação nesta conta.</p>
            ) : (
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                {panel?.media.map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setMediaId(m.id === mediaId ? null : m.id)}
                    title={m.caption ?? m.id}
                    className={cn(
                      'group relative aspect-square overflow-hidden rounded-md border bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
                      m.id === mediaId ? 'border-primary ring-2 ring-primary' : 'border-border',
                    )}
                  >
                    {m.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={m.thumbnailUrl} alt={m.caption ?? ''} className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-[10px] text-muted-foreground">
                        {m.mediaType ?? 'mídia'}
                      </span>
                    )}
                    <span className="absolute inset-x-0 bottom-0 truncate bg-black/55 px-1 py-0.5 text-[10px] text-white">
                      {handle ?? ''} · {fmtDate(m.timestamp).split(' ')[0]}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {selectedMedia && channelId ? (
        <MediaComments
          key={selectedMedia.id}
          channelId={channelId}
          mediaId={selectedMedia.id}
          caption={selectedMedia.caption}
          permalink={selectedMedia.permalink}
          handle={handle}
        />
      ) : null}
    </section>
  );
}

// ------------------------------------------------------------
// Comentários de um post + moderação
// ------------------------------------------------------------

function MediaComments({
  channelId,
  mediaId,
  caption,
  permalink,
  handle,
}: {
  channelId: string;
  mediaId: string;
  caption: string | null;
  permalink: string | null;
  handle: string | null;
}) {
  const [comments, setComments] = useState<InstagramComment[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newText, setNewText] = useState('');
  const [replyFor, setReplyFor] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await listInstagramMediaComments(channelId, mediaId);
      if (!r.ok) {
        setError(r.error);
        setComments(null);
      } else {
        setError(null);
        setComments(r.comments);
      }
    } catch {
      setError('Não foi possível ler os comentários. Recarregue a página (F5) e tente de novo.');
    } finally {
      setLoading(false);
    }
  }, [channelId, mediaId]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (id: string, fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    if (busy) return;
    setBusy(id);
    try {
      const r = await fn();
      if (!r.ok) {
        toast.error(r.error ?? 'Não deu certo.');
        return false;
      }
      toast.success(okMsg);
      await load();
      return true;
    } catch {
      toast.error('Não deu certo. Recarregue a página (F5) e tente de novo.');
      return false;
    } finally {
      setBusy(null);
    }
  };

  const total = (comments ?? []).reduce((n, c) => n + 1 + c.replies.length, 0);

  const renderComment = (c: InstagramComment, isReply: boolean) => (
    <li key={c.id} className={cn('rounded-lg border border-border bg-background p-3', isReply && 'ml-6')}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
        <span className="font-medium text-foreground">{c.username ? `@${c.username}` : 'usuário'}</span>
        <span className="text-xs text-muted-foreground">{fmtDate(c.timestamp)}</span>
        {c.hidden ? (
          <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[11px] text-amber-700 dark:text-amber-300">
            oculto
          </span>
        ) : null}
        {c.likeCount ? <span className="text-xs text-muted-foreground">· {c.likeCount} curtida{c.likeCount === 1 ? '' : 's'}</span> : null}
      </div>
      <p className={cn('mt-1 whitespace-pre-line text-sm text-foreground', c.hidden && 'text-muted-foreground line-through')}>
        {c.text || '(sem texto)'}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {!isReply ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setReplyFor(replyFor === c.id ? null : c.id);
              setReplyText('');
            }}
            disabled={!!busy}
            title="Responder publicamente, dentro do comentário"
          >
            <Reply className="h-3.5 w-3.5" />
            Responder
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => void run(c.id, () => hideInstagramComment(channelId, c.id, !c.hidden), c.hidden ? 'Comentário visível de novo' : 'Comentário oculto')}
          disabled={!!busy}
          title={c.hidden ? 'Voltar a mostrar no post' : 'Ocultar do post (a pessoa não é avisada)'}
        >
          {busy === c.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : c.hidden ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
          {c.hidden ? 'Mostrar' : 'Ocultar'}
        </Button>
        {confirmDelete === c.id ? (
          <>
            <span className="text-xs text-muted-foreground">Apagar de vez?</span>
            <Button
              size="sm"
              variant="destructive"
              onClick={() =>
                void run(c.id, () => deleteInstagramComment(channelId, c.id), 'Comentário apagado').then((ok) => {
                  if (ok) setConfirmDelete(null);
                })
              }
              disabled={!!busy}
            >
              Sim, apagar
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)} disabled={!!busy}>
              Não
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => setConfirmDelete(c.id)}
            disabled={!!busy}
            title="Apagar o comentário do post"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Apagar
          </Button>
        )}
      </div>
      {replyFor === c.id ? (
        <div className="mt-2 flex items-end gap-2">
          <Textarea
            value={replyText}
            onChange={(e) => setReplyText(e.target.value)}
            placeholder={`Responder ${c.username ? `@${c.username}` : ''}…`}
            rows={2}
            className="min-h-0"
          />
          <Button
            size="sm"
            onClick={() =>
              void run(`reply:${c.id}`, () => replyInstagramComment(channelId, c.id, replyText), 'Resposta publicada').then((ok) => {
                if (ok) {
                  setReplyFor(null);
                  setReplyText('');
                }
              })
            }
            disabled={!!busy || !replyText.trim()}
          >
            {busy === `reply:${c.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
            Enviar
          </Button>
        </div>
      ) : null}
      {c.replies.length ? <ul className="mt-2 space-y-2">{c.replies.map((r) => renderComment(r, true))}</ul> : null}
    </li>
  );

  return (
    <div className="border-t border-border p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground">
          <MessageCircle className="h-4 w-4 text-pink-500" />
          Comentários {handle ? `· ${handle}` : ''}
          {comments ? <span className="font-normal text-muted-foreground">({total})</span> : null}
        </h3>
        <div className="flex items-center gap-2">
          {permalink ? (
            <a href={permalink} target="_blank" rel="noopener noreferrer" className="text-xs text-primary underline">
              Abrir no Instagram
            </a>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </div>
      {caption ? <p className="mb-3 line-clamp-2 text-xs text-muted-foreground">{caption}</p> : null}

      <div className="mb-4 flex items-end gap-2">
        <Textarea
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          placeholder="Comentar neste post como a conta…"
          rows={2}
          className="min-h-0"
        />
        <Button
          size="sm"
          onClick={() =>
            void run('new', () => createInstagramComment(channelId, mediaId, newText), 'Comentário publicado').then((ok) => {
              if (ok) setNewText('');
            })
          }
          disabled={!!busy || !newText.trim()}
        >
          {busy === 'new' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
          Comentar
        </Button>
      </div>

      {error ? <p className="text-sm text-red-600 dark:text-red-300">{error}</p> : null}
      {loading && !comments ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Lendo os comentários…
        </p>
      ) : null}
      {comments && comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nenhum comentário neste post ainda.</p>
      ) : null}
      {comments && comments.length > 0 ? <ul className="space-y-2">{comments.map((c) => renderComment(c, false))}</ul> : null}
    </div>
  );
}

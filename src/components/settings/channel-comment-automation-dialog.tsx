'use client';

// ============================================================
// Automação comentário→DM de um canal Instagram. Lista as regras e deixa
// criar/editar/ligar/remover. Cada regra: quando alguém comenta (palavra-chave
// ou qualquer comentário) num post da conta, o CRM responde o comentário
// (opcional) e manda um DM com o link. Fala com instagram-comments-actions.ts.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Plus,
  Trash2,
  Pencil,
  MessageCircle,
  ArrowLeft,
  Image as ImageIcon,
  Repeat2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { ChannelSummary } from './channels-tab';
import {
  listCommentAutomations,
  createCommentAutomation,
  updateCommentAutomation,
  toggleCommentAutomation,
  deleteCommentAutomation,
  listInstagramPosts,
  type CommentAutomation,
  type CommentPost,
} from './instagram-comments-actions';

const EMPTY = {
  name: '',
  enabled: true,
  matchAny: false,
  keywords: '',
  publicReply: '',
  dmMessage: '',
  oncePerUser: true,
  // '' = qualquer post; senão o media_id do post escolhido.
  mediaId: '',
};

type FormState = typeof EMPTY;

export function ChannelCommentAutomationDialog({
  channel,
  onClose,
  initialMediaId,
  initialPosts,
}: {
  channel: ChannelSummary;
  onClose: () => void;
  /** Quando vem da galeria: '' = qualquer post, ou o media_id do post clicado.
   *  A lista filtra por esse post e o "novo" já vem com ele selecionado.
   *  undefined = modo geral (lista tudo). */
  initialMediaId?: string | null;
  /** Posts já carregados pela galeria (evita refazer a Server Action, que
   *  quebra com bundle velho). */
  initialPosts?: CommentPost[];
}) {
  const [rules, setRules] = useState<CommentAutomation[]>([]);
  const [loading, setLoading] = useState(true);
  // null = lista; 'new' = criando; string = editando o id.
  const [editing, setEditing] = useState<null | 'new' | string>(null);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [saving, setSaving] = useState(false);
  // Posts do IG pro seletor. Se a galeria já passou (initialPosts), usa esses e
  // não refaz a Server Action; senão carrega sob demanda (uso via Config→Canais).
  const [posts, setPosts] = useState<CommentPost[]>(initialPosts ?? []);
  const [postsLoading, setPostsLoading] = useState(false);
  const [postsLoaded, setPostsLoaded] = useState(!!initialPosts?.length);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRules(await listCommentAutomations(channel.id));
    } catch (err) {
      console.error('[comment-automation] load failed:', err);
      toast.error('Não foi possível carregar as automações.');
    } finally {
      setLoading(false);
    }
  }, [channel.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadPosts = useCallback(async () => {
    if (postsLoaded || postsLoading) return;
    setPostsLoading(true);
    try {
      setPosts(await listInstagramPosts(channel.id));
      setPostsLoaded(true);
    } catch (err) {
      console.error('[comment-automation] posts load failed:', err);
    } finally {
      setPostsLoading(false);
    }
  }, [channel.id, postsLoaded, postsLoading]);

  const startNew = () => {
    setForm({ ...EMPTY, mediaId: initialMediaId ?? '' });
    setEditing('new');
    void loadPosts();
  };

  // Vindo da galeria (initialMediaId definido): mostra só as regras daquele post
  // (ou as "qualquer post" quando ''). Modo geral (undefined) lista tudo.
  const displayRules =
    initialMediaId === undefined
      ? rules
      : rules.filter((r) =>
          initialMediaId ? r.media_id === initialMediaId : !r.media_id,
        );

  const startEdit = (r: CommentAutomation) => {
    setForm({
      name: r.name,
      enabled: r.enabled,
      matchAny: r.match_any,
      keywords: r.keywords,
      publicReply: r.public_reply ?? '',
      dmMessage: r.dm_message,
      oncePerUser: r.once_per_user,
      mediaId: r.media_id ?? '',
    });
    setEditing(r.id);
    void loadPosts();
  };

  const save = async () => {
    setSaving(true);
    try {
      const input = {
        channelId: channel.id,
        name: form.name,
        enabled: form.enabled,
        matchAny: form.matchAny,
        keywords: form.keywords,
        publicReply: form.publicReply || null,
        dmMessage: form.dmMessage,
        oncePerUser: form.oncePerUser,
        mediaId: form.mediaId || null,
      };
      if (editing === 'new') {
        await createCommentAutomation(input);
        toast.success('Automação criada.');
      } else if (editing) {
        await updateCommentAutomation(editing, input);
        toast.success('Automação atualizada.');
      }
      setEditing(null);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (r: CommentAutomation) => {
    // Otimista.
    setRules((prev) =>
      prev.map((x) => (x.id === r.id ? { ...x, enabled: !x.enabled } : x)),
    );
    try {
      await toggleCommentAutomation(r.id, !r.enabled);
    } catch {
      toast.error('Não foi possível alterar.');
      void load();
    }
  };

  const remove = async (r: CommentAutomation) => {
    try {
      await deleteCommentAutomation(r.id);
      setRules((prev) => prev.filter((x) => x.id !== r.id));
      toast.success('Automação removida.');
    } catch {
      toast.error('Não foi possível remover.');
    }
  };

  const inForm = editing !== null;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageCircle className="size-4" />
            Automação de comentários — {channel.name}
          </DialogTitle>
          <DialogDescription>
            Quando alguém comenta num post da conta, o CRM responde o comentário
            e manda um DM com o link. Requer a permissão de comentários aprovada
            na Meta e o post publicado pela conta profissional.
          </DialogDescription>
        </DialogHeader>

        {inForm ? (
          <div className="flex flex-col gap-3 py-1">
            <Field label="Nome da automação">
              <input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Ex: Post do e-book"
                className={inputCls}
              />
            </Field>

            <Field label="Post da automação">
              <PostPicker
                posts={posts}
                loading={postsLoading}
                value={form.mediaId}
                onChange={(id) => setForm({ ...form, mediaId: id })}
              />
            </Field>

            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={form.matchAny}
                onChange={(e) => setForm({ ...form, matchAny: e.target.checked })}
              />
              Responder <strong>qualquer</strong> comentário (ignora palavras-chave)
            </label>

            {!form.matchAny && (
              <Field label="Palavras-chave (separadas por vírgula)">
                <input
                  value={form.keywords}
                  onChange={(e) => setForm({ ...form, keywords: e.target.value })}
                  placeholder="quero, eu quero, link, preço"
                  className={inputCls}
                />
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Dispara se o comentário contiver qualquer uma delas.
                </p>
              </Field>
            )}

            <Field label="Resposta pública no comentário (opcional)">
              <textarea
                value={form.publicReply}
                onChange={(e) => setForm({ ...form, publicReply: e.target.value })}
                placeholder="Te chamei na DM! 📩"
                rows={2}
                className={inputCls}
              />
            </Field>

            <Field label="Mensagem do DM (com o link)">
              <textarea
                value={form.dmMessage}
                onChange={(e) => setForm({ ...form, dmMessage: e.target.value })}
                placeholder="Oi! Aqui está o link que você pediu: https://…"
                rows={3}
                className={inputCls}
              />
            </Field>

            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={form.oncePerUser}
                onChange={(e) =>
                  setForm({ ...form, oncePerUser: e.target.checked })
                }
              />
              Mandar o DM só <strong>uma vez</strong> por pessoa
            </label>

            <div className="mt-1 flex items-center justify-between gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEditing(null)}
                disabled={saving}
                className="text-muted-foreground"
              >
                <ArrowLeft className="size-4" />
                Voltar
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                Salvar
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2 py-1">
            {loading ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="size-5 animate-spin text-primary" />
              </div>
            ) : displayRules.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nenhuma automação ainda. Crie a primeira.
              </p>
            ) : (
              displayRules.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border bg-background px-3 py-2"
                >
                  <button
                    type="button"
                    onClick={() => startEdit(r)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <p className="truncate text-sm font-medium text-foreground">
                      {r.name}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {r.match_any
                        ? 'Qualquer comentário'
                        : `Palavras: ${r.keywords || '—'}`}
                    </p>
                  </button>
                  <label
                    className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
                    title={r.enabled ? 'Ativa' : 'Desligada'}
                  >
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={() => toggle(r)}
                    />
                    {r.enabled ? 'Ativa' : 'Off'}
                  </label>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => startEdit(r)}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => remove(r)}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              ))
            )}

            <Button
              variant="outline"
              onClick={startNew}
              className="mt-1 w-full border-border"
            >
              <Plus className="size-4" />
              Nova automação
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

const inputCls =
  'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground';

/** Seletor de post: por padrão COMPACTO (só o post escolhido + "Trocar post").
 *  Clicar em "Trocar post" abre a faixa com todos pra escolher outro. */
function PostPicker({
  posts,
  loading,
  value,
  onChange,
}: {
  posts: CommentPost[];
  loading: boolean;
  value: string;
  onChange: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const selected = value ? (posts.find((p) => p.id === value) ?? null) : null;

  const pick = (id: string) => {
    onChange(id);
    setExpanded(false);
  };

  if (!expanded) {
    return (
      <div className="flex items-center gap-3">
        {value === '' ? (
          <div className="flex size-14 shrink-0 flex-col items-center justify-center rounded-lg border border-border text-center text-[10px] font-medium text-muted-foreground">
            Qualquer
            <br />
            post
          </div>
        ) : selected?.thumbnail_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={selected.thumbnail_url}
            alt=""
            className="size-14 shrink-0 rounded-lg border border-primary object-cover"
          />
        ) : (
          <div className="flex size-14 shrink-0 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground">
            <ImageIcon className="size-5" />
          </div>
        )}
        <div className="min-w-0">
          <p className="truncate text-xs text-muted-foreground">
            {value === ''
              ? 'Vale pra comentários em qualquer post.'
              : 'Só dispara nos comentários deste post.'}
          </p>
          <button
            type="button"
            onClick={() => setExpanded(true)}
            className="mt-0.5 inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            <Repeat2 className="size-3.5" /> Trocar post
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex gap-2 overflow-x-auto pb-1">
        <button
          type="button"
          onClick={() => pick('')}
          className={cn(
            'flex size-16 shrink-0 flex-col items-center justify-center rounded-lg border text-center text-[10px] font-medium leading-tight',
            value === ''
              ? 'border-primary text-foreground ring-2 ring-primary'
              : 'border-border text-muted-foreground',
          )}
        >
          Qualquer
          <br />
          post
        </button>
        {loading && posts.length === 0 && (
          <div className="flex size-16 items-center justify-center text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
          </div>
        )}
        {posts.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => pick(p.id)}
            title={p.caption ?? ''}
            className={cn(
              'relative size-16 shrink-0 overflow-hidden rounded-lg border bg-muted',
              value === p.id ? 'border-primary ring-2 ring-primary' : 'border-border',
            )}
          >
            {p.thumbnail_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={p.thumbnail_url} alt="" className="size-full object-cover" />
            ) : (
              <span className="flex size-full items-center justify-center text-[9px] text-muted-foreground">
                sem foto
              </span>
            )}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setExpanded(false)}
        className="text-[11px] text-muted-foreground hover:text-foreground"
      >
        Fechar
      </button>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

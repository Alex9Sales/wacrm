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
  X,
  Check,
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
  // lista de media_id dos posts; vazio = qualquer post.
  mediaIds: [] as string[],
  // botão no DM (estilo ManyChat): texto + link. Vazio = DM só texto.
  dmButtonText: '',
  dmButtonUrl: '',
};

type FormState = typeof EMPTY;

export function ChannelCommentAutomationDialog({
  channel,
  onClose,
  initialMediaIds,
  initialPosts,
}: {
  channel: ChannelSummary;
  onClose: () => void;
  /** Quando vem da galeria: [] = qualquer post, ou os media_ids dos posts
   *  clicados. A lista filtra por esses posts e o "novo" já vem com eles.
   *  undefined = modo geral (lista tudo). */
  initialMediaIds?: string[];
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
    setForm({ ...EMPTY, mediaIds: initialMediaIds ?? [] });
    setEditing('new');
    void loadPosts();
  };

  // Posts que uma regra cobre (media_ids novo, ou media_id legado).
  const ruleMediaIds = (r: CommentAutomation): string[] =>
    r.media_ids?.length ? r.media_ids : r.media_id ? [r.media_id] : [];

  // Vindo da galeria (initialMediaIds definido): [] = mostra as regras "qualquer
  // post"; [ids] = regras que cobrem algum desses posts. undefined = lista tudo.
  const displayRules =
    initialMediaIds === undefined
      ? rules
      : rules.filter((r) => {
          const ids = ruleMediaIds(r);
          return initialMediaIds.length === 0
            ? ids.length === 0
            : ids.some((id) => initialMediaIds.includes(id));
        });

  const startEdit = (r: CommentAutomation) => {
    setForm({
      name: r.name,
      enabled: r.enabled,
      matchAny: r.match_any,
      keywords: r.keywords,
      publicReply: r.public_reply ?? '',
      dmMessage: r.dm_message,
      oncePerUser: r.once_per_user,
      mediaIds: ruleMediaIds(r),
      dmButtonText: r.dm_button_text ?? '',
      dmButtonUrl: r.dm_button_url ?? '',
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
        mediaIds: form.mediaIds,
        dmButtonText: form.dmButtonText || null,
        dmButtonUrl: form.dmButtonUrl || null,
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
      <DialogContent className="max-h-[85vh] overflow-y-auto border-border bg-popover sm:max-w-lg">
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

            <Field label="Posts da automação">
              <PostMultiPicker
                posts={posts}
                loading={postsLoading}
                value={form.mediaIds}
                onChange={(ids) => setForm({ ...form, mediaIds: ids })}
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

            <Field label="Mensagem do DM">
              <textarea
                value={form.dmMessage}
                onChange={(e) => setForm({ ...form, dmMessage: e.target.value })}
                placeholder="Oi! Aqui está o que você pediu 👇"
                rows={3}
                className={inputCls}
              />
            </Field>

            <div className="rounded-lg border border-border p-3">
              <p className="text-xs font-medium text-foreground">
                Botão no DM{' '}
                <span className="text-muted-foreground">
                  (opcional — estilo ManyChat)
                </span>
              </p>
              <p className="mb-2 mt-0.5 text-[11px] text-muted-foreground">
                Se preencher, o DM vira um card com um botão clicável (abre o
                link / página de vendas). O botão aparece no app do Instagram.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Texto do botão">
                  <input
                    value={form.dmButtonText}
                    onChange={(e) =>
                      setForm({ ...form, dmButtonText: e.target.value })
                    }
                    placeholder="Ex: Quero o link"
                    maxLength={20}
                    className={inputCls}
                  />
                </Field>
                <Field label="Link do botão">
                  <input
                    value={form.dmButtonUrl}
                    onChange={(e) =>
                      setForm({ ...form, dmButtonUrl: e.target.value })
                    }
                    placeholder="https://..."
                    className={inputCls}
                  />
                </Field>
              </div>
            </div>

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

/** Multi-seleção de posts: miniaturas escolhidas (com "x" pra remover) + botão
 *  "+" que abre uma grade DENTRO do card (rola, não vaza). Vazio = qualquer post. */
function PostMultiPicker({
  posts,
  loading,
  value,
  onChange,
}: {
  posts: CommentPost[];
  loading: boolean;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const [picking, setPicking] = useState(false);
  const selected = value
    .map((id) => posts.find((p) => p.id === id))
    .filter((p): p is CommentPost => !!p);
  const toggle = (id: string) =>
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {value.length === 0 ? (
          <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
            Qualquer post
          </span>
        ) : (
          selected.map((p) => (
            <span key={p.id} className="relative">
              {p.thumbnail_url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={p.thumbnail_url}
                  alt=""
                  className="size-12 rounded-lg border border-primary object-cover"
                />
              ) : (
                <span className="flex size-12 items-center justify-center rounded-lg border border-border bg-muted text-[9px] text-muted-foreground">
                  post
                </span>
              )}
              <button
                type="button"
                onClick={() => toggle(p.id)}
                aria-label="Remover post"
                className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-destructive text-white"
              >
                <X className="size-2.5" />
              </button>
            </span>
          ))
        )}
        <button
          type="button"
          onClick={() => setPicking((v) => !v)}
          aria-label="Adicionar posts"
          className="flex size-12 items-center justify-center rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-primary/50 hover:text-primary"
        >
          <Plus className="size-5" />
        </button>
      </div>

      <p className="text-[11px] text-muted-foreground">
        {value.length === 0
          ? 'Vale pra comentários em qualquer post. Adicione posts (+) pra restringir.'
          : `Dispara nos comentários de ${value.length} post(s).`}
      </p>

      {picking && (
        <div className="rounded-lg border border-border bg-muted/30 p-2">
          <div className="flex items-center justify-between pb-2">
            <button
              type="button"
              onClick={() => onChange([])}
              className="text-[11px] text-primary hover:underline"
            >
              Limpar (qualquer post)
            </button>
            <button
              type="button"
              onClick={() => setPicking(false)}
              className="text-[11px] font-medium text-foreground hover:underline"
            >
              Pronto
            </button>
          </div>
          {loading && posts.length === 0 ? (
            <div className="flex h-16 items-center justify-center text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
            </div>
          ) : (
            <div className="grid max-h-48 grid-cols-4 gap-2 overflow-y-auto sm:grid-cols-5">
              {posts.map((p) => {
                const on = value.includes(p.id);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => toggle(p.id)}
                    title={p.caption ?? ''}
                    className={cn(
                      'relative aspect-square overflow-hidden rounded-lg border bg-muted',
                      on ? 'border-primary ring-2 ring-primary' : 'border-border',
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
                    {on && (
                      <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-primary text-white">
                        <Check className="size-2.5" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
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

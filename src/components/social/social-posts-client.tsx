'use client';

// ============================================================
// /social — Instagram · Publicações. Lista + compositor (post, carrossel,
// reels, story), agendamento e automação comentário→DM amarrada ao post.
// O envio é do worker (30s): a tela recarrega sozinha enquanto houver post
// agendado/publicando. Erros esperados chegam como { ok:false, error }.
// ============================================================

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { toast } from 'sonner';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  CircleDashed,
  Clapperboard,
  Clock,
  ExternalLink,
  Film,
  Image as ImageIcon,
  Images,
  Camera,
  Loader2,
  MessageCircle,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { MEDIA_MAX_BYTES, uploadAccountMedia } from '@/lib/storage/upload-media';
import {
  CAPTION_MAX,
  CAROUSEL_MAX,
  IMAGE_MAX_BYTES,
  KIND_LABEL,
  validatePost,
  type SocialAutomationDraft,
  type SocialMediaItem,
  type SocialPostKind,
  type SocialPostStatus,
} from '@/lib/social/social-shared';
import { cn } from '@/lib/utils';
import {
  cancelSocialPost,
  deleteSocialPost,
  getSocialComposerOptions,
  listSocialPosts,
  retrySocialPost,
  saveSocialPost,
  type SocialPostInput,
  type SocialPostRow,
} from '@/app/(dashboard)/social/actions';
import type { FlowLite, IgChannelLite } from '@/components/settings/instagram-comments-actions';

// ---------------------------------------------------------------- meta

const KINDS: { kind: SocialPostKind; icon: typeof ImageIcon; hint: string }[] = [
  { kind: 'image', icon: ImageIcon, hint: '1 imagem (JPEG; PNG é convertido)' },
  { kind: 'carousel', icon: Images, hint: '2 a 10 imagens ou vídeos' },
  { kind: 'reel', icon: Clapperboard, hint: '1 vídeo MP4 vertical (3s a 15 min)' },
  { kind: 'story', icon: CircleDashed, hint: '1 imagem ou vídeo — some em 24h' },
];

const STATUS_META: Record<SocialPostStatus, { label: string; className: string; icon: typeof Clock }> = {
  draft: { label: 'Rascunho', className: 'bg-muted text-muted-foreground', icon: Pencil },
  scheduled: { label: 'Agendado', className: 'bg-sky-500/15 text-sky-600 dark:text-sky-300', icon: CalendarClock },
  publishing: { label: 'Publicando…', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-300', icon: Loader2 },
  published: { label: 'Publicado', className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-300', icon: CheckCircle2 },
  failed: { label: 'Falhou', className: 'bg-red-500/15 text-red-600 dark:text-red-300', icon: AlertTriangle },
  canceled: { label: 'Cancelado', className: 'bg-muted text-muted-foreground', icon: X },
};

function fmt(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const EMPTY_AUTOMATION: SocialAutomationDraft = {
  keywords: '',
  matchAny: false,
  publicReplies: ['', '', ''],
  dmMessage: '',
  dmButtons: [{ text: '', url: '' }],
  oncePerUser: true,
  startFlowId: null,
};

interface FormState {
  id?: string;
  channelId: string;
  kind: SocialPostKind;
  caption: string;
  media: SocialMediaItem[];
  shareToFeed: boolean;
  when: 'now' | 'at';
  at: string;
  automationOn: boolean;
  automation: SocialAutomationDraft;
}

function blankForm(channelId: string): FormState {
  return {
    channelId,
    kind: 'image',
    caption: '',
    media: [],
    shareToFeed: true,
    when: 'now',
    at: toLocalInput(new Date(Date.now() + 60 * 60_000)),
    automationOn: false,
    automation: { ...EMPTY_AUTOMATION, publicReplies: ['', '', ''], dmButtons: [{ text: '', url: '' }] },
  };
}

function formFromRow(p: SocialPostRow): FormState {
  const a = p.automation;
  return {
    id: p.id,
    channelId: p.channelId,
    kind: p.kind,
    caption: p.caption,
    media: p.media,
    shareToFeed: p.shareToFeed,
    when: p.scheduledAt && new Date(p.scheduledAt).getTime() > Date.now() + 120_000 ? 'at' : 'now',
    at: toLocalInput(p.scheduledAt ? new Date(p.scheduledAt) : new Date(Date.now() + 60 * 60_000)),
    automationOn: !!a,
    automation: a
      ? {
          ...a,
          publicReplies: [...a.publicReplies, '', '', ''].slice(0, 3),
          dmButtons: a.dmButtons.length ? a.dmButtons : [{ text: '', url: '' }],
        }
      : { ...EMPTY_AUTOMATION, publicReplies: ['', '', ''], dmButtons: [{ text: '', url: '' }] },
  };
}

/** Instagram só aceita JPEG por URL: PNG/WebP viram JPEG no navegador. */
async function ensureJpeg(file: File): Promise<File> {
  if (file.type === 'image/jpeg') return file;
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Não deu pra converter a imagem.');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Não deu pra converter a imagem.'))), 'image/jpeg', 0.92),
  );
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' });
}

// ---------------------------------------------------------------- página

export function SocialPostsClient() {
  const [posts, setPosts] = useState<SocialPostRow[] | null>(null);
  const [options, setOptions] = useState<{ channels: IgChannelLite[]; flows: FlowLite[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [p, o] = await Promise.all([listSocialPosts(), getSocialComposerOptions()]);
      setPosts(p);
      setOptions(o);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não foi possível carregar as publicações.');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const inFlight = useMemo(
    () => (posts ?? []).some((p) => p.status === 'scheduled' || p.status === 'publishing'),
    [posts],
  );
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [inFlight, load]);

  const channels = options?.channels ?? [];

  const act = async (id: string, fn: () => Promise<{ ok: boolean; error?: string }>, okMsg: string) => {
    setBusyId(id);
    try {
      const r = await fn();
      if (!r.ok) toast.error(r.error ?? 'Não deu certo.');
      else toast.success(okMsg);
      await load();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não deu certo.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold text-foreground">
            <Camera className="h-6 w-6 text-pink-500" />
            Instagram
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Publique post, carrossel, reels e story direto do CRM, agende e deixe a DM automática pronta pra quem comentar.
          </p>
        </div>
        <Button onClick={() => setForm(blankForm(channels[0]?.id ?? ''))} disabled={!channels.length}>
          <Plus className="mr-1.5 h-4 w-4" />
          Nova publicação
        </Button>
      </header>

      {error ? (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-300">
          {error}{' '}
          <button className="underline" onClick={() => void load()}>
            tentar de novo
          </button>
        </div>
      ) : null}

      {options && channels.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center">
          <Camera className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <p className="font-medium text-foreground">Nenhum canal do Instagram conectado</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Conecte a conta profissional do Instagram em Configurações → Canais pra publicar por aqui.
          </p>
          <Link
            href="/settings?tab=channels"
            className="mt-4 inline-flex h-9 items-center rounded-md border border-border bg-background px-4 text-sm font-medium text-foreground hover:bg-muted"
          >
            Ir para Canais
          </Link>
        </div>
      ) : null}

      {posts === null && !error ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
        </div>
      ) : null}

      {posts && posts.length === 0 && channels.length > 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Nenhuma publicação ainda. Clique em <strong>Nova publicação</strong> pra começar.
        </div>
      ) : null}

      {posts && posts.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {posts.map((p) => (
            <PostCard
              key={p.id}
              post={p}
              busy={busyId === p.id}
              onEdit={() => setForm(formFromRow(p))}
              onCancel={() => act(p.id, () => cancelSocialPost(p.id), 'Agendamento cancelado — voltou pra rascunho.')}
              onRetry={() => act(p.id, () => retrySocialPost(p.id), 'Tentando publicar de novo.')}
              onDelete={() => {
                if (!confirm('Excluir esta publicação do CRM? (não apaga do Instagram)')) return;
                void act(p.id, () => deleteSocialPost(p.id), 'Publicação excluída.');
              }}
            />
          ))}
        </div>
      ) : null}

      {form && options ? (
        <Composer
          form={form}
          setForm={setForm}
          channels={channels}
          flows={options.flows}
          onClose={() => setForm(null)}
          onSaved={async () => {
            setForm(null);
            await load();
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- card

function PostCard({
  post,
  busy,
  onEdit,
  onCancel,
  onRetry,
  onDelete,
}: {
  post: SocialPostRow;
  busy: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onDelete: () => void;
}) {
  const st = STATUS_META[post.status] ?? STATUS_META.draft;
  const StatusIcon = st.icon;
  const first = post.media[0];
  const editable = post.status === 'draft' || post.status === 'scheduled' || post.status === 'failed';
  const kw = post.automation?.keywords?.trim();

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card">
      <div className="relative aspect-square bg-muted">
        {first ? (
          first.type === 'video' ? (
            <video src={first.url} className="h-full w-full object-cover" muted preload="metadata" playsInline />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={first.url} alt="" className="h-full w-full object-cover" />
          )
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <ImageIcon className="h-8 w-8" />
          </div>
        )}
        <div className="absolute left-2 top-2 flex gap-1.5">
          <Badge className="bg-black/60 text-white hover:bg-black/60">{KIND_LABEL[post.kind]}</Badge>
          {post.kind === 'carousel' ? (
            <Badge className="bg-black/60 text-white hover:bg-black/60">{post.media.length} itens</Badge>
          ) : null}
          {first?.type === 'video' ? (
            <Badge className="bg-black/60 text-white hover:bg-black/60">
              <Film className="mr-1 h-3 w-3" /> vídeo
            </Badge>
          ) : null}
        </div>
        <div className="absolute right-2 top-2">
          <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', st.className)}>
            <StatusIcon className={cn('h-3 w-3', post.status === 'publishing' && 'animate-spin')} />
            {st.label}
          </span>
        </div>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <div className="text-xs text-muted-foreground">{post.channelName}</div>
        {post.caption ? (
          <p className="line-clamp-3 whitespace-pre-line text-sm text-foreground">{post.caption}</p>
        ) : (
          <p className="text-sm italic text-muted-foreground">Sem legenda</p>
        )}
        <div className="text-xs text-muted-foreground">
          {post.status === 'scheduled' && post.scheduledAt ? `Agendado para ${fmt(post.scheduledAt)}` : null}
          {post.status === 'published' && post.publishedAt ? `Publicado em ${fmt(post.publishedAt)}` : null}
          {post.status === 'publishing' ? 'O Instagram está processando a mídia…' : null}
          {post.status === 'draft' ? `Rascunho · ${fmt(post.updatedAt)}` : null}
          {post.status === 'failed' ? `Falhou · ${fmt(post.updatedAt)}` : null}
        </div>
        {post.automation ? (
          <div className="inline-flex w-fit items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 text-xs text-primary">
            <MessageCircle className="h-3 w-3" />
            DM automática{kw ? ` · "${kw.split(',')[0].trim()}"` : ' · qualquer comentário'}
            {post.automationId ? ' · ativa' : ''}
          </div>
        ) : null}
        {post.error ? (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 p-2 text-xs text-red-600 dark:text-red-300">
            {post.error}
          </div>
        ) : null}
        <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
          {post.permalink ? (
            <Button size="sm" variant="outline" onClick={() => window.open(post.permalink!, '_blank', 'noopener')}>
              <ExternalLink className="mr-1 h-3.5 w-3.5" /> Ver no Instagram
            </Button>
          ) : null}
          {editable ? (
            <Button size="sm" variant="outline" onClick={onEdit} disabled={busy}>
              <Pencil className="mr-1 h-3.5 w-3.5" /> Editar
            </Button>
          ) : null}
          {post.status === 'scheduled' ? (
            <Button size="sm" variant="ghost" onClick={onCancel} disabled={busy}>
              Cancelar agendamento
            </Button>
          ) : null}
          {post.status === 'failed' ? (
            <Button size="sm" variant="outline" onClick={onRetry} disabled={busy}>
              <RefreshCw className="mr-1 h-3.5 w-3.5" /> Tentar de novo
            </Button>
          ) : null}
          {post.status !== 'publishing' ? (
            <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground" onClick={onDelete} disabled={busy}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- compositor

function Composer({
  form,
  setForm,
  channels,
  flows,
  onClose,
  onSaved,
}: {
  form: FormState;
  setForm: (f: FormState | null) => void;
  channels: IgChannelLite[];
  flows: FlowLite[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const patch = (p: Partial<FormState>) => setForm({ ...form, ...p });
  const patchAuto = (p: Partial<SocialAutomationDraft>) => setForm({ ...form, automation: { ...form.automation, ...p } });

  const maxItems = form.kind === 'carousel' ? CAROUSEL_MAX : 1;
  const accept =
    form.kind === 'reel'
      ? 'video/mp4,video/quicktime'
      : form.kind === 'image'
        ? 'image/jpeg,image/png,image/webp'
        : 'image/jpeg,image/png,image/webp,video/mp4,video/quicktime';
  const contentError = validatePost(form.kind, form.media, form.kind === 'story' ? '' : form.caption);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    const room = maxItems - form.media.length;
    if (room <= 0) {
      toast.error(form.kind === 'carousel' ? `Carrossel aceita até ${CAROUSEL_MAX} itens.` : 'Este tipo aceita só 1 mídia. Remova a atual pra trocar.');
      return;
    }
    const list = Array.from(files).slice(0, room);
    setUploading(list.length);
    const added: SocialMediaItem[] = [];
    for (const raw of list) {
      try {
        const isVideo = raw.type.startsWith('video/');
        if (isVideo && !['video/mp4', 'video/quicktime'].includes(raw.type)) throw new Error(`${raw.name}: vídeo precisa ser MP4 (ou MOV).`);
        if (!isVideo && !raw.type.startsWith('image/')) throw new Error(`${raw.name}: arquivo não é imagem nem vídeo.`);
        if (isVideo && raw.size > MEDIA_MAX_BYTES) throw new Error(`${raw.name}: vídeo acima de ${Math.round(MEDIA_MAX_BYTES / 1024 / 1024)} MB.`);
        const file = isVideo ? raw : await ensureJpeg(raw);
        if (!isVideo && file.size > IMAGE_MAX_BYTES) throw new Error(`${raw.name}: imagem acima de 8 MB mesmo depois de converter.`);
        const up = await uploadAccountMedia('media', file);
        added.push({ url: up.publicUrl, type: isVideo ? 'video' : 'image', name: file.name });
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Falha no upload.');
      } finally {
        setUploading((n) => Math.max(0, n - 1));
      }
    }
    if (added.length) setForm({ ...form, media: [...form.media, ...added] });
    if (fileRef.current) fileRef.current.value = '';
  };

  const submit = async (mode: 'draft' | 'publish') => {
    if (submitting || uploading > 0) return;
    if (!form.channelId) {
      toast.error('Escolha o canal do Instagram.');
      return;
    }
    if (mode === 'publish' && contentError) {
      toast.error(contentError);
      return;
    }
    if (mode === 'publish' && form.automationOn && !form.automation.dmMessage.trim()) {
      toast.error('Escreva a mensagem da DM automática (ou desligue a automação).');
      return;
    }
    const input: SocialPostInput = {
      id: form.id,
      channelId: form.channelId,
      kind: form.kind,
      caption: form.caption,
      media: form.media,
      shareToFeed: form.shareToFeed,
      automation: form.automationOn && form.kind !== 'story' ? form.automation : null,
    };
    const when =
      mode === 'draft'
        ? ({ when: 'draft' } as const)
        : form.when === 'now'
          ? ({ when: 'now' } as const)
          : ({ when: 'at', at: new Date(form.at).toISOString() } as const);
    setSubmitting(true);
    try {
      const r = await saveSocialPost(input, when);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      toast.success(
        mode === 'draft'
          ? 'Rascunho salvo.'
          : form.when === 'now'
            ? 'Enviando pro Instagram — em instantes aparece como Publicado.'
            : `Agendado para ${fmt(new Date(form.at).toISOString())}.`,
      );
      await onSaved();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Não foi possível salvar.');
    } finally {
      setSubmitting(false);
    }
  };

  const kindMeta = KINDS.find((k) => k.kind === form.kind)!;

  return (
    <Dialog open onOpenChange={(o) => (!o ? onClose() : null)}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{form.id ? 'Editar publicação' : 'Nova publicação'}</DialogTitle>
          <DialogDescription>Escolha o tipo, suba a mídia, escreva a legenda e decida quando publicar.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          {channels.length > 1 ? (
            <div className="flex flex-col gap-1.5">
              <Label>Canal</Label>
              <Select value={form.channelId} onValueChange={(v) => patch({ channelId: String(v ?? '') })}>
                <SelectTrigger>
                  <SelectValue placeholder="Escolha o Instagram" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              Canal: <span className="font-medium text-foreground">{channels[0]?.name ?? '—'}</span>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label>Tipo</Label>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {KINDS.map(({ kind, icon: Icon }) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => patch({ kind, media: [], automationOn: kind === 'story' ? false : form.automationOn })}
                  disabled={!!form.id && form.media.length > 0 && kind !== form.kind}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-lg border p-3 text-sm transition-colors',
                    form.kind === kind
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-muted/40 text-muted-foreground hover:bg-muted',
                    'disabled:opacity-50',
                  )}
                >
                  <Icon className="h-5 w-5" />
                  {KIND_LABEL[kind]}
                </button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">{kindMeta.hint}</p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Mídia</Label>
            <input
              ref={fileRef}
              type="file"
              accept={accept}
              multiple={form.kind === 'carousel'}
              className="hidden"
              onChange={(e) => void handleFiles(e.target.files)}
            />
            <div className="flex flex-wrap gap-2">
              {form.media.map((m, i) => (
                <div key={m.url + i} className="relative h-24 w-24 overflow-hidden rounded-md border border-border bg-muted">
                  {m.type === 'video' ? (
                    <video src={m.url} className="h-full w-full object-cover" muted preload="metadata" playsInline />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={m.url} alt="" className="h-full w-full object-cover" />
                  )}
                  <button
                    type="button"
                    aria-label="Remover"
                    onClick={() => patch({ media: form.media.filter((_, j) => j !== i) })}
                    className="absolute right-1 top-1 rounded-full bg-black/70 p-0.5 text-white"
                  >
                    <X className="h-3 w-3" />
                  </button>
                  {form.kind === 'carousel' ? (
                    <span className="absolute bottom-1 left-1 rounded bg-black/70 px-1 text-[10px] text-white">{i + 1}</span>
                  ) : null}
                </div>
              ))}
              {form.media.length < maxItems ? (
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading > 0}
                  className="flex h-24 w-24 flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-xs text-muted-foreground hover:bg-muted"
                >
                  {uploading > 0 ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" />}
                  {uploading > 0 ? `Enviando ${uploading}…` : 'Adicionar'}
                </button>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              Imagem até 8 MB (JPEG/PNG). Vídeo MP4 até {Math.round(MEDIA_MAX_BYTES / 1024 / 1024)} MB. Feed: proporção entre 4:5 e 1.91:1; Reels e Story: 9:16.
            </p>
          </div>

          {form.kind !== 'story' ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <Label htmlFor="caption">Legenda</Label>
                <span className={cn('text-xs', form.caption.length > CAPTION_MAX ? 'text-red-500' : 'text-muted-foreground')}>
                  {form.caption.length}/{CAPTION_MAX}
                </span>
              </div>
              <Textarea
                id="caption"
                rows={5}
                value={form.caption}
                onChange={(e) => patch({ caption: e.target.value })}
                placeholder="Escreva a legenda, com hashtags se quiser…"
              />
            </div>
          ) : null}

          {form.kind === 'reel' ? (
            <label className="flex items-center justify-between rounded-lg border border-border p-3 text-sm">
              <span>
                Mostrar também no feed
                <span className="block text-xs text-muted-foreground">Desligado = só na aba Reels.</span>
              </span>
              <Switch checked={form.shareToFeed} onCheckedChange={(v) => patch({ shareToFeed: !!v })} />
            </label>
          ) : null}

          <div className="flex flex-col gap-2">
            <Label>Quando</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant={form.when === 'now' ? 'default' : 'outline'} onClick={() => patch({ when: 'now' })}>
                Publicar agora
              </Button>
              <Button type="button" size="sm" variant={form.when === 'at' ? 'default' : 'outline'} onClick={() => patch({ when: 'at' })}>
                <CalendarClock className="mr-1 h-3.5 w-3.5" /> Agendar
              </Button>
              {form.when === 'at' ? (
                <Input
                  type="datetime-local"
                  value={form.at}
                  min={toLocalInput(new Date())}
                  onChange={(e) => patch({ at: e.target.value })}
                  className="w-auto"
                />
              ) : null}
            </div>
          </div>

          {form.kind !== 'story' ? (
            <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
              <label className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <MessageCircle className="h-4 w-4 text-primary" />
                  DM automática pra quem comentar
                  <span className="hidden text-xs font-normal text-muted-foreground sm:inline">
                    (criada assim que o post for publicado)
                  </span>
                </span>
                <Switch checked={form.automationOn} onCheckedChange={(v) => patch({ automationOn: !!v })} />
              </label>

              {form.automationOn ? (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="kw">Palavras-chave no comentário</Label>
                    <Input
                      id="kw"
                      value={form.automation.keywords}
                      onChange={(e) => patchAuto({ keywords: e.target.value })}
                      placeholder="eu quero, quero, link"
                      disabled={form.automation.matchAny}
                    />
                    <label className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Switch checked={form.automation.matchAny} onCheckedChange={(v) => patchAuto({ matchAny: !!v })} />
                      Responder qualquer comentário
                    </label>
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Resposta pública no comentário (até 3, alternadas)</Label>
                    {form.automation.publicReplies.map((r, i) => (
                      <Input
                        key={i}
                        value={r}
                        onChange={(e) => {
                          const next = [...form.automation.publicReplies];
                          next[i] = e.target.value;
                          patchAuto({ publicReplies: next });
                        }}
                        placeholder={i === 0 ? 'Te mandei no direct 😉' : 'Outra variação (opcional)'}
                      />
                    ))}
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label htmlFor="dm">Mensagem da DM</Label>
                    <Textarea
                      id="dm"
                      rows={3}
                      value={form.automation.dmMessage}
                      onChange={(e) => patchAuto({ dmMessage: e.target.value })}
                      placeholder="Oi! Vi seu comentário 😊 Aqui está o link…"
                    />
                  </div>
                  <div className="flex flex-col gap-1.5">
                    <Label>Botões da DM (até 3)</Label>
                    {form.automation.dmButtons.map((b, i) => (
                      <div key={i} className="flex gap-2">
                        <Input
                          value={b.text}
                          onChange={(e) => {
                            const next = form.automation.dmButtons.map((x, j) => (j === i ? { ...x, text: e.target.value } : x));
                            patchAuto({ dmButtons: next });
                          }}
                          placeholder="Texto do botão"
                          className="w-2/5"
                        />
                        <Input
                          value={b.url}
                          onChange={(e) => {
                            const next = form.automation.dmButtons.map((x, j) => (j === i ? { ...x, url: e.target.value } : x));
                            patchAuto({ dmButtons: next });
                          }}
                          placeholder="https://…"
                        />
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          aria-label="Remover botão"
                          onClick={() => patchAuto({ dmButtons: form.automation.dmButtons.filter((_, j) => j !== i) })}
                        >
                          <X className="h-4 w-4" />
                        </Button>
                      </div>
                    ))}
                    {form.automation.dmButtons.length < 3 ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-fit"
                        onClick={() => patchAuto({ dmButtons: [...form.automation.dmButtons, { text: '', url: '' }] })}
                      >
                        <Plus className="mr-1 h-3.5 w-3.5" /> Botão
                      </Button>
                    ) : null}
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="flex items-center justify-between rounded-md border border-border p-2 text-sm">
                      <span>1 DM por pessoa</span>
                      <Switch checked={form.automation.oncePerUser} onCheckedChange={(v) => patchAuto({ oncePerUser: !!v })} />
                    </label>
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs">Iniciar um Fluxo depois da DM</Label>
                      <Select
                        value={form.automation.startFlowId ?? 'none'}
                        onValueChange={(v) => patchAuto({ startFlowId: !v || v === 'none' ? null : String(v) })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Nenhum" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">Nenhum</SelectItem>
                          {flows.map((f) => (
                            <SelectItem key={f.id} value={f.id}>
                              {f.name}
                              {!f.entry_is_buttons ? ' (entrada sem botões)' : ''}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}

          {contentError && form.media.length > 0 ? <p className="text-xs text-amber-600 dark:text-amber-300">{contentError}</p> : null}

          <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-4">
            <Button type="button" variant="ghost" onClick={onClose} disabled={submitting}>
              Fechar
            </Button>
            <Button type="button" variant="outline" onClick={() => void submit('draft')} disabled={submitting || uploading > 0}>
              Salvar rascunho
            </Button>
            <Button type="button" onClick={() => void submit('publish')} disabled={submitting || uploading > 0 || !!contentError}>
              {submitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              {form.when === 'now' ? 'Publicar agora' : 'Agendar'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

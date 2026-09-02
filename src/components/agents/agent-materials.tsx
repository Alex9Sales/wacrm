'use client';
// ============================================================
// 📎 Materiais do agente — arquivos/imagens/vídeos que a IA pode ENVIAR na
// conversa. O dono sobe o arquivo, dá um nome curto e diz QUANDO enviar; a
// IA escreve [[ENVIAR:nome]] e o motor manda a mídia depois do texto.
// Caso de origem (01/09): Circular de Oferta de Franquia da Limpeza com Zelo.
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Plus,
  Trash2,
  Video,
} from 'lucide-react';

import {
  deleteAgentMaterial,
  listAgentMaterials,
  saveAgentMaterial,
  type AgentMaterialRow,
} from '@/app/(dashboard)/agents/materials-actions';
import type { MaterialKind } from '@/lib/ai/materials-shared';
import {
  MEDIA_MAX_BYTES_BY_KIND,
  uploadAccountMedia,
} from '@/lib/storage/upload-media';
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
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';

const MATERIALS_BUCKET = 'flow-media';

const ACCEPT =
  'image/jpeg,image/png,image/webp,video/mp4,video/3gpp,application/pdf,' +
  'application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,' +
  'application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,' +
  'application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation,' +
  'text/plain';

function kindOf(file: File): MaterialKind {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return 'document';
}

function fmtBytes(n: number | null): string {
  if (!n) return '';
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const KIND_ICON: Record<MaterialKind, typeof FileText> = {
  image: ImageIcon,
  video: Video,
  document: FileText,
};
const KIND_LABEL: Record<MaterialKind, string> = {
  image: 'Imagem',
  video: 'Vídeo',
  document: 'Documento',
};

export function AgentMaterials({
  agentId,
  disabled = false,
}: {
  /** null = tela do agente padrão (materiais "todos os agentes"). */
  agentId: string | null;
  disabled?: boolean;
}) {
  const [rows, setRows] = useState<AgentMaterialRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [onlyThisAgent, setOnlyThisAgent] = useState(!!agentId);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listAgentMaterials(agentId));
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const reset = () => {
    setFile(null);
    setName('');
    setDescription('');
    setOnlyThisAgent(!!agentId);
    if (fileRef.current) fileRef.current.value = '';
  };

  const pick = (f: File | null) => {
    setFile(f);
    if (f && !name.trim()) {
      setName(f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').slice(0, 80));
    }
  };

  const submit = async () => {
    if (!file) {
      toast.error('Escolha o arquivo.');
      return;
    }
    const kind = kindOf(file);
    const cap = MEDIA_MAX_BYTES_BY_KIND[kind];
    if (file.size > cap) {
      toast.error(
        `${KIND_LABEL[kind]} até ${Math.round(cap / 1024 / 1024)} MB no WhatsApp. Esse tem ${fmtBytes(file.size)}.`,
      );
      return;
    }
    if (!name.trim()) {
      toast.error('Dê um nome curto — é o que a IA vai escrever.');
      return;
    }
    setSaving(true);
    try {
      setUploading(true);
      const { publicUrl } = await uploadAccountMedia(MATERIALS_BUCKET, file);
      setUploading(false);
      const res = await saveAgentMaterial({
        agentId: onlyThisAgent ? agentId : null,
        name: name.trim(),
        description: description.trim() || null,
        mediaType: kind,
        mediaUrl: publicUrl,
        filename: file.name,
        mimetype: file.type || null,
        sizeBytes: file.size,
      });
      if (res.error) {
        toast.error(res.error);
        return;
      }
      toast.success(`"${name.trim()}" pronto — a IA já pode enviar com [[ENVIAR:${name.trim()}]].`);
      setOpen(false);
      reset();
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha no upload.');
    } finally {
      setUploading(false);
      setSaving(false);
    }
  };

  const remove = async (row: AgentMaterialRow) => {
    if (!window.confirm(`Remover "${row.name}"? A IA deixa de poder enviar este arquivo.`)) return;
    const res = await deleteAgentMaterial(row.id);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success('Material removido.');
    await load();
  };

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Paperclip className="h-4 w-4 text-primary" />
            Materiais que a IA pode enviar
          </p>
          <p className="mb-2 text-xs text-muted-foreground">
            Documentos, imagens e vídeos (catálogo, contrato, circular, apresentação).
            Diga <strong>quando</strong> enviar e a IA manda na conversa, depois do texto.
            No prompt você também pode mandar direto: &quot;quando o lead pedir a circular,
            envie <code className="rounded bg-muted px-1">[[ENVIAR:Circular de Oferta]]</code>&quot;.
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => setOpen(true)}
          disabled={disabled}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Adicionar material
        </Button>
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Carregando…
        </p>
      ) : rows.length === 0 ? (
        <p className="rounded-md border border-dashed border-border px-3 py-3 text-xs text-muted-foreground">
          Nenhum material ainda. Suba o primeiro arquivo e a ferramenta &quot;Enviar material&quot;
          liga sozinha neste agente.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((r) => {
            const Icon = KIND_ICON[r.mediaType];
            return (
              <li
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-md border border-border/60 px-2.5 py-2"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-xs font-medium text-foreground">
                      {r.name}
                      <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                        {KIND_LABEL[r.mediaType]}
                        {r.sizeBytes ? ` · ${fmtBytes(r.sizeBytes)}` : ''}
                      </span>
                      {r.agentId ? (
                        <span className="ml-1 rounded bg-primary/10 px-1 py-0.5 text-[9px] text-primary">
                          só este agente
                        </span>
                      ) : (
                        <span className="ml-1 rounded bg-muted px-1 py-0.5 text-[9px] text-muted-foreground">
                          todos os agentes
                        </span>
                      )}
                    </p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {r.description || r.filename || '—'}
                      {' · '}
                      <span className="font-mono">[[ENVIAR:{r.name}]]</span>
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <a
                    href={r.mediaUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] text-primary hover:underline"
                  >
                    abrir
                  </a>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7 text-muted-foreground hover:text-destructive"
                    onClick={() => void remove(r)}
                    disabled={disabled}
                    aria-label={`Remover ${r.name}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={open}
        onOpenChange={(v) => {
          if (saving) return;
          setOpen(v);
          if (!v) reset();
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Novo material</DialogTitle>
            <DialogDescription>
              Imagem até 5 MB, vídeo e documento até 16 MB (limite do WhatsApp). PDF, Word,
              Excel, PowerPoint, JPG, PNG, MP4.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="mat-file">Arquivo</Label>
              <Input
                id="mat-file"
                ref={fileRef}
                type="file"
                accept={ACCEPT}
                onChange={(e) => pick(e.target.files?.[0] ?? null)}
                disabled={saving}
              />
              {file && (
                <p className="text-[11px] text-muted-foreground">
                  {KIND_LABEL[kindOf(file)]} · {fmtBytes(file.size)}
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mat-name">Nome curto (é o que a IA escreve)</Label>
              <Input
                id="mat-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ex.: Circular de Oferta"
                maxLength={80}
                disabled={saving}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="mat-desc">Quando enviar (instrução pra IA)</Label>
              <Textarea
                id="mat-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="ex.: quando o interessado quiser avançar na franquia. Obrigatória por lei, no mínimo 10 dias antes da venda."
                rows={3}
                maxLength={400}
                disabled={saving}
              />
            </div>
            {agentId && (
              <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2">
                <Label className="text-xs text-foreground">Só este agente pode enviar</Label>
                <Switch checked={onlyThisAgent} onCheckedChange={setOnlyThisAgent} disabled={saving} />
              </div>
            )}
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
                Cancelar
              </Button>
              <Button type="button" onClick={() => void submit()} disabled={saving || !file}>
                {saving ? (
                  <>
                    <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
                    {uploading ? 'Enviando arquivo…' : 'Salvando…'}
                  </>
                ) : (
                  'Salvar material'
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

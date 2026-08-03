'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  Loader2,
  Plus,
  Trash2,
  Pencil,
  RefreshCw,
  BookOpen,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';

interface DocSummary {
  id: string;
  title: string;
  updated_at: string;
}

/** Editor target: 'new' when creating, a doc id when editing, null when closed. */
type EditTarget = 'new' | string | null;

export function AiKnowledgeCard({
  accountId,
  canEdit,
  hasEmbeddingsKey,
}: {
  accountId: string | null;
  canEdit: boolean;
  hasEmbeddingsKey: boolean;
}) {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  const loadedAccountIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/knowledge');
      const data = await res.json();
      if (res.ok) setDocs(data.documents ?? []);
      else toast.error(data.error ?? 'Falha ao carregar a base de conhecimento');
    } catch {
      toast.error('Falha ao carregar a base de conhecimento');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accountId || loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    void fetchDocs();
  }, [accountId, fetchDocs]);

  const openNew = () => {
    setEditing('new');
    setTitle('');
    setContent('');
  };

  const openEdit = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`);
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Falha ao abrir o documento');
        return;
      }
      setEditing(id);
      setTitle(data.title ?? '');
      setContent(data.content ?? '');
    } catch {
      toast.error('Falha ao abrir o documento');
    }
  };

  const cancelEdit = () => {
    setEditing(null);
    setTitle('');
    setContent('');
  };

  const importFile = async (file: File) => {
    setImporting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/ai/knowledge/extract', {
        method: 'POST',
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'Falha ao importar o arquivo.');
        return;
      }
      setContent(data.content ?? '');
      setTitle((t) => (t.trim() ? t : (data.title ?? '')));
      toast.success(
        `Texto importado (${data.chars} caracteres).` +
          (data.truncated ? ' Cortado no limite de tamanho.' : '') +
          ' Revise e salve.',
      );
    } catch {
      toast.error('Falha ao importar o arquivo.');
    } finally {
      setImporting(false);
    }
  };

  const save = async () => {
    if (!title.trim() || !content.trim()) {
      toast.error('Título e conteúdo são obrigatórios.');
      return;
    }
    setSaving(true);
    try {
      const isNew = editing === 'new';
      const res = await fetch(
        isNew ? '/api/ai/knowledge' : `/api/ai/knowledge/${editing}`,
        {
          method: isNew ? 'POST' : 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: title.trim(), content: content.trim() }),
        },
      );
      const data = await res.json();
      if (res.ok) {
        // A 200 with `warning` means saved but indexing degraded.
        if (data.warning) toast.warning(data.warning);
        else toast.success(isNew ? 'Documento adicionado.' : 'Documento atualizado.');
        cancelEdit();
        await fetchDocs();
      } else {
        toast.error(data.error ?? 'Falha ao salvar.');
      }
    } catch {
      toast.error('Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await fetch(`/api/ai/knowledge/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success('Documento removido.');
        setDocs((d) => d.filter((x) => x.id !== id));
      } else {
        const data = await res.json();
        toast.error(data.error ?? 'Falha ao remover.');
      }
    } catch {
      toast.error('Falha ao remover.');
    }
  };

  const reindex = async () => {
    setReindexing(true);
    try {
      const res = await fetch('/api/ai/knowledge/reindex', { method: 'POST' });
      const data = await res.json();
      if (res.ok && data.success) {
        toast.success(`${data.reindexed} documento(s) reindexado(s).`);
      } else {
        toast.error(data.error ?? 'Falha ao reindexar.');
      }
    } catch {
      toast.error('Falha ao reindexar.');
    } finally {
      setReindexing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BookOpen className="h-4 w-4 text-primary" /> Base de conhecimento
        </CardTitle>
        <CardDescription>
          Adicione FAQs, políticas ou detalhes de produtos. O assistente busca
          os trechos relevantes ao redigir e responder automaticamente, para
          que possa responder em vez de transferir.
          {hasEmbeddingsKey
            ? ' A busca semântica está ativada (chave de embeddings configurada).'
            : ' Usando busca por palavra-chave — adicione uma chave de embeddings acima para busca semântica.'}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando…
          </div>
        ) : (
          <>
            {docs.length === 0 && editing === null && (
              <p className="text-sm text-muted-foreground">
                Nenhum documento ainda.
              </p>
            )}

            {docs.length > 0 && (
              <ul className="divide-y divide-border rounded-md border border-border">
                {docs.map((doc) => (
                  <li
                    key={doc.id}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    <span className="min-w-0 truncate text-sm text-foreground">
                      {doc.title}
                    </span>
                    {canEdit && (
                      <span className="flex shrink-0 gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0"
                          onClick={() => void openEdit(doc.id)}
                          title="Editar"
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                          onClick={() => void remove(doc.id)}
                          title="Excluir"
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}

            {editing !== null ? (
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="space-y-2">
                  <Label htmlFor="kb-title">Título</Label>
                  <Input
                    id="kb-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="ex.: Política de trocas e reembolsos"
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="kb-content">Conteúdo</Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={saving || importing}
                      title="Importar de um arquivo PDF, Word (.docx) ou texto"
                    >
                      {importing ? (
                        <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Upload className="mr-2 h-3.5 w-3.5" />
                      )}
                      Importar arquivo
                    </Button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".pdf,.docx,.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) void importFile(f);
                        e.target.value = '';
                      }}
                    />
                  </div>
                  <Textarea
                    id="kb-content"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder="Cole o texto, ou use “Importar arquivo” (PDF, Word ou texto)…"
                    rows={8}
                    disabled={saving || importing}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={cancelEdit} disabled={saving}>
                    Cancelar
                  </Button>
                  <Button onClick={save} disabled={saving}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Salvar documento
                  </Button>
                </div>
              </div>
            ) : (
              canEdit && (
                <div className="flex items-center justify-between">
                  <Button variant="outline" size="sm" onClick={openNew}>
                    <Plus className="mr-2 h-4 w-4" /> Adicionar documento
                  </Button>
                  {hasEmbeddingsKey && docs.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={reindex}
                      disabled={reindexing}
                      title="Reprocessar embeddings de todos os documentos (ex.: após adicionar uma chave de embeddings)"
                    >
                      {reindexing ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                      )}
                      Reindexar
                    </Button>
                  )}
                </div>
              )
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

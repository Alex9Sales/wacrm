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
  HelpCircle,
  Link2,
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
  sourceType?: string;
  updated_at: string;
}

/** Editor target: 'new' when creating, a doc id when editing, null when closed. */
type EditTarget = 'new' | string | null;

export function AiKnowledgeCard({
  accountId,
  canEdit,
  hasEmbeddingsKey,
  baseId = null,
}: {
  accountId: string | null;
  canEdit: boolean;
  hasEmbeddingsKey: boolean;
  /** Base selecionada (Fase K). Escopo dos documentos listados/criados. */
  baseId?: string | null;
}) {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<EditTarget>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importingUrl, setImportingUrl] = useState(false);
  const [reindexing, setReindexing] = useState(false);
  // 'text' = documento normal; 'qa' = pergunta & resposta (K2).
  const [mode, setMode] = useState<'text' | 'qa'>('text');
  const loadedAccountIdRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchDocs = useCallback(async () => {
    setLoading(true);
    try {
      const url = baseId
        ? `/api/ai/knowledge?baseId=${encodeURIComponent(baseId)}`
        : '/api/ai/knowledge';
      const res = await fetch(url);
      const data = await res.json();
      if (res.ok) setDocs(data.documents ?? []);
      else toast.error(data.error ?? 'Falha ao carregar a base de conhecimento');
    } catch {
      toast.error('Falha ao carregar a base de conhecimento');
    } finally {
      setLoading(false);
    }
  }, [baseId]);

  useEffect(() => {
    // Chaveado por conta + base: trocar de base recarrega os documentos.
    const key = `${accountId ?? ''}:${baseId ?? ''}`;
    if (!accountId || loadedAccountIdRef.current === key) return;
    loadedAccountIdRef.current = key;
    void fetchDocs();
  }, [accountId, baseId, fetchDocs]);

  const openNew = (m: 'text' | 'qa' = 'text') => {
    setMode(m);
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
      setMode(data.sourceType === 'qa' ? 'qa' : 'text');
      setEditing(id);
      setTitle(data.title ?? '');
      setContent(data.content ?? '');
    } catch {
      toast.error('Falha ao abrir o documento');
    }
  };

  const cancelEdit = () => {
    setEditing(null);
    setMode('text');
    setTitle('');
    setContent('');
  };

  // 📥 Importar Q&A por planilha: parseia no navegador (parseSheet) e manda
  // em lotes de 200 pra /api/ai/knowledge/import. Detecta as colunas pelo
  // cabeçalho (pergunta/question, resposta/answer); sem cabeçalho casando,
  // usa as duas primeiras colunas.
  const qaFileRef = useRef<HTMLInputElement>(null);
  const [importingQa, setImportingQa] = useState(false);
  const importQaSheet = async (file: File) => {
    setImportingQa(true);
    try {
      const { parseSheet } = await import('@/lib/import/sheet');
      const rows = await parseSheet(file);
      if (rows.length === 0) {
        toast.error('Planilha vazia.');
        return;
      }
      const headers = Object.keys(rows[0] ?? {});
      const qCol =
        headers.find((h) => /pergunta|question/i.test(h)) ?? headers[0];
      const aCol =
        headers.find((h) => /resposta|answer/i.test(h)) ??
        headers.find((h) => h !== qCol) ??
        headers[1];
      if (!qCol || !aCol) {
        toast.error('Não achei as colunas de Pergunta e Resposta.');
        return;
      }
      const items = rows
        .map((r) => ({
          question: String(r[qCol] ?? '').trim(),
          answer: String(r[aCol] ?? '').trim(),
        }))
        .filter((it) => it.question && it.answer);
      if (items.length === 0) {
        toast.error('Nenhum par pergunta/resposta válido na planilha.');
        return;
      }
      let created = 0;
      let pendingIndex = 0;
      for (let i = 0; i < items.length; i += 200) {
        const batch = items.slice(i, i + 200);
        const res = await fetch('/api/ai/knowledge/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseId, items: batch }),
        });
        const data = (await res.json().catch(() => ({}))) as {
          created?: number;
          pending_index?: number;
          error?: string;
        };
        if (!res.ok) {
          toast.error(data.error || 'Falha no import.');
          break;
        }
        created += data.created ?? 0;
        pendingIndex += data.pending_index ?? 0;
        toast.success(
          `Importadas ${created}/${items.length} perguntas…`,
        );
      }
      if (created > 0) {
        toast.success(
          pendingIndex > 0
            ? `Import concluído: ${created} Q&As. ${pendingIndex} ainda indexando — clique em Reindexar em alguns minutos.`
            : `Import concluído: ${created} Q&As na base! 🎉`,
        );
        await fetchDocs();
      }
    } catch (e) {
      console.error('QA import failed:', e);
      toast.error('Falha ao ler a planilha.');
    } finally {
      setImportingQa(false);
    }
  };

  const importUrl = async () => {
    const url = window.prompt('Cole a URL da página (site, FAQ, etc.):');
    if (!url || !url.trim()) return;
    setImportingUrl(true);
    try {
      const res = await fetch('/api/ai/knowledge/import-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), baseId }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        toast.success(
          data.warning ?? `Importado: ${data.title ?? 'página'}.`,
        );
        await fetchDocs();
      } else toast.error(data.error ?? 'Falha ao importar a URL.');
    } catch {
      toast.error('Falha ao importar a URL.');
    } finally {
      setImportingUrl(false);
    }
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
      toast.error(
        mode === 'qa'
          ? 'Pergunta e resposta são obrigatórias.'
          : 'Título e conteúdo são obrigatórios.',
      );
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
          body: JSON.stringify({
            title: title.trim(),
            content: content.trim(),
            // Cria o doc na base selecionada + tipo (Fase K/K2); PATCH ignora.
            ...(isNew && baseId ? { baseId } : {}),
            ...(isNew ? { sourceType: mode } : {}),
          }),
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
                    <span className="flex min-w-0 items-center gap-2">
                      {(doc.sourceType === 'qa' || doc.sourceType === 'url') && (
                        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                          {doc.sourceType === 'qa' ? 'Q&A' : 'URL'}
                        </span>
                      )}
                      <span className="min-w-0 truncate text-sm text-foreground">
                        {doc.title}
                      </span>
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
                  <Label htmlFor="kb-title">
                    {mode === 'qa' ? 'Pergunta' : 'Título'}
                  </Label>
                  <Input
                    id="kb-title"
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder={
                      mode === 'qa'
                        ? 'ex.: Qual é o horário de atendimento?'
                        : 'ex.: Política de trocas e reembolsos'
                    }
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label htmlFor="kb-content">
                      {mode === 'qa' ? 'Resposta' : 'Conteúdo'}
                    </Label>
                    {mode !== 'qa' && (
                      <>
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
                      </>
                    )}
                  </div>
                  <Textarea
                    id="kb-content"
                    value={content}
                    onChange={(e) => setContent(e.target.value)}
                    placeholder={
                      mode === 'qa'
                        ? 'A resposta exata que a IA deve dar a essa pergunta…'
                        : 'Cole o texto, ou use “Importar arquivo” (PDF, Word ou texto)…'
                    }
                    rows={mode === 'qa' ? 4 : 8}
                    disabled={saving || importing}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" onClick={cancelEdit} disabled={saving}>
                    Cancelar
                  </Button>
                  <Button onClick={save} disabled={saving}>
                    {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {mode === 'qa' ? 'Salvar Q&A' : 'Salvar documento'}
                  </Button>
                </div>
              </div>
            ) : (
              canEdit && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openNew('text')}
                  >
                    <Plus className="mr-2 h-4 w-4" /> Adicionar documento
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => openNew('qa')}
                  >
                    <HelpCircle className="mr-2 h-4 w-4" /> Pergunta e resposta
                  </Button>
                  {/* 📥 Import em massa de Q&A por planilha (pedido do Rafael:
                      995 linhas não dá pra digitar). Colunas: Pergunta |
                      Resposta (detectadas pelo cabeçalho; fallback = 1ª/2ª). */}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => qaFileRef.current?.click()}
                    disabled={importingQa}
                    title="Importar planilha (xlsx/csv) com colunas Pergunta e Resposta"
                  >
                    {importingQa ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Upload className="mr-2 h-4 w-4" />
                    )}
                    Importar planilha (Q&A)
                  </Button>
                  <input
                    ref={qaFileRef}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void importQaSheet(f);
                      e.target.value = '';
                    }}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={importUrl}
                    disabled={importingUrl}
                    title="Importar o texto de uma página (site, FAQ)"
                  >
                    {importingUrl ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Link2 className="mr-2 h-4 w-4" />
                    )}
                    Importar de URL
                  </Button>
                  {hasEmbeddingsKey && docs.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
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

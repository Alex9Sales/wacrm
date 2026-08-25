'use client';

// ============================================================
// 🔧 Ferramentas externas — o agente chama APIs da empresa (ERP, estoque,
// pedidos) sem n8n. "Adicionar ferramenta" em linguagem de dono de negócio;
// por baixo é HTTP + placeholders + headers cifrados. Categorias:
// 🟢 consulta · 🟡 ação reversível · 🔴 crítica (não executa sozinha).
// Testável na hora (botão Testar) e auditável (Histórico de ações).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  FlaskConical,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Wrench,
} from 'lucide-react';

import {
  deleteAgentTool,
  listAgentExternalTools,
  listAgentToolRuns,
  saveAgentTool,
  testAgentTool,
  type AgentToolRow,
  type ToolRunRow,
} from '@/app/(dashboard)/agents/tools-actions';
import type { ToolParamDef } from '@/lib/ai/external-tools';
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
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';

const RISK_META = {
  read: { label: '🟢 Consulta', hint: 'só lê dados — a IA usa livremente' },
  write: { label: '🟡 Ação', hint: 'cria/atualiza registros — a IA executa' },
  critical: {
    label: '🔴 Crítica',
    hint: 'venda/cancelamento/reembolso — a IA NÃO executa sozinha, transfere pra humano',
  },
} as const;

interface FormState {
  id: string | null;
  name: string;
  description: string;
  method: string;
  url: string;
  authHeader: string;
  authValue: string;
  params: ToolParamDef[];
  bodyTemplate: string;
  risk: 'read' | 'write' | 'critical';
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  id: null,
  name: '',
  description: '',
  method: 'GET',
  url: '',
  authHeader: 'Authorization',
  authValue: '',
  params: [],
  bodyTemplate: '',
  risk: 'read',
  enabled: true,
};

export function AgentExternalTools({ agentId }: { agentId: string }) {
  const [tools, setTools] = useState<AgentToolRow[]>([]);
  const [runs, setRuns] = useState<ToolRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [showRuns, setShowRuns] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<AgentToolRow | null>(null);
  const [testArgs, setTestArgs] = useState<Record<string, string>>({});
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testBusy, setTestBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTools(await listAgentExternalTools(agentId));
    } catch {
      toast.error('Não foi possível carregar as ferramentas.');
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    void load();
  }, [load]);

  const openEdit = (t?: AgentToolRow) => {
    if (!t) {
      setForm({ ...EMPTY_FORM });
      return;
    }
    setForm({
      id: t.id,
      name: t.name,
      description: t.description,
      method: t.method,
      url: t.url,
      authHeader: t.headerNames[0] ?? 'Authorization',
      authValue: '', // segredo nunca volta; vazio = manter o guardado
      params: t.params,
      bodyTemplate: t.bodyTemplate ?? '',
      risk: t.risk,
      enabled: t.enabled,
    });
  };

  const save = async () => {
    if (!form) return;
    setSaving(true);
    const headers =
      form.authValue.trim()
        ? { [form.authHeader.trim() || 'Authorization']: form.authValue.trim() }
        : form.id
          ? undefined // editar sem redigitar = mantém o segredo
          : {};
    const { error } = await saveAgentTool({
      id: form.id,
      agentId,
      name: form.name,
      description: form.description,
      method: form.method,
      url: form.url,
      headers,
      params: form.params,
      bodyTemplate: form.bodyTemplate || null,
      risk: form.risk,
      enabled: form.enabled,
    });
    setSaving(false);
    if (error) {
      toast.error(error);
      return;
    }
    toast.success('Ferramenta salva');
    setForm(null);
    await load();
  };

  const remove = async (t: AgentToolRow) => {
    const { error } = await deleteAgentTool(t.id);
    if (error) toast.error(error);
    else {
      toast.success('Ferramenta excluída');
      await load();
    }
  };

  const runTest = async () => {
    if (!testing) return;
    setTestBusy(true);
    setTestResult(null);
    try {
      const out = await testAgentTool(testing.id, testArgs);
      setTestResult(
        `${out.status.toUpperCase()}${out.httpStatus ? ` · HTTP ${out.httpStatus}` : ''}\n\n${out.summary}`,
      );
    } catch {
      setTestResult('Falha ao executar o teste.');
    } finally {
      setTestBusy(false);
    }
  };

  return (
    <div className="rounded-md border border-border p-3">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Wrench className="h-4 w-4 text-primary" /> Ferramentas externas
          </p>
          <p className="text-xs text-muted-foreground">
            Conecte o agente aos sistemas da sua empresa (ERP, estoque,
            pedidos) — ele consulta e age com dados reais, sem intermediários.
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={() => openEdit()}>
          <Plus className="mr-1 h-3.5 w-3.5" /> Adicionar
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-3">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </div>
      ) : tools.length > 0 ? (
        <div className="mt-3 space-y-2">
          {tools.map((t) => (
            <div
              key={t.id}
              className={cn(
                'flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2',
                !t.enabled && 'opacity-50',
              )}
            >
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground">
                  {t.name}{' '}
                  <span className="text-[11px] font-normal text-muted-foreground">
                    {RISK_META[t.risk].label} · {t.method}
                  </span>
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {t.url}
                </p>
              </div>
              <button
                type="button"
                title="Testar agora"
                onClick={() => {
                  setTesting(t);
                  setTestArgs({});
                  setTestResult(null);
                }}
                className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <FlaskConical className="h-4 w-4" />
              </button>
              <button
                type="button"
                title="Editar"
                onClick={() => openEdit(t)}
                className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <Pencil className="h-4 w-4" />
              </button>
              <button
                type="button"
                title="Excluir"
                onClick={() => void remove(t)}
                className="rounded p-1.5 text-red-500 hover:bg-red-500/10"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          Nenhuma ferramenta ainda. Ex.: “Consultar estoque”, “Buscar cliente”,
          “Criar pedido”.
        </p>
      )}

      <button
        type="button"
        onClick={async () => {
          const next = !showRuns;
          setShowRuns(next);
          if (next) {
            try {
              setRuns(await listAgentToolRuns(agentId));
            } catch {
              /* silencioso */
            }
          }
        }}
        className="mt-2 text-[11px] font-medium text-primary hover:underline"
      >
        {showRuns ? 'Ocultar histórico de ações' : 'Ver histórico de ações'}
      </button>
      {showRuns && (
        <div className="mt-2 space-y-1">
          {runs.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              Nenhuma execução ainda.
            </p>
          )}
          {runs.map((r) => (
            <p key={r.id} className="text-[11px] text-muted-foreground">
              <span
                className={cn(
                  'font-medium',
                  r.status === 'ok' ? 'text-emerald-600' : 'text-red-500',
                )}
              >
                {r.status}
              </span>{' '}
              · {r.toolSlug}
              {r.httpStatus ? ` · HTTP ${r.httpStatus}` : ''}
              {r.durationMs != null ? ` · ${r.durationMs}ms` : ''} ·{' '}
              {new Date(r.createdAt).toLocaleString('pt-BR', {
                day: '2-digit',
                month: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </p>
          ))}
        </div>
      )}

      {/* ------- form de criar/editar ------- */}
      <Dialog open={!!form} onOpenChange={(o) => !o && setForm(null)}>
        <DialogContent className="max-h-[88vh] max-w-xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {form?.id ? 'Editar ferramenta' : 'Adicionar ferramenta'}
            </DialogTitle>
            <DialogDescription>
              A IA usa a descrição pra decidir QUANDO chamar. Nos campos de URL
              e corpo, use {'{parametro}'} pros valores que a IA preenche.
            </DialogDescription>
          </DialogHeader>
          {form && (
            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>Nome</Label>
                  <Input
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                    placeholder="Consultar estoque"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Categoria</Label>
                  <select
                    value={form.risk}
                    onChange={(e) =>
                      setForm({ ...form, risk: e.target.value as FormState['risk'] })
                    }
                    className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                  >
                    {(Object.keys(RISK_META) as Array<keyof typeof RISK_META>).map(
                      (k) => (
                        <option key={k} value={k}>
                          {RISK_META[k].label}
                        </option>
                      ),
                    )}
                  </select>
                  <p className="text-[10px] text-muted-foreground">
                    {RISK_META[form.risk].hint}
                  </p>
                </div>
              </div>

              <div className="space-y-1">
                <Label>Descrição para a IA (quando usar)</Label>
                <Textarea
                  rows={2}
                  value={form.description}
                  onChange={(e) =>
                    setForm({ ...form, description: e.target.value })
                  }
                  placeholder="Use para consultar disponibilidade e preço atual de um produto antes de informar ao cliente."
                />
              </div>

              <div className="grid gap-3 sm:grid-cols-[110px_1fr]">
                <div className="space-y-1">
                  <Label>Método</Label>
                  <select
                    value={form.method}
                    onChange={(e) => setForm({ ...form, method: e.target.value })}
                    className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                  >
                    {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
                      <option key={m}>{m}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <Label>URL</Label>
                  <Input
                    value={form.url}
                    onChange={(e) => setForm({ ...form, url: e.target.value })}
                    placeholder="https://api.suaempresa.com/estoque?produto={produto}"
                  />
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label>Header de autenticação</Label>
                  <Input
                    value={form.authHeader}
                    onChange={(e) =>
                      setForm({ ...form, authHeader: e.target.value })
                    }
                    placeholder="Authorization"
                  />
                </div>
                <div className="space-y-1">
                  <Label>Valor (ex.: Bearer xxxxx)</Label>
                  <Input
                    type="password"
                    value={form.authValue}
                    onChange={(e) =>
                      setForm({ ...form, authValue: e.target.value })
                    }
                    placeholder={
                      form.id ? '•••••• (vazio = manter o atual)' : 'Bearer …'
                    }
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <Label>Parâmetros que a IA preenche</Label>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setForm({
                        ...form,
                        params: [
                          ...form.params,
                          { name: '', type: 'string', description: '', required: true },
                        ],
                      })
                    }
                  >
                    <Plus className="mr-1 h-3 w-3" /> Parâmetro
                  </Button>
                </div>
                {form.params.map((p, i) => (
                  <div key={i} className="flex flex-wrap items-center gap-1.5">
                    <Input
                      value={p.name}
                      onChange={(e) => {
                        const params = [...form.params];
                        params[i] = { ...p, name: e.target.value };
                        setForm({ ...form, params });
                      }}
                      placeholder="produto"
                      className="h-8 w-28 text-xs"
                    />
                    <Input
                      value={p.description}
                      onChange={(e) => {
                        const params = [...form.params];
                        params[i] = { ...p, description: e.target.value };
                        setForm({ ...form, params });
                      }}
                      placeholder="nome ou código do produto"
                      className="h-8 flex-1 text-xs"
                    />
                    <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <input
                        type="checkbox"
                        checked={p.required}
                        onChange={(e) => {
                          const params = [...form.params];
                          params[i] = { ...p, required: e.target.checked };
                          setForm({ ...form, params });
                        }}
                        className="h-3 w-3"
                      />
                      obrig.
                    </label>
                    <button
                      type="button"
                      onClick={() =>
                        setForm({
                          ...form,
                          params: form.params.filter((_, j) => j !== i),
                        })
                      }
                      className="rounded p-1 text-red-500 hover:bg-red-500/10"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>

              {form.method !== 'GET' && form.method !== 'DELETE' && (
                <div className="space-y-1">
                  <Label>Corpo (JSON com {'{parametros}'}) — opcional</Label>
                  <Textarea
                    rows={3}
                    value={form.bodyTemplate}
                    onChange={(e) =>
                      setForm({ ...form, bodyTemplate: e.target.value })
                    }
                    placeholder={'{ "p_name": "{nome}", "p_phone": "{telefone}" }'}
                    className="font-mono text-xs"
                  />
                </div>
              )}

              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                  className="h-3.5 w-3.5"
                />
                Este agente pode usar esta ferramenta
              </label>

              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setForm(null)}>
                  Cancelar
                </Button>
                <Button onClick={() => void save()} disabled={saving}>
                  {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                  Salvar ferramenta
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* ------- teste manual ------- */}
      <Dialog open={!!testing} onOpenChange={(o) => !o && setTesting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Testar “{testing?.name}”</DialogTitle>
            <DialogDescription>
              Executa a chamada real agora, com os valores abaixo — sem IA no
              meio. O resultado aparece aqui e no histórico.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {(testing?.params ?? []).map((p) => (
              <div key={p.name} className="space-y-1">
                <Label className="text-xs">
                  {p.name}
                  {p.required ? ' *' : ''}
                </Label>
                <Input
                  value={testArgs[p.name] ?? ''}
                  onChange={(e) =>
                    setTestArgs({ ...testArgs, [p.name]: e.target.value })
                  }
                  placeholder={p.description}
                  className="h-8 text-sm"
                />
              </div>
            ))}
            {(testing?.params ?? []).length === 0 && (
              <p className="text-xs text-muted-foreground">Sem parâmetros.</p>
            )}
            {testResult && (
              <pre className="max-h-48 overflow-auto rounded-md bg-muted p-2 text-[11px] whitespace-pre-wrap">
                {testResult}
              </pre>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setTesting(null)}>
                Fechar
              </Button>
              <Button onClick={() => void runTest()} disabled={testBusy}>
                {testBusy ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <FlaskConical className="mr-1.5 h-4 w-4" />
                )}
                Executar teste
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

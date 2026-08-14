'use client';

// ============================================================
// Chaves de API (credenciais) — Fase 1. Cadastra/lista/remove as chaves dos
// provedores (OpenAI/Anthropic; Gemini na Fase 3), reutilizáveis pelos agentes.
// A chave em claro nunca chega aqui — só a dica mascarada (••••1234).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import {
  KeyRound,
  Plus,
  Loader2,
  Trash2,
  DownloadCloud,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

interface Credential {
  id: string;
  provider: string;
  label: string;
  keyHint: string;
  createdAt: string;
}

const PROVIDER_LABEL: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};

// Provedores que dá pra cadastrar HOJE (Gemini entra na Fase 3).
const ADDABLE_PROVIDERS: { value: string; label: string }[] = [
  { value: 'openai', label: 'OpenAI' },
  { value: 'anthropic', label: 'Anthropic' },
];

export function CredentialsManager({ canEdit }: { canEdit: boolean }) {
  const [creds, setCreds] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [addOpen, setAddOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/credentials', { cache: 'no-store' });
      const data = await res.json();
      if (res.ok) setCreds(Array.isArray(data.credentials) ? data.credentials : []);
      else toast.error(data.error ?? 'Falha ao carregar as chaves.');
    } catch {
      toast.error('Falha ao carregar as chaves.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(c: Credential) {
    if (!confirm(`Remover a chave “${c.label}”? Agentes que a usam vão parar de responder.`))
      return;
    setBusyId(c.id);
    try {
      const res = await fetch(`/api/ai/credentials/${c.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const p = await res.json().catch(() => ({}));
        toast.error(p.error ?? 'Não foi possível remover.');
        return;
      }
      toast.success('Chave removida.');
      await load();
    } finally {
      setBusyId(null);
    }
  }

  async function importFromAgents() {
    setImporting(true);
    try {
      const res = await fetch('/api/ai/credentials/import', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? 'Não foi possível importar.');
        return;
      }
      toast.success(
        data.created > 0
          ? `${data.created} chave(s) importada(s) dos agentes.`
          : 'Nenhuma chave nova para importar.',
      );
      await load();
    } finally {
      setImporting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <KeyRound className="h-5 w-5 text-primary" /> Chaves de API
          </h2>
          <p className="mt-0.5 max-w-xl text-sm text-muted-foreground">
            Cadastre suas chaves uma vez aqui. Na criação/configuração de um
            agente você escolhe qual chave e qual modelo usar — sem redigitar.
          </p>
        </div>
        {canEdit && (
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void importFromAgents()}
              disabled={importing}
              title="Trazer para cá as chaves que já estão nos agentes"
            >
              {importing ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <DownloadCloud className="mr-1.5 h-4 w-4" />
              )}
              Importar dos agentes
            </Button>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" /> Adicionar chave
            </Button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
        </div>
      ) : creds.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center">
          <KeyRound className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
          <p className="font-medium text-foreground">Nenhuma chave cadastrada</p>
          <p className="mx-auto mt-1 max-w-sm text-sm text-muted-foreground">
            Adicione a sua chave (OpenAI ou Anthropic) — ou importe as que já
            estão nos seus agentes.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {creds.map((c) => (
            <Card key={c.id} size="sm">
              <CardContent className="flex items-center gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <KeyRound className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium text-foreground">
                      {c.label}
                    </span>
                    <Badge variant="outline" className="text-muted-foreground">
                      {PROVIDER_LABEL[c.provider] ?? c.provider}
                    </Badge>
                  </div>
                  <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                    {c.keyHint}
                  </p>
                </div>
                {canEdit && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void remove(c)}
                    disabled={busyId === c.id}
                    title="Remover"
                  >
                    {busyId === c.id ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <Trash2 className="h-4 w-4" />
                    )}
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AddCredentialDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        onCreated={() => void load()}
      />
    </div>
  );
}

function AddCredentialDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const [provider, setProvider] = useState('openai');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);

  function reset() {
    setProvider('openai');
    setLabel('');
    setApiKey('');
    setSaving(false);
  }

  async function save() {
    const key = apiKey.trim();
    if (!key) {
      toast.error('Cole a sua chave de API.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/ai/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          label: label.trim() || null,
          api_key: key,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(data.error ?? 'A chave não foi aceita pelo provedor.');
        return;
      }
      toast.success('Chave validada e salva.');
      onCreated();
      onOpenChange(false);
      reset();
    } catch {
      toast.error('Não foi possível contatar o servidor.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Adicionar chave de API</DialogTitle>
          <DialogDescription>
            A chave é validada com o provedor antes de salvar e fica
            criptografada. Ela nunca é exibida de novo.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-2">
            <Label className="text-muted-foreground">Provedor</Label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary"
            >
              {ADDABLE_PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Nome (rótulo)</Label>
            <Input
              placeholder="ex.: OpenAI da empresa"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={60}
            />
            <p className="text-xs text-muted-foreground">
              Opcional — só pra você identificar a chave.
            </p>
          </div>

          <div className="space-y-2">
            <Label className="text-muted-foreground">Chave de API</Label>
            <Input
              type="password"
              placeholder={provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancelar
          </Button>
          <Button onClick={() => void save()} disabled={saving}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Validando…
              </>
            ) : (
              'Validar e salvar'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

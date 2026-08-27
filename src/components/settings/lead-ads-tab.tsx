'use client';

// ============================================================
// LeadAdsTab — Config → "Anúncios de Lead".
//
// Conecta fontes de lead do TikTok e do Meta (Facebook/Instagram). NÃO é canal
// de mensagem: é INGESTÃO — o lead do formulário do anúncio cai como contato +
// card no funil (e, se ligado, a IA dá o 1º alô no WhatsApp). Fala só com as
// server actions (lead-ads-actions). Traz o "manualzinho" embutido com a URL
// do webhook + verify_token pra colar no TikTok/Meta.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Plus, Trash2, Pencil, Megaphone, Copy } from 'lucide-react';

import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  listLeadSources,
  listPipelinesForSelect,
  createLeadSource,
  updateLeadSource,
  toggleLeadSource,
  deleteLeadSource,
  getTikTokConnectUrl,
  getLinkedInConnectUrl,
  type LeadProvider,
  type LeadSourceRow,
} from '@/components/settings/lead-ads-actions';

interface FormState {
  provider: LeadProvider;
  name: string;
  externalAccountId: string;
  accessToken: string;
  formId: string;
  verifyToken: string;
  appSecret: string;
  pipelineId: string;
  deliverToAi: boolean;
  enabled: boolean;
}

const EMPTY_FORM: FormState = {
  provider: 'tiktok',
  name: '',
  externalAccountId: '',
  accessToken: '',
  formId: '',
  verifyToken: '',
  appSecret: '',
  pipelineId: '',
  deliverToAi: false,
  enabled: true,
};

const PROVIDER_LABEL: Record<LeadProvider, string> = {
  tiktok: 'TikTok',
  meta: 'Meta (Facebook/Instagram)',
  linkedin: 'LinkedIn',
};

/** Rótulo da chave de roteamento por provedor (mostrado no card e no form). */
const ACCOUNT_ID_LABEL: Record<LeadProvider, string> = {
  meta: 'page_id',
  tiktok: 'advertiser_id',
  linkedin: 'organization id',
};

export function LeadAdsTab() {
  // Owner + admin podem conectar/editar fontes — casa com requireRole('admin')
  // das server actions (hasMinRole). O check cru `=== 'admin'` escondia os
  // botões do PROPRIETÁRIO (owner), que é a role do dono da conta.
  const { isOwner, isAdmin: isAdminRole } = useAuth();
  const isAdmin = isOwner || isAdminRole;

  const [sources, setSources] = useState<LeadSourceRow[]>([]);
  const [pipelines, setPipelines] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [origin, setOrigin] = useState('');

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    setOrigin(window.location.origin);
    // Retorno do OAuth do TikTok (?tiktok=connected|error).
    const params = new URLSearchParams(window.location.search);
    const tk = params.get('tiktok');
    if (tk === 'connected') toast.success('TikTok conectado! Suas contas de anúncios entraram como fontes.');
    else if (tk === 'error') toast.error('Não foi possível conectar o TikTok. Tente de novo ou use a conexão manual.');
    // Retorno do OAuth do LinkedIn (?linkedin=connected|connected_no_org|error).
    const li = params.get('linkedin');
    if (li === 'connected') toast.success('LinkedIn conectado! Suas organizações entraram como fontes.');
    else if (li === 'connected_no_org') toast.success('LinkedIn conectado! Informe o organization id na fonte pra ativar o roteamento.');
    else if (li === 'error') toast.error('Não foi possível conectar o LinkedIn. Tente de novo ou use a conexão manual.');
    if (tk || li) {
      params.delete('tiktok');
      params.delete('linkedin');
      const qs = params.toString();
      window.history.replaceState(null, '', `/settings?${qs}`);
    }
  }, []);

  const connectTikTok = async () => {
    try {
      const url = await getTikTokConnectUrl();
      window.location.href = url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao iniciar a conexão.');
    }
  };

  const connectLinkedIn = async () => {
    try {
      const url = await getLinkedInConnectUrl();
      window.location.href = url;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao iniciar a conexão.');
    }
  };

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [s, p] = await Promise.all([listLeadSources(), listPipelinesForSelect()]);
      setSources(s);
      setPipelines(p);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao carregar as fontes.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openNew = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setOpen(true);
  };

  const openEdit = (s: LeadSourceRow) => {
    setEditingId(s.id);
    setForm({
      provider: s.provider,
      name: s.name,
      externalAccountId: s.external_account_id ?? '',
      accessToken: '',
      formId: s.form_id ?? '',
      verifyToken: s.verify_token ?? '',
      appSecret: '',
      pipelineId: s.pipeline_id ?? '',
      deliverToAi: s.deliver_to_ai,
      enabled: s.enabled,
    });
    setOpen(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        provider: form.provider,
        name: form.name,
        externalAccountId: form.externalAccountId,
        accessToken: form.accessToken,
        formId: form.formId || null,
        verifyToken: form.verifyToken || null,
        appSecret: form.appSecret || null,
        pipelineId: form.pipelineId || null,
        deliverToAi: form.deliverToAi,
        enabled: form.enabled,
      };
      if (editingId) {
        await updateLeadSource(editingId, payload);
        toast.success('Fonte atualizada.');
      } else {
        if (!form.accessToken.trim()) {
          toast.error('Cole o token de acesso.');
          setSaving(false);
          return;
        }
        await createLeadSource(payload);
        toast.success('Fonte conectada.');
      }
      setOpen(false);
      await reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  };

  const onToggle = async (s: LeadSourceRow, enabled: boolean) => {
    try {
      await toggleLeadSource(s.id, enabled);
      setSources((prev) =>
        prev.map((x) => (x.id === s.id ? { ...x, enabled } : x)),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao atualizar.');
    }
  };

  const onDelete = async (s: LeadSourceRow) => {
    if (!confirm(`Remover a fonte "${s.name}"?`)) return;
    try {
      await deleteLeadSource(s.id);
      setSources((prev) => prev.filter((x) => x.id !== s.id));
      toast.success('Fonte removida.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao remover.');
    }
  };

  const webhookUrl = (p: LeadProvider) =>
    `${origin || 'https://crm.salestecnologia.com.br'}/api/webhooks/lead-ads/${p}`;

  const copy = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text);
    toast.success(`${label} copiado.`);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold text-foreground">
            <Megaphone className="h-5 w-5 text-primary" /> Anúncios de Lead
          </h2>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Conecte os anúncios de lead do TikTok, do Meta e do LinkedIn. Todo
            lead que preenche o formulário cai aqui: vira contato + card no funil
            na hora — e, se você ligar, a IA já dá o primeiro alô no WhatsApp.
          </p>
        </div>
        {isAdmin && (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="outline" onClick={connectTikTok}>
              Conectar TikTok
            </Button>
            <Button variant="outline" onClick={connectLinkedIn}>
              Conectar LinkedIn
            </Button>
            <Button onClick={openNew}>
              <Plus className="h-4 w-4" /> Adicionar fonte
            </Button>
          </div>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Carregando…
        </div>
      ) : sources.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            Nenhuma fonte conectada ainda.
            {isAdmin && ' Clique em “Adicionar fonte” para começar.'}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {sources.map((s) => (
            <Card key={s.id}>
              <CardContent className="space-y-3 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium text-foreground">
                        {s.name}
                      </span>
                      <Badge variant="secondary">{PROVIDER_LABEL[s.provider]}</Badge>
                      {s.deliver_to_ai && <Badge>IA no automático</Badge>}
                    </div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {ACCOUNT_ID_LABEL[s.provider]}:{' '}
                      {s.external_account_id || '—'}
                      {s.form_id ? ` · form ${s.form_id}` : ''}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={s.enabled}
                      onCheckedChange={(v) => onToggle(s, v)}
                      disabled={!isAdmin}
                      aria-label="Ativar fonte"
                    />
                    {isAdmin && (
                      <>
                        <Button variant="ghost" size="icon" onClick={() => openEdit(s)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => onDelete(s)}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </>
                    )}
                  </div>
                </div>

                <details className="rounded-lg bg-muted/50 p-3 text-sm">
                  <summary className="cursor-pointer font-medium text-foreground">
                    Como conectar no {PROVIDER_LABEL[s.provider]}
                  </summary>
                  <div className="mt-3 space-y-2 text-muted-foreground">
                    <FieldCopy
                      label="URL do webhook (callback)"
                      value={webhookUrl(s.provider)}
                      onCopy={copy}
                    />
                    {s.provider === 'meta' && s.verify_token && (
                      <FieldCopy
                        label="Verify token"
                        value={s.verify_token}
                        onCopy={copy}
                      />
                    )}
                    {s.provider === 'meta' ? (
                      <ol className="ml-4 list-decimal space-y-1 pt-1">
                        <li>No app do Meta, produto <b>Webhooks</b> → objeto <b>Página</b>.</li>
                        <li>Callback URL = a URL acima; Verify token = o token acima.</li>
                        <li>Assine o campo <b>leadgen</b>.</li>
                        <li>Conecte a Página e publique um anúncio de lead → teste enviando um lead.</li>
                      </ol>
                    ) : s.provider === 'linkedin' ? (
                      <ol className="ml-4 list-decimal space-y-1 pt-1">
                        <li>No app do LinkedIn (Developers), com o <b>Lead Sync API</b> aprovado.</li>
                        <li>Em <b>Webhooks</b> (leadNotifications), aponte o callback para a URL acima.</li>
                        <li>Na validação, informe o <b>Client Secret</b> do app (é ele que assina) no campo App secret da fonte.</li>
                        <li>Autorize a organização (organization id acima) via <b>Conectar LinkedIn</b> e publique um Lead Gen Form.</li>
                        <li>Envie um lead de teste → ele deve cair no funil.</li>
                      </ol>
                    ) : (
                      <ol className="ml-4 list-decimal space-y-1 pt-1">
                        <li>No TikTok for Business (Developers), app com <b>Lead Generation</b>.</li>
                        <li>Em <b>Webhooks</b>, aponte o callback para a URL acima e assine o evento de <b>Lead</b>.</li>
                        <li>Autorize a conta de anúncios (advertiser_id acima) e publique um anúncio de lead.</li>
                        <li>Envie um lead de teste → ele deve cair no funil.</li>
                      </ol>
                    )}
                  </div>
                </details>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{editingId ? 'Editar fonte' : 'Conectar anúncios de lead'}</DialogTitle>
            <DialogDescription>
              Conexão manual (piloto). Os leads dessa fonte viram contato + card no
              funil automaticamente.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <Label>Provedor</Label>
              <select
                className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
                value={form.provider}
                onChange={(e) =>
                  setForm((f) => ({ ...f, provider: e.target.value as LeadProvider }))
                }
                disabled={!!editingId}
              >
                <option value="tiktok">TikTok</option>
                <option value="meta">Meta (Facebook/Instagram)</option>
                <option value="linkedin">LinkedIn</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <Label>Nome da fonte</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Ex.: TikTok — Campanha Agosto"
              />
            </div>

            <div className="space-y-1.5">
              <Label>
                {form.provider === 'meta'
                  ? 'page_id (da Página)'
                  : form.provider === 'linkedin'
                    ? 'organization id (da Página de empresa)'
                    : 'advertiser_id (conta de anúncios)'}
              </Label>
              <Input
                value={form.externalAccountId}
                onChange={(e) =>
                  setForm((f) => ({ ...f, externalAccountId: e.target.value }))
                }
                placeholder={
                  form.provider === 'meta'
                    ? '1158771580642406'
                    : form.provider === 'linkedin'
                      ? '144549939'
                      : '700000000000000'
                }
                autoComplete="off"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Token de acesso {editingId && <span className="text-xs text-muted-foreground">(deixe em branco para manter)</span>}</Label>
              <Textarea
                value={form.accessToken}
                onChange={(e) => setForm((f) => ({ ...f, accessToken: e.target.value }))}
                placeholder={
                  form.provider === 'meta'
                    ? 'Page Access Token'
                    : form.provider === 'linkedin'
                      ? 'Access token do LinkedIn (OAuth)'
                      : 'Access Token do app TikTok'
                }
                rows={2}
                autoComplete="off"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>form_id <span className="text-xs text-muted-foreground">(opcional)</span></Label>
                <Input
                  value={form.formId}
                  onChange={(e) => setForm((f) => ({ ...f, formId: e.target.value }))}
                  placeholder="qualquer formulário"
                  autoComplete="off"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Funil de destino</Label>
                <select
                  className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm"
                  value={form.pipelineId}
                  onChange={(e) => setForm((f) => ({ ...f, pipelineId: e.target.value }))}
                >
                  <option value="">Padrão (primeiro funil)</option>
                  {pipelines.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {form.provider === 'meta' && (
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label>Verify token <span className="text-xs text-muted-foreground">(auto)</span></Label>
                  <Input
                    value={form.verifyToken}
                    onChange={(e) => setForm((f) => ({ ...f, verifyToken: e.target.value }))}
                    placeholder="gerado automaticamente"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>App secret <span className="text-xs text-muted-foreground">(opcional)</span></Label>
                  <Input
                    type="password"
                    value={form.appSecret}
                    onChange={(e) => setForm((f) => ({ ...f, appSecret: e.target.value }))}
                    placeholder="usa META_APP_SECRET se vazio"
                    autoComplete="off"
                  />
                </div>
              </div>
            )}

            {form.provider === 'linkedin' && (
              <div className="space-y-1.5">
                <Label>
                  Client Secret{' '}
                  <span className="text-xs text-muted-foreground">(recomendado)</span>
                </Label>
                <Input
                  type="password"
                  value={form.appSecret}
                  onChange={(e) => setForm((f) => ({ ...f, appSecret: e.target.value }))}
                  placeholder="usa LINKEDIN_CLIENT_SECRET se vazio"
                  autoComplete="off"
                />
                <p className="text-xs text-muted-foreground">
                  Assina o webhook (X-LI-Signature) e responde ao desafio de
                  validação. Sem ele, o CRM aceita o lead sem validar a assinatura
                  (piloto).
                </p>
              </div>
            )}

            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <div className="pr-3">
                <p className="text-sm font-medium text-foreground">Entregar novos leads pra IA</p>
                <p className="text-xs text-muted-foreground">
                  Dispara um WhatsApp de abertura; a IA (se ligada no canal) assume
                  quando o lead responder. Desligado por padrão.
                </p>
              </div>
              <Switch
                checked={form.deliverToAi}
                onCheckedChange={(v) => setForm((f) => ({ ...f, deliverToAi: v }))}
              />
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <p className="text-sm font-medium text-foreground">Fonte ativa</p>
              <Switch
                checked={form.enabled}
                onCheckedChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={save} disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editingId ? 'Salvar' : 'Conectar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function FieldCopy({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy: (v: string, label: string) => void;
}) {
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1 text-xs">
          {value}
        </code>
        <Button variant="ghost" size="icon" onClick={() => onCopy(value, label)}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

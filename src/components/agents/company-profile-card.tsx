'use client';

// ============================================================
// Perfil da empresa ("Núcleo" guiado) — a camada ESTRUTURADA da Base de
// Conhecimento. Diferente dos documentos (retrieval por relevância), estes
// campos vão SEMPRE no contexto do agente. Formulário guiado: o cliente leigo
// preenche campos nomeados em vez de encarar uma tela em branco.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Building2, Save } from 'lucide-react';
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

interface Profile {
  business_name: string | null;
  description: string | null;
  offerings: string | null;
  hours: string | null;
  payment_methods: string | null;
  delivery_info: string | null;
  tone: string | null;
  notes: string | null;
}

const EMPTY: Profile = {
  business_name: '',
  description: '',
  offerings: '',
  hours: '',
  payment_methods: '',
  delivery_info: '',
  tone: '',
  notes: '',
};

export function CompanyProfileCard({ canEdit }: { canEdit: boolean }) {
  const [form, setForm] = useState<Profile>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const loadedRef = useRef(false);

  const set = <K extends keyof Profile>(key: K, value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/ai/company-profile');
      const data = await res.json();
      if (res.ok && data.profile) {
        const p = data.profile as Partial<Profile>;
        setForm({
          business_name: p.business_name ?? '',
          description: p.description ?? '',
          offerings: p.offerings ?? '',
          hours: p.hours ?? '',
          payment_methods: p.payment_methods ?? '',
          delivery_info: p.delivery_info ?? '',
          tone: p.tone ?? '',
          notes: p.notes ?? '',
        });
      }
    } catch {
      toast.error('Falha ao carregar o perfil da empresa.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/ai/company-profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (res.ok) toast.success('Perfil da empresa salvo.');
      else toast.error(data.error ?? 'Falha ao salvar.');
    } catch {
      toast.error('Falha ao salvar.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Building2 className="h-4 w-4 text-primary" /> Perfil da empresa
        </CardTitle>
        <CardDescription>
          O básico que o agente precisa saber em toda conversa — quem é a
          empresa, o que vende, horário e formas de pagamento. Isso entra{' '}
          <strong>sempre</strong> no contexto (os documentos abaixo são buscados
          só quando a pergunta pede).
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center py-4 text-sm text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Carregando…
          </div>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Nome do negócio">
                <Input
                  value={form.business_name ?? ''}
                  onChange={(e) => set('business_name', e.target.value)}
                  placeholder="ex.: Gás Express Campo Grande"
                  disabled={!canEdit || saving}
                />
              </Field>
              <Field label="Horário de atendimento">
                <Input
                  value={form.hours ?? ''}
                  onChange={(e) => set('hours', e.target.value)}
                  placeholder="ex.: Seg a Sáb, 8h às 18h"
                  disabled={!canEdit || saving}
                />
              </Field>
            </div>

            <Field label="Sobre a empresa" hint="O que a empresa faz, em 1–2 frases.">
              <Textarea
                value={form.description ?? ''}
                onChange={(e) => set('description', e.target.value)}
                placeholder="ex.: Entrega de gás de cozinha e água mineral na Grande Campo Grande, com foco em rapidez."
                rows={2}
                disabled={!canEdit || saving}
              />
            </Field>

            <Field
              label="Produtos / serviços"
              hint="Os principais itens e, se quiser, preços de referência."
            >
              <Textarea
                value={form.offerings ?? ''}
                onChange={(e) => set('offerings', e.target.value)}
                placeholder={
                  'ex.:\n- Botijão P13: R$ 110\n- Água 20L: R$ 12\n- Recarga de água: R$ 8'
                }
                rows={4}
                disabled={!canEdit || saving}
              />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Formas de pagamento">
                <Input
                  value={form.payment_methods ?? ''}
                  onChange={(e) => set('payment_methods', e.target.value)}
                  placeholder="ex.: Pix, dinheiro, cartão na entrega"
                  disabled={!canEdit || saving}
                />
              </Field>
              <Field label="Entrega / região">
                <Input
                  value={form.delivery_info ?? ''}
                  onChange={(e) => set('delivery_info', e.target.value)}
                  placeholder="ex.: Entrega grátis em toda a cidade, em até 40 min"
                  disabled={!canEdit || saving}
                />
              </Field>
            </div>

            <Field
              label="Tom de voz"
              hint="Como o agente deve falar com o cliente."
            >
              <Input
                value={form.tone ?? ''}
                onChange={(e) => set('tone', e.target.value)}
                placeholder="ex.: Amigável e direto, tratando por você, sem formalidade"
                disabled={!canEdit || saving}
              />
            </Field>

            <Field
              label="Observações"
              hint="Qualquer regra ou detalhe importante que não coube acima."
            >
              <Textarea
                value={form.notes ?? ''}
                onChange={(e) => set('notes', e.target.value)}
                placeholder="ex.: Não fazemos entrega aos domingos. Pedido mínimo para o interior: 2 botijões."
                rows={2}
                disabled={!canEdit || saving}
              />
            </Field>

            {canEdit && (
              <div className="flex justify-end">
                <Button onClick={save} disabled={saving}>
                  {saving ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-2 h-4 w-4" />
                  )}
                  Salvar perfil
                </Button>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

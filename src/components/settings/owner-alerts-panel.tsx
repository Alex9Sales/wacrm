'use client';

// ============================================================
// 📣 Avisos do responsável — Config → Negócios (ao lado do Sócio IA).
// "Fez venda avisa no telefone, IA escalou avisa, agendou avisa" — a
// critério de cada empresa (caso real: despacho da Família do Gás).
// ============================================================

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Megaphone } from 'lucide-react';

import { getOwnerAlerts, setOwnerAlerts } from './actions';
import { DEFAULT_ALERT_TEMPLATES } from '@/lib/alerts/templates';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function OwnerAlertsPanel() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [phone, setPhone] = useState('');
  const [channelId, setChannelId] = useState<string>('');
  const [onWon, setOnWon] = useState(false);
  const [onHandoff, setOnHandoff] = useState(false);
  const [onBooking, setOnBooking] = useState(false);
  const [onOrder, setOnOrder] = useState(false);
  const [onDemo, setOnDemo] = useState(false);
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [wonTemplate, setWonTemplate] = useState('');
  const [handoffTemplate, setHandoffTemplate] = useState('');
  const [bookingTemplate, setBookingTemplate] = useState('');
  const [orderTemplate, setOrderTemplate] = useState('');
  const [demoTemplate, setDemoTemplate] = useState('');

  useEffect(() => {
    getOwnerAlerts()
      .then((d) => {
        setPhone(d.phone);
        setChannelId(d.channelId ?? '');
        setOnWon(d.onWon);
        setOnHandoff(d.onHandoff);
        setOnBooking(d.onBooking);
        setOnOrder(d.onOrder);
        setOnDemo(d.onDemo);
        setChannels(d.channels);
        setWonTemplate(d.wonTemplate);
        setHandoffTemplate(d.handoffTemplate);
        setBookingTemplate(d.bookingTemplate);
        setOrderTemplate(d.orderTemplate);
        setDemoTemplate(d.demoTemplate);
        if (
          d.wonTemplate ||
          d.handoffTemplate ||
          d.bookingTemplate ||
          d.orderTemplate ||
          d.demoTemplate
        ) {
          setShowTemplates(true);
        }
      })
      .catch(() => toast.error('Não foi possível carregar os avisos.'))
      .finally(() => setLoading(false));
  }, []);

  const save = async () => {
    setSaving(true);
    const { error } = await setOwnerAlerts({
      phone,
      channelId: channelId || null,
      onWon,
      onHandoff,
      onBooking,
      onOrder,
      onDemo,
      wonTemplate,
      handoffTemplate,
      bookingTemplate,
      orderTemplate,
      demoTemplate,
    });
    setSaving(false);
    if (error) toast.error(error);
    else toast.success('Avisos salvos');
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Megaphone className="h-4 w-4 text-primary" /> Avisos do responsável
        </CardTitle>
        <CardDescription>
          O Fluxia avisa num WhatsApp da sua escolha (o do dono, do gestor ou o
          grupo da equipe) quando os eventos marcados acontecerem — com o resumo
          pronto pra agir.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex justify-center py-4">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="alert-phone">WhatsApp que recebe os avisos</Label>
                <Input
                  id="alert-phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="ex.: 67 99999-9999"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="alert-channel">Canal que envia</Label>
                <select
                  id="alert-channel"
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                  className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
                >
                  <option value="">1º WhatsApp conectado</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Avisar quando…</Label>
              {[
                {
                  checked: onWon,
                  set: setOnWon,
                  label: '🏆 Fechar uma venda (negócio marcado como ganho)',
                },
                {
                  checked: onHandoff,
                  set: setOnHandoff,
                  label: '🔁 A IA transferir um atendimento pra humano (com resumo)',
                },
                {
                  checked: onBooking,
                  set: setOnBooking,
                  label: '📅 Um cliente marcar horário pela página pública',
                },
                {
                  checked: onOrder,
                  set: setOnOrder,
                  label: '🛒 A IA confirmar um pedido (com produto, endereço e valor)',
                },
                {
                  checked: onDemo,
                  set: setOnDemo,
                  label: '🎯 O SDR marcar um teste/demonstração (com empresa e resumo)',
                },
              ].map((o) => (
                <label
                  key={o.label}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    type="checkbox"
                    checked={o.checked}
                    onChange={(e) => o.set(e.target.checked)}
                    className="h-3.5 w-3.5 accent-[var(--primary)]"
                  />
                  <span className="text-foreground">{o.label}</span>
                </label>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setShowTemplates((v) => !v)}
              className="text-xs font-medium text-primary hover:underline"
            >
              {showTemplates
                ? 'Ocultar personalização das mensagens'
                : '✏️ Personalizar as mensagens (opcional)'}
            </button>

            {showTemplates && (
              <div className="space-y-3 rounded-md border border-border p-3">
                <p className="text-xs text-muted-foreground">
                  Monte a mensagem do seu jeito — vazio = padrão do sistema.
                  Linha cuja variável ficar sem dado é removida sozinha.
                </p>
                {(
                  [
                    {
                      label: '🏆 Venda fechada',
                      vars: '{{titulo}} {{valor}} {{cliente}} {{telefone}} {{notas}}',
                      value: wonTemplate,
                      set: setWonTemplate,
                      def: DEFAULT_ALERT_TEMPLATES.won,
                    },
                    {
                      label: '🔁 IA transferiu pra humano',
                      vars: '{{cliente}} {{telefone}} {{motivo}} {{resumo}}',
                      value: handoffTemplate,
                      set: setHandoffTemplate,
                      def: DEFAULT_ALERT_TEMPLATES.handoff,
                    },
                    {
                      label: '📅 Agendamento',
                      vars: '{{nome}} {{telefone}} {{quando}} {{agenda}} {{local}}',
                      value: bookingTemplate,
                      set: setBookingTemplate,
                      def: DEFAULT_ALERT_TEMPLATES.booking,
                    },
                    {
                      label: '🛒 Pedido confirmado pela IA',
                      vars: '{{titulo}} {{valor}} {{cliente}} {{telefone}} {{resumo}}',
                      value: orderTemplate,
                      set: setOrderTemplate,
                      def: DEFAULT_ALERT_TEMPLATES.order,
                    },
                    {
                      label: '🎯 Teste/demo agendado pelo SDR',
                      vars: '{{cliente}} {{telefone}} {{empresa}} {{resumo}}',
                      value: demoTemplate,
                      set: setDemoTemplate,
                      def: DEFAULT_ALERT_TEMPLATES.demo,
                    },
                  ] as const
                ).map((t) => (
                  <div key={t.label} className="space-y-1">
                    <Label className="text-xs">
                      {t.label}{' '}
                      <span className="font-normal text-muted-foreground">
                        · variáveis: {t.vars}
                      </span>
                    </Label>
                    <Textarea
                      rows={4}
                      value={t.value}
                      onChange={(e) => t.set(e.target.value)}
                      placeholder={t.def}
                      className="text-xs"
                    />
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-end">
              <Button size="sm" onClick={() => void save()} disabled={saving}>
                {saving && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
                Salvar avisos
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

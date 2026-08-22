"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Sparkles, Send } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { getOwnerDigest, setOwnerDigest, sendOwnerDigestTest } from "./actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

// Sócio IA: resumo diário do funil no WhatsApp do dono. OFF por padrão (dispara
// mensagem real). O dono liga, escolhe a hora e o número que recebe.
export function OwnerDigestPanel() {
  const { canEditSettings } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [hour, setHour] = useState(8);
  const [phone, setPhone] = useState("");
  const [channelId, setChannelId] = useState<string>("");
  const [channels, setChannels] = useState<{ id: string; name: string }[]>([]);
  const [preview, setPreview] = useState("");

  useEffect(() => {
    getOwnerDigest()
      .then((res) => {
        setEnabled(res.enabled);
        setHour(res.hour);
        setPhone(res.phone);
        setChannelId(res.channelId ?? "");
        setChannels(res.channels);
        setPreview(res.preview);
      })
      .catch(() => toast.error("Falha ao carregar o resumo diário."))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    const res = await setOwnerDigest({
      enabled,
      hour,
      phone,
      channelId: channelId || null,
    });
    setSaving(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Resumo diário salvo.");
  }

  async function handleTest() {
    setTesting(true);
    const res = await sendOwnerDigestTest();
    setTesting(false);
    if (!res.ok) {
      toast.error(res.error ?? "Não foi possível enviar o teste.");
      return;
    }
    toast.success("Resumo de teste enviado no WhatsApp. 📲");
  }

  const selectCls =
    "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Sparkles className="size-4 text-primary" />
          Sócio IA — resumo diário no WhatsApp
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Todo dia, num horário que você escolhe, a IA manda no seu WhatsApp um
          resumo do funil: vendas de ontem, valor em aberto, negócios esfriando,
          conversas esperando resposta e a meta do mês.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex justify-center py-4 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            <label className="flex items-center gap-2 text-sm text-foreground">
              <input
                type="checkbox"
                checked={enabled}
                disabled={!canEditSettings}
                onChange={(e) => setEnabled(e.target.checked)}
                className="size-4 accent-primary"
              />
              Ligar o resumo diário
            </label>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label className="text-muted-foreground">Enviar às</Label>
                <select
                  value={hour}
                  onChange={(e) => setHour(Number(e.target.value))}
                  disabled={!canEditSettings}
                  className={selectCls}
                >
                  {Array.from({ length: 24 }, (_, h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, "0")}:00
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-2">
                <Label className="text-muted-foreground">
                  WhatsApp que recebe
                </Label>
                <input
                  type="tel"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  disabled={!canEditSettings}
                  placeholder="Ex.: 67 99999-9999"
                  className={selectCls}
                />
              </div>
            </div>

            {channels.length > 1 && (
              <div className="grid gap-2 sm:max-w-md">
                <Label className="text-muted-foreground">
                  Enviar a partir do canal
                </Label>
                <select
                  value={channelId}
                  onChange={(e) => setChannelId(e.target.value)}
                  disabled={!canEditSettings}
                  className={selectCls}
                >
                  <option value="">1º canal WhatsApp conectado</option>
                  {channels.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {preview && (
              <div className="grid gap-2">
                <Label className="text-muted-foreground">
                  Prévia (com seus dados de agora)
                </Label>
                <pre className="whitespace-pre-wrap rounded-lg border border-border bg-muted/60 p-3 text-[13px] leading-relaxed text-foreground">
                  {preview}
                </pre>
              </div>
            )}

            {!canEditSettings ? (
              <p className="text-xs text-muted-foreground">
                Apenas administradores da conta podem mudar isto.
              </p>
            ) : (
              <div className="flex flex-wrap gap-2">
                <Button
                  onClick={handleSave}
                  disabled={saving}
                  className="bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  {saving ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Salvando...
                    </>
                  ) : (
                    "Salvar"
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleTest}
                  disabled={testing || !phone}
                  title={
                    phone
                      ? "Envia o resumo agora pro número configurado"
                      : "Informe o número primeiro"
                  }
                >
                  {testing ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Enviando...
                    </>
                  ) : (
                    <>
                      <Send className="size-4" /> Enviar teste agora
                    </>
                  )}
                </Button>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

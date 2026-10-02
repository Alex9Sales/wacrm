"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Sparkles, Send } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { phonesMatch } from "@/lib/whatsapp/phone-utils";
import {
  getOwnerDigest,
  previewOwnerDigest,
  setOwnerDigest,
  sendOwnerDigestTest,
} from "./actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

type DigestMode = "hora" | "fechamento";

// Sócio IA: resumo diário do funil no WhatsApp do dono. OFF por padrão (dispara
// mensagem real). O dono liga, escolhe QUANDO e o número que recebe.
// 02/10/2026 (pedido de uma clínica: "todo fim de expediente"): além da hora fixa, o
// resumo pode sair no fechamento de cada dia de expediente — o horário vem de
// Configurações → Atendimento, então a opção só existe com ele ligado.
export function OwnerDigestPanel() {
  const { canEditSettings } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);

  const [enabled, setEnabled] = useState(false);
  const [hour, setHour] = useState(8);
  const [mode, setMode] = useState<DigestMode>("hora");
  const [savedMode, setSavedMode] = useState<DigestMode>("hora");
  const [expedienteOk, setExpedienteOk] = useState(false);
  const [fechamentos, setFechamentos] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [channelId, setChannelId] = useState<string>("");
  const [channels, setChannels] = useState<
    { id: string; name: string; phone: string | null }[]
  >([]);
  const [preview, setPreview] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  // O número digitado é o de um canal DESTA conta? Aí o resumo entra nesse
  // canal como mensagem recebida (08/09: o agente respondeu ao resumo como se
  // fosse lead — hoje a IA reconhece e fica quieta, mas o dono deve saber).
  const sameAsChannel = phone.trim()
    ? channels.find((c) => c.phone && phonesMatch(c.phone, phone))
    : undefined;

  useEffect(() => {
    getOwnerDigest()
      .then((res) => {
        setEnabled(res.enabled);
        setHour(res.hour);
        // Salvo "no fim do expediente" com o horário de atendimento desligado:
        // na prática sai na hora (owner-digest.ts modoEfetivo) — a tela mostra
        // isso, com o aviso amarelo explicando por quê.
        setMode(
          res.mode === "fechamento" && !res.expedienteConfigurado ? "hora" : res.mode,
        );
        setSavedMode(res.mode);
        setExpedienteOk(res.expedienteConfigurado);
        setFechamentos(res.fechamentos);
        setPhone(res.phone);
        setChannelId(res.channelId ?? "");
        setChannels(res.channels);
        setPreview(res.preview);
      })
      .catch(() => toast.error("Falha ao carregar o resumo diário."))
      .finally(() => setLoading(false));
  }, []);

  // A prévia acompanha o modo escolhido na tela (o texto da manhã e o do fim
  // do dia são diferentes), mesmo antes de salvar.
  async function changeMode(next: DigestMode) {
    if (next === mode) return;
    setMode(next);
    setPreviewLoading(true);
    try {
      setPreview(await previewOwnerDigest(next));
    } catch {
      toast.error("Não foi possível atualizar a prévia.");
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleSave() {
    setSaving(true);
    const res = await setOwnerDigest({
      enabled,
      hour,
      phone,
      channelId: channelId || null,
      mode,
    });
    setSaving(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    setSavedMode(mode);
    toast.success("Resumo diário salvo.");
  }

  async function handleTest() {
    setTesting(true);
    const res = await sendOwnerDigestTest(mode);
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
          A IA manda no seu WhatsApp um resumo do atendimento e do funil: num
          horário fixo (resumo da manhã, com as vendas de ontem) ou no fim de
          cada dia de expediente (resumo de hoje). Os dois mostram quem está
          esperando resposta e as transferências da IA que ninguém assumiu.
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

            <div className="grid gap-2">
              <Label className="text-muted-foreground">Quando enviar</Label>
              <div className="flex flex-col gap-2 sm:flex-row sm:gap-6">
                <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                  <input
                    type="radio"
                    name="owner-digest-mode"
                    checked={mode === "hora"}
                    disabled={!canEditSettings}
                    onChange={() => void changeMode("hora")}
                    className="size-4 accent-primary"
                  />
                  Num horário, todo dia
                </label>
                <label
                  className={`flex items-center gap-2 text-sm ${
                    expedienteOk
                      ? "cursor-pointer text-foreground"
                      : "cursor-not-allowed text-muted-foreground"
                  }`}
                >
                  <input
                    type="radio"
                    name="owner-digest-mode"
                    checked={mode === "fechamento"}
                    disabled={!canEditSettings || !expedienteOk}
                    onChange={() => void changeMode("fechamento")}
                    className="size-4 accent-primary"
                  />
                  No fim do expediente
                </label>
              </div>
              {!expedienteOk && (
                <p className="text-xs text-muted-foreground">
                  &quot;No fim do expediente&quot; usa o horário de fechamento
                  de cada dia. Ligue o horário de atendimento em Configurações →
                  Atendimento para usar esta opção.
                </p>
              )}
              {savedMode === "fechamento" && !expedienteOk && (
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  O resumo está salvo para o fim do expediente, mas o horário de
                  atendimento está desligado — enquanto isso ele sai às{" "}
                  {String(hour).padStart(2, "0")}:00.
                </p>
              )}
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              {mode === "hora" ? (
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
              ) : (
                <div className="grid content-start gap-2">
                  <Label className="text-muted-foreground">
                    Sai logo depois do fechamento
                  </Label>
                  <p className="rounded-lg border border-border bg-muted/60 px-2.5 py-2 text-sm text-foreground">
                    {fechamentos ?? "Nenhum dia aberto no horário de atendimento."}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Do horário de atendimento (Configurações → Atendimento),
                    até 15 min depois do fechamento. Dia fechado não tem resumo.
                  </p>
                </div>
              )}

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
                {sameAsChannel && (
                  <p className="text-xs text-amber-700 dark:text-amber-400">
                    Esse é o número do canal «{sameAsChannel.name}» desta conta.
                    O resumo vai entrar nesse canal como mensagem recebida (a IA
                    reconhece e não responde a ele, mas a conversa aparece como
                    não lida). Prefira um número que não seja canal.
                  </p>
                )}
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

            {(preview || previewLoading) && (
              <div className="grid gap-2">
                <Label className="flex items-center gap-2 text-muted-foreground">
                  Prévia (com seus dados de agora)
                  {previewLoading && <Loader2 className="size-3.5 animate-spin" />}
                </Label>
                <pre
                  className={`whitespace-pre-wrap rounded-lg border border-border bg-muted/60 p-3 text-[13px] leading-relaxed text-foreground ${
                    previewLoading ? "opacity-60" : ""
                  }`}
                >
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

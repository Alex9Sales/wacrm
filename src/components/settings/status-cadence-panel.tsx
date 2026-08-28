"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Trophy, XCircle } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { getStatusCadences, setStatusCadences } from "./actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

interface CadenceOpt {
  id: string;
  name: string;
  active: boolean;
}

// Gatilho por status: ao GANHAR o negócio, inscreve o contato numa cadência
// (pós-venda); ao PERDER, numa cadência de recuperação. Reusa as cadências.
export function StatusCadencePanel() {
  const { canEditSettings } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [cadences, setCadences] = useState<CadenceOpt[]>([]);
  const [pipes, setPipes] = useState<{ id: string; name: string }[]>([]);
  const [wonId, setWonId] = useState("");
  const [lostId, setLostId] = useState("");
  const [wonPipeId, setWonPipeId] = useState("");
  const [lostPipeId, setLostPipeId] = useState("");
  const [recordOnWon, setRecordOnWon] = useState(true);

  useEffect(() => {
    getStatusCadences()
      .then((res) => {
        setCadences(res.cadences);
        setPipes(res.pipelines);
        setWonId(res.wonCadenceId ?? "");
        setLostId(res.lostCadenceId ?? "");
        setWonPipeId(res.wonPipelineId ?? "");
        setLostPipeId(res.lostPipelineId ?? "");
        setRecordOnWon(res.recordSaleOnWon);
      })
      .catch(() => toast.error("Falha ao carregar as cadências."))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    const res = await setStatusCadences({
      wonCadenceId: wonId || null,
      lostCadenceId: lostId || null,
      wonPipelineId: wonPipeId || null,
      lostPipelineId: lostPipeId || null,
      recordSaleOnWon: recordOnWon,
    });
    setSaving(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Gatilhos salvos.");
  }

  const selectCls =
    "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60";

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Trophy className="size-4 text-primary" />
          Cadência ao ganhar / perder
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Ao marcar um negócio como <strong>ganho</strong> ou{" "}
          <strong>perdido</strong>, o contato entra automaticamente na cadência
          escolhida (pós-venda quando ganha, recuperação quando perde).
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex justify-center py-4 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            {/* CDL: registrar a venda ganha no histórico de compras. */}
            <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-muted/30 p-3">
              <input
                type="checkbox"
                checked={recordOnWon}
                onChange={(e) => setRecordOnWon(e.target.checked)}
                disabled={!canEditSettings}
                className="mt-0.5 size-4 accent-[var(--primary)]"
              />
              <span className="text-sm">
                <span className="font-medium text-foreground">
                  Registrar a venda no histórico ao GANHAR
                </span>
                <span className="mt-0.5 block text-xs text-muted-foreground">
                  Ao marcar um negócio como ganho, a compra entra no “Histórico
                  de compras” do cliente (a IA passa a conhecer o cliente).
                  Desligue em contas que já sincronizam o histórico de um ERP.
                </span>
              </span>
            </label>

            {cadences.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Você ainda não tem cadências. Crie em{" "}
                <strong>Automações → Cadências</strong> e volte aqui para
                escolher.
              </p>
            ) : (
              <>
            <div className="grid gap-2 sm:max-w-md">
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Trophy className="size-3.5 text-emerald-600" /> Ao GANHAR, inscrever em
              </span>
              <select
                value={wonId}
                onChange={(e) => setWonId(e.target.value)}
                disabled={!canEditSettings}
                className={selectCls}
              >
                <option value="">Nenhuma</option>
                {cadences.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.active ? "" : " (pausada)"}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2 sm:max-w-md">
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <XCircle className="size-3.5 text-rose-500" /> Ao PERDER, inscrever em
              </span>
              <select
                value={lostId}
                onChange={(e) => setLostId(e.target.value)}
                disabled={!canEditSettings}
                className={selectCls}
              >
                <option value="">Nenhuma</option>
                {cadences.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.active ? "" : " (pausada)"}
                  </option>
                ))}
              </select>
            </div>

              </>
            )}

            {/* 🔀 Funil→funil (ideia do cliente Dentai): ganhou/perdeu → abre
                um NOVO negócio no funil escolhido (o original fica onde está,
                preservando os relatórios). Opt-in — nenhum = como sempre foi. */}
            {pipes.length > 1 && (
              <div className="space-y-4 border-t border-border pt-4">
                <p className="text-sm text-muted-foreground">
                  <strong className="text-foreground">
                    Mover para outro funil
                  </strong>{" "}
                  — ao ganhar/perder, abre automaticamente um novo negócio no
                  funil escolhido (ex.: pós-venda no ganho, resgate na perda). O
                  negócio original fica no funil dele, mantendo os relatórios.
                </p>
                <div className="grid gap-2 sm:max-w-md">
                  <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <Trophy className="size-3.5 text-emerald-600" /> Ao GANHAR,
                    abrir negócio no funil
                  </span>
                  <select
                    value={wonPipeId}
                    onChange={(e) => setWonPipeId(e.target.value)}
                    disabled={!canEditSettings}
                    className={selectCls}
                  >
                    <option value="">Não mover (padrão)</option>
                    {pipes.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="grid gap-2 sm:max-w-md">
                  <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                    <XCircle className="size-3.5 text-rose-500" /> Ao PERDER,
                    abrir negócio no funil
                  </span>
                  <select
                    value={lostPipeId}
                    onChange={(e) => setLostPipeId(e.target.value)}
                    disabled={!canEditSettings}
                    className={selectCls}
                  >
                    <option value="">Não mover (padrão)</option>
                    {pipes.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {!canEditSettings ? (
              <p className="text-xs text-muted-foreground">
                Apenas administradores da conta podem mudar isto.
              </p>
            ) : (
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
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

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
  const [wonId, setWonId] = useState("");
  const [lostId, setLostId] = useState("");

  useEffect(() => {
    getStatusCadences()
      .then((res) => {
        setCadences(res.cadences);
        setWonId(res.wonCadenceId ?? "");
        setLostId(res.lostCadenceId ?? "");
      })
      .catch(() => toast.error("Falha ao carregar as cadências."))
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    const res = await setStatusCadences({
      wonCadenceId: wonId || null,
      lostCadenceId: lostId || null,
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
        ) : cadences.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Você ainda não tem cadências. Crie em{" "}
            <strong>Automações → Cadências</strong> e volte aqui para escolher.
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

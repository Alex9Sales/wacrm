"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Snowflake } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { getDealAlertDays, setDealAlertDays } from "./actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

// Alerta de negócio "esfriando": marca no funil o negócio ABERTO parado na
// mesma etapa por mais de N dias. 0 = desligado.
export function StaleDealPanel() {
  const { canEditSettings } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [days, setDays] = useState(7);

  useEffect(() => {
    getDealAlertDays()
      .then((d) => setDays(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  async function handleSave() {
    setSaving(true);
    const res = await setDealAlertDays(days);
    setSaving(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Alerta atualizado.");
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Snowflake className="size-4 text-primary" />
          Negócio esfriando
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Um negócio aberto parado na mesma etapa por muitos dias vira
          &quot;esfriando&quot;: ganha um alerta no card e aparece no filtro
          &quot;Esfriando&quot; do funil, pra ninguém deixar o lead apodrecer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex justify-center py-4 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
              <span>Marcar como esfriando após</span>
              <input
                type="number"
                min={0}
                max={365}
                value={days}
                disabled={!canEditSettings}
                onChange={(e) => setDays(Math.max(0, Math.min(365, Number(e.target.value) || 0)))}
                className="h-9 w-20 rounded-lg border border-border bg-muted px-2.5 text-center text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:opacity-60"
              />
              <span>dias parado na etapa.</span>
            </div>
            <p className="text-xs text-muted-foreground">
              Use <strong>0</strong> para desligar o alerta.
            </p>
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

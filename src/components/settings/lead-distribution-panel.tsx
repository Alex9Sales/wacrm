"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Shuffle, Users } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { getLeadDistribution, saveLeadDistribution } from "./actions";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

interface Member {
  id: string;
  name: string | null;
  email: string | null;
  role: string | null;
}

// Distribuição automática de leads (rodízio). Quando um lead entra sem dono
// (diagnóstico, anúncios, API), o sistema atribui a um vendedor do rodízio.
export function LeadDistributionPanel() {
  const { canEditSettings } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [strategy, setStrategy] = useState<"round_robin" | "load">("round_robin");
  const [members, setMembers] = useState<Member[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    setLoading(true);
    getLeadDistribution()
      .then((res) => {
        setEnabled(res.config.enabled);
        setStrategy(res.config.strategy);
        setMembers(res.members as Member[]);
        setSelected(new Set(res.config.memberIds));
      })
      .catch(() => toast.error("Falha ao carregar a distribuição."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function toggleMember(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    const res = await saveLeadDistribution({
      enabled,
      strategy,
      memberIds: [...selected],
    });
    setSaving(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Distribuição salva.");
  }

  const noMembers = enabled && selected.size === 0;

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Shuffle className="size-4 text-primary" />
          Distribuição automática de leads
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Quando um lead novo entra sem dono (diagnóstico, anúncios, API), o
          sistema atribui automaticamente a um vendedor do rodízio, cria a
          tarefa e avisa a pessoa.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loading ? (
          <div className="flex justify-center py-6 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            {/* Liga/desliga */}
            <label className="flex items-center gap-3">
              <button
                type="button"
                role="switch"
                aria-checked={enabled}
                disabled={!canEditSettings}
                onClick={() => setEnabled((v) => !v)}
                className={`relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50 ${
                  enabled ? "bg-primary" : "bg-muted"
                }`}
              >
                <span
                  className={`absolute top-0.5 size-5 rounded-full bg-white transition-all ${
                    enabled ? "left-[1.375rem]" : "left-0.5"
                  }`}
                />
              </button>
              <span className="text-sm font-medium text-foreground">
                {enabled ? "Distribuição ligada" : "Distribuição desligada"}
              </span>
            </label>

            {/* Estratégia */}
            <div className="grid gap-2 sm:max-w-xs">
              <span className="text-sm text-muted-foreground">Como distribuir</span>
              <select
                value={strategy}
                onChange={(e) => setStrategy(e.target.value as "round_robin" | "load")}
                disabled={!canEditSettings || !enabled}
                className="h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary disabled:cursor-not-allowed disabled:opacity-60"
              >
                <option value="round_robin">Rodízio (um pra cada, na ordem)</option>
                <option value="load">Por carga (quem tem menos negócios abertos)</option>
              </select>
            </div>

            {/* Quem entra no rodízio */}
            <div className="grid gap-2">
              <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Users className="size-3.5" /> Quem recebe os leads
              </span>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {members.map((m) => (
                  <label
                    key={m.id}
                    className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors ${
                      selected.has(m.id)
                        ? "border-primary/50 bg-primary/5"
                        : "border-border"
                    } ${enabled && canEditSettings ? "cursor-pointer" : "opacity-60"}`}
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(m.id)}
                      disabled={!canEditSettings || !enabled}
                      onChange={() => toggleMember(m.id)}
                      style={{ accentColor: "var(--primary)" }}
                      className="size-4"
                    />
                    <span className="min-w-0">
                      <span className="block truncate font-medium text-foreground">
                        {m.name || m.email || "Sem nome"}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {m.role}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {noMembers && (
                <p className="text-xs text-destructive">
                  Escolha pelo menos uma pessoa, senão o lead cai sem dono.
                </p>
              )}
            </div>

            {!canEditSettings ? (
              <p className="text-xs text-muted-foreground">
                Apenas administradores da conta podem mudar a distribuição.
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

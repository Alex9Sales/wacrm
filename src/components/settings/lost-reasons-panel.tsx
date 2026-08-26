"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, XCircle, X, Plus, Lock } from "lucide-react";

import { useAuth } from "@/hooks/use-auth";
import { getLostReasonsSettings, setLostReasonsSettings } from "./actions";
import { canonReason } from "@/lib/deals/lost-reasons";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";

// Motivos de perda da conta (estilo RD): o admin gerencia os chips aqui e,
// com a trava ligada, o vendedor só escolhe — sem texto livre. Evita o
// mesmo motivo entrar duas vezes por acento/grafia (pedido do Rafael).
export function LostReasonsPanel() {
  const { canEditSettings } = useAuth();
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [reasons, setReasons] = useState<string[]>([]);
  const [locked, setLocked] = useState(false);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    getLostReasonsSettings()
      .then((res) => {
        setReasons(res.reasons);
        setLocked(res.locked);
      })
      .catch(() => toast.error("Falha ao carregar os motivos de perda."))
      .finally(() => setLoading(false));
  }, []);

  function addDraft() {
    const t = draft.trim();
    if (!t) return;
    if (reasons.some((r) => canonReason(r) === canonReason(t))) {
      toast.error("Esse motivo já existe na lista.");
      return;
    }
    setReasons((prev) => [...prev, t]);
    setDraft("");
  }

  async function handleSave() {
    setSaving(true);
    const res = await setLostReasonsSettings({ reasons, locked });
    setSaving(false);
    if (res.error) {
      toast.error(res.error);
      return;
    }
    toast.success("Motivos de perda salvos.");
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <XCircle className="size-4 text-rose-500" />
          Motivos de perda
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          Os motivos oferecidos ao marcar um negócio como{" "}
          <strong>perdido</strong>. Com a lista <strong>fechada</strong>, o
          vendedor só escolhe um destes (sem texto livre) — o relatório não
          divide a contagem por diferença de grafia ou acento.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <div className="flex justify-center py-4 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {reasons.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  Nenhum motivo cadastrado ainda.
                </p>
              )}
              {reasons.map((r) => (
                <span
                  key={r}
                  className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-xs text-foreground"
                >
                  {r}
                  {canEditSettings && (
                    <button
                      type="button"
                      onClick={() =>
                        setReasons((prev) => prev.filter((x) => x !== r))
                      }
                      aria-label={`Remover motivo ${r}`}
                      className="text-muted-foreground transition-colors hover:text-rose-500"
                    >
                      <X className="size-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>

            {canEditSettings && (
              <div className="flex items-center gap-2 sm:max-w-md">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addDraft();
                    }
                  }}
                  placeholder="Novo motivo (ex.: Achou caro)"
                  maxLength={60}
                  className="h-9 flex-1 border-border bg-muted text-sm"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addDraft}
                >
                  <Plus className="size-4" /> Adicionar
                </Button>
              </div>
            )}

            <label className="flex cursor-pointer items-start gap-2.5 sm:max-w-md">
              <input
                type="checkbox"
                checked={locked}
                disabled={!canEditSettings}
                onChange={(e) => setLocked(e.target.checked)}
                className="mt-0.5 size-4 accent-primary"
              />
              <span className="text-sm text-foreground">
                <span className="flex items-center gap-1.5 font-medium">
                  <Lock className="size-3.5" /> Somente motivos pré-definidos
                </span>
                <span className="text-xs text-muted-foreground">
                  O vendedor escolhe um chip da lista — o campo de motivo
                  livre some das telas de perda (estilo RD).
                </span>
              </span>
            </label>

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

"use client";

import { useEffect, useState } from "react";
import { Bell, Play, Volume2 } from "lucide-react";

import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { SettingsPanelHead } from "./settings-panel-head";
import {
  NOTIFICATION_SOUNDS,
  playNotificationSound,
} from "@/lib/notifications/sounds";
import {
  getNotificationPrefs,
  setNotificationPrefs,
  type NotificationPrefs,
} from "@/lib/notifications/prefs";

/**
 * Notificações — per-device alert preferences (sound + pop-up). These live in
 * localStorage (they control how THIS browser alerts), so there's no server
 * round-trip. The global listener reads the same prefs live.
 */
export function NotificationsPanel() {
  const [prefs, setPrefs] = useState<NotificationPrefs | null>(null);

  useEffect(() => {
    setPrefs(getNotificationPrefs());
  }, []);

  const update = (patch: Partial<NotificationPrefs>) => {
    const next = setNotificationPrefs(patch);
    setPrefs(next);
  };

  if (!prefs) return null;

  return (
    <div>
      <SettingsPanelHead
        title="Notificações"
        description="Som e pop-up de mensagens novas — de clientes e do chat interno. Vale só para este navegador/dispositivo."
      />

      <div className="mt-4 space-y-4">
        {/* Pop-up */}
        <div className="flex items-center justify-between gap-4 rounded-xl border border-border bg-card p-4">
          <div className="min-w-0">
            <Label className="flex items-center gap-2 text-sm font-medium text-foreground">
              <Bell className="h-4 w-4 text-primary" />
              Pop-up de mensagem nova
            </Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Mostra um aviso no canto da tela quando chega uma mensagem de
              cliente, com o nome e uma prévia. Clicar abre a conversa.
            </p>
          </div>
          <Switch
            checked={prefs.toastEnabled}
            onCheckedChange={(v) => update({ toastEnabled: v })}
            aria-label="Ativar pop-up de mensagem nova"
          />
        </div>

        {/* Sound */}
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0">
              <Label className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Volume2 className="h-4 w-4 text-primary" />
                Som de notificação
              </Label>
              <p className="mt-1 text-xs text-muted-foreground">
                Toca quando chega uma mensagem nova. Escolha o som abaixo.
              </p>
            </div>
            <Switch
              checked={prefs.soundEnabled}
              onCheckedChange={(v) => update({ soundEnabled: v })}
              aria-label="Ativar som de notificação"
            />
          </div>

          {prefs.soundEnabled && (
            <>
              <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {NOTIFICATION_SOUNDS.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      update({ soundId: s.id });
                      playNotificationSound(s.id, prefs.volume);
                    }}
                    className={cn(
                      "flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm transition-colors",
                      prefs.soundId === s.id
                        ? "border-primary bg-primary/5 text-foreground"
                        : "border-border text-muted-foreground hover:bg-muted",
                    )}
                  >
                    {s.label}
                    <Play className="h-3.5 w-3.5 shrink-0" />
                  </button>
                ))}
              </div>

              <div className="mt-4 flex items-center gap-3">
                <span className="text-xs text-muted-foreground">Volume</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.1}
                  value={prefs.volume}
                  onChange={(e) => update({ volume: Number(e.target.value) })}
                  onMouseUp={() =>
                    playNotificationSound(prefs.soundId, prefs.volume)
                  }
                  className="h-1.5 flex-1 cursor-pointer accent-primary"
                  aria-label="Volume"
                />
                <span className="w-8 text-right text-xs tabular-nums text-muted-foreground">
                  {Math.round(prefs.volume * 100)}%
                </span>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

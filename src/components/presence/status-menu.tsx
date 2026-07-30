"use client";

// Header presence control (Fase 3.1). The member's own status, always visible
// and one click to change — "saí pro almoço" → Ausente/Offline; "voltei" →
// Online. Writes go through use-my-status; <PresenceHeartbeat/> pushes the
// choice to the server.

import { Check, ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { PresenceDot } from "@/components/presence/presence-dot";
import { presenceStatusPt, type StoredPresence } from "@/lib/presence";
import { useMyStatus } from "@/hooks/use-my-status";
import { cn } from "@/lib/utils";

const OPTIONS: { status: StoredPresence; hint: string }[] = [
  { status: "online", hint: "Recebendo e respondendo clientes" },
  { status: "away", hint: "Ausente — voltando já (ex.: almoço)" },
  { status: "offline", hint: "Fora do atendimento" },
];

export function StatusMenu() {
  const { status, setStatus } = useMyStatus();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-muted/70 focus:bg-muted/70 focus:outline-none data-popup-open:bg-muted/70"
        aria-label="Mudar meu status"
      >
        <PresenceDot status={status} />
        <span className="hidden sm:inline">{presenceStatusPt(status)}</span>
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="min-w-60 bg-popover text-popover-foreground ring-border"
      >
        <div className="px-2 py-1.5">
          <p className="text-xs font-medium text-muted-foreground">
            Meu status
          </p>
        </div>
        {OPTIONS.map((opt) => (
          <DropdownMenuItem
            key={opt.status}
            onClick={() => setStatus(opt.status)}
            className="items-start gap-2 text-popover-foreground focus:bg-accent focus:text-accent-foreground"
          >
            <PresenceDot status={opt.status} className="mt-1.5" />
            <span className="flex flex-1 flex-col">
              <span className="text-sm font-medium">
                {presenceStatusPt(opt.status)}
              </span>
              <span className="text-xs text-muted-foreground">{opt.hint}</span>
            </span>
            <Check
              className={cn(
                "mt-1 size-4 shrink-0 text-primary",
                status === opt.status ? "opacity-100" : "opacity-0",
              )}
            />
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

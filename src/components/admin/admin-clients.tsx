"use client";

// ============================================================
// AdminClients — the /admin client-management dashboard (Phase 8).
//
// - Overview cards (total / ativos / suspensos / vencidos).
// - Client table ordered by due date, OVERDUE highlighted.
// - Row actions: Ligar/Desligar (status toggle via PATCH), Editar
//   (billing dialog), Enviar lembrete (POST reminder).
// - "Provisionar cliente" (dialog → POST /api/admin/clients).
//
// Fetches GET /api/admin/clients; refetches after every mutation.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Loader2,
  Pencil,
  UserPlus,
  RefreshCw,
  Users,
  Radio,
  AlertTriangle,
  ShieldCheck,
  Search,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type {
  AdminClientsResponse,
  ClientListRow,
  ClientOverview,
  PlatformAdminUser,
} from "./admin-types";
import {
  formatDate,
  isOverdue,
  trialCountdown,
  STATUS_LABEL,
} from "./admin-format";
import { EditBillingDialog } from "./edit-billing-dialog";
import { ProvisionDialog } from "./provision-dialog";
import { ClientActions } from "./client-actions";

const EMPTY_OVERVIEW: ClientOverview = {
  total: 0,
  active: 0,
  suspended: 0,
  trial: 0,
  canceled: 0,
  deleted: 0,
  overdue: 0,
};

function StatusBadge({ status }: { status: ClientListRow["status"] }) {
  const label = STATUS_LABEL[status];
  if (status === "active") {
    return (
      <Badge className="border-emerald-500/40 bg-emerald-500/10 text-emerald-400">
        {label}
      </Badge>
    );
  }
  if (status === "suspended") {
    return <Badge variant="destructive">{label}</Badge>;
  }
  if (status === "canceled") {
    return (
      <Badge className="border-amber-500/40 bg-amber-500/10 text-amber-400">
        {label}
      </Badge>
    );
  }
  if (status === "deleted") {
    return (
      <Badge className="border-border bg-muted text-muted-foreground">
        {label}
      </Badge>
    );
  }
  return (
    <Badge className="border-sky-500/40 bg-sky-500/10 text-sky-400">
      {label}
    </Badge>
  );
}

/** Which slice of clients the table shows. Cards toggle this. */
type StatusFilter =
  | "all"
  | "active"
  | "trial"
  | "suspended"
  | "canceled"
  | "deleted"
  | "overdue";

function OverviewCard({
  label,
  value,
  tone,
  active,
  onClick,
}: {
  label: string;
  value: number;
  tone?: "default" | "danger";
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button type="button" onClick={onClick} className="w-full text-left">
      <Card
        size="sm"
        className={cn(
          "transition-colors hover:border-primary/50",
          active && "border-primary ring-1 ring-primary/40",
        )}
      >
        <CardContent>
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <p
            className={cn(
              "mt-1 text-2xl font-semibold tabular-nums",
              tone === "danger" && value > 0
                ? "text-destructive"
                : "text-foreground",
            )}
          >
            {value}
          </p>
        </CardContent>
      </Card>
    </button>
  );
}

export function AdminClients() {
  const [clients, setClients] = useState<ClientListRow[]>([]);
  const [overview, setOverview] = useState<ClientOverview>(EMPTY_OVERVIEW);
  const [admins, setAdmins] = useState<PlatformAdminUser[]>([]);
  // The logged-in admin's own id, from the API (no AuthProvider under /admin).
  const [myId, setMyId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // "Meus" vs "Todos": both admins see everything; this just focuses the list.
  const [onlyMine, setOnlyMine] = useState(false);
  // Status slice (driven by the overview cards) + free-text search.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");

  const [provisionOpen, setProvisionOpen] = useState(false);
  const [editClient, setEditClient] = useState<ClientListRow | null>(null);
  const [editOpen, setEditOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/clients", { cache: "no-store" });
      if (!res.ok) {
        toast.error("Não foi possível carregar os clientes.");
        return;
      }
      const data = (await res.json()) as AdminClientsResponse;
      setClients(data.clients ?? []);
      setOverview(data.overview ?? EMPTY_OVERVIEW);
      setAdmins(data.admins ?? []);
      setMyId(data.currentAdminId ?? null);
    } catch (err) {
      console.error("[AdminClients] load error:", err);
      toast.error("Não foi possível conectar ao servidor.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openEdit(client: ClientListRow) {
    setEditClient(client);
    setEditOpen(true);
  }

  const mineCount = myId
    ? clients.filter((c) => c.responsible?.id === myId).length
    : 0;

  // Toggle a status card: clicking the active one (or "Total") clears back to all.
  function pickStatus(next: StatusFilter) {
    setStatusFilter((prev) => (prev === next ? "all" : next));
  }

  const q = query.trim().toLowerCase();
  const visibleClients = clients.filter((c) => {
    if (onlyMine && (!myId || c.responsible?.id !== myId)) return false;
    // Excluídas só aparecem no filtro "Excluídas".
    if (c.status === "deleted" && statusFilter !== "deleted") return false;
    if (statusFilter === "overdue" && !isOverdue(c.dueAt, c.status)) return false;
    if (
      (statusFilter === "active" ||
        statusFilter === "trial" ||
        statusFilter === "suspended" ||
        statusFilter === "canceled" ||
        statusFilter === "deleted") &&
      c.status !== statusFilter
    )
      return false;
    if (q) {
      const hay = [
        c.name,
        c.owner?.email,
        c.responsible?.name,
        c.responsible?.email,
        c.plan,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-xl font-semibold text-foreground">
            Clientes
          </h1>
          <p className="text-sm text-muted-foreground">
            Gerencie as organizações, cobrança e status de cada cliente.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/* Meus / Todos — both admins see everything; this focuses the list. */}
          <div className="flex overflow-hidden rounded-lg border border-border">
            <button
              type="button"
              onClick={() => setOnlyMine(false)}
              className={cn(
                "px-3 py-1.5 text-sm transition-colors",
                !onlyMine
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              Todos ({clients.length})
            </button>
            <button
              type="button"
              onClick={() => setOnlyMine(true)}
              className={cn(
                "px-3 py-1.5 text-sm transition-colors",
                onlyMine
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:text-foreground",
              )}
            >
              Meus ({mineCount})
            </button>
          </div>
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw className="size-4" />
            Atualizar
          </Button>
          <Button onClick={() => setProvisionOpen(true)}>
            <UserPlus className="size-4" />
            Provisionar cliente
          </Button>
        </div>
      </div>

      {/* Overview cards — click to filter the table by status. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        <OverviewCard
          label="Total de clientes"
          value={overview.total}
          active={statusFilter === "all"}
          onClick={() => setStatusFilter("all")}
        />
        <OverviewCard
          label="Ativos"
          value={overview.active}
          active={statusFilter === "active"}
          onClick={() => pickStatus("active")}
        />
        <OverviewCard
          label="Testes"
          value={overview.trial}
          active={statusFilter === "trial"}
          onClick={() => pickStatus("trial")}
        />
        <OverviewCard
          label="Suspensos"
          value={overview.suspended}
          active={statusFilter === "suspended"}
          onClick={() => pickStatus("suspended")}
        />
        <OverviewCard
          label="Vencidos"
          value={overview.overdue}
          tone="danger"
          active={statusFilter === "overdue"}
          onClick={() => pickStatus("overdue")}
        />
        <OverviewCard
          label="Canceladas"
          value={overview.canceled}
          active={statusFilter === "canceled"}
          onClick={() => pickStatus("canceled")}
        />
        <OverviewCard
          label="Excluídas"
          value={overview.deleted}
          active={statusFilter === "deleted"}
          onClick={() => pickStatus("deleted")}
        />
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar por nome, e-mail ou plano…"
          className="w-full rounded-lg border border-border bg-background py-2 pl-9 pr-9 text-sm text-foreground placeholder:text-muted-foreground focus:border-primary focus:outline-none"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground hover:text-foreground"
            title="Limpar busca"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {/* Table */}
      <Card className="p-0">
        <div className="overflow-x-auto">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Carregando clientes…
            </div>
          ) : visibleClients.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              {clients.length === 0
                ? "Nenhum cliente ainda. Use “Provisionar cliente”."
                : q || statusFilter !== "all" || onlyMine
                  ? "Nenhum cliente com esses filtros."
                  : "Nenhum cliente para mostrar."}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Cliente</TableHead>
                  <TableHead>Dono</TableHead>
                  <TableHead>Responsável</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Plano</TableHead>
                  <TableHead>Entrada</TableHead>
                  <TableHead>Vencimento</TableHead>
                  <TableHead className="text-center">Membros</TableHead>
                  <TableHead className="text-center">Canais</TableHead>
                  <TableHead className="text-right">Ações</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleClients.map((c) => {
                  const overdue = isOverdue(c.dueAt, c.status);
                  const mine = !!myId && c.responsible?.id === myId;
                  // Cancelamento agendado ainda no futuro (conta segue ativa).
                  const cancelPending =
                    !!c.cancelAt &&
                    c.status !== "canceled" &&
                    c.status !== "deleted" &&
                    new Date(c.cancelAt).getTime() > Date.now();
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium text-foreground">
                        {c.name}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {c.owner ? (
                          <span className="text-xs">{c.owner.email}</span>
                        ) : (
                          <span className="text-xs italic">sem dono</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {c.responsible ? (
                          <span
                            className={cn(
                              "inline-flex items-center gap-1.5 text-xs",
                              mine
                                ? "font-medium text-primary"
                                : "text-muted-foreground",
                            )}
                          >
                            <ShieldCheck className="size-3.5" />
                            {c.responsible.name || c.responsible.email}
                            {mine ? " (você)" : ""}
                          </span>
                        ) : (
                          <span className="text-xs italic text-muted-foreground">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell>
                        <StatusBadge status={c.status} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {c.plan ?? "—"}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(c.startedAt)}
                      </TableCell>
                      <TableCell>
                        <span
                          className={cn(
                            "inline-flex items-center gap-1",
                            overdue
                              ? "font-medium text-destructive"
                              : "text-muted-foreground",
                          )}
                        >
                          {overdue ? (
                            <AlertTriangle className="size-3.5" />
                          ) : null}
                          {formatDate(c.dueAt)}
                        </span>
                        {c.status === "trial" && trialCountdown(c.dueAt) ? (
                          <span
                            className={cn(
                              "block text-[10px]",
                              overdue ? "text-destructive" : "text-sky-400",
                            )}
                          >
                            {trialCountdown(c.dueAt)}
                          </span>
                        ) : null}
                        {cancelPending ? (
                          <span className="block text-[10px] text-amber-400">
                            cancela em {formatDate(c.cancelAt)}
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-center text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Users className="size-3.5" />
                          {c.memberCount}
                        </span>
                      </TableCell>
                      <TableCell className="text-center text-muted-foreground">
                        <span className="inline-flex items-center gap-1">
                          <Radio className="size-3.5" />
                          {c.channelCount}
                        </span>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {c.status !== "deleted" ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => openEdit(c)}
                              title="Editar cobrança"
                            >
                              <Pencil className="size-3.5" />
                            </Button>
                          ) : null}
                          <ClientActions
                            client={c}
                            onDone={() => void load()}
                          />
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </Card>

      <ProvisionDialog
        open={provisionOpen}
        onOpenChange={setProvisionOpen}
        onProvisioned={() => void load()}
      />
      <EditBillingDialog
        client={editClient}
        admins={admins}
        open={editOpen}
        onOpenChange={setEditOpen}
        onSaved={() => void load()}
      />
    </div>
  );
}

// Shared client-side types for the /admin panel (Phase 8). These mirror
// the server shapes in src/lib/admin/clients.ts (ClientListRow /
// ClientOverview) so the client components don't import server-only code.

export type ClientBillingStatus =
  | "active"
  | "suspended"
  | "trial"
  | "canceled"
  | "deleted";

export interface ClientListRow {
  id: string;
  name: string;
  slug: string | null;
  createdAt: string;
  status: ClientBillingStatus;
  cancelAt: string | null;
  deletedAt: string | null;
  startedAt: string | null;
  dueAt: string | null;
  plan: string | null;
  billingPhone: string | null;
  /** Para onde a cobrança vai — não é o e-mail de login (migr 0195). */
  billingEmail: string | null;
  // Endereço de cobrança (migr 0196). Nada depende dele hoje: existe para a nota
  // fiscal, mais à frente. `billingProvince` é BAIRRO — nome do campo no Asaas.
  billingPostalCode: string | null;
  billingAddress: string | null;
  billingAddressNumber: string | null;
  billingComplement: string | null;
  billingProvince: string | null;
  billingCity: string | null;
  billingState: string | null;
  notes: string | null;
  lastReminderAt: string | null;
  owner: { email: string; name: string } | null;
  responsible: { id: string; email: string; name: string } | null;
  memberCount: number;
  channelCount: number;
  /** Documento do cliente (migr 0191) — é por ele que se acha no Asaas. */
  cpfCnpj: string | null;
  /** Valor realmente contratado por mês. null = usa o preço do plano. */
  monthlyValue: number | null;
  /** Compromisso do contrato: monthly | semiannual | annual. */
  billingCycle: string | null;
  asaasCustomerId: string | null;
  asaasSubscriptionId: string | null;
  /** Cobrança única, semestral/anual (migr 0197). */
  asaasPaymentId: string | null;
}

/** A platform admin (Alex/Rafael) that can own clients — for the picker. */
export interface PlatformAdminUser {
  id: string;
  name: string;
  email: string;
}

export interface ClientOverview {
  total: number;
  active: number;
  suspended: number;
  trial: number;
  canceled: number;
  deleted: number;
  overdue: number;
}

export interface BillingEventRow {
  id: string;
  event: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorType: string;
  actorLabel: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AdminClientsResponse {
  clients: ClientListRow[];
  overview: ClientOverview;
  admins: PlatformAdminUser[];
  /** The requesting admin's own user id — drives the "Meus" filter (the /admin
   *  route has no AuthProvider, so the client can't read it from useAuth). */
  currentAdminId: string;
}

// ============================================================
// Better Auth server instance — the auth source of truth.
//
// Model: organization = tenant (multi-tenancy via the org plugin).
// - UUID ids everywhere (advanced.database.generateId) so domain
//   `account_id` uuid FKs can point at `organization.id`.
// - Email/password only; verification off in dev.
// - Transactional email logged to console in dev (see ./auth/email).
// - On session create we default `activeOrganizationId` to the
//   user's first membership so `getCurrentAccount()` always resolves.
//
// The app's authoritative role logic stays in ./auth/roles.ts; the
// `ac`/`roles` handed to the org plugin only name the four roles.
// ============================================================

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import { eq, asc } from "drizzle-orm";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { ac, roles } from "@/lib/permissions";
import {
  sendResetPassword,
  sendVerificationEmail,
  sendInvitationEmail,
} from "@/lib/auth/email";

export const auth = betterAuth({
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",

  // UUID primary keys / FK columns — required so the domain's uuid
  // account_id columns can reference organization.id.
  advanced: {
    database: {
      generateId: "uuid",
    },
  },

  emailAndPassword: {
    enabled: true,
    // 02/09 (hardening): cadastro só entra depois de confirmar o e-mail.
    // Quem já existia foi marcado como verificado no banco (backfill) —
    // ninguém antigo fica trancado. Membro criado por admin/convite nasce
    // verificado (o admin/convite já garante o e-mail).
    requireEmailVerification: true,
    sendResetPassword,
  },

  emailVerification: {
    sendVerificationEmail,
    // O envio é explícito (rota do trial / tela de cadastro) — não no signUp
    // genérico, senão membro criado pelo admin recebia e-mail à toa.
    sendOnSignUp: false,
    // Tentou entrar sem confirmar → reenvia o link na hora (auto-cura).
    sendOnSignIn: true,
    // Clicou no link → já entra logado.
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24,
  },

  plugins: [
    organization({
      ac,
      roles,
      creatorRole: "owner",
      // Cadastro fechado: ninguém cria organização (tenant) pelo cliente.
      // Clientes são provisionados no /admin (insert direto, não passa por
      // aqui) e atendentes entram por convite (acceptInvitation, não cria org).
      // Isso corta o cadastro "frio" — um estranho não vira um cliente novo.
      allowUserToCreateOrganization: false,
      schema: {
        organization: {
          additionalFields: {
            defaultCurrency: {
              type: "string",
              input: true,
              required: false,
              fieldName: "default_currency",
            },
          },
        },
      },
      sendInvitationEmail,
    }),
  ],

  databaseHooks: {
    session: {
      create: {
        // Default the active organization to the user's first
        // membership so a freshly signed-in session already has a
        // tenant scope (getCurrentAccount reads activeOrganizationId).
        before: async (session) => {
          const firstMembership = await db
            .select({ organizationId: schema.member.organizationId })
            .from(schema.member)
            .where(eq(schema.member.userId, session.userId))
            .orderBy(asc(schema.member.createdAt))
            .limit(1);

          const organizationId = firstMembership[0]?.organizationId ?? null;

          return {
            data: {
              ...session,
              activeOrganizationId: organizationId,
            },
          };
        },
      },
    },
  },
});

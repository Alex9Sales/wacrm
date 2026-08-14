"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import { authClient } from "@/lib/auth-client";

// Phase 1: the browser Supabase client is gone. Auth state is hydrated
// from GET /api/me (session → profile + account). `User` collapses to a
// minimal shape until Better Auth (Phase 2) reintroduces a real user
// object; nothing in the app reads more than `id` off it.
type User = { id: string };
import {
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  canAssignConversations as canAssignConversationsFor,
  canViewDashboard as canViewDashboardFor,
  canSeeAllConversations as canSeeAllConversationsFor,
  isAccountRole,
  type AccountRole,
} from "@/lib/auth/roles";

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  /**
   * Opted-in beta feature keys for this account. No current feature
   * reads this — Flows was the last user and went to soft-GA in PR
   * #134 — but the column survives for future beta gates.
   */
  beta_features: string[];
  account_id: string | null;
  account_role: AccountRole | null;
  /** Phase 8: true when the session email is on the platform-admin
   *  allowlist. Gates the /admin link in the header. */
  is_platform_admin: boolean;
  /** Phase 8: true when the active org's billing is 'suspended'. The
   *  dashboard renders a "conta suspensa" screen when this is set. */
  suspended: boolean;
  /** Fase 2: trial em andamento (não expirado) + quando termina. */
  trial_active: boolean;
  trial_ends_at: string | null;
  /** Fase 2: trial expirado — bloqueia o app. */
  trial_expired: boolean;
}

interface AccountSummary {
  id: string;
  name: string;
  /** Default deal currency (ISO-4217). NOT NULL DEFAULT 'USD' in the
   *  DB (migration 021); narrowed to DEFAULT_CURRENCY when absent. */
  default_currency: string;
}

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  /**
   * Session-level loading. Flips to false as soon as we know whether
   * a user is signed in, *without* waiting for the profile row. Use
   * this for chrome (sidebar / header) that can render with just the
   * user object.
   */
  loading: boolean;
  /**
   * Profile-row loading. Stays true until `fetchProfile` settles
   * (success, missing row, or error). Code that branches on
   * `profile.beta_features` MUST gate on this — otherwise it sees the
   * `{ loading: false, profile: null }` window during initial load
   * and may take the "not opted in" branch incorrectly.
   */
  profileLoading: boolean;
  signOut: () => Promise<void>;
  /** Re-fetch the current user's profile row — call after a save from
   *  the settings form so header/sidebar reflect the change without a
   *  full page reload. */
  refreshProfile: () => Promise<void>;

  // ----------------------------------------------------------
  // Account-scoped context (added by the account-sharing series)
  //
  // All of these are nullable until `profileLoading` is false.
  // After the profile resolves they're guaranteed to be set,
  // because migration 017 made `account_id` / `account_role`
  // NOT NULL on `profiles`.
  // ----------------------------------------------------------

  /** Account id the current user belongs to. Null while loading. */
  accountId: string | null;
  /** Role within that account. Null while loading. */
  accountRole: AccountRole | null;
  /** Lightweight account meta — id + name + default_currency. Null while loading. */
  account: AccountSummary | null;
  /** Account default deal currency. Falls back to DEFAULT_CURRENCY
   *  while loading or when no account is resolved, so callers can use
   *  it unconditionally. */
  defaultCurrency: string;
  /** True if `accountRole === 'owner'`. */
  isOwner: boolean;
  /** True if `accountRole === 'admin'` (does NOT include owner — use canManageMembers for "admin or above"). */
  isAdmin: boolean;
  /** True if `accountRole === 'supervisor'`. */
  isSupervisor: boolean;
  /** True if `accountRole === 'agent'`. */
  isAgent: boolean;
  /** True if `accountRole === 'viewer'`. */
  isViewer: boolean;
  /** True if the caller can manage members (supervisor+). */
  canManageMembers: boolean;
  /** True if the caller can edit account-wide settings (supervisor+). */
  canEditSettings: boolean;
  /** True if the caller can send messages and edit operational data (agent+). */
  canSendMessages: boolean;
  /** True if the caller can assign/reassign conversations and manage sectors (supervisor+). */
  canAssignConversations: boolean;
  /** True if the caller can see the analytics dashboard / Painel (supervisor+). */
  canViewDashboard: boolean;
  /** True if the caller can see every conversation, incl. private (supervisor+). */
  canSeeAllConversations: boolean;
  /** Phase 8: session email is a platform admin (Fluxia operator).
   *  Gates the /admin link. False while loading / outside the provider. */
  isPlatformAdmin: boolean;
  /** Phase 8: active org's billing is 'suspended'. Drives the
   *  dashboard's full-page suspended screen. */
  suspended: boolean;
  /** Fase 2: trial ativo + quando termina (banner de dias). */
  trialActive: boolean;
  trialEndsAt: string | null;
  /** Fase 2: trial expirado — tela de bloqueio + checkout. */
  trialExpired: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * AuthProvider — wrap this around the dashboard layout.
 * Makes ONE getSession() call for the whole tree instead of one per
 * component, avoiding internal lock contention in the Supabase client.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(true);

  // Hydrate the whole auth context from GET /api/me in one round trip.
  // The endpoint resolves the session server-side (Phase 1 dev stub →
  // Better Auth in Phase 2) and returns profile + account already
  // snake_cased to match our types.
  const fetchProfile = useCallback(async () => {
    setProfileLoading(true);
    try {
      const res = await fetch("/api/me", { cache: "no-store" });
      if (res.status === 401) {
        setUser(null);
        setProfile(null);
        setAccount(null);
        return;
      }
      if (!res.ok) {
        console.error("[AuthProvider] /api/me failed:", res.status);
        return;
      }

      const body = (await res.json()) as {
        profile: {
          id: string;
          full_name: string | null;
          email: string;
          avatar_url: string | null;
          role: string | null;
          beta_features: string[] | null;
          account_id: string | null;
          account_role: string | null;
          is_platform_admin?: boolean;
          suspended?: boolean;
          trial_active?: boolean;
          trial_ends_at?: string | null;
          trial_expired?: boolean;
        } | null;
        account: AccountSummary | null;
      };

      if (!body.profile) {
        setUser(null);
        setProfile(null);
        setAccount(null);
        return;
      }

      const accountRole = isAccountRole(body.profile.account_role)
        ? body.profile.account_role
        : null;

      setUser({ id: body.profile.id });
      setProfile({
        id: body.profile.id,
        full_name: body.profile.full_name,
        email: body.profile.email,
        avatar_url: body.profile.avatar_url,
        role: body.profile.role,
        beta_features: body.profile.beta_features ?? [],
        account_id: body.profile.account_id ?? null,
        account_role: accountRole,
        is_platform_admin: body.profile.is_platform_admin ?? false,
        suspended: body.profile.suspended ?? false,
        trial_active: body.profile.trial_active ?? false,
        trial_ends_at: body.profile.trial_ends_at ?? null,
        trial_expired: body.profile.trial_expired ?? false,
      });
      setAccount(
        body.account
          ? {
              id: body.account.id,
              name: body.account.name,
              default_currency:
                body.account.default_currency ?? DEFAULT_CURRENCY,
            }
          : null,
      );
    } catch (err) {
      console.error("[AuthProvider] fetchProfile threw:", err);
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      await fetchProfile();
      if (mounted) setLoading(false);
    })();
    return () => {
      mounted = false;
    };
  }, [fetchProfile]);

  const signOut = useCallback(async () => {
    // Tear down the Better Auth cookie session, then reset local state
    // and redirect to /login.
    try {
      await authClient.signOut();
    } catch (err) {
      console.error("[AuthProvider] signOut failed:", err);
    }
    setUser(null);
    setProfile(null);
    setAccount(null);
    window.location.href = "/login";
  }, []);

  const refreshProfile = useCallback(async () => {
    await fetchProfile();
  }, [fetchProfile]);

  // Derive the role booleans once per profile change rather than on
  // every consumer render. Cheap regardless, but the memo also gives
  // each derived value a stable identity for React.memo / useEffect
  // dependencies downstream.
  const derived = useMemo(() => {
    const role = profile?.account_role ?? null;
    return {
      accountRole: role,
      accountId: profile?.account_id ?? null,
      isOwner: role === "owner",
      isAdmin: role === "admin",
      isSupervisor: role === "supervisor",
      isAgent: role === "agent",
      isViewer: role === "viewer",
      canManageMembers: role ? canManageMembersFor(role) : false,
      canEditSettings: role ? canEditSettingsFor(role) : false,
      canSendMessages: role ? canSendMessagesFor(role) : false,
      canAssignConversations: role ? canAssignConversationsFor(role) : false,
      canViewDashboard: role ? canViewDashboardFor(role) : false,
      canSeeAllConversations: role ? canSeeAllConversationsFor(role) : false,
    };
  }, [profile?.account_role, profile?.account_id]);

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        signOut,
        refreshProfile,
        account,
        defaultCurrency: account?.default_currency ?? DEFAULT_CURRENCY,
        isPlatformAdmin: profile?.is_platform_admin ?? false,
        suspended: profile?.suspended ?? false,
        trialActive: profile?.trial_active ?? false,
        trialEndsAt: profile?.trial_ends_at ?? null,
        trialExpired: profile?.trial_expired ?? false,
        ...derived,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * useAuth — read the shared auth state from context.
 * Must be used inside an <AuthProvider>.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider (shouldn't
    // happen in normal flow, but don't crash the page). Account state
    // collapses to least-privileged null — every `canX` boolean is
    // false so UI gates fail closed.
    return {
      user: null,
      profile: null,
      loading: false,
      profileLoading: false,
      signOut: async () => {
        window.location.href = "/login";
      },
      refreshProfile: async () => {},
      account: null,
      defaultCurrency: DEFAULT_CURRENCY,
      accountId: null,
      accountRole: null,
      isOwner: false,
      isAdmin: false,
      isSupervisor: false,
      isAgent: false,
      isViewer: false,
      canManageMembers: false,
      canEditSettings: false,
      canSendMessages: false,
      canAssignConversations: false,
      canViewDashboard: false,
      canSeeAllConversations: false,
      isPlatformAdmin: false,
      suspended: false,
      trialActive: false,
      trialEndsAt: null,
      trialExpired: false,
    };
  }
  return ctx;
}

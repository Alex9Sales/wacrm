// ============================================================
// Better Auth access-control statements + roles.
//
// Better Auth's organization plugin needs an access-control (`ac`)
// object and a role map so it can gate its own member/invitation
// operations. This is DELIBERATELY thin — the app's authoritative
// role policy lives in `src/lib/auth/roles.ts` (roleRank + capability
// predicates). Here we only wire the four role NAMES that must match
// exactly: owner / admin / agent / viewer.
//
// Statement resources are Better Auth's org defaults (organization,
// member, invitation, team) plus a couple of app-level buckets so
// agent≈member-with-write and viewer≈read-only read naturally.
// ============================================================

import { createAccessControl } from "better-auth/plugins/access";
import {
  defaultStatements,
  adminAc,
  ownerAc,
  memberAc,
} from "better-auth/plugins/organization/access";

/**
 * The full statement surface. We extend the org plugin's default
 * statements with an app-level `data` resource so agent/viewer have
 * a meaningful, distinct grant even though the real enforcement is
 * in roles.ts.
 */
export const statement = {
  ...defaultStatements,
  data: ["read", "write"],
} as const;

export const ac = createAccessControl(statement);

/** Owner — everything the org plugin's owner can do + full data. */
export const owner = ac.newRole({
  ...ownerAc.statements,
  data: ["read", "write"],
});

/** Admin — manage members/invitations + full data. */
export const admin = ac.newRole({
  ...adminAc.statements,
  data: ["read", "write"],
});

/** Agent — member-with-write: read the org, write operational data. */
export const agent = ac.newRole({
  ...memberAc.statements,
  data: ["read", "write"],
});

/** Viewer — read-only across the board. */
export const viewer = ac.newRole({
  ...memberAc.statements,
  data: ["read"],
});

/** Role map handed to both server (`auth.ts`) and client (`auth-client.ts`). */
export const roles = { owner, admin, agent, viewer } as const;

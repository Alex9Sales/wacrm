// ============================================================
// Transactional email — DEV console logger.
//
// Better Auth calls these hooks to deliver verification / reset /
// invitation links. In dev we just log the URL so flows can be
// exercised end-to-end without an SMTP/Resend account.
//
// TODO(email): plug Resend/SMTP for production. Keep the function
// signatures — Better Auth passes { user, url, token } (and the org
// plugin passes an invitation shape); we only ever need `url`.
// ============================================================

interface ConsoleEmailArgs {
  /** Recipient — either a Better Auth user or an invitation email. */
  to: string;
  /** What kind of link this is, for the log line. */
  subject: string;
  /** The action URL the user must open. */
  url: string;
}

function logEmail({ to, subject, url }: ConsoleEmailArgs): void {
  // eslint-disable-next-line no-console
  console.log(
    `\n[email:dev] ${subject}\n  to:  ${to}\n  url: ${url}\n`,
  );
}

/** Password reset link. */
export async function sendResetPassword(args: {
  user: { email: string };
  url: string;
  token: string;
}): Promise<void> {
  logEmail({ to: args.user.email, subject: "Reset your password", url: args.url });
}

/** Email verification link. */
export async function sendVerificationEmail(args: {
  user: { email: string };
  url: string;
  token: string;
}): Promise<void> {
  logEmail({
    to: args.user.email,
    subject: "Verify your email",
    url: args.url,
  });
}

/**
 * Organization invitation link. The org plugin passes an invitation
 * object; it does not hand us a ready-made URL, so we build one from
 * the invitation id (which is the join token — see the contract).
 */
export async function sendInvitationEmail(args: {
  id: string;
  email: string;
  organization: { name: string };
  inviter: { user: { email: string } };
}): Promise<void> {
  const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const url = `${base}/join/${args.id}`;
  logEmail({
    to: args.email,
    subject: `Invitation to join ${args.organization.name}`,
    url,
  });
}

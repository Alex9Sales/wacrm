// ============================================================
// Transactional email — Resend (produção) com fallback de console (dev).
//
// O Better Auth chama estes hooks para entregar links de verificação /
// reset de senha / convite. Em produção enviamos via Resend; se
// RESEND_API_KEY não estiver setada (dev/local), só logamos a URL no
// console para exercitar o fluxo sem conta de e-mail.
//
// Envs:
//   RESEND_API_KEY  — chave da API do Resend (sem ela = modo console).
//   EMAIL_FROM      — remetente, ex.: "Fluxia <nao-responda@salestecnologia.com.br>".
//                     O domínio precisa estar verificado no Resend.
// ============================================================

import { Resend } from "resend";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM =
  process.env.EMAIL_FROM ?? "Fluxia <nao-responda@salestecnologia.com.br>";

// Instancia o cliente só quando há chave — evita erro em dev/local.
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

/**
 * Envia um e-mail. Com RESEND_API_KEY → Resend; sem ela → console (dev).
 * Nunca lança: uma falha de e-mail não deve derrubar o fluxo de auth
 * (o usuário vê o erro na tela e tenta de novo).
 */
async function sendEmail(args: {
  to: string;
  subject: string;
  html: string;
  /** Fallback de texto puro (o link) para o modo console. */
  url: string;
}): Promise<void> {
  if (!resend) {
    console.log(
      `\n[email:dev] ${args.subject}\n  to:  ${args.to}\n  url: ${args.url}\n`,
    );
    return;
  }
  try {
    const { error } = await resend.emails.send({
      from: EMAIL_FROM,
      to: args.to,
      subject: args.subject,
      html: args.html,
    });
    if (error) {
      console.error(`[email] Resend falhou (${args.subject}):`, error);
    }
  } catch (err) {
    console.error(`[email] erro ao enviar (${args.subject}):`, err);
  }
}

/**
 * Layout base do e-mail (pt-BR, marca Fluxia). `intro` explica a ação,
 * `buttonLabel`/`url` são o CTA, `footer` é a linha de segurança.
 */
function layout(args: {
  title: string;
  intro: string;
  buttonLabel: string;
  url: string;
  footer: string;
}): string {
  return `
  <div style="margin:0;padding:24px;background:#0f0f11;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
    <div style="max-width:480px;margin:0 auto;background:#1a1a1f;border:1px solid #2a2a32;border-radius:16px;overflow:hidden;">
      <div style="padding:24px 28px;border-bottom:1px solid #2a2a32;">
        <span style="font-size:18px;font-weight:700;color:#a78bfa;">Fluxia</span>
      </div>
      <div style="padding:28px;">
        <h1 style="margin:0 0 12px;font-size:20px;color:#f5f5f7;">${args.title}</h1>
        <p style="margin:0 0 24px;font-size:14px;line-height:1.6;color:#c7c7cf;">${args.intro}</p>
        <a href="${args.url}" style="display:inline-block;background:#7c3aed;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;">${args.buttonLabel}</a>
        <p style="margin:24px 0 0;font-size:12px;line-height:1.6;color:#8a8a94;">${args.footer}</p>
        <p style="margin:16px 0 0;font-size:12px;color:#6a6a74;word-break:break-all;">Ou copie este link: ${args.url}</p>
      </div>
    </div>
  </div>`;
}

/** Link de reset de senha. */
export async function sendResetPassword(args: {
  user: { email: string };
  url: string;
  token: string;
}): Promise<void> {
  await sendEmail({
    to: args.user.email,
    subject: "Redefinir sua senha — Fluxia",
    url: args.url,
    html: layout({
      title: "Redefinir sua senha",
      intro:
        "Recebemos um pedido para redefinir a senha da sua conta no Fluxia. Clique no botão abaixo para escolher uma nova senha.",
      buttonLabel: "Redefinir senha",
      url: args.url,
      footer:
        "O link expira em breve. Se você não pediu isso, pode ignorar este e-mail — sua senha continua a mesma.",
    }),
  });
}

/** Link de verificação de e-mail. */
export async function sendVerificationEmail(args: {
  user: { email: string };
  url: string;
  token: string;
}): Promise<void> {
  await sendEmail({
    to: args.user.email,
    subject: "Confirme seu e-mail — Fluxia",
    url: args.url,
    html: layout({
      title: "Confirme seu e-mail",
      intro:
        "Para ativar sua conta no Fluxia, confirme seu endereço de e-mail clicando no botão abaixo.",
      buttonLabel: "Confirmar e-mail",
      url: args.url,
      footer: "Se você não criou uma conta no Fluxia, pode ignorar este e-mail.",
    }),
  });
}

/**
 * Convite de organização. O plugin de org passa o objeto do convite; a
 * URL é montada a partir do id (que é o token de join — ver contrato).
 */
export async function sendInvitationEmail(args: {
  id: string;
  email: string;
  organization: { name: string };
  inviter: { user: { email: string } };
}): Promise<void> {
  const base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000";
  const url = `${base}/join/${args.id}`;
  await sendEmail({
    to: args.email,
    subject: `Convite para entrar em ${args.organization.name} — Fluxia`,
    url,
    html: layout({
      title: `Você foi convidado para ${args.organization.name}`,
      intro: `${args.inviter.user.email} convidou você para entrar na equipe de ${args.organization.name} no Fluxia. Clique abaixo para aceitar e criar seu acesso.`,
      buttonLabel: "Aceitar convite",
      url,
      footer:
        "Se você não esperava este convite, pode ignorar este e-mail com segurança.",
    }),
  });
}

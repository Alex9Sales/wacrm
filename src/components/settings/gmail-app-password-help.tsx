// ============================================================
// Ajuda "como gerar a senha de app do Google" — usada na criação do canal
// Gmail e na troca de senha (channel-gmail-password-dialog).
//
// 15/09 (GoLink): o Google cancelou a senha de app quando a senha da conta foi
// trocada, e ninguém sabia que isso acontecia. O aviso fica nos dois lugares.
// ============================================================

export function GmailAppPasswordHelp({
  showDedicatedTip = true,
}: {
  showDedicatedTip?: boolean;
}) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      Como pegar a senha de app: ative a{' '}
      <strong>verificação em 2 etapas</strong> no Google, depois vá em{' '}
      <a
        href="https://myaccount.google.com/apppasswords"
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        Senhas de app
      </a>{' '}
      e gere uma — cole as 16 letras.
      <br />
      Se alguém trocar a senha da conta Google, o Google cancela as senhas de
      app e é preciso gerar outra.
      {showDedicatedTip && (
        <>
          <br />
          ⚠️ Use um <strong>Gmail dedicado</strong> do negócio: a gente lê a
          caixa de entrada dele.
        </>
      )}
    </div>
  );
}

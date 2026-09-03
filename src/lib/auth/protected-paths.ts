// ============================================================
// Rotas do app (área logada). Usado pelo middleware (edge) e pelo cliente
// (AuthProvider) — por isso é PURO, sem imports.
//
// 02/09: o middleware só protegia /dashboard, /admin e /api. Qualquer outra
// rota (/inbox, /settings, /supervisao…) sem sessão válida devolvia 200 com a
// casca do app; aí o cliente tomava 401 em tudo, ficava numa tela quebrada e
// abas antigas faziam polling sem sessão por horas (1.100 UnauthorizedError
// num dia). Agora TODA rota da área logada exige cookie de sessão.
// ============================================================

export const APP_PATH_PREFIXES = [
  '/dashboard',
  '/admin',
  '/agenda',
  '/aprovacoes',
  '/agendamentos',
  '/agents',
  '/automations',
  '/broadcasts',
  '/calls',
  '/captacao',
  '/contacts',
  '/empresas',
  '/flows',
  '/inbox',
  '/internal-chat',
  '/notifications',
  '/pipelines',
  '/propostas',
  '/prospeccao',
  '/recompra',
  '/relatorios',
  '/settings',
  '/social',
  '/supervisao',
  '/suporte',
  '/tarefas',
] as const

/** true quando o caminho é uma tela da área logada (exige sessão). */
export function isAppPath(pathname: string): boolean {
  return APP_PATH_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
}

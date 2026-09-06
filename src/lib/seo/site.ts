// ============================================================
// 🌐 Dados públicos do site — UMA fonte para metadata, JSON-LD, sitemap e
// robots. O domínio canônico é o do CRM (o apex redireciona pra cá).
// ============================================================

export const SITE_URL = 'https://crm.salestecnologia.com.br'
export const SITE_NAME = 'FluxiaCRM'
export const ORG_NAME = 'Sales Tecnologia'
export const ORG_CITY = 'Campo Grande'
export const ORG_REGION = 'MS'
export const ORG_COUNTRY = 'BR'
export const WHATSAPP_URL = 'https://wa.me/556791806048?text=Quero%20saber%20mais%20sobre%20o%20FluxiaCRM'
export const INSTAGRAM_URL = 'https://www.instagram.com/fluxia.oficial4/'
export const TRIAL_PATH = '/comecar'

/** Posicionamento curto, usado em title/OG/schema. Uma frase, sempre a mesma. */
export const TAGLINE = 'CRM com agentes de IA para vendas, atendimento e follow-up automático'
export const TAGLINE_SHORT = 'CRM autônomo supervisionado para empresas que vendem por conversa.'

/** Preços reais dos planos (fonte: lib/billing/plans.ts) — o schema NUNCA inventa preço. */
export const PLAN_PRICES_BRL = { start: 139.9, essencial: 497, pro: 799, enterprise: 1999 } as const

export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith('/') ? path : `/${path}`}`
}

/** Páginas públicas indexáveis — alimentam o sitemap e os breadcrumbs. */
export interface PublicPage {
  path: string
  title: string
  changeFrequency: 'weekly' | 'monthly'
  priority: number
}

export const PUBLIC_PAGES: PublicPage[] = [
  { path: '/', title: 'Início', changeFrequency: 'weekly', priority: 1 },
  { path: '/como-funciona', title: 'Como funciona', changeFrequency: 'monthly', priority: 0.9 },
  { path: '/crm-autonomo', title: 'CRM autônomo', changeFrequency: 'monthly', priority: 0.9 },
  { path: '/crm-com-ia', title: 'CRM com IA', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/crm-whatsapp', title: 'CRM para WhatsApp', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/ia-para-vendas', title: 'IA para vendas', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/follow-up-automatico', title: 'Follow-up automático', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/agentes-de-ia', title: 'Agentes de IA', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/customer-intelligence', title: 'Customer Intelligence', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/cases/familia-do-gas', title: 'Case: Família do Gás', changeFrequency: 'monthly', priority: 0.8 },
  { path: '/sobre', title: 'Sobre', changeFrequency: 'monthly', priority: 0.6 },
  { path: '/diagnostico', title: 'Diagnóstico gratuito', changeFrequency: 'monthly', priority: 0.7 },
  { path: '/privacidade', title: 'Privacidade', changeFrequency: 'monthly', priority: 0.3 },
  { path: '/termos', title: 'Termos de uso', changeFrequency: 'monthly', priority: 0.3 },
  { path: '/exclusao-de-dados', title: 'Exclusão de dados', changeFrequency: 'monthly', priority: 0.3 },
]

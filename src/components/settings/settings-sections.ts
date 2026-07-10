import {
  Building2,
  Coins,
  FileText,
  Headset,
  KeyRound,
  LayoutGrid,
  MessageSquare,
  Palette,
  Shield,
  Tags,
  User,
  UsersRound,
  Webhook,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'channels',
  'setores',
  'atendimento',
  'respostas',
  'templates',
  'fields',
  'deals',
  'members',
  'integrations',
  'api',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/** Rail grouping. `adminOnly` items are hidden for non-admins. */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
}

export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'Visão geral', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', label: 'Seu perfil', icon: User, group: 'account' },
  security: { id: 'security', label: 'Login e segurança', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', label: 'Aparência', icon: Palette, group: 'account' },
  channels: { id: 'channels', label: 'Canais', icon: MessageSquare, group: 'workspace' },
  setores: { id: 'setores', label: 'Setores', icon: Building2, group: 'workspace' },
  atendimento: { id: 'atendimento', label: 'Atendimento', icon: Headset, group: 'workspace' },
  respostas: { id: 'respostas', label: 'Respostas rápidas', icon: Zap, group: 'workspace' },
  templates: { id: 'templates', label: 'Templates', icon: FileText, group: 'workspace' },
  fields: { id: 'fields', label: 'Campos e etiquetas', icon: Tags, group: 'workspace' },
  deals: { id: 'deals', label: 'Negócios e moeda', icon: Coins, group: 'workspace' },
  members: { id: 'members', label: 'Membros da equipe', icon: UsersRound, group: 'workspace' },
  integrations: { id: 'integrations', label: 'Integrações', icon: Webhook, group: 'workspace' },
  api: { id: 'api', label: 'Chaves de API', icon: KeyRound, group: 'workspace' },
};

export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'CONTA', group: 'account' },
  { label: 'ÁREA DE TRABALHO', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section; the old single-Meta "whatsapp" tab →
 * the multi-channel "Canais" section). Anything unknown falls back to
 * the Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  if (raw === 'whatsapp') return 'channels';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}

import { pgTable, uniqueIndex, check, uuid, text, timestamp, index, foreignKey, unique, primaryKey, jsonb, integer, smallint, boolean, numeric, date, vector, customType } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

// tsvector is not a built-in drizzle column type; the column is a
// GENERATED ALWAYS STORED FTS column, read-only from app code.
const tsvector = customType<{ data: string }>({
	dataType() {
		return "tsvector";
	},
})

// ============================================================
// Better Auth tables (multi-tenancy = organization).
//
// Hand-written to mirror Better Auth 1.6.23's expected schema with
// uuid ids (advanced.database.generateId = "uuid"). Column NAMES use
// Better Auth's default camelCase-in-TS with snake_case DB names for
// multi-word columns. `organization` carries the extra
// `default_currency` additionalField. `member.role` is plain text
// (owner/admin/agent/viewer) — the app validates it via roles.ts.
// ============================================================

export const user = pgTable("user", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	email: text().notNull(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	image: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	unique("user_email_key").on(table.email),
]);

export const session = pgTable("session", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	token: text().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	ipAddress: text("ip_address"),
	userAgent: text("user_agent"),
	activeOrganizationId: uuid("active_organization_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "session_user_id_fkey"
		}).onDelete("cascade"),
	unique("session_token_key").on(table.token),
]);

export const account = pgTable("account", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: text("account_id").notNull(),
	providerId: text("provider_id").notNull(),
	accessToken: text("access_token"),
	refreshToken: text("refresh_token"),
	idToken: text("id_token"),
	accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true, mode: 'string' }),
	refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true, mode: 'string' }),
	scope: text(),
	password: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "account_user_id_fkey"
		}).onDelete("cascade"),
]);

export const verification = pgTable("verification", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	identifier: text().notNull(),
	value: text().notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const organization = pgTable("organization", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	slug: text(),
	logo: text(),
	metadata: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	// Property name MUST match the additionalField `fieldName` in
	// src/lib/auth.ts ("default_currency") — the Better Auth Drizzle
	// adapter resolves additionalFields by that key on the table object.
	default_currency: text("default_currency").default('USD').notNull(),
}, (table) => [
	unique("organization_slug_key").on(table.slug),
]);

export const member = pgTable("member", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	organizationId: uuid("organization_id").notNull(),
	role: text().default('member').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_member_organization").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	index("idx_member_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.userId],
			foreignColumns: [user.id],
			name: "member_user_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "member_organization_id_fkey"
		}).onDelete("cascade"),
]);

export const invitation = pgTable("invitation", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	email: text().notNull(),
	inviterId: uuid("inviter_id").notNull(),
	organizationId: uuid("organization_id").notNull(),
	role: text(),
	status: text().default('pending').notNull(),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_invitation_organization").using("btree", table.organizationId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "invitation_organization_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.inviterId],
			foreignColumns: [user.id],
			name: "invitation_inviter_id_fkey"
		}).onDelete("cascade"),
]);

// ============================================================
// ORGANIZATION_BILLING — super-admin (Phase 8) billing satellite.
//
// 1:1 with `organization` (PK = organization_id, FK cascade). Holds
// the SaaS-operator (Fluxia) billing + status metadata that lives
// ABOVE the org's own data. `status` drives suspension enforcement in
// getCurrentAccount (status='suspended' → AccountSuspendedError).
// ============================================================
export const organizationBilling = pgTable("organization_billing", {
	organizationId: uuid("organization_id").primaryKey().notNull(),
	status: text().default('active').notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }),
	plan: text(),
	billingPhone: text("billing_phone"),
	notes: text(),
	lastReminderAt: timestamp("last_reminder_at", { withTimezone: true, mode: 'string' }),
	// Assinatura no Asaas (gateway de pagamento). Setados no checkout; o webhook
	// /api/webhooks/asaas vira o status pra 'active' quando o pagamento confirma.
	asaasCustomerId: text("asaas_customer_id"),
	asaasSubscriptionId: text("asaas_subscription_id"),
	// Ciclo de vida (migr 0102): cancel_at = fim do período pago quando o cliente
	// cancela (o acesso vale ATÉ lá; depois vira 'canceled'). deleted_at =
	// soft-delete (mantém o registro + histórico, mas bloqueia e some da lista).
	cancelAt: timestamp("cancel_at", { withTimezone: true, mode: 'string' }),
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	// Platform admin (Alex/Rafael) responsible for this client. Set on
	// provision, editable to transfer. Nullable, no FK (a removed admin just
	// makes the row show "—"). Drives the /admin "Responsável" column + filter.
	responsibleAdminId: uuid("responsible_admin_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "organization_billing_organization_id_fkey"
		}).onDelete("cascade"),
	check("organization_billing_status_check", sql`status = ANY (ARRAY['active'::text, 'suspended'::text, 'trial'::text, 'canceled'::text])`),
]);

// ============================================================
// billing_events (migr 0102) — trilha de auditoria do ciclo de vida da conta:
// provisionamento, ativação, suspensão, reativação, cancelamento, exclusão,
// mudança de plano, lembrete, pagamento. Quem (admin/cliente/sistema), quando e
// por quê. Lida só pelo /admin (platform admin).
// ============================================================
export const billingEvents = pgTable("billing_events", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	organizationId: uuid("organization_id").notNull(),
	// provisioned | activated | suspended | reactivated | canceled | deleted |
	// plan_changed | reminder_sent | payment_received | …
	event: text().notNull(),
	fromStatus: text("from_status"),
	toStatus: text("to_status"),
	// admin | client | system
	actorType: text("actor_type").default('admin').notNull(),
	actorId: uuid("actor_id"),
	actorLabel: text("actor_label"),
	reason: text(),
	metadata: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_billing_events_org").using("btree", table.organizationId.asc().nullsLast(), table.createdAt.desc().nullsLast()),
	foreignKey({
			columns: [table.organizationId],
			foreignColumns: [organization.id],
			name: "billing_events_organization_id_fkey"
		}).onDelete("cascade"),
]);

export const contacts = pgTable("contacts", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	phone: text().notNull(),
	phoneNormalized: text("phone_normalized").generatedAlwaysAs(sql`regexp_replace(phone, '\D'::text, ''::text, 'g'::text)`),
	name: text(),
	email: text(),
	// `company` = texto livre legado (mantido p/ compat: {{empresa}} nos disparos
	// + import CSV). `companyId` = vínculo com a entidade Empresa (migração 0067).
	company: text(),
	companyId: uuid("company_id"),
	// Código(s) do cliente no ERP do cliente (múltiplos por contato). Exibido
	// ao lado do nome, editável, exportável/importável em CSV e via API v1.
	customerCodes: text("customer_codes").array().notNull().default(sql`'{}'::text[]`),
	avatarUrl: text("avatar_url"),
	// A "contact" that is actually a WhatsApp group (phone holds the group
	// jid's digits, name the group name). Only set for monitored groups.
	isGroup: boolean("is_group").default(false).notNull(),
	// Id externo do canal quando não há telefone (ex.: IGSID do Instagram Direct).
	// Migração 0095. Unicidade por (conta, external_id) no índice abaixo.
	externalId: text("external_id"),
	// "Não perturbe" / opt-out (anti-ban, migração 0105): true = a pessoa pediu
	// pra não receber mais. Disparos e agendadas PULAM esse contato (atendente
	// ainda responde 1:1 normal). Setado quando responde SAIR/toca "não quero".
	optedOut: boolean("opted_out").default(false).notNull(),
	optedOutAt: timestamp("opted_out_at", { withTimezone: true, mode: 'string' }),
	optedOutReason: text("opted_out_reason"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_contacts_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("idx_contacts_account_phone_normalized").using("btree", table.accountId.asc().nullsLast().op("text_ops"), table.phoneNormalized.asc().nullsLast().op("text_ops")).where(sql`(phone_normalized <> ''::text)`),
	uniqueIndex("idx_contacts_account_external_id").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.externalId.asc().nullsLast().op("text_ops")).where(sql`(external_id IS NOT NULL)`),
	index("idx_contacts_phone").using("btree", table.phone.asc().nullsLast().op("text_ops")),
	index("idx_contacts_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "contacts_account_id_fkey"
		}).onDelete("cascade"),
	index("idx_contacts_company").using("btree", table.companyId.asc().nullsLast().op("uuid_ops")),
]);

// Empresas como ENTIDADE (IA v2 roadmap — Fase "Empresas"). Antes "empresa" era
// só um texto livre no contato; agora é uma entidade própria com contatos e
// (Fase 2) negócios vinculados. Migração 0067. A FK contacts.company_id é criada
// na migração (aqui só a coluna, p/ não depender da ordem de definição no Drizzle).
export const companies = pgTable("companies", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	segment: text(),
	website: text(),
	phone: text(),
	notes: text(),
	// Ficha rica (Empresas v2 — migração 0108).
	document: text(),
	email: text(),
	address: text(),
	size: text(),
	assignedTo: uuid("assigned_to"),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_companies_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("idx_companies_account_name").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), sql`lower(${table.name})`),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "companies_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.assignedTo],
			foreignColumns: [user.id],
			name: "companies_assigned_to_fkey"
		}).onDelete("set null"),
]);

// Histórico/atividade da EMPRESA (timeline: notas + eventos) — migração 0108.
export const companyEvents = pgTable("company_events", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	companyId: uuid("company_id").notNull(),
	actorUserId: uuid("actor_user_id"),
	type: text().notNull(),
	data: jsonb().default(sql`'{}'::jsonb`).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_company_events_company").using("btree", table.companyId.asc().nullsLast().op("uuid_ops"), table.createdAt.asc().nullsLast()),
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "company_events_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.companyId], foreignColumns: [companies.id], name: "company_events_company_id_fkey" }).onDelete("cascade"),
]);

// Anexos/arquivos da EMPRESA (metadados; binário no MinIO) — migração 0108.
export const companyAttachments = pgTable("company_attachments", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	companyId: uuid("company_id").notNull(),
	name: text().notNull(),
	url: text().notNull(),
	mime: text(),
	size: integer(),
	uploadedBy: uuid("uploaded_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_company_attachments_company").using("btree", table.companyId.asc().nullsLast().op("uuid_ops")),
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "company_attachments_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.companyId], foreignColumns: [companies.id], name: "company_attachments_company_id_fkey" }).onDelete("cascade"),
]);

// Catálogo de PRODUTOS/SERVIÇOS da conta (Config → Produtos e serviços).
// Reutilizável nos produtos do negócio (deal_products). Migração 0070.
export const products = pgTable("products", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	description: text(),
	// 'product' | 'service' — só rótulo/organização.
	kind: text().default('product').notNull(),
	unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).default('0').notNull(),
	linkUrl: text("link_url"),
	imageUrl: text("image_url"),
	active: boolean().default(true).notNull(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_products_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "products_account_id_fkey"
		}).onDelete("cascade"),
]);

export const tags = pgTable("tags", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	color: text().default('#3b82f6').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_tags_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "tags_account_id_fkey"
		}).onDelete("cascade"),
]);

// Etiquetas da EMPRESA (reusa tags, como contact_tags) — migração 0108.
// Definido APÓS `tags` (o FK referencia tags.id — sem forward-reference).
export const companyTags = pgTable("company_tags", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	companyId: uuid("company_id").notNull(),
	tagId: uuid("tag_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	uniqueIndex("idx_company_tags_unique").using("btree", table.companyId.asc().nullsLast().op("uuid_ops"), table.tagId.asc().nullsLast().op("uuid_ops")),
	index("idx_company_tags_company").using("btree", table.companyId.asc().nullsLast().op("uuid_ops")),
	foreignKey({ columns: [table.companyId], foreignColumns: [companies.id], name: "company_tags_company_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.tagId], foreignColumns: [tags.id], name: "company_tags_tag_id_fkey" }).onDelete("cascade"),
]);

export const contactTags = pgTable("contact_tags", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	contactId: uuid("contact_id").notNull(),
	tagId: uuid("tag_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_contact_tags_contact").using("btree", table.contactId.asc().nullsLast().op("uuid_ops")),
	index("idx_contact_tags_tag").using("btree", table.tagId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "contact_tags_contact_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.tagId],
			foreignColumns: [tags.id],
			name: "contact_tags_tag_id_fkey"
		}).onDelete("cascade"),
	unique("contact_tags_contact_id_tag_id_key").on(table.contactId, table.tagId),
]);

// Etiqueta no ATENDENTE (migração 0090) — reusa `tags` da conta pra marcar
// membros (ex.: "Gerente"). A IA transfere pra quem tem a etiqueta escolhida.
export const memberTags = pgTable("member_tags", {
	memberId: uuid("member_id").notNull(),
	tagId: uuid("tag_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.memberId, table.tagId], name: "member_tags_pkey" }),
	index("member_tags_tag_idx").using("btree", table.tagId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.memberId],
			foreignColumns: [member.id],
			name: "member_tags_member_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.tagId],
			foreignColumns: [tags.id],
			name: "member_tags_tag_id_fkey"
		}).onDelete("cascade"),
]);

export const customFields = pgTable("custom_fields", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	fieldName: text("field_name").notNull(),
	fieldType: text("field_type").default('text').notNull(),
	fieldOptions: jsonb("field_options"),
	// Escopo do campo: 'contact' (default) ou 'deal' (negócio). Migração 0113.
	entity: text().default('contact').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_custom_fields_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "custom_fields_account_id_fkey"
		}).onDelete("cascade"),
]);

export const contactCustomValues = pgTable("contact_custom_values", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	contactId: uuid("contact_id").notNull(),
	customFieldId: uuid("custom_field_id").notNull(),
	value: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "contact_custom_values_contact_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.customFieldId],
			foreignColumns: [customFields.id],
			name: "contact_custom_values_custom_field_id_fkey"
		}).onDelete("cascade"),
	unique("contact_custom_values_contact_id_custom_field_id_key").on(table.contactId, table.customFieldId),
]);

// Valores dos campos personalizados DO NEGÓCIO (migração 0113). Espelha
// contact_custom_values. FKs no SQL da migração.
export const dealCustomValues = pgTable("deal_custom_values", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	dealId: uuid("deal_id").notNull(),
	customFieldId: uuid("custom_field_id").notNull(),
	value: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_deal_custom_values_deal").using("btree", table.dealId.asc().nullsLast().op("uuid_ops")),
	unique("deal_custom_values_deal_id_custom_field_id_key").on(table.dealId, table.customFieldId),
]);

// Metas de venda por responsável (migração 0114). 1 meta mensal por pessoa.
export const salesGoals = pgTable("sales_goals", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	userId: uuid("user_id").notNull(),
	targetValue: numeric("target_value", { precision: 14, scale: 2 }).default('0').notNull(),
	targetCount: integer("target_count").default(0).notNull(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_sales_goals_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	unique("sales_goals_account_id_user_id_key").on(table.accountId, table.userId),
]);

// Distribuição automática de leads (rodízio). 1 config por conta. Migração 0115.
export const leadDistribution = pgTable("lead_distribution", {
	accountId: uuid("account_id").primaryKey().notNull(),
	enabled: boolean().default(false).notNull(),
	strategy: text().default('round_robin').notNull(), // 'round_robin' | 'load'
	memberIds: jsonb("member_ids").default([]).notNull(),
	lastAssignedUserId: uuid("last_assigned_user_id"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

// Captação self-serve — formulários públicos por conta (migração 0118).
export const captureForms = pgTable("capture_forms", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	slug: text().notNull(),
	name: text().notNull(),
	headline: text(),
	description: text(),
	successMessage: text("success_message"),
	submitLabel: text("submit_label"),
	fields: jsonb().default([]).notNull(),
	content: jsonb(),
	// IA no Segundo Zero (migração 0124): primeira mensagem da IA no WhatsApp
	// segundos após o envio do formulário.
	aiIntro: boolean("ai_intro").default(false).notNull(),
	introChannelId: uuid("intro_channel_id"),
	// Link Zap + QR rastreado (migração 0125): ref curto no wa.me/QR → card com
	// a origem exata quando o "Oi" chega no inbound.
	waRef: text("wa_ref"),
	waLeads: integer("wa_leads").default(0).notNull(),
	// Obrigado que Vende (migração 0126): oferta + botão de zap + cadência.
	successOfferTitle: text("success_offer_title"),
	successOfferText: text("success_offer_text"),
	successWhatsapp: boolean("success_whatsapp").default(false).notNull(),
	cadenceId: uuid("cadence_id"),
	pipelineId: uuid("pipeline_id"),
	stageId: uuid("stage_id"),
	origin: text().default('Formulário').notNull(),
	theme: text().default('light').notNull(),
	active: boolean().default(true).notNull(),
	submissions: integer().default(0).notNull(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("idx_capture_forms_slug").using("btree", table.slug.asc().nullsLast().op("text_ops")),
	index("idx_capture_forms_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
]);

// Página de agendamento pública tipo Calendly (migração 0127).
export const schedulers = pgTable("schedulers", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	slug: text().notNull(),
	name: text().notNull(),
	headline: text(),
	description: text(),
	userId: uuid("user_id").notNull(),
	durationMinutes: integer("duration_minutes").default(30).notNull(),
	availability: jsonb().default([]).notNull(),
	minNoticeHours: integer("min_notice_hours").default(12).notNull(),
	horizonDays: integer("horizon_days").default(14).notNull(),
	location: text(),
	pipelineId: uuid("pipeline_id"),
	stageId: uuid("stage_id"),
	origin: text().default('Agendamento').notNull(),
	confirmWhatsapp: boolean("confirm_whatsapp").default(true).notNull(),
	confirmChannelId: uuid("confirm_channel_id"),
	active: boolean().default(true).notNull(),
	bookings: integer().default(0).notNull(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("idx_schedulers_slug").using("btree", table.slug.asc().nullsLast().op("text_ops")),
	index("idx_schedulers_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
]);

// 🌐 Domínio próprio das páginas de captação: o cliente aponta um CNAME e as
// páginas /f/* passam a responder no domínio dele (roteado por Host no
// middleware → /custom-domain). `verified` vira true após a checagem de DNS.
export const captureDomains = pgTable("capture_domains", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	domain: text().notNull(),
	verified: boolean().default(false).notNull(),
	verifiedAt: timestamp("verified_at", { withTimezone: true, mode: 'string' }),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("idx_capture_domains_domain").using("btree", table.domain.asc().nullsLast().op("text_ops")),
	index("idx_capture_domains_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
]);

// 🔒 Pendências do follow gate: quem comentou mas ainda não segue. Entrega
// acontece quando a pessoa responde a DM já seguindo (hook no inbound).
export const instagramFollowGatePending = pgTable("instagram_follow_gate_pending", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	channelId: uuid("channel_id").notNull(),
	automationId: uuid("automation_id").notNull(),
	igUserId: text("ig_user_id").notNull(),
	reminded: boolean().default(false).notNull(),
	delivered: boolean().default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	uniqueIndex("idx_ig_fgate_rule_user").using("btree", table.automationId.asc().nullsLast().op("uuid_ops"), table.igUserId.asc().nullsLast().op("text_ops")),
]);

// 📸 Stories (social selling): auto-DM pra quem responde/menciona story.
export const instagramStorySettings = pgTable("instagram_story_settings", {
	channelId: uuid("channel_id").primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	replyEnabled: boolean("reply_enabled").default(false).notNull(),
	replyMessage: text("reply_message"),
	mentionEnabled: boolean("mention_enabled").default(false).notNull(),
	mentionMessage: text("mention_message"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

// Anti-spam dos stories: 1 auto-DM por pessoa/tipo a cada 24h.
export const instagramStoryLog = pgTable("instagram_story_log", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	channelId: uuid("channel_id").notNull(),
	igUserId: text("ig_user_id").notNull(),
	kind: text().notNull(),
	lastSentAt: timestamp("last_sent_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("idx_ig_story_log_unique").using("btree", table.channelId.asc().nullsLast().op("uuid_ops"), table.igUserId.asc().nullsLast().op("text_ops"), table.kind.asc().nullsLast().op("text_ops")),
]);

export const contactNotes = pgTable("contact_notes", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	contactId: uuid("contact_id").notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	noteText: text("note_text").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_contact_notes_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "contact_notes_contact_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "contact_notes_account_id_fkey"
		}).onDelete("cascade"),
]);

// ============================================================
// CHANNELS — multi-provider WhatsApp (Phase 4). Replaces
// whatsapp_config. One row per connected WhatsApp channel
// (Meta / WAHA / Evolution / EvoGo). `credentials` is an
// AES-256-GCM-encrypted JSON blob whose shape depends on the
// provider (see docs/fase4-multicanal.md). Non-secret routing
// info (phone_number_id, waba_id, baseUrl, session/instance)
// lives in `provider_meta`.
//
// Defined before `conversations` so its channel_id FK can
// reference channels.id (Drizzle resolves FK targets eagerly).
// ============================================================
export const channels = pgTable("channels", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	provider: text().notNull(),
	name: text().notNull(),
	status: text().default('disconnected').notNull(),
	phoneNumber: text("phone_number"),
	// Encrypted JSON — provider-specific tokens/keys/session.
	credentials: text().notNull(),
	providerMeta: jsonb("provider_meta").default({}).notNull(),
	settings: jsonb().default({}).notNull(),
	// Phase 2 routing: new conversations that arrive on this channel are
	// routed to this sector by default (keyword matches on the first message
	// can still override). Null = no default → the general (null) queue. FK
	// to sectors is declared in the migration (sectors is defined below).
	defaultSectorId: uuid("default_sector_id"),
	// Per-channel token used to validate non-Meta webhook deliveries.
	webhookSecret: text("webhook_secret").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_channels_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	// Partial unique index for Meta inbound routing — resolve a channel
	// by provider_meta->>'phone_number_id'. Only meta channels carry one.
	uniqueIndex("channels_meta_pnid")
		.using("btree", sql`((provider_meta->>'phone_number_id'))`)
		.where(sql`(provider = 'meta'::text)`),
	// Roteamento do webhook do Instagram: acha o canal por provider_meta->>'ig_id'.
	uniqueIndex("channels_ig_id")
		.using("btree", sql`((provider_meta->>'ig_id'))`)
		.where(sql`(provider = 'instagram'::text)`),
	// Roteamento do webhook do Messenger: acha o canal por provider_meta->>'page_id'.
	uniqueIndex("channels_page_id")
		.using("btree", sql`((provider_meta->>'page_id'))`)
		.where(sql`(provider = 'messenger'::text)`),
	// Roteamento do webhook de E-mail: acha o canal pelo endereço (minúsculo).
	uniqueIndex("channels_email_addr")
		.using("btree", sql`((lower(provider_meta->>'address')))`)
		.where(sql`(provider = 'email'::text)`),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "channels_account_id_fkey"
		}).onDelete("cascade"),
	unique("channels_account_id_name_key").on(table.accountId, table.name),
	check("channels_provider_check", sql`provider = ANY (ARRAY['meta'::text, 'waha'::text, 'evolution'::text, 'evogo'::text, 'instagram'::text, 'messenger'::text, 'email'::text, 'gmail'::text])`),
	check("channels_status_check", sql`status = ANY (ARRAY['disconnected'::text, 'qr_pending'::text, 'connected'::text, 'error'::text])`),
]);

// ============================================================
// Anúncios de Lead (Lead Ads) — fontes de lead do TikTok e do Meta
// (Facebook/Instagram). NÃO é um canal de mensagem: é INGESTÃO. Um lead que
// preenche o formulário do anúncio vira contato + card no funil (o mesmo
// caminho do POST /api/v1/leads → ingestLead). O webhook roteia por
// external_account_id (page_id no Meta, advertiser_id no TikTok) + form_id.
// ============================================================
export const leadAdSources = pgTable("lead_ad_sources", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	// 'tiktok' | 'meta' | 'linkedin'
	provider: text().notNull(),
	name: text().notNull(),
	status: text().default('connected').notNull(),
	// Chave de roteamento do webhook: page_id (Meta) / advertiser_id (TikTok).
	externalAccountId: text("external_account_id"),
	// Amarra a um formulário específico (opcional; null = qualquer formulário).
	formId: text("form_id"),
	// Token de acesso CRIPTOGRAFADO (AES-256-GCM, mesma cripto dos canais).
	accessToken: text("access_token").notNull(),
	// Token de verificação do webhook (GET, Meta). Auto-gera se não vier.
	verifyToken: text("verify_token"),
	// Funil/etapa de destino (null = primeiro funil/etapa da conta).
	pipelineId: uuid("pipeline_id"),
	stageId: uuid("stage_id"),
	// Entregar lead novo pra IA (WhatsApp de abertura). Off por padrão.
	deliverToAi: boolean("deliver_to_ai").default(false).notNull(),
	enabled: boolean().default(true).notNull(),
	providerMeta: jsonb("provider_meta").default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_lead_ad_sources_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	// Roteamento do webhook: acha a fonte por (provider, external_account_id).
	index("idx_lead_ad_sources_route").using("btree", table.provider.asc().nullsLast(), table.externalAccountId.asc().nullsLast()),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "lead_ad_sources_account_id_fkey"
		}).onDelete("cascade"),
	unique("lead_ad_sources_account_id_name_key").on(table.accountId, table.name),
	check("lead_ad_sources_provider_check", sql`provider = ANY (ARRAY['tiktok'::text, 'meta'::text, 'linkedin'::text])`),
]);

export const conversations = pgTable("conversations", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	contactId: uuid("contact_id").notNull(),
	// Phase 4: the channel this conversation belongs to. Nullable during
	// the migration window (legacy rows predate multi-channel); the
	// inbound pipeline always sets it. Uniqueness is one conversation per
	// (account_id, contact_id, channel_id).
	channelId: uuid("channel_id"),
	status: text().default('open').notNull(),
	// Conversation priority (Chatwoot-style). CHECK in
	// ('none','low','medium','high','urgent'); defaults to 'none'.
	priority: text().default('none').notNull(),
	assignedAgentId: uuid("assigned_agent_id"),
	// When the current agent was assigned — resets the SLA clock so a
	// just-reassigned conversation gives the new agent the full window.
	assignedAt: timestamp("assigned_at", { withTimezone: true, mode: 'string' }),
	// Sector (department) this conversation belongs to. NULL = general queue
	// (visible to everyone); otherwise only members of the sector see it.
	sectorId: uuid("sector_id"),
	// Handoff note written when the conversation was transferred to a sector —
	// shown to the receiving agent as a banner. Cleared on dismiss.
	transferNote: text("transfer_note"),
	transferNoteAt: timestamp("transfer_note_at", { withTimezone: true, mode: 'string' }),
	transferNoteBy: uuid("transfer_note_by"),
	// Set when a CSAT survey was sent on close and we're awaiting the 1–5 reply.
	csatPendingAt: timestamp("csat_pending_at", { withTimezone: true, mode: 'string' }),
	// The csat_responses id awaiting a free-text comment (next customer message).
	csatCommentPending: uuid("csat_comment_pending"),
	lastMessageText: text("last_message_text"),
	lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: 'string' }),
	// Follow-up inteligente (migr 0080): quando o último follow-up automático saiu.
	// Garante 1 por silêncio — só volta a disparar após o cliente responder.
	lastFollowUpAt: timestamp("last_follow_up_at", { withTimezone: true, mode: 'string' }),
	// Escada (v2, migr 0081): degrau atual do episódio (nº de follow-ups já enviados).
	followUpStep: integer("follow_up_step").default(0).notNull(),
	unreadCount: integer("unread_count").default(0),
	aiAutoreplyDisabled: boolean("ai_autoreply_disabled").default(false).notNull(),
	// 🔀 Agente de IA "dono" da conversa (roteamento multiagente). NULL = por canal.
	aiAgentId: uuid("ai_agent_id"),
	aiReplyCount: integer("ai_reply_count").default(0).notNull(),
	// Preferência de voz do cliente (ferramenta voice_pref, migração 0091):
	// 'audio' | 'text' | null. A IA enviesa o formato da resposta.
	voicePreference: text("voice_preference"),
	// Private conversation (migration 0032): only the assigned agent, admins,
	// supervisors and explicit participants see it — hidden from the general
	// queue and from agents it isn't assigned to.
	isPrivate: boolean("is_private").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_conversations_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	// Perf (migr 0097): inbox lista por account_id ordenando por last_message_at DESC.
	index("idx_conversations_account_last_msg").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.lastMessageAt.desc().nullsLast()),
	index("idx_conversations_contact_id").using("btree", table.contactId.asc().nullsLast().op("uuid_ops")),
	index("idx_conversations_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	index("idx_conversations_channel").using("btree", table.channelId.asc().nullsLast().op("uuid_ops")).where(sql`(channel_id IS NOT NULL)`),
	// One conversation per (account, contact, channel). Partial so legacy
	// rows with a NULL channel_id don't collide (NULLs are distinct in a
	// non-partial unique index anyway, but the predicate documents intent).
	uniqueIndex("conversations_account_contact_channel_key").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.contactId.asc().nullsLast().op("uuid_ops"), table.channelId.asc().nullsLast().op("uuid_ops")).where(sql`(channel_id IS NOT NULL)`),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "conversations_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "conversations_contact_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "conversations_channel_id_fkey"
		}).onDelete("cascade"),
	check("conversations_status_check", sql`status = ANY (ARRAY['open'::text, 'pending'::text, 'closed'::text])`),
]);

// Histórico de ligações ("Ligações" panel, WhatsApp-style). One row per call
// on any transport (waha-voip or Meta). Inbound is born 'missed' and promoted
// to 'answered'/'rejected' by the call.accepted/rejected webhook; outbound is
// born 'dialing' and finalized by the modal's hangup.
export const callLogs = pgTable("call_logs", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	channelId: uuid("channel_id"),
	contactId: uuid("contact_id"),
	// Raw peer chatId (556…@c.us or …@lid) or E.164 digits.
	peer: text().notNull(),
	direction: text().notNull(),
	status: text().notNull(),
	provider: text().default('waha').notNull(),
	externalCallId: text("external_call_id"),
	durationSec: integer("duration_sec"),
	// The agent who took the call. Claimed atomically (UPDATE ... WHERE
	// claimed_by IS NULL) so only one of the ringing agents wins.
	claimedBy: uuid("claimed_by"),
	// When this leg finished. "Channel busy right now" = ended_at IS NULL.
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("call_logs_account_created").on(table.accountId, table.createdAt.desc()),
]);

export const messages = pgTable("messages", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	conversationId: uuid("conversation_id").notNull(),
	// Conta desnormalizada (migração 0111): preenchida por trigger a partir da
	// conversa. Evita Seq Scan nas agregações de mensagem (painel/relatórios).
	accountId: uuid("account_id"),
	senderType: text("sender_type").notNull(),
	senderId: uuid("sender_id"),
	contentType: text("content_type").default('text').notNull(),
	contentText: text("content_text"),
	mediaUrl: text("media_url"),
	templateName: text("template_name"),
	messageId: text("message_id"),
	status: text().default('sent').notNull(),
	// Setado quando a mensagem foi EDITADA (WhatsApp "Editada"). Migração 0061.
	editedAt: timestamp("edited_at", { withTimezone: true, mode: 'string' }),
	replyToMessageId: uuid("reply_to_message_id"),
	interactiveReplyId: text("interactive_reply_id"),
	// Speech-to-text of an inbound audio/voice note (null until transcribed).
	transcription: text("transcription"),
	// WhatsApp "view once" media — persisted so an agent can re-open it.
	viewOnce: boolean("view_once").default(false).notNull(),
	// Internal note: written in the thread but never sent to the customer —
	// for @mentioning a colleague without leaving the conversation.
	isInternal: boolean("is_internal").default(false).notNull(),
	// GROUP messages only: the stable key of the participant who sent this
	// message (phone digits when known, else LID user-part) — same key space as
	// group_participant_names.wa_key. Lets the inbox render a per-author avatar
	// next to each group bubble. Null for 1:1 and for our own (fromMe) echoes.
	authorKey: text("author_key"),
	// Set when the message was DELETED on WhatsApp (revoked/"apagar para todos").
	// The bubble renders a "Mensagem apagada" placeholder; the original content
	// stays in the row for audit but is hidden in the UI.
	deletedAt: timestamp("deleted_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_messages_conversation").using("btree", table.conversationId.asc().nullsLast().op("uuid_ops")),
	// Perf (migr 0097): abrir conversa busca por conversation_id ordenando por created_at DESC (+ id p/ cursor).
	index("idx_messages_conversation_created").using("btree", table.conversationId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsLast(), table.id.desc().nullsLast()),
	index("idx_messages_message_id").using("btree", table.messageId.asc().nullsLast().op("text_ops")),
	index("idx_messages_reply_to").using("btree", table.replyToMessageId.asc().nullsLast().op("uuid_ops")).where(sql`(reply_to_message_id IS NOT NULL)`),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "messages_conversation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.replyToMessageId],
			foreignColumns: [table.id],
			name: "messages_reply_to_message_id_fkey"
		}).onDelete("set null"),
	check("messages_sender_type_check", sql`sender_type = ANY (ARRAY['customer'::text, 'agent'::text, 'bot'::text])`),
	check("messages_status_check", sql`status = ANY (ARRAY['sending'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'failed'::text])`),
	check("messages_content_type_check", sql`content_type = ANY (ARRAY['text'::text, 'image'::text, 'document'::text, 'audio'::text, 'video'::text, 'location'::text, 'template'::text, 'interactive'::text])`),
]);

export const messageReactions = pgTable("message_reactions", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	messageId: uuid("message_id").notNull(),
	conversationId: uuid("conversation_id").notNull(),
	actorType: text("actor_type").notNull(),
	actorId: uuid("actor_id"),
	emoji: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_message_reactions_conversation").using("btree", table.conversationId.asc().nullsLast().op("uuid_ops")),
	index("idx_message_reactions_message").using("btree", table.messageId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.messageId],
			foreignColumns: [messages.id],
			name: "message_reactions_message_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "message_reactions_conversation_id_fkey"
		}).onDelete("cascade"),
	unique("message_reactions_message_id_actor_type_actor_id_key").on(table.messageId, table.actorType, table.actorId),
	check("message_reactions_actor_type_check", sql`actor_type = ANY (ARRAY['customer'::text, 'agent'::text])`),
]);

export const pipelines = pgTable("pipelines", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	// Estilo da barra de etapas no detalhe: 'pills' | 'chevrons'. Migração 0053.
	stepperStyle: text("stepper_style").default('pills').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_pipelines_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "pipelines_account_id_fkey"
		}).onDelete("cascade"),
]);

export const messageTemplates = pgTable("message_templates", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	// Phase 4: templates only exist on Meta channels. Nullable during
	// migration; new templates bind to a meta channel.
	channelId: uuid("channel_id"),
	name: text().notNull(),
	category: text().default('Marketing').notNull(),
	language: text().default('en_US'),
	headerType: text("header_type"),
	headerContent: text("header_content"),
	bodyText: text("body_text").notNull(),
	footerText: text("footer_text"),
	buttons: jsonb(),
	status: text().default('DRAFT'),
	sampleValues: jsonb("sample_values"),
	metaTemplateId: text("meta_template_id"),
	rejectionReason: text("rejection_reason"),
	qualityScore: text("quality_score"),
	headerHandle: text("header_handle"),
	headerMediaUrl: text("header_media_url"),
	submissionError: text("submission_error"),
	lastSubmittedAt: timestamp("last_submitted_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_message_templates_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_message_templates_meta_template_id").using("btree", table.metaTemplateId.asc().nullsLast().op("text_ops")).where(sql`(meta_template_id IS NOT NULL)`),
	uniqueIndex("message_templates_user_name_language_key").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.name.asc().nullsLast().op("uuid_ops"), table.language.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "message_templates_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "message_templates_channel_id_fkey"
		}).onDelete("cascade"),
	check("message_templates_category_check", sql`category = ANY (ARRAY['Marketing'::text, 'Utility'::text, 'Authentication'::text])`),
	check("message_templates_header_type_check", sql`header_type = ANY (ARRAY['text'::text, 'image'::text, 'video'::text, 'document'::text])`),
	check("message_templates_status_meta_check", sql`status = ANY (ARRAY['DRAFT'::text, 'PENDING'::text, 'APPROVED'::text, 'REJECTED'::text, 'PAUSED'::text, 'DISABLED'::text, 'IN_APPEAL'::text, 'PENDING_DELETION'::text])`),
	check("message_templates_quality_score_check", sql`(quality_score IS NULL) OR (quality_score = ANY (ARRAY['GREEN'::text, 'YELLOW'::text, 'RED'::text]))`),
	check("message_templates_buttons_shape_check", sql`(buttons IS NULL) OR ((jsonb_typeof(buttons) = 'array'::text) AND (jsonb_array_length(buttons) <= 10))`),
]);

export const pipelineStages = pgTable("pipeline_stages", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	pipelineId: uuid("pipeline_id").notNull(),
	name: text().notNull(),
	position: integer().default(0).notNull(),
	color: text().default('#3b82f6').notNull(),
	// Orientações por etapa (estilo RD) — migração 0062.
	objective: text(),
	guidance: text(),
	// Probabilidade de fechamento (0–100) p/ a previsão de receita — migração 0116.
	probability: integer().default(50).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_pipeline_stages_pipeline").using("btree", table.pipelineId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.pipelineId],
			foreignColumns: [pipelines.id],
			name: "pipeline_stages_pipeline_id_fkey"
		}).onDelete("cascade"),
]);

// Atividades automáticas por etapa (migração 0110). Templates de tarefa que
// são materializados em `tasks` quando um negócio ENTRA na etapa.
export const stageTaskTemplates = pgTable("stage_task_templates", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	stageId: uuid("stage_id").notNull(),
	title: text().notNull(),
	description: text(),
	dueOffsetDays: integer("due_offset_days").default(0).notNull(),
	type: text(),
	position: integer().default(0).notNull(),
	active: boolean().default(true).notNull(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_stage_task_templates_stage").using("btree", table.stageId.asc().nullsLast().op("uuid_ops")),
	index("idx_stage_task_templates_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "stage_task_templates_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.stageId], foreignColumns: [pipelineStages.id], name: "stage_task_templates_stage_id_fkey" }).onDelete("cascade"),
]);

// Cadências (migração 0112) — sequência de mensagens fixas multicanal. FKs no
// SQL da migração (evita forward-ref no schema); aqui só colunas + índices.
export const cadences = pgTable("cadences", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	description: text(),
	active: boolean().default(true).notNull(),
	pauseOnReply: boolean("pause_on_reply").default(true).notNull(),
	// Automação de funil (opt-in): move o negócio ao inscrever/responder e
	// marca perdido + fecha a conversa ao terminar sem resposta.
	funnelAutomation: boolean("funnel_automation").default(false).notNull(),
	// Etapa de "contato feito" — pra onde o negócio vai ao inscrever/responder.
	contactedStageId: uuid("contacted_stage_id"),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_cadences_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
]);

export const cadenceSteps = pgTable("cadence_steps", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	cadenceId: uuid("cadence_id").notNull(),
	position: integer().default(0).notNull(),
	delayValue: integer("delay_value").default(0).notNull(),
	delayUnit: text("delay_unit").default('days').notNull(),
	channel: text().default('whatsapp').notNull(),
	subject: text(),
	body: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_cadence_steps_cadence").using("btree", table.cadenceId.asc().nullsLast().op("uuid_ops"), table.position.asc().nullsLast().op("int4_ops")),
]);

export const cadenceEnrollments = pgTable("cadence_enrollments", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	cadenceId: uuid("cadence_id").notNull(),
	contactId: uuid("contact_id").notNull(),
	conversationId: uuid("conversation_id"),
	dealId: uuid("deal_id"),
	status: text().default('active').notNull(),
	enrolledBy: uuid("enrolled_by"),
	enrolledAt: timestamp("enrolled_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_cadence_enroll_account_status").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("idx_cadence_enroll_deal").using("btree", table.dealId.asc().nullsLast().op("uuid_ops")),
]);

export const cadenceEvents = pgTable("cadence_events", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	enrollmentId: uuid("enrollment_id").notNull(),
	cadenceId: uuid("cadence_id"),
	contactId: uuid("contact_id"),
	dealId: uuid("deal_id"),
	type: text().notNull(),
	stepPosition: integer("step_position"),
	channel: text(),
	data: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_cadence_events_enrollment").using("btree", table.enrollmentId.asc().nullsLast().op("uuid_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_cadence_events_contact").using("btree", table.contactId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsLast().op("timestamptz_ops")),
]);

export const deals = pgTable("deals", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	pipelineId: uuid("pipeline_id").notNull(),
	stageId: uuid("stage_id").notNull(),
	contactId: uuid("contact_id"),
	// Empresa vinculada ao negócio (Empresas Fase 2, migração 0068). FK criada na
	// migração (aqui só a coluna, p/ não depender da ordem no Drizzle).
	companyId: uuid("company_id"),
	conversationId: uuid("conversation_id"),
	assignedTo: uuid("assigned_to"),
	title: text().notNull(),
	value: numeric({ precision: 12, scale:  2 }).default('0').notNull(),
	currency: text().default('USD'),
	notes: text(),
	expectedCloseDate: date("expected_close_date"),
	status: text().default('open'),
	// Campos extras do lead (estilo RD) — migração 0050.
	temperature: text(),
	source: text(),
	origin: text(),
	// Paridade RD — migração 0060.
	lostReason: text("lost_reason"),
	qualification: smallint("qualification"),
	stageChangedAt: timestamp("stage_changed_at", { withTimezone: true, mode: 'string' }),
	// Follow-up por etapa: quando o último follow-up de entrada de etapa saiu —
	// migração 0092. Dispara de novo só quando entra numa etapa nova.
	stageFollowUpAt: timestamp("stage_follow_up_at", { withTimezone: true, mode: 'string' }),
	// Próximo follow-up agendado (visível no card) — migração 0093. Setado ao
	// entrar numa etapa-gatilho; limpo ao disparar.
	nextFollowUpAt: timestamp("next_follow_up_at", { withTimezone: true, mode: 'string' }),
	// Pausar negociação (estilo RD) — migração 0063.
	pausedAt: timestamp("paused_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_deals_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_deals_assigned_to").using("btree", table.assignedTo.asc().nullsLast().op("uuid_ops")),
	index("idx_deals_pipeline").using("btree", table.pipelineId.asc().nullsLast().op("uuid_ops")),
	index("idx_deals_stage").using("btree", table.stageId.asc().nullsLast().op("uuid_ops")),
	index("idx_deals_company").using("btree", table.companyId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "deals_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.pipelineId],
			foreignColumns: [pipelines.id],
			name: "deals_pipeline_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.stageId],
			foreignColumns: [pipelineStages.id],
			name: "deals_stage_id_fkey"
		}),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "deals_contact_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "deals_conversation_id_fkey"
		}),
	foreignKey({
			columns: [table.assignedTo],
			foreignColumns: [user.id],
			name: "deals_assigned_to_fkey"
		}).onDelete("set null"),
	check("deals_status_check", sql`status = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text])`),
]);

// Contatos ADICIONAIS de um negócio (Empresas Fase 2 — migração 0068). O contato
// PRINCIPAL continua em deals.contact_id; esta tabela guarda os demais (vários
// contatos por negócio, estilo RD). UNIQUE(deal_id, contact_id) evita duplicar.
export const dealContacts = pgTable("deal_contacts", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	dealId: uuid("deal_id").notNull(),
	contactId: uuid("contact_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("idx_deal_contacts_deal_contact").using("btree", table.dealId.asc().nullsLast().op("uuid_ops"), table.contactId.asc().nullsLast().op("uuid_ops")),
	index("idx_deal_contacts_deal").using("btree", table.dealId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.dealId],
			foreignColumns: [deals.id],
			name: "deal_contacts_deal_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "deal_contacts_contact_id_fkey"
		}).onDelete("cascade"),
]);

// Histórico do lead (timeline estilo RD): created / stage_changed / status_changed
// (won|lost|reopened) / note. `data` carrega o payload por tipo (nomes das
// etapas, texto da anotação, etc.). Migração 0049.
export const dealEvents = pgTable("deal_events", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	dealId: uuid("deal_id").notNull(),
	actorUserId: uuid("actor_user_id"),
	type: text().notNull(),
	data: jsonb().default(sql`'{}'::jsonb`).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_deal_events_deal").using("btree", table.dealId.asc().nullsLast().op("uuid_ops"), table.createdAt.asc().nullsLast()),
	index("idx_deal_events_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
		columns: [table.accountId],
		foreignColumns: [organization.id],
		name: "deal_events_account_id_fkey",
	}).onDelete("cascade"),
	foreignKey({
		columns: [table.dealId],
		foreignColumns: [deals.id],
		name: "deal_events_deal_id_fkey",
	}).onDelete("cascade"),
]);

// Produtos (itens) de um negócio — nome × qtd × preço unitário. Migração 0051.
export const dealProducts = pgTable("deal_products", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	dealId: uuid("deal_id").notNull(),
	name: text().notNull(),
	quantity: numeric({ precision: 12, scale: 2 }).default('1').notNull(),
	unitPrice: numeric("unit_price", { precision: 12, scale: 2 }).default('0').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_deal_products_deal").using("btree", table.dealId.asc().nullsLast().op("uuid_ops")),
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "deal_products_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.dealId], foreignColumns: [deals.id], name: "deal_products_deal_id_fkey" }).onDelete("cascade"),
]);

// IA para Negociações v2 — Fase 1: sugestões por evidência. Migração 0064.
export const dealSuggestions = pgTable("deal_suggestions", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	dealId: uuid("deal_id").notNull(),
	kind: text().default('field').notNull(),
	target: text().notNull(),
	label: text().notNull(),
	value: text().notNull(),
	evidence: text(),
	// Fase 2 (kind='task'): quando o follow-up sugerido deve vencer.
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }),
	status: text().default('pending').notNull(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_deal_suggestions_deal").using("btree", table.dealId.asc().nullsLast(), table.status.asc().nullsLast()),
	foreignKey({ columns: [table.dealId], foreignColumns: [deals.id], name: "deal_suggestions_deal_id_fkey" }).onDelete("cascade"),
]);

// Arquivos/anexos de um negócio — metadados (binário no MinIO). Migração 0051.
export const dealAttachments = pgTable("deal_attachments", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	dealId: uuid("deal_id").notNull(),
	name: text().notNull(),
	url: text().notNull(),
	mime: text(),
	size: integer(),
	uploadedBy: uuid("uploaded_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_deal_attachments_deal").using("btree", table.dealId.asc().nullsLast().op("uuid_ops")),
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "deal_attachments_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.dealId], foreignColumns: [deals.id], name: "deal_attachments_deal_id_fkey" }).onDelete("cascade"),
]);

// Questionários (perguntas de qualificação) do negócio. Migração 0052.
export const dealQuestions = pgTable("deal_questions", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	dealId: uuid("deal_id").notNull(),
	question: text().notNull(),
	answer: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_deal_questions_deal").using("btree", table.dealId.asc().nullsLast().op("uuid_ops")),
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "deal_questions_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.dealId], foreignColumns: [deals.id], name: "deal_questions_deal_id_fkey" }).onDelete("cascade"),
]);

// E-mails registrados/anexados ao negócio (registro, não envio). Migração 0052.
export const dealEmails = pgTable("deal_emails", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	dealId: uuid("deal_id").notNull(),
	subject: text().notNull(),
	body: text(),
	actorUserId: uuid("actor_user_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_deal_emails_deal").using("btree", table.dealId.asc().nullsLast().op("uuid_ops")),
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "deal_emails_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.dealId], foreignColumns: [deals.id], name: "deal_emails_deal_id_fkey" }).onDelete("cascade"),
]);

// Proposta do negócio (documento profissional) — migração 0109. 1 por negócio
// (unique deal_id). O `id` é o token do link público /proposta/<id>.
export const dealProposals = pgTable("deal_proposals", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	dealId: uuid("deal_id").notNull(),
	discount: numeric({ precision: 12, scale: 2 }).default('0').notNull(),
	discountType: text("discount_type").default('value').notNull(),
	validUntil: date("valid_until"),
	terms: text(),
	createdBy: uuid("created_by"),
	// Marca sobrescrita por proposta (migração 0119): null = usa o perfil da conta.
	sellerOverride: jsonb("seller_override"),
	// Aceite digital + rastreio (migração 0117).
	viewedAt: timestamp("viewed_at", { withTimezone: true, mode: 'string' }),
	acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: 'string' }),
	acceptorName: text("acceptor_name"),
	acceptorDocument: text("acceptor_document"),
	acceptorIp: text("acceptor_ip"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("idx_deal_proposals_deal").using("btree", table.dealId.asc().nullsLast().op("uuid_ops")),
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "deal_proposals_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.dealId], foreignColumns: [deals.id], name: "deal_proposals_deal_id_fkey" }).onDelete("cascade"),
]);

export const broadcasts = pgTable("broadcasts", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	// Channel the broadcast sends on. Nullable so the worker can resolve
	// the channel after a restart (the channel used to live only in the
	// transient BroadcastPlan); falls back to the default channel when null.
	channelId: uuid("channel_id"),
	// 'template' = Meta approved-template broadcast (official). 'text' = a
	// free-text drip on a non-official channel (WAHA/Evolution/EvoGo),
	// humanized-paced. bodyText holds the message for 'text' broadcasts.
	messageKind: text("message_kind").default('template').notNull(),
	bodyText: text("body_text"),
	// Assunto quando o canal do disparo é e-mail (migração 0128); WhatsApp ignora.
	subject: text(),
	// Múltiplos anexos (migração 0129): [{url,type,filename}]. null = usa as
	// colunas media_url/media_type/media_filename antigas (single).
	media: jsonb(),
	// Anti-ban (migração 0105): anexa uma opção de descadastro no fim de cada
	// mensagem 'text' (WAHA = "responda SAIR"; oficial usa botões no template).
	// Ligado por padrão pra disparos de texto.
	includeOptOut: boolean("include_opt_out").default(true).notNull(),
	// Optional media attachment for a 'text' broadcast (image/video/document/
	// audio). mediaUrl is the public (proxy) URL the provider fetches.
	mediaUrl: text("media_url"),
	mediaType: text("media_type"),
	mediaFilename: text("media_filename"),
	// Pacing config for humanized 'text' drips: { dailyCap, startMin, endMin,
	// days:[1..6], offsetMin }. Null → send as fast as the throughput limiter
	// allows (template/burst path).
	pacing: jsonb(),
	// Nullable: 'text' broadcasts carry no Meta template.
	templateName: text("template_name"),
	templateLanguage: text("template_language").default('en_US').notNull(),
	templateVariables: jsonb("template_variables"),
	audienceFilter: jsonb("audience_filter"),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }),
	status: text().default('draft').notNull(),
	totalRecipients: integer("total_recipients").default(0),
	sentCount: integer("sent_count").default(0),
	deliveredCount: integer("delivered_count").default(0),
	readCount: integer("read_count").default(0),
	repliedCount: integer("replied_count").default(0),
	failedCount: integer("failed_count").default(0),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_broadcasts_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "broadcasts_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "broadcasts_channel_id_fkey"
		}).onDelete("set null"),
	check("broadcasts_status_check", sql`status = ANY (ARRAY['draft'::text, 'scheduled'::text, 'sending'::text, 'paused'::text, 'cancelled'::text, 'sent'::text, 'failed'::text])`),
]);

export const broadcastRecipients = pgTable("broadcast_recipients", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	broadcastId: uuid("broadcast_id").notNull(),
	contactId: uuid("contact_id"),
	status: text().default('pending').notNull(),
	// Send attempts (queue retries). Reuses error_message for last error.
	attempts: integer().default(0).notNull(),
	// Per-recipient body params ({{1}}, {{2}}…) — persisted so the queue
	// worker can rebuild the template send after a process restart (they
	// used to live only in the transient BroadcastPlan).
	params: jsonb().default(sql`'[]'::jsonb`),
	// Structured per-send values (header text/media, URL/COPY_CODE button
	// values) — the dashboard's richer send path. Null for API sends that
	// only use positional `params`.
	messageParams: jsonb("message_params"),
	whatsappMessageId: text("whatsapp_message_id"),
	// Humanized drip: the computed instant this recipient should be sent.
	// Null for burst/template broadcasts (sent as fast as the limiter allows).
	scheduledSlotAt: timestamp("scheduled_slot_at", { withTimezone: true, mode: 'string' }),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }),
	deliveredAt: timestamp("delivered_at", { withTimezone: true, mode: 'string' }),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'string' }),
	repliedAt: timestamp("replied_at", { withTimezone: true, mode: 'string' }),
	errorMessage: text("error_message"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow(),
}, (table) => [
	index("idx_broadcast_recipients_broadcast").using("btree", table.broadcastId.asc().nullsLast().op("uuid_ops")),
	index("idx_broadcast_recipients_broadcast_status").using("btree", table.broadcastId.asc().nullsLast().op("text_ops"), table.status.asc().nullsLast().op("text_ops")),
	uniqueIndex("idx_broadcast_recipients_wamid").using("btree", table.whatsappMessageId.asc().nullsLast().op("text_ops")).where(sql`(whatsapp_message_id IS NOT NULL)`),
	foreignKey({
			columns: [table.broadcastId],
			foreignColumns: [broadcasts.id],
			name: "broadcast_recipients_broadcast_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "broadcast_recipients_contact_id_fkey"
		}).onDelete("set null"),
	check("broadcast_recipients_status_check", sql`status = ANY (ARRAY['pending'::text, 'sent'::text, 'delivered'::text, 'read'::text, 'replied'::text, 'failed'::text])`),
]);

export const automations = pgTable("automations", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	description: text(),
	triggerType: text("trigger_type").notNull(),
	triggerConfig: jsonb("trigger_config").default({}).notNull(),
	isActive: boolean("is_active").default(false).notNull(),
	executionCount: integer("execution_count").default(0).notNull(),
	lastExecutedAt: timestamp("last_executed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_automations_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_automations_account_active_trigger").using("btree", table.accountId.asc().nullsLast().op("text_ops"), table.triggerType.asc().nullsLast().op("text_ops")).where(sql`(is_active = true)`),
	index("idx_automations_active_trigger").using("btree", table.triggerType.asc().nullsLast().op("text_ops")).where(sql`(is_active = true)`),
	index("idx_automations_user_id").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "automations_account_id_fkey"
		}).onDelete("cascade"),
]);

export const automationSteps = pgTable("automation_steps", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	automationId: uuid("automation_id").notNull(),
	parentStepId: uuid("parent_step_id"),
	branch: text(),
	stepType: text("step_type").notNull(),
	stepConfig: jsonb("step_config").default({}).notNull(),
	position: integer().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_automation_steps_automation_id").using("btree", table.automationId.asc().nullsLast().op("int4_ops"), table.position.asc().nullsLast().op("int4_ops")),
	index("idx_automation_steps_parent").using("btree", table.parentStepId.asc().nullsLast().op("uuid_ops")).where(sql`(parent_step_id IS NOT NULL)`),
	foreignKey({
			columns: [table.automationId],
			foreignColumns: [automations.id],
			name: "automation_steps_automation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.parentStepId],
			foreignColumns: [table.id],
			name: "automation_steps_parent_step_id_fkey"
		}).onDelete("cascade"),
	check("automation_steps_branch_check", sql`branch = ANY (ARRAY['yes'::text, 'no'::text])`),
]);

export const automationLogs = pgTable("automation_logs", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	automationId: uuid("automation_id").notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	contactId: uuid("contact_id"),
	triggerEvent: text("trigger_event").notNull(),
	stepsExecuted: jsonb("steps_executed").default([]).notNull(),
	status: text().notNull(),
	errorMessage: text("error_message"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_automation_logs_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_automation_logs_automation").using("btree", table.automationId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsFirst().op("uuid_ops")),
	index("idx_automation_logs_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.automationId],
			foreignColumns: [automations.id],
			name: "automation_logs_automation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "automation_logs_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "automation_logs_contact_id_fkey"
		}).onDelete("set null"),
	check("automation_logs_status_check", sql`status = ANY (ARRAY['success'::text, 'partial'::text, 'failed'::text])`),
]);

export const automationPendingExecutions = pgTable("automation_pending_executions", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	automationId: uuid("automation_id").notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	contactId: uuid("contact_id"),
	logId: uuid("log_id"),
	parentStepId: uuid("parent_step_id"),
	branch: text(),
	nextStepPosition: integer("next_step_position").notNull(),
	context: jsonb().default({}).notNull(),
	status: text().default('pending').notNull(),
	runAt: timestamp("run_at", { withTimezone: true, mode: 'string' }).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_automation_pending_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_automation_pending_due").using("btree", table.runAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'pending'::text)`),
	foreignKey({
			columns: [table.automationId],
			foreignColumns: [automations.id],
			name: "automation_pending_executions_automation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "automation_pending_executions_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "automation_pending_executions_contact_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.logId],
			foreignColumns: [automationLogs.id],
			name: "automation_pending_executions_log_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.parentStepId],
			foreignColumns: [automationSteps.id],
			name: "automation_pending_executions_parent_step_id_fkey"
		}).onDelete("set null"),
	check("automation_pending_executions_branch_check", sql`branch = ANY (ARRAY['yes'::text, 'no'::text])`),
	check("automation_pending_executions_status_check", sql`status = ANY (ARRAY['pending'::text, 'running'::text, 'done'::text, 'failed'::text])`),
]);

export const flows = pgTable("flows", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	description: text(),
	status: text().default('draft').notNull(),
	triggerType: text("trigger_type").notNull(),
	triggerConfig: jsonb("trigger_config").default({}).notNull(),
	entryNodeId: text("entry_node_id"),
	// Optional channel binding. NULL = "todos os canais" (roda em qualquer
	// número/canal da conta, comportamento legado). Quando setado, o fluxo só
	// dispara em inbounds que chegam por ESSE canal — permite fluxos distintos
	// por canal (suporte, financeiro, Instagram…). Soft-ref (sem FK): se o
	// canal for excluído, o fluxo simplesmente para de casar (nenhum inbound
	// tem esse channel_id) em vez de silenciosamente virar "todos os canais".
	channelId: uuid("channel_id"),
	fallbackPolicy: jsonb("fallback_policy").default({"on_exhaust":"handoff","max_reprompts":2,"on_timeout_hours":24,"on_unknown_reply":"reprompt"}).notNull(),
	executionCount: integer("execution_count").default(0).notNull(),
	lastExecutedAt: timestamp("last_executed_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_flows_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_flows_account_active").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'active'::text)`),
	index("idx_flows_active_trigger").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.triggerType.asc().nullsLast().op("uuid_ops")).where(sql`(status = 'active'::text)`),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "flows_account_id_fkey"
		}).onDelete("cascade"),
	check("flows_status_check", sql`status = ANY (ARRAY['draft'::text, 'active'::text, 'archived'::text])`),
	check("flows_trigger_type_check", sql`trigger_type = ANY (ARRAY['keyword'::text, 'first_inbound_message'::text, 'tag_added'::text, 'manual'::text])`),
]);

export const apiKeys = pgTable("api_keys", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	createdBy: uuid("created_by"),
	name: text().notNull(),
	keyPrefix: text("key_prefix").notNull(),
	keyHash: text("key_hash").notNull(),
	scopes: text("scopes").array().default(sql`'{}'::text[]`).notNull(),
	lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: 'string' }),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	revokedAt: timestamp("revoked_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("api_keys_account_id_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("api_keys_key_hash_idx").using("btree", table.keyHash.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "api_keys_account_id_fkey"
		}).onDelete("cascade"),
	unique("api_keys_key_hash_key").on(table.keyHash),
]);

export const flowNodes = pgTable("flow_nodes", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	flowId: uuid("flow_id").notNull(),
	nodeKey: text("node_key").notNull(),
	nodeType: text("node_type").notNull(),
	config: jsonb().default({}).notNull(),
	positionX: integer("position_x").default(0).notNull(),
	positionY: integer("position_y").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_flow_nodes_flow").using("btree", table.flowId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.flowId],
			foreignColumns: [flows.id],
			name: "flow_nodes_flow_id_fkey"
		}).onDelete("cascade"),
	unique("flow_nodes_flow_id_node_key_key").on(table.flowId, table.nodeKey),
	check("flow_nodes_node_type_check", sql`node_type = ANY (ARRAY['start'::text, 'send_buttons'::text, 'send_list'::text, 'send_message'::text, 'send_media'::text, 'collect_input'::text, 'condition'::text, 'set_tag'::text, 'delay'::text, 'jump'::text, 'randomizer'::text, 'action'::text, 'ai'::text, 'handoff'::text, 'http_fetch'::text, 'end'::text])`),
]);

export const flowRuns = pgTable("flow_runs", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	flowId: uuid("flow_id").notNull(),
	userId: uuid("user_id").notNull(),
	accountId: uuid("account_id").notNull(),
	contactId: uuid("contact_id"),
	conversationId: uuid("conversation_id"),
	status: text().default('active').notNull(),
	currentNodeKey: text("current_node_key"),
	lastPromptMessageId: uuid("last_prompt_message_id"),
	vars: jsonb().default({}).notNull(),
	repromptCount: integer("reprompt_count").default(0).notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	lastAdvancedAt: timestamp("last_advanced_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	endedAt: timestamp("ended_at", { withTimezone: true, mode: 'string' }),
	endReason: text("end_reason"),
	// Drip: when a run hits a `delay` node it sleeps (status='sleeping') with
	// resume_at = the wake time; the flows scheduler worker resumes it once due.
	resumeAt: timestamp("resume_at", { withTimezone: true, mode: 'string' }),
	// No-reply timeout: when a run parks at a suspending node with a `timeout`
	// config, timeout_at holds the reply deadline. The scheduler routes the run
	// down the node's timeout path once it passes (if no reply cleared it first).
	timeoutAt: timestamp("timeout_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("idx_flow_runs_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_flow_runs_active_advanced").using("btree", table.lastAdvancedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'active'::text)`),
	index("idx_flow_runs_flow_started").using("btree", table.flowId.asc().nullsLast().op("uuid_ops"), table.startedAt.desc().nullsFirst().op("timestamptz_ops")),
	// Due-sleeping-run lookup for the scheduler worker.
	index("idx_flow_runs_sleeping_resume").using("btree", table.resumeAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'sleeping'::text)`),
	// Due-timeout lookup for the scheduler worker (active runs awaiting a reply).
	index("idx_flow_runs_timeout").using("btree", table.timeoutAt.asc().nullsLast().op("timestamptz_ops")).where(sql`((status = 'active'::text) AND (timeout_at IS NOT NULL))`),
	// One live run per contact — now covers BOTH active and sleeping so a
	// contact mid-drip can't start a second flow.
	uniqueIndex("idx_one_active_run_per_contact").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.contactId.asc().nullsLast().op("uuid_ops")).where(sql`(status = ANY (ARRAY['active'::text, 'sleeping'::text]))`),
	foreignKey({
			columns: [table.flowId],
			foreignColumns: [flows.id],
			name: "flow_runs_flow_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "flow_runs_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "flow_runs_contact_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "flow_runs_conversation_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.lastPromptMessageId],
			foreignColumns: [messages.id],
			name: "flow_runs_last_prompt_message_id_fkey"
		}).onDelete("set null"),
	check("flow_runs_status_check", sql`status = ANY (ARRAY['active'::text, 'sleeping'::text, 'completed'::text, 'handed_off'::text, 'timed_out'::text, 'paused_by_agent'::text, 'failed'::text])`),
]);

export const flowRunEvents = pgTable("flow_run_events", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	flowRunId: uuid("flow_run_id").notNull(),
	eventType: text("event_type").notNull(),
	nodeKey: text("node_key"),
	payload: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_flow_run_events_run_time").using("btree", table.flowRunId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("uuid_ops")),
	index("idx_flow_run_events_run_type").using("btree", table.flowRunId.asc().nullsLast().op("uuid_ops"), table.eventType.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.flowRunId],
			foreignColumns: [flowRuns.id],
			name: "flow_run_events_flow_run_id_fkey"
		}).onDelete("cascade"),
	check("flow_run_events_event_type_check", sql`event_type = ANY (ARRAY['started'::text, 'node_entered'::text, 'message_sent'::text, 'reply_received'::text, 'fallback_fired'::text, 'handoff'::text, 'timeout'::text, 'delay_sleep'::text, 'http_request'::text, 'error'::text, 'completed'::text])`),
]);

export const notifications = pgTable("notifications", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	userId: uuid("user_id").notNull(),
	type: text().default('conversation_assigned').notNull(),
	conversationId: uuid("conversation_id"),
	channelId: uuid("channel_id"),
	contactId: uuid("contact_id"),
	// Transferir lead: deep-link pro negócio na notificação (migração 0056).
	dealId: uuid("deal_id"),
	actorUserId: uuid("actor_user_id"),
	title: text().notNull(),
	body: text(),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_notifications_user_created").using("btree", table.userId.asc().nullsLast().op("timestamptz_ops"), table.createdAt.desc().nullsFirst().op("timestamptz_ops")),
	index("idx_notifications_user_unread").using("btree", table.userId.asc().nullsLast().op("uuid_ops")).where(sql`(read_at IS NULL)`),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "notifications_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "notifications_conversation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "notifications_contact_id_fkey"
		}).onDelete("set null"),
	check("notifications_type_check", sql`type = ANY (ARRAY['conversation_assigned'::text, 'sla_alert'::text, 'mention'::text, 'broadcast_halted'::text, 'deal_transferred'::text, 'deal_ai_suggestion'::text, 'scheduled_message_assigned'::text])`),
]);

export const webhookEndpoints = pgTable("webhook_endpoints", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	createdBy: uuid("created_by"),
	url: text().notNull(),
	secret: text().notNull(),
	events: text("events").array().default(sql`'{}'::text[]`).notNull(),
	// Canal (caixa de entrada) que este webhook escuta. NULL = todos. Migração 0082.
	channelId: uuid("channel_id"),
	isActive: boolean("is_active").default(true).notNull(),
	lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true, mode: 'string' }),
	failureCount: integer("failure_count").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("webhook_endpoints_account_id_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("webhook_endpoints_channel_idx").using("btree", table.channelId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "webhook_endpoints_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "webhook_endpoints_channel_id_fkey"
		}).onDelete("cascade"),
]);

// Suporte (migração 0083) — chamados abertos pelo cliente na tela /suporte.
// Registro (setor Suporte no /admin) + dispara alerta no WhatsApp da Fluxia.
export const supportTickets = pgTable("support_tickets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	createdBy: uuid("created_by"),
	// 'question' (dúvida) | 'config' (ajuda com config) | 'problem' (bug)
	type: text().default('problem').notNull(),
	subject: text().notNull(),
	description: text(),
	// URLs públicas dos prints anexados (bucket 'media').
	screenshotUrls: jsonb("screenshot_urls").default(sql`'[]'::jsonb`).notNull(),
	// Contexto automático: {url, userAgent, appVersion, orgName, userName, userEmail}.
	context: jsonb().default(sql`'{}'::jsonb`).notNull(),
	// 'open' | 'in_progress' | 'resolved'
	status: text().default('open').notNull(),
	alertedAt: timestamp("alerted_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("support_tickets_account_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsLast()),
	index("support_tickets_status_idx").using("btree", table.status.asc().nullsLast(), table.createdAt.desc().nullsLast()),
	check("support_tickets_type_check", sql`type = ANY (ARRAY['question'::text,'config'::text,'problem'::text])`),
	check("support_tickets_status_check", sql`status = ANY (ARRAY['open'::text,'in_progress'::text,'resolved'::text])`),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "support_tickets_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [user.id],
			name: "support_tickets_created_by_fkey"
		}).onDelete("set null"),
]);

// Chaves de API reutilizáveis (migração 0084) — cada agente aponta pra uma
// credencial (Fase 2) em vez de ter a chave embutida. api_key criptografada.
export const aiCredentials = pgTable("ai_credentials", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	createdBy: uuid("created_by"),
	provider: text().notNull(),
	label: text().notNull(),
	apiKey: text("api_key").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ai_credentials_account_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsLast()),
	check("ai_credentials_provider_check", sql`provider = ANY (ARRAY['openai'::text,'anthropic'::text,'gemini'::text])`),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "ai_credentials_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.createdBy],
			foreignColumns: [user.id],
			name: "ai_credentials_created_by_fkey"
		}).onDelete("set null"),
]);

export const aiConfigs = pgTable("ai_configs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	createdBy: uuid("created_by"),
	// Multi-agente (migração 0074): cada linha é um AGENTE. `name` rotula o card;
	// `isDefault` marca o agente fallback/catch-all (1 por conta). Antes era
	// 1-por-conta (unique account_id), agora vários roteados por canal.
	name: text(),
	isDefault: boolean("is_default").default(false).notNull(),
	provider: text().notNull(),
	model: text().notNull(),
	apiKey: text("api_key").notNull(),
	// Credencial reutilizável (migração 0085). NULL = usa a chave embutida acima
	// (fallback/back-compat). Quando setado, o runtime usa a chave/provedor da
	// credencial. Ver ai_credentials.
	credentialId: uuid("credential_id"),
	embeddingsApiKey: text("embeddings_api_key"),
	systemPrompt: text("system_prompt"),
	isActive: boolean("is_active").default(false).notNull(),
	autoReplyEnabled: boolean("auto_reply_enabled").default(false).notNull(),
	// Canais onde a IA responde (multi). Vazio = todos. Migração 0054.
	autoReplyChannelIds: uuid("auto_reply_channel_ids").array().default(sql`'{}'::uuid[]`).notNull(),
	// Bases de conhecimento que ESTE agente usa (Fase K). Vazio = todas as bases da conta.
	knowledgeBaseIds: uuid("knowledge_base_ids").array().default(sql`'{}'::uuid[]`).notNull(),
	// Follow-up inteligente (jsonb): { enabled, delayMinutes, instructions, armedAt }. Migração 0080.
	followUp: jsonb("follow_up").default({}).notNull(),
	autoReplyMaxPerConversation: integer("auto_reply_max_per_conversation").default(3).notNull(),
	// Horário de atendimento da IA: always | inside | outside (reusa o horário
	// da conta). Migração 0058.
	autoReplyHoursMode: text("auto_reply_hours_mode").default('always').notNull(),
	// Buffer (s) do Agente IA — espera após a última msg antes de responder.
	// Migração 0059. 0 = na hora.
	autoReplyBufferSeconds: integer("auto_reply_buffer_seconds").default(8).notNull(),
	// 🤫 Barge-in: humano respondeu → IA muda pra observação por N min (0 = off).
	bargeInMinutes: integer("barge_in_minutes").default(5).notNull(),
	// 🔊 Responder por áudio (TTS). OFF → entende áudio, responde só texto.
	audioRepliesEnabled: boolean("audio_replies_enabled").default(true).notNull(),
	// IA proativa em Negociações (Fase 3): analisa sozinha o negócio no inbound
	// e cria sugestões pendentes. Migração 0066. OPT-IN, default OFF.
	dealSuggestionsProactive: boolean("deal_suggestions_proactive").default(false).notNull(),
	// Assinatura da IA: nome do atendente/agente + se assina as mensagens. Migração 0055.
	signatureName: text("signature_name"),
	signatureEnabled: boolean("signature_enabled").default(false).notNull(),
	// Encerramento inteligente (migração 0087, opt-in): a IA pode se despedir,
	// RESOLVER a conversa e MOVER o card do funil quando o atendimento acaba /
	// o cliente não tem mais interesse. Default OFF.
	autoCloseEnabled: boolean("auto_close_enabled").default(false).notNull(),
	// IA agenda de verdade (migração 0088, opt-in): cria evento na Agenda quando
	// combina um horário com o cliente. Default OFF.
	autoScheduleEnabled: boolean("auto_schedule_enabled").default(false).notNull(),
	// Ferramentas do agente (migração 0089) — conjunto de ações ligadas (chaves
	// de src/lib/ai/tools.ts). Fonte da verdade do que a IA pode fazer no CRM.
	tools: jsonb().default(sql`'["skip_reply","tag","handoff"]'::jsonb`).notNull(),
	// Funil DESTE agente (migração 0139): card criado pela IA nasce aqui.
	// NULL = 1º funil da conta (comportamento antigo).
	pipelineId: uuid("pipeline_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "ai_configs_account_id_fkey"
		}).onDelete("cascade"),
	// A unique(account_id) foi removida na 0074 (multi-agente). O "no máximo 1
	// default por conta" é garantido por um índice único parcial na migração.
	index("ai_configs_account_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	check("ai_configs_auto_reply_max_per_conversation_check", sql`(auto_reply_max_per_conversation >= 1) AND (auto_reply_max_per_conversation <= 20)`),
	check("ai_configs_auto_reply_hours_mode_check", sql`auto_reply_hours_mode = ANY (ARRAY['always'::text, 'inside'::text, 'outside'::text])`),
	check("ai_configs_auto_reply_buffer_seconds_check", sql`(auto_reply_buffer_seconds >= 0) AND (auto_reply_buffer_seconds <= 300)`),
	check("ai_configs_provider_check", sql`provider = ANY (ARRAY['openai'::text, 'anthropic'::text, 'gemini'::text])`),
	foreignKey({
			columns: [table.credentialId],
			foreignColumns: [aiCredentials.id],
			name: "ai_configs_credential_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.pipelineId],
			foreignColumns: [pipelines.id],
			name: "ai_configs_pipeline_id_fkey"
		}).onDelete("set null"),
]);

// Fase B — Medidor de custo da IA (migração 0075). Uma linha append-only por
// chamada de modelo (só tokens; o custo US$/R$ é calculado na query com a
// tabela de preços em src/lib/ai/pricing.ts). Semântica: prompt_tokens = TOTAL
// de input (inclui cache); cached_read/cache_creation são subconjuntos.
export const aiUsage = pgTable("ai_usage", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	agentId: uuid("agent_id"),
	conversationId: uuid("conversation_id"),
	channelId: uuid("channel_id"),
	provider: text().notNull(),
	model: text().notNull(),
	source: text().default('inbox').notNull(),
	promptTokens: integer("prompt_tokens").default(0).notNull(),
	completionTokens: integer("completion_tokens").default(0).notNull(),
	cachedReadTokens: integer("cached_read_tokens").default(0).notNull(),
	cacheCreationTokens: integer("cache_creation_tokens").default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ai_usage_account_created_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsLast()),
	index("ai_usage_account_agent_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.agentId.asc().nullsLast().op("uuid_ops")),
	index("ai_usage_account_channel_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.channelId.asc().nullsLast().op("uuid_ops")),
	index("ai_usage_account_conversation_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.conversationId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "ai_usage_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.agentId],
			foreignColumns: [aiConfigs.id],
			name: "ai_usage_agent_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "ai_usage_conversation_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "ai_usage_channel_id_fkey"
		}).onDelete("set null"),
	check("ai_usage_source_check", sql`source = ANY (ARRAY['inbox'::text, 'draft'::text, 'playground'::text, 'pipeline'::text, 'flow'::text, 'deal_suggest'::text, 'vision'::text, 'transcribe'::text, 'tts'::text, 'embeddings'::text])`),
]);

// Bases de conhecimento NOMEADAS (Fase K). Ficam na CONTA; cada agente escolhe
// quais usa (ai_configs.knowledge_base_ids, vazio = todas). Migração 0076.
export const aiKnowledgeBases = pgTable("ai_knowledge_bases", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	description: text(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ai_knowledge_bases_account_id_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "ai_knowledge_bases_account_id_fkey"
		}).onDelete("cascade"),
]);

export const aiKnowledgeDocuments = pgTable("ai_knowledge_documents", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	knowledgeBaseId: uuid("knowledge_base_id"),
	createdBy: uuid("created_by"),
	title: text().notNull(),
	content: text().notNull(),
	// text | file | url | qa | approval (Fase K). 'question' guarda a pergunta do Q&A;
	// 'sourceUrl'/'fileName' a origem; 'status' o processamento (ready/pending/error).
	sourceType: text("source_type").default('text').notNull(),
	question: text(),
	sourceUrl: text("source_url"),
	fileName: text("file_name"),
	status: text().default('ready').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ai_knowledge_documents_account_id_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("ai_knowledge_documents_kb_idx").using("btree", table.knowledgeBaseId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "ai_knowledge_documents_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.knowledgeBaseId],
			foreignColumns: [aiKnowledgeBases.id],
			name: "ai_knowledge_documents_kb_fkey"
		}).onDelete("cascade"),
]);

export const aiKnowledgeChunks = pgTable("ai_knowledge_chunks", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	documentId: uuid("document_id").notNull(),
	accountId: uuid("account_id").notNull(),
	// Base denormalizada (Fase K): filtra o retrieval por base sem join. Migração 0076.
	knowledgeBaseId: uuid("knowledge_base_id"),
	chunkIndex: integer("chunk_index").default(0).notNull(),
	content: text().notNull(),
	fts: tsvector("fts").generatedAlwaysAs(sql`to_tsvector('simple'::regconfig, content)`),
	embedding: vector({ dimensions: 1536 }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("ai_knowledge_chunks_account_id_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("ai_knowledge_chunks_account_kb_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.knowledgeBaseId.asc().nullsLast().op("uuid_ops")),
	index("ai_knowledge_chunks_document_id_idx").using("btree", table.documentId.asc().nullsLast().op("uuid_ops")),
	index("ai_knowledge_chunks_embedding_idx").using("hnsw", table.embedding.asc().nullsLast().op("vector_cosine_ops")),
	index("ai_knowledge_chunks_fts_idx").using("gin", table.fts.asc().nullsLast().op("tsvector_ops")),
	foreignKey({
			columns: [table.documentId],
			foreignColumns: [aiKnowledgeDocuments.id],
			name: "ai_knowledge_chunks_document_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "ai_knowledge_chunks_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.knowledgeBaseId],
			foreignColumns: [aiKnowledgeBases.id],
			name: "ai_knowledge_chunks_kb_fkey"
		}).onDelete("cascade"),
]);

// Fase K4 — Fila de aprovação: a IA PROPÕE Q&A a partir de conversas; nada
// entra na base sem humano aprovar. Migração 0079.
export const aiKnowledgeApprovals = pgTable("ai_knowledge_approvals", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	knowledgeBaseId: uuid("knowledge_base_id"),
	conversationId: uuid("conversation_id"),
	question: text().notNull(),
	answer: text().notNull(),
	status: text().default('pending').notNull(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	reviewedBy: uuid("reviewed_by"),
	reviewedAt: timestamp("reviewed_at", { withTimezone: true, mode: 'string' }),
}, (table) => [
	index("ai_knowledge_approvals_account_status_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast(), table.createdAt.desc().nullsLast()),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "ai_knowledge_approvals_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.knowledgeBaseId],
			foreignColumns: [aiKnowledgeBases.id],
			name: "ai_knowledge_approvals_kb_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "ai_knowledge_approvals_conversation_fkey"
		}).onDelete("set null"),
	check("ai_knowledge_approvals_status_check", sql`status = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])`),
]);

// Perfil da empresa ("Núcleo" guiado): a camada estruturada da Base de
// Conhecimento (1 linha por conta). Sempre injetado no contexto do agente
// (buildSystemPrompt) — não depende do retrieval. Migração 0073.
export const aiCompanyProfile = pgTable("ai_company_profile", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	businessName: text("business_name"),
	description: text(),
	offerings: text(),
	hours: text(),
	paymentMethods: text("payment_methods"),
	deliveryInfo: text("delivery_info"),
	tone: text(),
	notes: text(),
	// Identidade da empresa p/ propostas (migração 0120).
	legalName: text("legal_name"),
	tradeName: text("trade_name"),
	document: text(),
	website: text(),
	address: text(),
	phone: text(),
	updatedBy: uuid("updated_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "ai_company_profile_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.updatedBy], foreignColumns: [user.id], name: "ai_company_profile_updated_by_fkey" }).onDelete("set null"),
	unique("ai_company_profile_account_key").on(table.accountId),
]);

// ============================================================
// TASKS ("Tarefas") — per-account task / reminder subsystem.
//
// Account-scoped (account_id → organization, cascade). A task has a
// free-text title + OPTIONAL free-text `type` label (no CHECK, stays
// flexible). It may link to a contact (client) and/or a deal (Kanban
// card) — both nullable, SET NULL on delete so removing a
// contact/deal doesn't destroy the task. `assigned_to` / `created_by`
// are plain uuids (member/user ids) with no FK, mirroring the loose
// user refs elsewhere. `set_updated_at` trigger keeps updated_at
// fresh (see baseline). The due-alert badge reads (overdue +
// dueToday) via getTasksOverview.
// ============================================================
export const tasks = pgTable("tasks", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	title: text().notNull(),
	description: text(),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }),
	status: text().default('open').notNull(),
	// Optional free-text label (e.g. 'ligar','cobrar','enviar_boleto',
	// 'outro'). Deliberately no CHECK so accounts can coin their own.
	type: text(),
	contactId: uuid("contact_id"),
	dealId: uuid("deal_id"),
	// Responsável PRIMÁRIO (compat com telas/joins antigos). A lista completa
	// de responsáveis vive em `assigneeIds` (multi-responsável, spec Alex);
	// `assignedTo` = assigneeIds[0].
	assignedTo: uuid("assigned_to"),
	assigneeIds: uuid("assignee_ids").array().default(sql`'{}'::uuid[]`).notNull(),
	createdBy: uuid("created_by"),
	// Origem: template de etapa que criou esta tarefa (auto). Dedupe na
	// reentrada + marca a tarefa como automática. Migração 0110.
	sourceTemplateId: uuid("source_template_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_tasks_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_tasks_source_template").using("btree", table.sourceTemplateId.asc().nullsLast().op("uuid_ops")),
	index("idx_tasks_assignee_ids").using("gin", table.assigneeIds.asc().nullsLast().op("array_ops")),
	index("idx_tasks_account_status").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("idx_tasks_due_at").using("btree", table.dueAt.asc().nullsLast().op("timestamptz_ops")),
	index("idx_tasks_contact").using("btree", table.contactId.asc().nullsLast().op("uuid_ops")),
	index("idx_tasks_deal").using("btree", table.dealId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "tasks_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "tasks_contact_id_fkey"
		}).onDelete("set null"),
	foreignKey({
			columns: [table.dealId],
			foreignColumns: [deals.id],
			name: "tasks_deal_id_fkey"
		}).onDelete("set null"),
	check("tasks_status_check", sql`status = ANY (ARRAY['open'::text, 'done'::text, 'cancelled'::text])`),
]);

// ============================================================
// Scheduled messages — a single WhatsApp message queued to be sent
// into ONE conversation at a future time. Distinct from broadcasts
// (bulk, template-driven): this is a 1:1 free-text (or media) message
// an operator schedules from the inbox sidebar. A BullMQ delayed job
// (queue 'scheduled-message', jobId `sched-{id}`) fires at scheduled_at
// and the worker calls sendMessageToConversation, then flips status to
// 'sent'. Cancelling removes the job AND flips status to 'cancelled'.
// ============================================================
export const scheduledMessages = pgTable("scheduled_messages", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	conversationId: uuid("conversation_id").notNull(),
	// Denormalized for display + so a deleted contact just nulls out.
	contactId: uuid("contact_id"),
	// 'text' | 'image' | 'video' | 'document' | 'audio' (matches the send
	// funnel's message types; v1 UI only creates 'text').
	messageType: text("message_type").default('text').notNull(),
	contentText: text("content_text"),
	mediaUrl: text("media_url"),
	filename: text(),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }).notNull(),
	status: text().default('pending').notNull(),
	// Set after a successful send.
	sentMessageId: uuid("sent_message_id"),
	externalMessageId: text("external_message_id"),
	lastError: text("last_error"),
	attempts: integer().default(0).notNull(),
	createdBy: uuid("created_by"),
	// Central de agendamentos (migração 0069): responsável pela mensagem (dono do
	// lead) e quem atribuiu. Governam a visibilidade por papel + notificação.
	assignedTo: uuid("assigned_to"),
	assignedBy: uuid("assigned_by"),
	// Tag de cadência (migração 0112): qual inscrição/degrau gerou esta agendada.
	cadenceEnrollmentId: uuid("cadence_enrollment_id"),
	cadenceStepPosition: integer("cadence_step_position"),
	// Assunto do e-mail (degrau de e-mail da cadência). Null = assunto padrão.
	subject: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_scheduled_messages_conversation").using("btree", table.conversationId.asc().nullsLast().op("uuid_ops")),
	index("idx_scheduled_messages_account_status").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.status.asc().nullsLast().op("text_ops")),
	index("idx_scheduled_messages_assigned").using("btree", table.assignedTo.asc().nullsLast().op("uuid_ops")),
	index("idx_scheduled_messages_due").using("btree", table.scheduledAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "scheduled_messages_account_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "scheduled_messages_conversation_id_fkey"
		}).onDelete("cascade"),
	foreignKey({
			columns: [table.contactId],
			foreignColumns: [contacts.id],
			name: "scheduled_messages_contact_id_fkey"
		}).onDelete("set null"),
	check("scheduled_messages_status_check", sql`status = ANY (ARRAY['pending'::text, 'sent'::text, 'cancelled'::text, 'failed'::text])`),
]);

// ============================================================
// account_settings — one row per account (organization) holding
// workspace-wide preference toggles that don't warrant their own table
// (e.g. the agent-signature toggle). Shape of `settings` is app-defined
// (see src/lib/settings/account-settings.ts).
// ============================================================
export const accountSettings = pgTable("account_settings", {
	accountId: uuid("account_id").primaryKey().notNull(),
	settings: jsonb().default({}).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "account_settings_account_id_fkey"
		}).onDelete("cascade"),
]);

// ============================================================
// Internal team chat (Chat Interno) — Slack-style channels for the
// account's team members. Public channels are visible to everyone in the
// account; private channels only to rows in internal_channel_members.
// ============================================================
export const internalChannels = pgTable("internal_channels", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	description: text(),
	isPrivate: boolean("is_private").default(false).notNull(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_internal_channels_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "internal_channels_account_id_fkey"
		}).onDelete("cascade"),
]);

// Monitored WhatsApp groups — opt-in ingestion. A group's messages enter the
// CRM only when it has a row here (for its channel).
export const monitoredGroups = pgTable("monitored_groups", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	channelId: uuid("channel_id").notNull(),
	groupJid: text("group_jid").notNull(),
	groupName: text("group_name"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("monitored_groups_unique").using("btree", table.channelId.asc().nullsLast().op("uuid_ops"), table.groupJid.asc().nullsLast().op("text_ops")),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "monitored_groups_channel_id_fkey"
		}).onDelete("cascade"),
]);

// Voice agent config per channel (IA de voz). The account-wide ai_configs is
// the TEXT agent; this is the opt-in-per-channel VOICE agent read by the media
// bridge: whether the AI answers on this number, with which prompt/voice, and
// when (always vs only on overflow).
export const voiceAgents = pgTable("voice_agents", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	channelId: uuid("channel_id").notNull(),
	enabled: boolean().default(false).notNull(),
	mode: text().default('overflow').notNull(),
	systemPrompt: text("system_prompt"),
	voiceId: text("voice_id"),
	greeting: text(),
	notifyPhone: text("notify_phone"),
	pipelineId: uuid("pipeline_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("voice_agents_channel_unique").using("btree", table.channelId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [channels.id],
			name: "voice_agents_channel_id_fkey"
		}).onDelete("cascade"),
	check("voice_agents_mode_check", sql`mode = ANY (ARRAY['always'::text, 'overflow'::text])`),
]);

// Voice credentials per account (client-supplied). ElevenLabs (TTS) + OpenAI
// (Realtime brain) keys, one set per account, AES-256-GCM encrypted like
// ai_configs.api_key. The per-channel persona/voice lives in voice_agents.
export const voiceSettings = pgTable("voice_settings", {
	accountId: uuid("account_id").primaryKey().notNull(),
	elevenlabsApiKey: text("elevenlabs_api_key"),
	openaiApiKey: text("openai_api_key"),
	llmProvider: text("llm_provider").default('openai').notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "voice_settings_account_id_fkey"
		}).onDelete("cascade"),
]);

// Group participant name registry — maps a participant's wa_key (LID user-part
// or phone digits) to the pushName we saw on their messages, so mentions inside
// group messages ("@146089705500852") render as the name ("@Guilherme Andrade").
// Best-effort cache accumulated at ingestion; keyed per account.
export const groupParticipantNames = pgTable("group_participant_names", {
	accountId: uuid("account_id").notNull(),
	waKey: text("wa_key").notNull(),
	name: text().notNull(),
	// Re-hosted (MinIO) profile photo of this participant — the group-thread
	// avatar. Backfilled best-effort from the participant's phone via the same
	// profile-picture pipeline as 1:1 contacts. Null = no photo yet / privacy /
	// only a LID is known. Kept as attempt-once-per-null.
	avatarUrl: text("avatar_url"),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	primaryKey({ columns: [table.accountId, table.waKey], name: "group_participant_names_pkey" }),
]);

// Conversation participants — a user granted access to a specific conversation
// (via @mention) without being its assignee. Read by the sector-privacy check.
export const conversationParticipants = pgTable("conversation_participants", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	conversationId: uuid("conversation_id").notNull(),
	userId: uuid("user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("conversation_participants_unique").using("btree", table.conversationId.asc().nullsLast().op("uuid_ops"), table.userId.asc().nullsLast().op("uuid_ops")),
	index("conversation_participants_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.conversationId],
			foreignColumns: [conversations.id],
			name: "conversation_participants_conversation_id_fkey"
		}).onDelete("cascade"),
]);

export const internalChannelMembers = pgTable("internal_channel_members", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	channelId: uuid("channel_id").notNull(),
	userId: uuid("user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("internal_channel_members_unique").using("btree", table.channelId.asc().nullsLast().op("uuid_ops"), table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [internalChannels.id],
			name: "internal_channel_members_channel_id_fkey"
		}).onDelete("cascade"),
]);

export const internalMessages = pgTable("internal_messages", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	channelId: uuid("channel_id").notNull(),
	senderId: uuid("sender_id").notNull(),
	content: text().notNull(),
	// Optional attachment (migration 0033). media_type: image|video|audio|document.
	mediaUrl: text("media_url"),
	mediaType: text("media_type"),
	mediaName: text("media_name"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_internal_messages_channel").using("btree", table.channelId.asc().nullsLast().op("uuid_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [internalChannels.id],
			name: "internal_messages_channel_id_fkey"
		}).onDelete("cascade"),
]);

// Presence (Fase 3): one row per user, online/away + last heartbeat.
// "offline" is derived client-side from staleness (see lib/presence.ts).
export const memberPresence = pgTable("member_presence", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	userId: uuid("user_id").notNull(),
	status: text().default('online').notNull(),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("member_presence_user_id_key").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	index("idx_member_presence_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	check("member_presence_status_check", sql`status = ANY (ARRAY['online'::text, 'away'::text, 'offline'::text])`),
]);

// Per-user read state for internal chat channels — drives the unread badge.
export const internalChannelReads = pgTable("internal_channel_reads", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	channelId: uuid("channel_id").notNull(),
	userId: uuid("user_id").notNull(),
	lastReadAt: timestamp("last_read_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("internal_channel_reads_unique").using("btree", table.channelId.asc().nullsLast().op("uuid_ops"), table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.channelId],
			foreignColumns: [internalChannels.id],
			name: "internal_channel_reads_channel_id_fkey"
		}).onDelete("cascade"),
]);

// ============================================================
// Sectors (departments) — organize conversations by team (Vendas,
// Financeiro, Suporte…). Drive both routing and PRIVACY: a non-admin agent
// only sees conversations whose sector they belong to (plus the general,
// null-sector queue). Admins/owner see everything.
// ============================================================
export const sectors = pgTable("sectors", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	name: text().notNull(),
	color: text().default('#6d4bd8').notNull(),
	// Phase 2 routing: if the first inbound message text contains any of
	// these keywords (case/accent-insensitive), the conversation is routed
	// to this sector — this beats the channel's default sector.
	keywords: text().array().default(sql`ARRAY[]::text[]`).notNull(),
	// When true, a conversation routed to this sector is auto-assigned to the
	// least-loaded member of the sector. When false, it lands unassigned in
	// the sector's queue for someone to pick up.
	autoAssign: boolean("auto_assign").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_sectors_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "sectors_account_id_fkey"
		}).onDelete("cascade"),
]);

export const sectorMembers = pgTable("sector_members", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	sectorId: uuid("sector_id").notNull(),
	userId: uuid("user_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("sector_members_unique").using("btree", table.sectorId.asc().nullsLast().op("uuid_ops"), table.userId.asc().nullsLast().op("uuid_ops")),
	index("idx_sector_members_user").using("btree", table.userId.asc().nullsLast().op("uuid_ops")),
	foreignKey({
			columns: [table.sectorId],
			foreignColumns: [sectors.id],
			name: "sector_members_sector_id_fkey"
		}).onDelete("cascade"),
]);

// ============================================================
// Quick replies (respostas rápidas) — canned messages an agent inserts in
// the composer by shortcut. Account-shared; managed by admins, used by all.
// ============================================================
export const quickReplies = pgTable("quick_replies", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	shortcut: text().notNull(),
	content: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_quick_replies_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("quick_replies_account_shortcut").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), sql`lower(shortcut)`),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "quick_replies_account_id_fkey"
		}).onDelete("cascade"),
]);

// ============================================================
// CSAT (pesquisa de satisfação) — a 1–5 score the customer sends after a
// conversation is closed. conversations.csat_pending_at flags an awaited reply.
// ============================================================
export const csatResponses = pgTable("csat_responses", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	conversationId: uuid("conversation_id"),
	contactId: uuid("contact_id"),
	agentId: uuid("agent_id"),
	score: integer().notNull(),
	comment: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_csat_account_created").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.createdAt.asc().nullsLast().op("timestamptz_ops")),
	check("csat_responses_score_check", sql`score >= 1 AND score <= 5`),
	foreignKey({
			columns: [table.accountId],
			foreignColumns: [organization.id],
			name: "csat_responses_account_id_fkey"
		}).onDelete("cascade"),
]);

// ------------------------------------------------------------
// Agenda (seção Agenda) — migração 0071. Multi-calendário + eventos com
// vínculo opcional a contato/negócio. Sync Google entra numa migração seguinte.
// ------------------------------------------------------------
export const calendars = pgTable("calendars", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	ownerUserId: uuid("owner_user_id"),
	name: text().notNull(),
	color: text().default('#6366f1').notNull(),
	// 'local' | 'google'
	source: text().default('local').notNull(),
	googleCalendarId: text("google_calendar_id"),
	// Conexão OAuth dona da agenda do Google (FK real na migração 0072).
	connectionId: uuid("connection_id"),
	isVisible: boolean("is_visible").default(true).notNull(),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_calendars_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_calendars_owner").using("btree", table.ownerUserId.asc().nullsLast().op("uuid_ops")),
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "calendars_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.ownerUserId], foreignColumns: [user.id], name: "calendars_owner_user_id_fkey" }).onDelete("set null"),
	check("calendars_source_check", sql`source IN ('local','google')`),
]);

export const calendarEvents = pgTable("calendar_events", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	calendarId: uuid("calendar_id").notNull(),
	ownerUserId: uuid("owner_user_id"),
	title: text().notNull(),
	description: text(),
	location: text(),
	startsAt: timestamp("starts_at", { withTimezone: true, mode: 'string' }).notNull(),
	endsAt: timestamp("ends_at", { withTimezone: true, mode: 'string' }).notNull(),
	allDay: boolean("all_day").default(false).notNull(),
	contactId: uuid("contact_id"),
	dealId: uuid("deal_id"),
	// 'confirmed' | 'cancelled'
	status: text().default('confirmed').notNull(),
	// Lembretes de reunião já enviados (ordem cronológica) — migração 0094.
	remindersSent: integer("reminders_sent").default(0).notNull(),
	// 'local' | 'google'
	source: text().default('local').notNull(),
	googleEventId: text("google_event_id"),
	createdBy: uuid("created_by"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_calendar_events_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("idx_calendar_events_calendar").using("btree", table.calendarId.asc().nullsLast().op("uuid_ops")),
	index("idx_calendar_events_starts").using("btree", table.startsAt.asc().nullsLast()),
	index("idx_calendar_events_contact").using("btree", table.contactId.asc().nullsLast().op("uuid_ops")),
	index("idx_calendar_events_deal").using("btree", table.dealId.asc().nullsLast().op("uuid_ops")),
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "calendar_events_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.calendarId], foreignColumns: [calendars.id], name: "calendar_events_calendar_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.ownerUserId], foreignColumns: [user.id], name: "calendar_events_owner_user_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.contactId], foreignColumns: [contacts.id], name: "calendar_events_contact_id_fkey" }).onDelete("set null"),
	foreignKey({ columns: [table.dealId], foreignColumns: [deals.id], name: "calendar_events_deal_id_fkey" }).onDelete("set null"),
	check("calendar_events_status_check", sql`status IN ('confirmed','cancelled')`),
	check("calendar_events_source_check", sql`source IN ('local','google')`),
]);

// Conexões OAuth de calendário (Google) — migração 0072. Tokens criptografados.
export const calendarConnections = pgTable("calendar_connections", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	userId: uuid("user_id").notNull(),
	provider: text().default('google').notNull(),
	googleEmail: text("google_email"),
	accessToken: text("access_token").notNull(),
	refreshToken: text("refresh_token"),
	tokenExpiry: timestamp("token_expiry", { withTimezone: true, mode: 'string' }),
	scope: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_calendar_connections_account").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	uniqueIndex("idx_calendar_connections_user_email").using("btree", table.userId.asc().nullsLast().op("uuid_ops"), table.googleEmail.asc().nullsLast()),
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "calendar_connections_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.userId], foreignColumns: [user.id], name: "calendar_connections_user_id_fkey" }).onDelete("cascade"),
]);

// ============================================================
// Automação comentário→DM do Instagram (migração 0096).
// Regras por canal + log/dedup dos comentários processados.
// ============================================================

export const instagramCommentAutomations = pgTable("instagram_comment_automations", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	channelId: uuid("channel_id").notNull(),
	name: text().notNull(),
	enabled: boolean().default(true).notNull(),
	// responde QUALQUER comentário (ignora keywords).
	matchAny: boolean("match_any").default(false).notNull(),
	// keywords separadas por vírgula (casa se o comentário CONTÉM qualquer uma).
	keywords: text().default('').notNull(),
	// resposta pública no próprio comentário (opcional). LEGADO: 1 variante;
	// a fonte da verdade agora é `publicReplies` (rotação).
	publicReply: text("public_reply"),
	// até 3 variantes de resposta pública, alternadas a cada envio (round-robin
	// via replyRotation) — parece humano e evita padrão de spam.
	publicReplies: jsonb("public_replies").$type<string[]>(),
	replyRotation: integer("reply_rotation").default(0).notNull(),
	// 🔒 Follow gate (social selling): exige seguir o perfil antes de receber o
	// DM com o link; a mensagem pede o follow (null = texto padrão).
	followGate: boolean("follow_gate").default(false).notNull(),
	followGateMessage: text("follow_gate_message"),
	// ⏰ Follow-up pós-DM: cutucada pra quem RESPONDEU a DM e sumiu (janela de
	// 24h aberta — a API não deixa mensagear quem nunca respondeu).
	followUpEnabled: boolean("follow_up_enabled").default(false).notNull(),
	followUpHours: integer("follow_up_hours").default(4).notNull(),
	followUpMessage: text("follow_up_message"),
	// DM/resposta privada mandada a quem comentou.
	dmMessage: text("dm_message").notNull(),
	// não mandar o mesmo DM 2x pra mesma pessoa nessa regra.
	oncePerUser: boolean("once_per_user").default(true).notNull(),
	// amarra a regra a um POST específico (media_id do IG). NULL = qualquer post.
	// LEGADO: mantido pra compat; a fonte da verdade agora é `mediaIds`.
	mediaId: text("media_id"),
	// lista de posts (media_id) que a regra cobre. NULL/vazio = qualquer post.
	mediaIds: text("media_ids").array(),
	// LEGADO (1 botão): mantido pra compat de leitura de regras antigas. A fonte
	// da verdade agora é `dmButtons`. Ao escrever, guardamos o 1º botão aqui.
	dmButtonText: text("dm_button_text"),
	dmButtonUrl: text("dm_button_url"),
	// Botões do DM (card estilo ManyChat): lista de { text, url }, até 3. Se tiver
	// ao menos 1, o DM vai como card com os botões (renderiza no app do IG).
	dmButtons: jsonb("dm_buttons").$type<{ text: string; url: string }[]>(),
	// Depois de mandar o DM, INICIA este Fluxo pro contato (sequência visual).
	// NULL = só o DM. FK ON DELETE SET NULL (excluir o fluxo não apaga a regra).
	startFlowId: uuid("start_flow_id"),
	// 🎯 Qualificação por IA (social selling): antes de mandar o DM, a IA analisa
	// o perfil (@username + bio/seguidores via Business Discovery, quando é conta
	// business/creator) e o texto do comentário contra os critérios. Não
	// qualificado → só a resposta pública, sem DM. NULL = sem critério (não filtra).
	qualificationEnabled: boolean("qualification_enabled").default(false).notNull(),
	qualificationPrompt: text("qualification_prompt"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("idx_ig_comment_automations_channel").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.channelId.asc().nullsLast().op("uuid_ops")),
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "instagram_comment_automations_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.channelId], foreignColumns: [channels.id], name: "instagram_comment_automations_channel_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.startFlowId], foreignColumns: [flows.id], name: "ig_comment_automations_start_flow_id_fkey" }).onDelete("set null"),
]);

export const instagramCommentEvents = pgTable("instagram_comment_events", {
	id: uuid().default(sql`uuid_generate_v4()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	channelId: uuid("channel_id").notNull(),
	commentId: text("comment_id").notNull(),
	commenterIgsid: text("commenter_igsid"),
	commenterUsername: text("commenter_username"),
	mediaId: text("media_id"),
	commentText: text("comment_text"),
	automationId: uuid("automation_id"),
	matched: boolean().default(false).notNull(),
	publicReplied: boolean("public_replied").default(false).notNull(),
	dmSent: boolean("dm_sent").default(false).notNull(),
	error: text(),
	// ⏰ follow-up pós-DM enviado (1x por evento).
	followUpSentAt: timestamp("follow_up_sent_at", { withTimezone: true, mode: 'string' }),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	uniqueIndex("uniq_ig_comment_event").using("btree", table.channelId.asc().nullsLast().op("uuid_ops"), table.commentId.asc().nullsLast()),
	index("idx_ig_comment_events_user").using("btree", table.automationId.asc().nullsLast().op("uuid_ops"), table.commenterIgsid.asc().nullsLast()),
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "instagram_comment_events_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.channelId], foreignColumns: [channels.id], name: "instagram_comment_events_channel_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.automationId], foreignColumns: [instagramCommentAutomations.id], name: "instagram_comment_events_automation_id_fkey" }).onDelete("set null"),
]);

// 🔧 Ferramentas externas por agente (migração 0134) — tool HTTP configurável
// que a IA chama via marcador [[FERRAMENTA: slug | {...}]]. headers_enc =
// ciphertext AES-GCM de um JSON de headers (mesmo esquema dos canais).
export const agentTools = pgTable("agent_tools", {
	id: uuid().default(sql`gen_random_uuid()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	agentId: uuid("agent_id").notNull(),
	name: text().notNull(),
	slug: text().notNull(),
	description: text().notNull(),
	method: text().default('GET').notNull(),
	url: text().notNull(),
	headersEnc: text("headers_enc"),
	params: jsonb().default([]).notNull(),
	bodyTemplate: text("body_template"),
	risk: text().default('read').notNull(),
	enabled: boolean().default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("agent_tools_account_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops")),
	index("agent_tools_agent_idx").using("btree", table.agentId.asc().nullsLast().op("uuid_ops"), table.enabled.asc().nullsLast()),
	uniqueIndex("agent_tools_agent_slug_unique").using("btree", table.agentId.asc().nullsLast().op("uuid_ops"), table.slug.asc().nullsLast()),
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "agent_tools_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.agentId], foreignColumns: [aiConfigs.id], name: "agent_tools_agent_id_fkey" }).onDelete("cascade"),
]);

// Histórico de execução das ferramentas (auditoria/debug do agente).
export const agentToolRuns = pgTable("agent_tool_runs", {
	id: uuid().default(sql`gen_random_uuid()`).primaryKey().notNull(),
	accountId: uuid("account_id").notNull(),
	toolId: uuid("tool_id"),
	agentId: uuid("agent_id"),
	conversationId: uuid("conversation_id"),
	toolSlug: text("tool_slug").notNull(),
	args: jsonb(),
	status: text().notNull(),
	resultSummary: text("result_summary"),
	httpStatus: integer("http_status"),
	durationMs: integer("duration_ms"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => [
	index("agent_tool_runs_account_idx").using("btree", table.accountId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsLast()),
	index("agent_tool_runs_tool_idx").using("btree", table.toolId.asc().nullsLast().op("uuid_ops"), table.createdAt.desc().nullsLast()),
	foreignKey({ columns: [table.accountId], foreignColumns: [organization.id], name: "agent_tool_runs_account_id_fkey" }).onDelete("cascade"),
	foreignKey({ columns: [table.toolId], foreignColumns: [agentTools.id], name: "agent_tool_runs_tool_id_fkey" }).onDelete("set null"),
]);

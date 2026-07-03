import { relations } from "drizzle-orm/relations";
import { organization, contacts, tags, contactTags, customFields, contactCustomValues, contactNotes, conversations, messages, messageReactions, pipelines, whatsappConfig, messageTemplates, pipelineStages, deals, broadcasts, broadcastRecipients, automations, automationSteps, automationLogs, automationPendingExecutions, flows, apiKeys, flowNodes, flowRuns, flowRunEvents, notifications, webhookEndpoints, aiConfigs, aiKnowledgeDocuments, aiKnowledgeChunks } from "./schema";

// ============================================================
// Domain relations — the tenant root is now `organization` (Better
// Auth). Every domain `account_id` FK targets `organization.id`.
// Better Auth's own tables (user/session/account/member/invitation)
// carry their FKs in schema.ts and don't need Drizzle relations here.
// ============================================================

export const organizationRelations = relations(organization, ({many}) => ({
	contacts: many(contacts),
	tags: many(tags),
	customFields: many(customFields),
	contactNotes: many(contactNotes),
	conversations: many(conversations),
	pipelines: many(pipelines),
	whatsappConfigs: many(whatsappConfig),
	messageTemplates: many(messageTemplates),
	deals: many(deals),
	broadcasts: many(broadcasts),
	automations: many(automations),
	automationLogs: many(automationLogs),
	automationPendingExecutions: many(automationPendingExecutions),
	flows: many(flows),
	apiKeys: many(apiKeys),
	flowRuns: many(flowRuns),
	notifications: many(notifications),
	webhookEndpoints: many(webhookEndpoints),
	aiConfigs: many(aiConfigs),
	aiKnowledgeDocuments: many(aiKnowledgeDocuments),
	aiKnowledgeChunks: many(aiKnowledgeChunks),
}));

export const contactsRelations = relations(contacts, ({one, many}) => ({
	account: one(organization, {
		fields: [contacts.accountId],
		references: [organization.id]
	}),
	contactTags: many(contactTags),
	contactCustomValues: many(contactCustomValues),
	contactNotes: many(contactNotes),
	conversations: many(conversations),
	deals: many(deals),
	broadcastRecipients: many(broadcastRecipients),
	automationLogs: many(automationLogs),
	automationPendingExecutions: many(automationPendingExecutions),
	flowRuns: many(flowRuns),
	notifications: many(notifications),
}));

export const tagsRelations = relations(tags, ({one, many}) => ({
	account: one(organization, {
		fields: [tags.accountId],
		references: [organization.id]
	}),
	contactTags: many(contactTags),
}));

export const contactTagsRelations = relations(contactTags, ({one}) => ({
	contact: one(contacts, {
		fields: [contactTags.contactId],
		references: [contacts.id]
	}),
	tag: one(tags, {
		fields: [contactTags.tagId],
		references: [tags.id]
	}),
}));

export const customFieldsRelations = relations(customFields, ({one, many}) => ({
	account: one(organization, {
		fields: [customFields.accountId],
		references: [organization.id]
	}),
	contactCustomValues: many(contactCustomValues),
}));

export const contactCustomValuesRelations = relations(contactCustomValues, ({one}) => ({
	contact: one(contacts, {
		fields: [contactCustomValues.contactId],
		references: [contacts.id]
	}),
	customField: one(customFields, {
		fields: [contactCustomValues.customFieldId],
		references: [customFields.id]
	}),
}));

export const contactNotesRelations = relations(contactNotes, ({one}) => ({
	contact: one(contacts, {
		fields: [contactNotes.contactId],
		references: [contacts.id]
	}),
	account: one(organization, {
		fields: [contactNotes.accountId],
		references: [organization.id]
	}),
}));

export const conversationsRelations = relations(conversations, ({one, many}) => ({
	account: one(organization, {
		fields: [conversations.accountId],
		references: [organization.id]
	}),
	contact: one(contacts, {
		fields: [conversations.contactId],
		references: [contacts.id]
	}),
	messages: many(messages),
	messageReactions: many(messageReactions),
	deals: many(deals),
	flowRuns: many(flowRuns),
	notifications: many(notifications),
}));

export const messagesRelations = relations(messages, ({one, many}) => ({
	conversation: one(conversations, {
		fields: [messages.conversationId],
		references: [conversations.id]
	}),
	message: one(messages, {
		fields: [messages.replyToMessageId],
		references: [messages.id],
		relationName: "messages_replyToMessageId_messages_id"
	}),
	messages: many(messages, {
		relationName: "messages_replyToMessageId_messages_id"
	}),
	messageReactions: many(messageReactions),
	flowRuns: many(flowRuns),
}));

export const messageReactionsRelations = relations(messageReactions, ({one}) => ({
	message: one(messages, {
		fields: [messageReactions.messageId],
		references: [messages.id]
	}),
	conversation: one(conversations, {
		fields: [messageReactions.conversationId],
		references: [conversations.id]
	}),
}));

export const pipelinesRelations = relations(pipelines, ({one, many}) => ({
	account: one(organization, {
		fields: [pipelines.accountId],
		references: [organization.id]
	}),
	pipelineStages: many(pipelineStages),
	deals: many(deals),
}));

export const whatsappConfigRelations = relations(whatsappConfig, ({one}) => ({
	account: one(organization, {
		fields: [whatsappConfig.accountId],
		references: [organization.id]
	}),
}));

export const messageTemplatesRelations = relations(messageTemplates, ({one}) => ({
	account: one(organization, {
		fields: [messageTemplates.accountId],
		references: [organization.id]
	}),
}));

export const pipelineStagesRelations = relations(pipelineStages, ({one, many}) => ({
	pipeline: one(pipelines, {
		fields: [pipelineStages.pipelineId],
		references: [pipelines.id]
	}),
	deals: many(deals),
}));

export const dealsRelations = relations(deals, ({one}) => ({
	account: one(organization, {
		fields: [deals.accountId],
		references: [organization.id]
	}),
	pipeline: one(pipelines, {
		fields: [deals.pipelineId],
		references: [pipelines.id]
	}),
	pipelineStage: one(pipelineStages, {
		fields: [deals.stageId],
		references: [pipelineStages.id]
	}),
	contact: one(contacts, {
		fields: [deals.contactId],
		references: [contacts.id]
	}),
	conversation: one(conversations, {
		fields: [deals.conversationId],
		references: [conversations.id]
	}),
}));

export const broadcastsRelations = relations(broadcasts, ({one, many}) => ({
	account: one(organization, {
		fields: [broadcasts.accountId],
		references: [organization.id]
	}),
	broadcastRecipients: many(broadcastRecipients),
}));

export const broadcastRecipientsRelations = relations(broadcastRecipients, ({one}) => ({
	broadcast: one(broadcasts, {
		fields: [broadcastRecipients.broadcastId],
		references: [broadcasts.id]
	}),
	contact: one(contacts, {
		fields: [broadcastRecipients.contactId],
		references: [contacts.id]
	}),
}));

export const automationsRelations = relations(automations, ({one, many}) => ({
	account: one(organization, {
		fields: [automations.accountId],
		references: [organization.id]
	}),
	automationSteps: many(automationSteps),
	automationLogs: many(automationLogs),
	automationPendingExecutions: many(automationPendingExecutions),
}));

export const automationStepsRelations = relations(automationSteps, ({one, many}) => ({
	automation: one(automations, {
		fields: [automationSteps.automationId],
		references: [automations.id]
	}),
	automationStep: one(automationSteps, {
		fields: [automationSteps.parentStepId],
		references: [automationSteps.id],
		relationName: "automationSteps_parentStepId_automationSteps_id"
	}),
	automationSteps: many(automationSteps, {
		relationName: "automationSteps_parentStepId_automationSteps_id"
	}),
	automationPendingExecutions: many(automationPendingExecutions),
}));

export const automationLogsRelations = relations(automationLogs, ({one, many}) => ({
	automation: one(automations, {
		fields: [automationLogs.automationId],
		references: [automations.id]
	}),
	account: one(organization, {
		fields: [automationLogs.accountId],
		references: [organization.id]
	}),
	contact: one(contacts, {
		fields: [automationLogs.contactId],
		references: [contacts.id]
	}),
	automationPendingExecutions: many(automationPendingExecutions),
}));

export const automationPendingExecutionsRelations = relations(automationPendingExecutions, ({one}) => ({
	automation: one(automations, {
		fields: [automationPendingExecutions.automationId],
		references: [automations.id]
	}),
	account: one(organization, {
		fields: [automationPendingExecutions.accountId],
		references: [organization.id]
	}),
	contact: one(contacts, {
		fields: [automationPendingExecutions.contactId],
		references: [contacts.id]
	}),
	automationLog: one(automationLogs, {
		fields: [automationPendingExecutions.logId],
		references: [automationLogs.id]
	}),
	automationStep: one(automationSteps, {
		fields: [automationPendingExecutions.parentStepId],
		references: [automationSteps.id]
	}),
}));

export const flowsRelations = relations(flows, ({one, many}) => ({
	account: one(organization, {
		fields: [flows.accountId],
		references: [organization.id]
	}),
	flowNodes: many(flowNodes),
	flowRuns: many(flowRuns),
}));

export const apiKeysRelations = relations(apiKeys, ({one}) => ({
	account: one(organization, {
		fields: [apiKeys.accountId],
		references: [organization.id]
	}),
}));

export const flowNodesRelations = relations(flowNodes, ({one}) => ({
	flow: one(flows, {
		fields: [flowNodes.flowId],
		references: [flows.id]
	}),
}));

export const flowRunsRelations = relations(flowRuns, ({one, many}) => ({
	flow: one(flows, {
		fields: [flowRuns.flowId],
		references: [flows.id]
	}),
	account: one(organization, {
		fields: [flowRuns.accountId],
		references: [organization.id]
	}),
	contact: one(contacts, {
		fields: [flowRuns.contactId],
		references: [contacts.id]
	}),
	conversation: one(conversations, {
		fields: [flowRuns.conversationId],
		references: [conversations.id]
	}),
	message: one(messages, {
		fields: [flowRuns.lastPromptMessageId],
		references: [messages.id]
	}),
	flowRunEvents: many(flowRunEvents),
}));

export const flowRunEventsRelations = relations(flowRunEvents, ({one}) => ({
	flowRun: one(flowRuns, {
		fields: [flowRunEvents.flowRunId],
		references: [flowRuns.id]
	}),
}));

export const notificationsRelations = relations(notifications, ({one}) => ({
	account: one(organization, {
		fields: [notifications.accountId],
		references: [organization.id]
	}),
	conversation: one(conversations, {
		fields: [notifications.conversationId],
		references: [conversations.id]
	}),
	contact: one(contacts, {
		fields: [notifications.contactId],
		references: [contacts.id]
	}),
}));

export const webhookEndpointsRelations = relations(webhookEndpoints, ({one}) => ({
	account: one(organization, {
		fields: [webhookEndpoints.accountId],
		references: [organization.id]
	}),
}));

export const aiConfigsRelations = relations(aiConfigs, ({one}) => ({
	account: one(organization, {
		fields: [aiConfigs.accountId],
		references: [organization.id]
	}),
}));

export const aiKnowledgeDocumentsRelations = relations(aiKnowledgeDocuments, ({one, many}) => ({
	account: one(organization, {
		fields: [aiKnowledgeDocuments.accountId],
		references: [organization.id]
	}),
	aiKnowledgeChunks: many(aiKnowledgeChunks),
}));

export const aiKnowledgeChunksRelations = relations(aiKnowledgeChunks, ({one}) => ({
	aiKnowledgeDocument: one(aiKnowledgeDocuments, {
		fields: [aiKnowledgeChunks.documentId],
		references: [aiKnowledgeDocuments.id]
	}),
	account: one(organization, {
		fields: [aiKnowledgeChunks.accountId],
		references: [organization.id]
	}),
}));

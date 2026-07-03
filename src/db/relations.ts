import { relations } from "drizzle-orm/relations";
import { accounts, profiles, contacts, tags, contactTags, customFields, contactCustomValues, contactNotes, conversations, messages, messageReactions, pipelines, whatsappConfig, messageTemplates, pipelineStages, deals, broadcasts, broadcastRecipients, automations, automationSteps, automationLogs, automationPendingExecutions, flows, apiKeys, flowNodes, flowRuns, flowRunEvents, notifications, webhookEndpoints, aiConfigs, aiKnowledgeDocuments, aiKnowledgeChunks } from "./schema";

export const profilesRelations = relations(profiles, ({one, many}) => ({
	account: one(accounts, {
		fields: [profiles.accountId],
		references: [accounts.id]
	}),
	deals: many(deals),
}));

export const accountsRelations = relations(accounts, ({many}) => ({
	profiles: many(profiles),
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
	account: one(accounts, {
		fields: [contacts.accountId],
		references: [accounts.id]
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
	account: one(accounts, {
		fields: [tags.accountId],
		references: [accounts.id]
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
	account: one(accounts, {
		fields: [customFields.accountId],
		references: [accounts.id]
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
	account: one(accounts, {
		fields: [contactNotes.accountId],
		references: [accounts.id]
	}),
}));

export const conversationsRelations = relations(conversations, ({one, many}) => ({
	account: one(accounts, {
		fields: [conversations.accountId],
		references: [accounts.id]
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
	account: one(accounts, {
		fields: [pipelines.accountId],
		references: [accounts.id]
	}),
	pipelineStages: many(pipelineStages),
	deals: many(deals),
}));

export const whatsappConfigRelations = relations(whatsappConfig, ({one}) => ({
	account: one(accounts, {
		fields: [whatsappConfig.accountId],
		references: [accounts.id]
	}),
}));

export const messageTemplatesRelations = relations(messageTemplates, ({one}) => ({
	account: one(accounts, {
		fields: [messageTemplates.accountId],
		references: [accounts.id]
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
	account: one(accounts, {
		fields: [deals.accountId],
		references: [accounts.id]
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
	profile: one(profiles, {
		fields: [deals.assignedTo],
		references: [profiles.id]
	}),
}));

export const broadcastsRelations = relations(broadcasts, ({one, many}) => ({
	account: one(accounts, {
		fields: [broadcasts.accountId],
		references: [accounts.id]
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
	account: one(accounts, {
		fields: [automations.accountId],
		references: [accounts.id]
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
	account: one(accounts, {
		fields: [automationLogs.accountId],
		references: [accounts.id]
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
	account: one(accounts, {
		fields: [automationPendingExecutions.accountId],
		references: [accounts.id]
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
	account: one(accounts, {
		fields: [flows.accountId],
		references: [accounts.id]
	}),
	flowNodes: many(flowNodes),
	flowRuns: many(flowRuns),
}));

export const apiKeysRelations = relations(apiKeys, ({one}) => ({
	account: one(accounts, {
		fields: [apiKeys.accountId],
		references: [accounts.id]
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
	account: one(accounts, {
		fields: [flowRuns.accountId],
		references: [accounts.id]
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
	account: one(accounts, {
		fields: [notifications.accountId],
		references: [accounts.id]
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
	account: one(accounts, {
		fields: [webhookEndpoints.accountId],
		references: [accounts.id]
	}),
}));

export const aiConfigsRelations = relations(aiConfigs, ({one}) => ({
	account: one(accounts, {
		fields: [aiConfigs.accountId],
		references: [accounts.id]
	}),
}));

export const aiKnowledgeDocumentsRelations = relations(aiKnowledgeDocuments, ({one, many}) => ({
	account: one(accounts, {
		fields: [aiKnowledgeDocuments.accountId],
		references: [accounts.id]
	}),
	aiKnowledgeChunks: many(aiKnowledgeChunks),
}));

export const aiKnowledgeChunksRelations = relations(aiKnowledgeChunks, ({one}) => ({
	aiKnowledgeDocument: one(aiKnowledgeDocuments, {
		fields: [aiKnowledgeChunks.documentId],
		references: [aiKnowledgeDocuments.id]
	}),
	account: one(accounts, {
		fields: [aiKnowledgeChunks.accountId],
		references: [accounts.id]
	}),
}));
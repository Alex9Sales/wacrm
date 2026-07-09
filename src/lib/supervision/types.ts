// Types for the agent supervision panel.

export interface AgentStat {
  id: string;
  name: string;
  email: string;
  image: string | null;
  /** Open conversations assigned to this agent. */
  open: number;
  /** Assigned open conversations awaiting an agent reply (SLA). */
  waiting: number;
  /** Longest current wait (minutes) among this agent's conversations. */
  maxWaitingMin: number | null;
  /** Average first-response time in minutes over the last 7 days. */
  avgResponseMin: number | null;
}

export interface SupervisionOverview {
  agents: AgentStat[];
  totalOpen: number;
  totalWaiting: number;
  /** Open conversations with no assigned agent — the shared queue. */
  unassignedOpen: number;
}

export interface AgentConversationRow {
  id: string;
  contactName: string;
  channelName: string | null;
  status: string;
  lastMessageAt: string | null;
  /** Minutes the customer has been waiting for a reply (null = not waiting). */
  waitingMin: number | null;
  unread: number;
}

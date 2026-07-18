// ============================================================
// The internal-chat channel the user is currently viewing, shared with the
// notification listener so it can silence only THAT channel — a message in
// another channel still sounds, even while the chat is open (WhatsApp/Slack
// behavior). Module-level (not React state) because the listener reads it
// imperatively inside an SSE callback.
// ============================================================

let activeChannelId: string | null = null;

export function setActiveInternalChannel(id: string | null): void {
  activeChannelId = id;
}

export function getActiveInternalChannel(): string | null {
  return activeChannelId;
}

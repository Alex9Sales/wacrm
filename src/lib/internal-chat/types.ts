// Shared types for the internal team chat (Chat Interno).

export interface InternalChannel {
  id: string;
  name: string;
  description: string | null;
  is_private: boolean;
  created_at: string;
  /** True when there are messages from others newer than the user's last read. */
  unread?: boolean;
}

export type InternalMediaKind = "image" | "video" | "audio" | "document";

export interface InternalChatMessage {
  id: string;
  channel_id: string;
  sender_id: string;
  sender_name: string;
  sender_image: string | null;
  content: string;
  /** Optional attachment (migration 0033). */
  media_url: string | null;
  media_type: InternalMediaKind | null;
  media_name: string | null;
  created_at: string;
  /** True when the current user is the sender (computed server-side). */
  is_mine: boolean;
}

export interface TeamMemberOption {
  id: string;
  name: string;
  email: string;
  image: string | null;
}

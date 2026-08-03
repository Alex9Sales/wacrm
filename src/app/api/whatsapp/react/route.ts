import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';

import {
  db,
  contacts,
  conversations,
  messageReactions,
  messages,
} from '@/db';
import { firstOrNull } from '@/db/helpers';
import {
  getCurrentAccount,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account';
import { loadChannel } from '@/lib/channels/channels';
import { getProvider } from '@/lib/channels/registry';
import { publishEvent } from '@/lib/events/publish';
import { sanitizePhoneForMeta } from '@/lib/whatsapp/phone-utils';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

/**
 * POST /api/whatsapp/react
 *
 * Body: { message_id: <internal UUID>, emoji: <single emoji or "" to remove> }
 *
 * Sends the reaction to Meta and mirrors it into `message_reactions`
 * (delete on empty emoji). Customer-side reactions are handled by the
 * webhook — this route only writes `actor_type = 'agent'` rows.
 */
export async function POST(request: Request) {
  try {
    let ctx: AccountContext;
    try {
      ctx = await getCurrentAccount();
    } catch (err) {
      return toErrorResponse(err);
    }
    const accountId = ctx.accountId;

    const limit = await checkRateLimit(`react:${ctx.userId}`, RATE_LIMITS.react);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json();
    const { message_id, emoji } = body as {
      message_id?: string;
      emoji?: string;
    };

    if (!message_id || typeof emoji !== 'string') {
      return NextResponse.json(
        { error: 'message_id and emoji are required' },
        { status: 400 },
      );
    }

    // Resolve target message + its conversation; verify ownership.
    let targetMessage: {
      id: string;
      messageId: string | null;
      conversationId: string;
      senderType: string;
    } | null = null;
    try {
      targetMessage = firstOrNull(
        await db
          .select({
            id: messages.id,
            messageId: messages.messageId,
            conversationId: messages.conversationId,
            senderType: messages.senderType,
          })
          .from(messages)
          .where(eq(messages.id, message_id))
          .limit(1),
      );
    } catch {
      targetMessage = null;
    }

    if (!targetMessage) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }

    if (!targetMessage.messageId) {
      // No Meta ID yet — usually a sending/failed agent message. We can't
      // tell Meta to react to a message it never received.
      return NextResponse.json(
        { error: 'Cannot react to a message that has not been sent to WhatsApp' },
        { status: 400 },
      );
    }

    const conversation = firstOrNull(
      await db
        .select({
          id: conversations.id,
          channelId: conversations.channelId,
          contactPhone: contacts.phone,
        })
        .from(conversations)
        .leftJoin(contacts, eq(conversations.contactId, contacts.id))
        .where(
          and(
            eq(conversations.id, targetMessage.conversationId),
            eq(conversations.accountId, accountId),
          ),
        )
        .limit(1),
    );

    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 },
      );
    }

    if (!conversation.contactPhone) {
      return NextResponse.json(
        { error: 'Contact phone number not found' },
        { status: 400 },
      );
    }

    if (!conversation.channelId) {
      return NextResponse.json(
        { error: 'WhatsApp not configured.' },
        { status: 400 },
      );
    }

    // Dispatch the reaction through the conversation's channel provider.
    // Credentials arrive already decrypted on the ctx.
    const channel = await loadChannel(conversation.channelId);
    if (!channel) {
      return NextResponse.json(
        { error: 'WhatsApp not configured.' },
        { status: 400 },
      );
    }

    const provider = getProvider(channel.provider);
    if (!provider.capabilities.reactions || !provider.sendReaction) {
      return NextResponse.json(
        { error: 'This channel does not support reactions.' },
        { status: 400 },
      );
    }

    const sanitizedPhone = sanitizePhoneForMeta(conversation.contactPhone);

    // The unified sendReaction signature carries only the target message
    // id + emoji; the recipient phone is threaded through
    // providerMeta.reaction_to (the Meta adapter reads it there). The WAHA/gows
    // adapter also needs the target's DIRECTION to rebuild the serialized id
    // (`<fromMe>_<chatId>_<HASH>`) — threaded as reaction_from_me.
    const targetFromMe =
      targetMessage.senderType === 'agent' ||
      targetMessage.senderType === 'bot';
    const channelWithRecipient = {
      ...channel,
      providerMeta: {
        ...channel.providerMeta,
        reaction_to: sanitizedPhone,
        reaction_from_me: targetFromMe,
      },
    };

    try {
      await provider.sendReaction(
        channelWithRecipient,
        targetMessage.messageId,
        emoji,
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Unknown provider error';
      console.error('[whatsapp/react] provider send failed:', message);
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 502 },
      );
    }

    // Mirror into DB. Empty emoji = removal.
    if (emoji === '') {
      try {
        await db
          .delete(messageReactions)
          .where(
            and(
              eq(messageReactions.messageId, targetMessage.id),
              eq(messageReactions.actorType, 'agent'),
              eq(messageReactions.actorId, ctx.userId),
            ),
          );
      } catch (delError) {
        console.error(
          '[whatsapp/react] DB delete failed:',
          delError instanceof Error ? delError.message : delError,
        );
        return NextResponse.json(
          { error: 'Reaction sent to Meta but DB delete failed' },
          { status: 500 },
        );
      }
    } else {
      // Upsert. The unique constraint (message_id, actor_type, actor_id)
      // lets us swap emoji in a single statement.
      try {
        await db
          .insert(messageReactions)
          .values({
            messageId: targetMessage.id,
            conversationId: targetMessage.conversationId,
            actorType: 'agent',
            actorId: ctx.userId,
            emoji,
          })
          .onConflictDoUpdate({
            target: [
              messageReactions.messageId,
              messageReactions.actorType,
              messageReactions.actorId,
            ],
            set: { emoji },
          });
      } catch (upsertError) {
        console.error(
          '[whatsapp/react] DB upsert failed:',
          upsertError instanceof Error ? upsertError.message : upsertError,
        );
        return NextResponse.json(
          { error: 'Reaction sent to Meta but DB upsert failed' },
          { status: 500 },
        );
      }
    }

    // Reflect the reaction in the conversation-list preview, like WhatsApp
    // ("Você reagiu com 👍"). Only for a real emoji — removing a reaction
    // leaves the last real message preview alone. We do NOT bump
    // last_message_at, so the card stays put but shows the reaction line.
    if (emoji) {
      try {
        await db
          .update(conversations)
          .set({ lastMessageText: `↩️ Você reagiu com ${emoji}` })
          .where(eq(conversations.id, targetMessage.conversationId));
        await publishEvent(accountId, {
          type: 'message.received',
          conversationId: targetMessage.conversationId,
          fromMe: true,
        });
      } catch (previewErr) {
        console.error(
          '[whatsapp/react] preview update failed:',
          previewErr instanceof Error ? previewErr.message : previewErr,
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error in WhatsApp react POST:', error);
    return NextResponse.json(
      { error: 'Failed to react to message' },
      { status: 500 },
    );
  }
}

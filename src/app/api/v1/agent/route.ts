// ============================================================
// GET /api/v1/agent  — read the AI text agent config.   scope: agent:read
// PUT /api/v1/agent  — configure the AI text agent.      scope: agent:write
//
// The "text agent" is the account's single AI configuration (provider,
// model, system prompt, own API key) that powers AI-drafted replies, the
// auto-reply bot and the Playground. PUT upserts it: the provider is asked
// to validate the key before it's stored (AES-256-GCM encrypted). When
// `api_key` is omitted the stored key is reused. The key is NEVER returned.
// ============================================================

import { eq } from 'drizzle-orm';

import { db, aiConfigs } from '@/db';
import { firstOrNull } from '@/db/helpers';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import { validateAiCredentials } from '@/lib/ai/validate';
import { AiError, type AiProvider } from '@/lib/ai/types';

function serialize(row: {
  provider: string;
  model: string;
  systemPrompt: string | null;
  isActive: boolean;
  autoReplyEnabled: boolean;
  autoReplyMaxPerConversation: number;
}) {
  return {
    configured: true,
    provider: row.provider,
    model: row.model,
    system_prompt: row.systemPrompt,
    is_active: row.isActive,
    auto_reply_enabled: row.autoReplyEnabled,
    auto_reply_max_per_conversation: row.autoReplyMaxPerConversation,
    has_key: true,
  };
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'agent:read');
    const row = firstOrNull(
      await db
        .select({
          provider: aiConfigs.provider,
          model: aiConfigs.model,
          systemPrompt: aiConfigs.systemPrompt,
          isActive: aiConfigs.isActive,
          autoReplyEnabled: aiConfigs.autoReplyEnabled,
          autoReplyMaxPerConversation: aiConfigs.autoReplyMaxPerConversation,
        })
        .from(aiConfigs)
        .where(eq(aiConfigs.accountId, ctx.accountId))
        .limit(1),
    );
    if (!row) return ok({ configured: false });
    return ok(serialize(row));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'agent:write');
    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return fail('bad_request', 'Request body must be a JSON object', 400);
    }

    const provider = body.provider as AiProvider;
    if (provider !== 'openai' && provider !== 'anthropic') {
      return fail('bad_request', 'provider must be "openai" or "anthropic"', 400);
    }
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) return fail('bad_request', 'model is required', 400);

    const systemPrompt =
      typeof body.system_prompt === 'string' && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null;
    const isActive = body.is_active === true;
    const autoReplyEnabled = body.auto_reply_enabled === true;
    let maxPer = Number(body.auto_reply_max_per_conversation);
    if (!Number.isFinite(maxPer)) maxPer = 3;
    maxPer = Math.min(20, Math.max(1, Math.floor(maxPer)));

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';

    const existing = firstOrNull(
      await db
        .select({
          id: aiConfigs.id,
          provider: aiConfigs.provider,
          model: aiConfigs.model,
          apiKey: aiConfigs.apiKey,
        })
        .from(aiConfigs)
        .where(eq(aiConfigs.accountId, ctx.accountId))
        .limit(1),
    );

    let apiKeyPlain: string;
    if (rawKey) {
      apiKeyPlain = rawKey;
    } else if (existing?.apiKey) {
      try {
        apiKeyPlain = decrypt(existing.apiKey);
      } catch {
        return fail(
          'bad_request',
          'Stored API key could not be decrypted — send api_key again.',
          400,
        );
      }
    } else {
      return fail('bad_request', 'api_key is required on first setup', 400);
    }

    // Verify the credentials with the provider before persisting, but only
    // when the reachability-affecting fields changed (first setup, new key,
    // new provider/model). A prompt/toggle-only change skips the round-trip.
    const credentialsChanged =
      !existing ||
      rawKey !== '' ||
      provider !== existing.provider ||
      model !== existing.model;
    if (credentialsChanged) {
      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey: apiKeyPlain,
          systemPrompt,
          isActive,
          autoReplyEnabled,
          autoReplyMaxPerConversation: maxPer,
          embeddingsApiKey: null,
        });
      } catch (err) {
        if (err instanceof AiError) return fail('bad_request', err.message, 400);
        console.error('[api/v1/agent] validation error:', err);
        return fail('bad_request', 'Could not validate the API key with the provider.', 400);
      }
    }

    const encryptedKey = rawKey ? encrypt(rawKey) : null;
    const shared = {
      provider,
      model,
      systemPrompt,
      isActive,
      autoReplyEnabled,
      autoReplyMaxPerConversation: maxPer,
    };

    try {
      if (existing) {
        await db
          .update(aiConfigs)
          .set(encryptedKey ? { ...shared, apiKey: encryptedKey } : shared)
          .where(eq(aiConfigs.accountId, ctx.accountId));
      } else {
        const createdBy = await resolveAuditUserId(ctx.accountId);
        await db.insert(aiConfigs).values({
          accountId: ctx.accountId,
          createdBy,
          apiKey: encryptedKey!,
          ...shared,
        });
      }
    } catch (err) {
      console.error('[api/v1/agent] save error:', err);
      return fail('internal', 'Failed to save agent configuration', 500);
    }

    return ok(serialize({ ...shared }));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

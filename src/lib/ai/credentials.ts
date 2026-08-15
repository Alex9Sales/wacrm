// ============================================================
// Chaves de API (credenciais) — CRUD + validação. Server-only.
//
// Uma credencial = provedor + rótulo + chave (criptografada). Reutilizável
// entre agentes (Fase 2 liga o agente a uma credencial). A chave em claro
// NUNCA sai daqui: a serialização devolve só uma dica mascarada (últimos 4).
// ============================================================

import { desc, eq, and } from "drizzle-orm";

import { db, aiCredentials, aiConfigs } from "@/db";
import { firstOrNull } from "@/db/helpers";
import { encrypt, decrypt } from "@/lib/whatsapp/encryption";
import { validateAiCredentials } from "./validate";
import { AI_PROVIDER_DEFAULT_MODEL } from "./defaults";
import { AiError, type AiProvider } from "./types";

/**
 * Valida uma chave Gemini SEM depender de um modelo específico: lista os
 * modelos (checagem de auth). Um generateContent com modelo fixo pode dar 404
 * ("modelo indisponível pra novos usuários") mesmo com a chave boa — então
 * validamos por listagem, e o usuário escolhe o modelo no seletor.
 */
async function validateGeminiKey(apiKey: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1",
      { headers: { "x-goog-api-key": apiKey }, signal: AbortSignal.timeout(15_000) },
    );
  } catch {
    throw new AiError("Não foi possível contatar o Google Gemini.", {
      code: "network_error",
      status: 502,
    });
  }
  if (res.status === 400 || res.status === 401 || res.status === 403) {
    throw new AiError(
      "O Google rejeitou a chave (inválida ou sem permissão para a API Gemini).",
      { code: "invalid_key", status: 401 },
    );
  }
  if (!res.ok) {
    throw new AiError(`Falha ao validar a chave Gemini (HTTP ${res.status}).`, {
      code: "provider_error",
      status: 502,
    });
  }
}

/** Provedores que já têm adapter funcionando (podem ser validados/usados).
 *  O Gemini entra aqui na Fase 3. A tabela aceita 'gemini' desde já. */
export const CREDENTIAL_PROVIDERS: AiProvider[] = [
  "openai",
  "anthropic",
  "gemini",
];

export interface CredentialDTO {
  id: string;
  provider: string;
  label: string;
  /** Dica mascarada da chave (••••1234) — nunca a chave inteira. */
  keyHint: string;
  createdAt: string;
}

function maskKey(encrypted: string): string {
  try {
    const plain = decrypt(encrypted);
    const last4 = plain.slice(-4);
    return last4 ? `••••${last4}` : "••••";
  } catch {
    return "••••";
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function serialize(row: any): CredentialDTO {
  return {
    id: row.id as string,
    provider: row.provider as string,
    label: row.label as string,
    keyHint: maskKey(row.apiKey as string),
    createdAt: row.createdAt as string,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Credenciais da conta, mais novas primeiro. */
export async function listCredentials(
  accountId: string,
): Promise<CredentialDTO[]> {
  const rows = await db
    .select()
    .from(aiCredentials)
    .where(eq(aiCredentials.accountId, accountId))
    .orderBy(desc(aiCredentials.createdAt));
  return rows.map(serialize);
}

export class CredentialError extends Error {}

/**
 * Cria uma credencial: valida a chave contra o provedor (uma geração
 * mínima) antes de salvar — mesmo "verifica antes de gravar" do resto.
 * Devolve a credencial serializada (mascarada).
 */
export async function createCredential(input: {
  accountId: string;
  userId: string;
  provider: AiProvider;
  label: string;
  apiKey: string;
}): Promise<CredentialDTO> {
  const { accountId, userId, provider, label, apiKey } = input;
  if (!CREDENTIAL_PROVIDERS.includes(provider)) {
    throw new CredentialError("Provedor não suportado ainda.");
  }
  const key = apiKey.trim();
  if (!key) throw new CredentialError("Informe a chave de API.");

  // Valida a chave antes de salvar. Gemini valida por listagem de modelos
  // (não depende de um modelo específico); OpenAI/Anthropic por uma geração
  // mínima com o modelo padrão.
  if (provider === "gemini") {
    await validateGeminiKey(key);
  } else {
    await validateAiCredentials({
      provider,
      model: AI_PROVIDER_DEFAULT_MODEL[provider],
      apiKey: key,
      systemPrompt: null,
      isActive: true,
      autoReplyEnabled: false,
      autoReplyChannelIds: [],
      autoReplyMaxPerConversation: 3,
      autoReplyHoursMode: "always",
      embeddingsApiKey: null,
      signatureName: null,
      signatureEnabled: false,
    });
  }

  const row = firstOrNull(
    await db
      .insert(aiCredentials)
      .values({
        accountId,
        createdBy: userId,
        provider,
        label: label.trim().slice(0, 60) || defaultLabel(provider),
        apiKey: encrypt(key),
      })
      .returning(),
  );
  if (!row) throw new CredentialError("Não foi possível salvar a credencial.");
  return serialize(row);
}

/** Remove uma credencial da conta. Devolve true se removeu. */
export async function deleteCredential(
  accountId: string,
  id: string,
): Promise<boolean> {
  const row = firstOrNull(
    await db
      .delete(aiCredentials)
      .where(and(eq(aiCredentials.id, id), eq(aiCredentials.accountId, accountId)))
      .returning({ id: aiCredentials.id }),
  );
  return !!row;
}

function defaultLabel(provider: string): string {
  if (provider === "openai") return "OpenAI";
  if (provider === "anthropic") return "Anthropic";
  if (provider === "gemini") return "Gemini";
  return provider;
}

/**
 * Importa as chaves que já estão nos agentes (ai_configs) para o registro de
 * credenciais, deduplicando pela chave REAL (decriptada) — a criptografia usa
 * IV aleatório, então o mesmo segredo tem ciphertext diferente por linha, e
 * dedup só é possível decriptando aqui. Não valida (as chaves já rodam).
 * Devolve quantas credenciais novas foram criadas.
 */
export async function importCredentialsFromAgents(input: {
  accountId: string;
  userId: string;
}): Promise<number> {
  const { accountId, userId } = input;

  const agents = await db
    .select({ provider: aiConfigs.provider, apiKey: aiConfigs.apiKey })
    .from(aiConfigs)
    .where(eq(aiConfigs.accountId, accountId));

  // Chaves já registradas (provider + plaintext) pra não duplicar.
  const existing = await db
    .select({ provider: aiCredentials.provider, apiKey: aiCredentials.apiKey })
    .from(aiCredentials)
    .where(eq(aiCredentials.accountId, accountId));
  const seen = new Set<string>();
  for (const c of existing) {
    try {
      seen.add(`${c.provider}:${decrypt(c.apiKey)}`);
    } catch {
      /* ignora blob corrompido */
    }
  }

  let created = 0;
  for (const a of agents) {
    if (!a.apiKey) continue;
    let plain: string;
    try {
      plain = decrypt(a.apiKey);
    } catch {
      continue;
    }
    if (!plain) continue;
    const dedupKey = `${a.provider}:${plain}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    await db.insert(aiCredentials).values({
      accountId,
      createdBy: userId,
      provider: a.provider,
      label: defaultLabel(a.provider),
      apiKey: encrypt(plain),
    });
    created += 1;
  }
  return created;
}

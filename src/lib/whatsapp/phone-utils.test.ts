import { describe, expect, it } from "vitest";
import {
  isRecipientNotAllowedError,
  isValidE164,
  normalizeInboundPhoneBR,
  normalizePhone,
  phoneVariants,
  phonesMatch,
  sanitizePhoneForMeta,
  isImpossibleBrE164,
  isPlausibleBrNational,
  toBrE164IfNational,
} from "./phone-utils";

describe("sanitizePhoneForMeta", () => {
  it("strips +, spaces, and dashes leaving only digits", () => {
    expect(sanitizePhoneForMeta("+370 612 34567")).toBe("37061234567");
    expect(sanitizePhoneForMeta("+1 (415) 555-1212")).toBe("14155551212");
  });

  it("returns an empty string for falsy input", () => {
    expect(sanitizePhoneForMeta("")).toBe("");
    // Defensive: existing call sites occasionally pass through nullable
    // contact phones. The function early-returns on the falsy check.
    expect(sanitizePhoneForMeta(undefined as unknown as string)).toBe("");
  });

  it("is idempotent on already-sanitized input", () => {
    const cleaned = "14155551212";
    expect(sanitizePhoneForMeta(cleaned)).toBe(cleaned);
  });
});

describe("normalizePhone", () => {
  it("matches sanitizePhoneForMeta byte-for-byte (shared canonical form)", () => {
    const samples = ["+370 12345", "abc-555-DEF", "", "0044 7000 0000 0000"];
    for (const s of samples) {
      expect(normalizePhone(s)).toBe(sanitizePhoneForMeta(s));
    }
  });
});

describe("phonesMatch", () => {
  it("returns true for exact digit matches", () => {
    expect(phonesMatch("+37061234567", "37061234567")).toBe(true);
  });

  it("matches across trunk-prefix variants by last-8 fallback", () => {
    // Lithuanian trunk-0 variant. Last 8 digits ("61234567") collide.
    expect(phonesMatch("370061234567", "37061234567")).toBe(true);
  });

  it("rejects mismatched numbers", () => {
    expect(phonesMatch("+37061234567", "+37061234568")).toBe(false);
  });

  it("rejects very short inputs that would false-positive on tail match", () => {
    // Only 7 digits — the last-8 fallback is gated to len>=8 on both
    // sides to avoid declaring "12345" and "67890-12345" a match.
    expect(phonesMatch("1234567", "1234567")).toBe(true);
    expect(phonesMatch("1234567", "9991234567")).toBe(false);
  });

  it("ignores formatting noise on both sides", () => {
    expect(phonesMatch("+370 6 123 4567", "37061234567")).toBe(true);
    expect(phonesMatch("(415) 555-1212", "+1 415-555-1212")).toBe(true);
  });
});

describe("phonesMatch — números brasileiros: o DDD faz parte da identidade", () => {
  it("NÃO iguala DDDs diferentes com o mesmo final (caso DDD 43 × 47, 05/09)", () => {
    // Antes: os 8 últimos dígitos batiam e o inbound do 43 caiu no contato do
    // 47 — endereço do outro, contato renomeado, resposta entregue a um estranho.
    expect(phonesMatch("43990001234", "47990001234")).toBe(false);
    expect(phonesMatch("5543990001234", "5547990001234")).toBe(false);
    expect(phonesMatch("6790001234", "6890001234")).toBe(false);
  });

  it("continua tolerando o 55 na frente", () => {
    expect(phonesMatch("5567990001234", "67990001234")).toBe(true);
  });

  it("continua tolerando o 9º dígito (celular antigo × novo)", () => {
    expect(phonesMatch("67990001234", "6790001234")).toBe(true);
    expect(phonesMatch("5567990001234", "6790001234")).toBe(true);
  });

  it("55 + 9º dígito juntos, nos dois sentidos", () => {
    expect(phonesMatch("6790001234", "5567990001234")).toBe(true);
  });

  it("brasileiro × estrangeiro com o mesmo final não casa como brasileiro (cai na regra antiga só se ambos forem não-BR)", () => {
    // Um BR e um não-BR: a chave BR não fecha nos dois, então vale a regra
    // antiga de tronco — comportamento preservado de propósito.
    expect(phonesMatch("4155551212", "+1 415-555-1212")).toBe(true);
  });
});

describe("isValidE164", () => {
  it("accepts numbers 7–15 digits with optional + and non-zero start", () => {
    expect(isValidE164("+37061234567")).toBe(true);
    expect(isValidE164("37061234567")).toBe(true);
    expect(isValidE164("+1234567")).toBe(true); // 7 digits — lower bound
    expect(isValidE164("+123456789012345")).toBe(true); // 15 digits — upper bound
  });

  it("rejects numbers that start with 0 in international form", () => {
    expect(isValidE164("+0123456")).toBe(false);
    expect(isValidE164("0044700000000")).toBe(false);
  });

  it("rejects too-short and too-long inputs", () => {
    expect(isValidE164("+123456")).toBe(false); // 6 digits
    expect(isValidE164("+1234567890123456")).toBe(false); // 16 digits
  });

  it("rejects strings with non-digit characters", () => {
    expect(isValidE164("+1-415-555-1212")).toBe(false);
    expect(isValidE164("+1 4155551212")).toBe(false);
    expect(isValidE164("abc12345678")).toBe(false);
  });

  it("rejects the empty string", () => {
    expect(isValidE164("")).toBe(false);
  });
});

describe("phoneVariants", () => {
  it("returns an empty list for empty input", () => {
    expect(phoneVariants("")).toEqual([]);
  });

  it("always lists the original number first", () => {
    const out = phoneVariants("37061234567");
    expect(out[0]).toBe("37061234567");
  });

  it("inserts a trunk 0 after each plausible country-code length", () => {
    // Input "37061234567" — CC-1 → "3" + "0" + "7061234567",
    //                       CC-3 → "370" + "0" + "61234567".
    // CC-2 is skipped because "061234567" already starts with 0.
    const out = phoneVariants("37061234567");
    expect(out).toEqual(
      expect.arrayContaining([
        "37061234567",
        "307061234567",
        "370061234567",
      ]),
    );
  });

  it("removes a leading 0 after the country code when present", () => {
    // Input "370061234567" — CC-2 strips one leading 0 from
    // "0061234567" → "37" + "061234567" = "37061234567". Only one zero
    // comes off per pass; that's what the live retry loop needs.
    const out = phoneVariants("370061234567");
    expect(out).toContain("370061234567");
    expect(out).toContain("37061234567");
  });

  it("deduplicates variants that collapse to the same digits", () => {
    const out = phoneVariants("37061234567");
    expect(new Set(out).size).toBe(out.length);
  });

  it("returns just the original when the number is too short for any CC slice", () => {
    // 1-char input is shorter than all ccLen values; both loops skip.
    expect(phoneVariants("1")).toEqual(["1"]);
  });
});

describe("normalizeInboundPhoneBR", () => {
  it("fixes the '0 + carrier code + DDD + número' national-dial format", () => {
    // 0 + CSP 15 + DDD 27 + 990001234 → 55 27 99000 1234
    expect(normalizeInboundPhoneBR("01527990001234")).toBe("5527990001234");
    // 0 + CSP 15 + DDD 28 + 990005678
    expect(normalizeInboundPhoneBR("01528990005678")).toBe("5528990005678");
  });

  it("fixes a trunk-0-only national number (0 + DDD + número)", () => {
    expect(normalizeInboundPhoneBR("027990001234")).toBe("5527990001234"); // mobile (11)
    expect(normalizeInboundPhoneBR("02733334444")).toBe("552733334444"); // landline (10)
  });

  it("leaves clean E.164 numbers completely untouched (never corrupts them)", () => {
    expect(normalizeInboundPhoneBR("5527990001234")).toBe("5527990001234");
    expect(normalizeInboundPhoneBR("12025550181")).toBe("12025550181"); // US
    expect(normalizeInboundPhoneBR("37061234567")).toBe("37061234567"); // LT
  });

  it("strips formatting noise", () => {
    expect(normalizeInboundPhoneBR("+55 27 99000-1234")).toBe("5527990001234");
    expect(normalizeInboundPhoneBR("0 15 27 99000 1234")).toBe("5527990001234");
  });

  it("does not mangle a foreign number that happens to carry a trunk 0", () => {
    // UK "+44 20 7946 0958" delivered with a trunk 0 → 44 not a CSP → left as
    // digits (zeros stripped) rather than turned into a fake 55… number.
    expect(normalizeInboundPhoneBR("0442079460958")).toBe("442079460958");
  });

  it("is idempotent", () => {
    const once = normalizeInboundPhoneBR("01527990001234");
    expect(normalizeInboundPhoneBR(once)).toBe(once);
  });

  it("handles empty / falsy input", () => {
    expect(normalizeInboundPhoneBR("")).toBe("");
    expect(normalizeInboundPhoneBR(undefined as unknown as string)).toBe("");
  });

  // 25/09: o formulário de uma clínica pedia telefone e o paciente digitava
  // "11 96097-4661", sem o 55. O contato nascia assim e a mensagem dele no
  // WhatsApp (que chega como 5511…) nunca casava com a ficha: a recepção via
  // um cadastro sem conversa nenhuma e achava que a mensagem tinha sumido.
  it("completa o 55 do nacional limpo digitado em formulário/planilha", () => {
    expect(normalizeInboundPhoneBR("11960974661")).toBe("5511960974661"); // celular
    expect(normalizeInboundPhoneBR("(11) 96097-4661")).toBe("5511960974661");
    expect(normalizeInboundPhoneBR("1133334444")).toBe("551133334444"); // fixo
  });

  it("mas não inventa um brasileiro a partir de número estrangeiro", () => {
    // 11 dígitos com DDD plausível só vira BR quando o local começa com 9
    // (celular). Estes não começam, então continuam como estão.
    expect(normalizeInboundPhoneBR("12025550181")).toBe("12025550181"); // US
    expect(normalizeInboundPhoneBR("37061234567")).toBe("37061234567"); // LT
    expect(normalizeInboundPhoneBR("442079460958")).toBe("442079460958"); // UK, 12 díg.
  });
});

describe("isRecipientNotAllowedError", () => {
  it("matches Meta error code 131030", () => {
    expect(
      isRecipientNotAllowedError(
        "(#131030) Recipient phone number not in allowed list",
      ),
    ).toBe(true);
  });

  it("matches the human-readable English variants", () => {
    expect(isRecipientNotAllowedError("not in allowed list")).toBe(true);
    expect(isRecipientNotAllowedError("recipient not in the allowed list")).toBe(
      true,
    );
    // Case-insensitive on the human text.
    expect(isRecipientNotAllowedError("NOT IN ALLOWED LIST")).toBe(true);
  });

  it("does not false-positive on unrelated Meta errors", () => {
    expect(isRecipientNotAllowedError("(#100) Invalid parameter")).toBe(false);
    expect(isRecipientNotAllowedError("template name does not exist")).toBe(
      false,
    );
    expect(isRecipientNotAllowedError("")).toBe(false);
  });
});

describe("número brasileiro possível (19/09, 55 dobrado)", () => {
  it("celular com 9, fixo e celular antigo de 10 dígitos ganham o 55", () => {
    expect(toBrE164IfNational("12999998888")).toBe("5512999998888");
    expect(toBrE164IfNational("1233334444")).toBe("551233334444");
    expect(toBrE164IfNational("6790001234")).toBe("556790001234");
  });

  it('"55 12 + 7 dígitos" não vira DDD 55: fica como veio', () => {
    expect(toBrE164IfNational("55129888381")).toBe("55129888381");
    expect(isPlausibleBrNational("55129888381")).toBe(false);
  });

  it("celular de DDD 55 digitado sem o país continua valendo", () => {
    expect(toBrE164IfNational("55991234567")).toBe("5555991234567");
  });

  it("número brasileiro impossível é reconhecido; estrangeiro não é julgado", () => {
    expect(isImpossibleBrE164("5555129888381")).toBe(true);
    expect(isImpossibleBrE164("+55 12 99999-8888")).toBe(false);
    expect(isImpossibleBrE164("551233334444")).toBe(false);
    expect(isImpossibleBrE164("5555991234567")).toBe(false);
    expect(isImpossibleBrE164("12025550181")).toBe(false);
  });
});

import { describe, it, expect } from "vitest";

import { DEAL_ORIGINS, isDealOrigin } from "@/lib/pipelines/deal-origin";

describe("origem do negócio", () => {
  it("tem 'Site' na lista padrão", () => {
    expect(DEAL_ORIGINS).toContain("Site");
    expect(DEAL_ORIGINS).toContain("WhatsApp");
    expect(DEAL_ORIGINS).toContain("Instagram");
  });

  it("isDealOrigin valida contra a lista", () => {
    expect(isDealOrigin("Site")).toBe(true);
    expect(isDealOrigin("Indicação")).toBe(true);
    expect(isDealOrigin("Campanha X")).toBe(false); // texto livre legado
    expect(isDealOrigin("")).toBe(false);
    expect(isDealOrigin(null)).toBe(false);
    expect(isDealOrigin(undefined)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";

import { dealChannelLabel, isInstagramProvider } from "@/lib/pipelines/channel-label";

describe("dealChannelLabel", () => {
  it("nomeia Instagram e Messenger; todo WhatsApp (meta/waha/…) vira WhatsApp", () => {
    expect(dealChannelLabel("instagram")).toBe("Instagram");
    expect(dealChannelLabel("messenger")).toBe("Messenger");
    expect(dealChannelLabel("meta")).toBe("WhatsApp");
    expect(dealChannelLabel("waha")).toBe("WhatsApp");
    expect(dealChannelLabel("evolution")).toBe("WhatsApp");
  });

  it("case-insensitive + fallback WhatsApp p/ null/undefined/vazio", () => {
    expect(dealChannelLabel("INSTAGRAM")).toBe("Instagram");
    expect(dealChannelLabel(null)).toBe("WhatsApp");
    expect(dealChannelLabel(undefined)).toBe("WhatsApp");
    expect(dealChannelLabel("")).toBe("WhatsApp");
  });

  it("isInstagramProvider só é true no instagram", () => {
    expect(isInstagramProvider("instagram")).toBe(true);
    expect(isInstagramProvider("Instagram")).toBe(true);
    expect(isInstagramProvider("meta")).toBe(false);
    expect(isInstagramProvider("messenger")).toBe(false);
    expect(isInstagramProvider(null)).toBe(false);
  });
});

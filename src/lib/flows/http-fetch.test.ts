import { describe, it, expect } from "vitest";
import { runHttpFetch } from "./http-fetch";

// These exercise the pre-fetch guards only — every case is refused BEFORE
// any socket is opened, so the suite is offline and deterministic.
describe("runHttpFetch — SSRF / scheme guards", () => {
  it("rejects a non-http(s) scheme", async () => {
    const r = await runHttpFetch(
      { method: "GET", url: "file:///etc/passwd", next_node_key: "x" },
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("esquema_nao_permitido");
    expect(r.status).toBe(0);
  });

  it("rejects a malformed URL", async () => {
    const r = await runHttpFetch(
      { method: "GET", url: "not a url", next_node_key: "x" },
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("url_invalida");
  });

  it("refuses a loopback target (SSRF)", async () => {
    const r = await runHttpFetch(
      { method: "GET", url: "https://127.0.0.1/admin", next_node_key: "x" },
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("destino_bloqueado_ssrf");
  });

  it("refuses the cloud-metadata IP (SSRF)", async () => {
    const r = await runHttpFetch(
      {
        method: "GET",
        url: "https://169.254.169.254/latest/meta-data",
        next_node_key: "x",
      },
      {},
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("destino_bloqueado_ssrf");
  });

  it("interpolates the URL from vars and still applies the guard", async () => {
    // A private IP smuggled in via a var must be refused just the same.
    const r = await runHttpFetch(
      {
        method: "GET",
        url: "https://{{vars.host}}/x",
        next_node_key: "x",
      },
      { host: "10.0.0.5" },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe("destino_bloqueado_ssrf");
  });
});

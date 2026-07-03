import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMediaPath,
  MEDIA_MAX_BYTES_BY_KIND,
  uploadAccountMedia,
  deleteAccountMedia,
} from "./upload-media";

const ACCOUNT = "11111111-2222-3333-4444-555555555555";

describe("buildMediaPath", () => {
  it("namespaces under account-<id> so RLS write policies match", () => {
    const path = buildMediaPath(ACCOUNT, "photo.png", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-photo.png`);
    expect(path.split("/")[0]).toBe(`account-${ACCOUNT}`);
  });

  it("lower-cases the extension and sanitizes the basename", () => {
    const path = buildMediaPath(ACCOUNT, "My Invoice (final).PDF", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-My_Invoice_final_.pdf`);
  });

  it("caps the basename at 40 chars", () => {
    const long = "a".repeat(100) + ".png";
    const path = buildMediaPath(ACCOUNT, long, 1700000000000);
    const base = path.split("/")[1].replace("1700000000000-", "").replace(".png", "");
    expect(base.length).toBe(40);
  });

  it("falls back to 'file' / 'bin' for a nameless input", () => {
    const path = buildMediaPath(ACCOUNT, "", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-file.bin`);
  });

  it("defaults the extension to bin when there is none", () => {
    const path = buildMediaPath(ACCOUNT, "README", 1700000000000);
    expect(path).toBe(`account-${ACCOUNT}/1700000000000-README.bin`);
  });
});

describe("MEDIA_MAX_BYTES_BY_KIND", () => {
  it("caps images at Meta's tighter 5 MB limit", () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.image).toBe(5 * 1024 * 1024);
  });

  it("caps video/audio/document at the 16 MB bucket limit", () => {
    expect(MEDIA_MAX_BYTES_BY_KIND.video).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.audio).toBe(16 * 1024 * 1024);
    expect(MEDIA_MAX_BYTES_BY_KIND.document).toBe(16 * 1024 * 1024);
  });
});

function makeFile(name = "photo.png", type = "image/png"): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

describe("uploadAccountMedia", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs a multipart FormData to /api/media/upload and returns the result", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            publicUrl: "https://cdn.example.com/media/account-x/1-photo.png",
            path: "account-x/1-photo.png",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const result = await uploadAccountMedia("chat-media", makeFile());

    expect(result).toEqual({
      publicUrl: "https://cdn.example.com/media/account-x/1-photo.png",
      path: "account-x/1-photo.png",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/media/upload");
    expect(init?.method).toBe("POST");
    const form = init?.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    // 'chat-media' maps to the friendly 'media' bucket.
    expect(form.get("bucket")).toBe("media");
    expect(form.get("file")).toBeInstanceOf(File);
  });

  it("maps the 'avatars' bucket to the friendly 'avatars' name", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ publicUrl: "u", path: "p" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );

    await uploadAccountMedia("avatars", makeFile());

    const form = fetchSpy.mock.calls[0][1]?.body as FormData;
    expect(form.get("bucket")).toBe("avatars");
  });

  it("throws the server's error message on a non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "File is empty." }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(uploadAccountMedia("media", makeFile())).rejects.toThrow(
      "File is empty.",
    );
  });

  it("throws a generic message when the server is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network down"));

    await expect(uploadAccountMedia("media", makeFile())).rejects.toThrow(
      "could not reach the server",
    );
  });
});

describe("deleteAccountMedia", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs the friendly bucket + path to /api/media/delete", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), { status: 200 }),
      );

    await deleteAccountMedia("flow-media", "account-x/1-photo.png");

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/media/delete");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body).toEqual({ bucket: "media", path: "account-x/1-photo.png" });
  });

  it("throws on a non-OK delete response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("nope", { status: 403 }),
    );

    await expect(
      deleteAccountMedia("media", "account-x/1-photo.png"),
    ).rejects.toThrow("Delete failed");
  });
});

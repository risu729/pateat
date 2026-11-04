import { describe, expect, it, vi } from "vitest";
import {
  RELATED_ORIGIN_FETCH_MS,
  createRelatedOrigins,
  needsRelatedOrigins,
  relatedOriginListed,
} from "./related-origins";

const json = (body: unknown, init: { status?: number; type?: string } = {}) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": init.type ?? "application/json" },
  });

describe("relatedOriginListed (WebAuthn related origins validation, ADR 0084)", () => {
  it("finds the caller's origin, as OpenAI lists ChatGPT", () => {
    // https://openai.com/.well-known/webauthn on 2026-11-04.
    const openai = { origins: ["https://chatgpt.com"] };
    expect(relatedOriginListed("https://chatgpt.com", openai)).toBe(true);
    expect(relatedOriginListed("https://sora.chatgpt.com", openai)).toBe(false);
    expect(relatedOriginListed("https://chatgpt.com:8443", openai)).toBe(false);
    expect(relatedOriginListed("https://chatgpt.com", { origins: ["https://chatgpt.com/"] })).toBe(
      true,
    );
  });

  it.each([
    ["no object", ["https://chatgpt.com"]],
    ["null", null],
    ["no origins", {}],
    ["origins that are not an array", { origins: "https://chatgpt.com" }],
    ["an origin that is not a string", { origins: ["https://chatgpt.com", 1] }],
  ])("lists nothing for %s", (_label, document) => {
    expect(relatedOriginListed("https://chatgpt.com", document)).toBe(false);
  });

  it("skips entries that are no URL or have no registrable label", () => {
    expect(
      relatedOriginListed("https://chatgpt.com", {
        origins: ["not a url", "android:apk-key-hash:abc", "https://com", "https://chatgpt.com"],
      }),
    ).toBe(true);
  });

  it("stops at five labels, as Chrome does", () => {
    const five = ["a", "b", "c", "d", "e"].map((label) => `https://${label}.example`);
    expect(
      relatedOriginListed("https://f.example", { origins: [...five, "https://f.example"] }),
    ).toBe(false);
    // A further origin of a label already seen still counts.
    expect(
      relatedOriginListed("https://login.c.example", {
        origins: [...five, "https://login.c.example"],
      }),
    ).toBe(true);
    // The same label under another suffix is one label.
    expect(
      relatedOriginListed("https://f.example", {
        origins: ["https://a.example", "https://a.test", "https://a.dev", "https://f.example"],
      }),
    ).toBe(true);
  });
});

describe("needsRelatedOrigins", () => {
  it.each([
    ["https://chatgpt.com", "openai.com", true],
    ["https://chatgpt.com", "auth.openai.com", true],
    ["https://login.example.com", "example.com", false],
    ["https://example.com", "example.com", false],
    ["https://example.com", "www.example.com", true],
    ["https://example.com", "com", false],
    ["https://example.com", "github.io", false],
    ["https://example.com", "OpenAI.com", false],
    ["https://example.com", "127.0.0.1", false],
    ["http://localhost:3000", "openai.com", false],
    ["http://example.com", "openai.com", false],
  ])("%s with RP ID %s -> %s", (origin, rpId, expected) => {
    expect(needsRelatedOrigins(origin, rpId)).toBe(expected);
  });
});

describe("createRelatedOrigins", () => {
  it("reads the RP's list without credentials or a referrer", async () => {
    const fetch = vi.fn(async () => json({ origins: ["https://chatgpt.com"] }));
    const related = createRelatedOrigins({ fetch });
    expect(await related.allows("https://chatgpt.com", "openai.com")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openai.com/.well-known/webauthn");
    expect(init).toMatchObject({ credentials: "omit", referrerPolicy: "no-referrer" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(await related.allows("https://evil.example", "openai.com")).toBe(false);
    // Both answers came from the one read.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never reads a list for an RP ID the page may use anyway", async () => {
    const fetch = vi.fn(async () => json({ origins: ["https://login.example.com"] }));
    const related = createRelatedOrigins({ fetch });
    expect(await related.allows("https://login.example.com", "example.com")).toBe(false);
    expect(await related.allows("https://login.example.com", "com")).toBe(false);
    expect(await related.allows("http://localhost:3000", "example.com")).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["another status", json({ origins: ["https://chatgpt.com"] }, { status: 404 })],
    ["a redirect's own answer", json({ origins: ["https://chatgpt.com"] }, { status: 302 })],
    ["HTML", json({ origins: ["https://chatgpt.com"] }, { type: "text/html" })],
    ["broken JSON", json("{", {})],
    ["a list too long", json({ origins: ["https://chatgpt.com", "x".repeat(70_000)] })],
  ])("refuses %s", async (_label, response) => {
    const related = createRelatedOrigins({ fetch: async () => response });
    expect(await related.allows("https://chatgpt.com", "openai.com")).toBe(false);
  });

  it("accepts a JSON content type with parameters", async () => {
    const related = createRelatedOrigins({
      fetch: async () =>
        json({ origins: ["https://chatgpt.com"] }, { type: "application/json; charset=utf-8" }),
    });
    expect(await related.allows("https://chatgpt.com", "openai.com")).toBe(true);
  });

  it("keeps a list ten minutes and a failed read one", async () => {
    let now = 0;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockImplementation(async () => json({ origins: ["https://chatgpt.com"] }));
    const related = createRelatedOrigins({ fetch, now: () => now });
    expect(await related.allows("https://chatgpt.com", "openai.com")).toBe(false);
    now = 59_000;
    expect(await related.allows("https://chatgpt.com", "openai.com")).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
    now = 61_000;
    expect(await related.allows("https://chatgpt.com", "openai.com")).toBe(true);
    now = 61_000 + 9 * 60_000;
    expect(await related.allows("https://chatgpt.com", "openai.com")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    now = 61_000 + 10 * 60_000;
    expect(await related.allows("https://chatgpt.com", "openai.com")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("bounds the read and lets a caller stop waiting", async () => {
    const signals: AbortSignal[] = [];
    let answer!: (response: Response) => void;
    const related = createRelatedOrigins({
      fetch: (_url, init) => {
        signals.push(init!.signal!);
        return new Promise((resolve) => {
          answer = resolve;
        });
      },
    });
    const controller = new AbortController();
    const waiting = related.allows("https://chatgpt.com", "openai.com", controller.signal);
    controller.abort();
    expect(await waiting).toBe(false);
    // The shared read goes on for another caller.
    const other = related.allows("https://chatgpt.com", "openai.com");
    answer(json({ origins: ["https://chatgpt.com"] }));
    expect(await other).toBe(true);
    expect(signals).toHaveLength(1);
    expect(RELATED_ORIGIN_FETCH_MS).toBe(5000);
  });
});

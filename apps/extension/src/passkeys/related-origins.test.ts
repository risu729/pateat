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

/** An answer whose final URL, after redirects, is `url`. */
const redirectedTo = (url: string) => {
  const response = json({ origins: ["https://chatgpt.com"] });
  Object.defineProperty(response, "url", { value: url });
  return response;
};

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
    ["a server error", json({ origins: ["https://chatgpt.com"] }, { status: 503 })],
    ["HTML", json({ origins: ["https://chatgpt.com"] }, { type: "text/html" })],
    ["broken JSON", json("{", {})],
    ["a list too long", json({ origins: ["https://chatgpt.com", "x".repeat(70_000)] })],
    [
      "a list that says it is too long",
      new Response("{}", {
        headers: { "content-type": "application/json", "content-length": "70000" },
      }),
    ],
    ["an answer that came over HTTP", redirectedTo("http://127.0.0.1:8080/")],
  ])("refuses %s, and tries again after a minute", async (_label, response) => {
    let now = 0;
    const fetch = vi.fn(async () => response);
    const related = createRelatedOrigins({ fetch, now: () => now });
    expect(await related.allows("https://chatgpt.com", "openai.com")).toBe(false);
    now = 61_000;
    await related.allows("https://chatgpt.com", "openai.com");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stops reading a body once it passes the bound", async () => {
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(16 * 1024));
      },
    });
    const related = createRelatedOrigins({
      fetch: async () => new Response(endless, { headers: { "content-type": "application/json" } }),
    });
    expect(await related.allows("https://chatgpt.com", "openai.com")).toBe(false);
    expect(pulled).toBeLessThan(10);
  });

  it("follows a redirect that stays on HTTPS, as amazon.com redirects to www", async () => {
    const related = createRelatedOrigins({
      fetch: async () => redirectedTo("https://www.openai.com/.well-known/webauthn"),
    });
    expect(await related.allows("https://chatgpt.com", "openai.com")).toBe(true);
  });

  it("keeps at most 64 RP lists", async () => {
    const fetch = vi.fn(async () => json({ origins: ["https://chatgpt.com"] }));
    const related = createRelatedOrigins({ fetch });
    for (let index = 0; index <= 64; index += 1)
      // eslint-disable-next-line no-await-in-loop
      await related.allows("https://chatgpt.com", `rp${index}.example`);
    expect(fetch).toHaveBeenCalledTimes(65);
    await related.allows("https://chatgpt.com", "rp64.example");
    expect(fetch).toHaveBeenCalledTimes(65);
    // The oldest went first.
    await related.allows("https://chatgpt.com", "rp0.example");
    expect(fetch).toHaveBeenCalledTimes(66);
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

  it("shares one read among callers and bounds it", async () => {
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
    const first = related.allows("https://chatgpt.com", "openai.com");
    const second = related.allows("https://evil.example", "openai.com");
    answer(json({ origins: ["https://chatgpt.com"] }));
    expect([await first, await second]).toEqual([true, false]);
    expect(signals).toHaveLength(1);
    expect(RELATED_ORIGIN_FETCH_MS).toBe(5000);
  });
});

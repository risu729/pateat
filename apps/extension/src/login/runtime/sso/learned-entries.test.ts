import { beforeEach, describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => new Map<string, unknown>());
vi.mock("wxt/browser", () => ({
  browser: { storage: { local: { setAccessLevel: async () => undefined } } },
}));
vi.mock("wxt/utils/storage", () => ({
  storage: {
    getItem: async (key: string) => stored.get(key) ?? null,
    setItem: async (key: string, value: unknown) => void stored.set(key, structuredClone(value)),
    removeItem: async (key: string) => void stored.delete(key),
  },
}));
const { learnSsoEntry, ssoEntryReaches } = await import("./learned-entries");

const site = "https://broker.example";
const provider = { by: "id" as const, value: "provider-entry" };
beforeEach(() => stored.clear());

describe("which IdP a broker page's entry reached (ADR 0085)", () => {
  it("answers only for the IdP the entry reached, on its own page", async () => {
    void learnSsoEntry(site, "/login", provider, "https://idp.example");
    expect(await ssoEntryReaches(site, "/login", provider, "https://idp.example")).toBe(true);
    expect(await ssoEntryReaches(site, "/login", provider, "https://other.example")).toBe(false);
    expect(await ssoEntryReaches(site, "/other", provider, "https://idp.example")).toBe(false);
    expect(
      await ssoEntryReaches(site, "/login", { by: "id", value: "x" }, "https://idp.example"),
    ).toBe(false);
  });

  it("keeps the newest IdP an entry reached", async () => {
    await learnSsoEntry(site, "/login", provider, "https://idp.example");
    await learnSsoEntry(site, "/login", provider, "https://other.example");
    expect(await ssoEntryReaches(site, "/login", provider, "https://idp.example")).toBe(false);
    expect(await ssoEntryReaches(site, "/login", provider, "https://other.example")).toBe(true);
  });

  it("reads a malformed record as nothing learned", async () => {
    stored.set("local:pateat.login.sso-entries.v1", [{ origin: site }]);
    expect(await ssoEntryReaches(site, "/login", provider, "https://idp.example")).toBe(false);
  });
});

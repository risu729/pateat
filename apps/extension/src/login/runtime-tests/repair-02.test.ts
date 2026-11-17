import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe } from "@pateat/contracts";
import { createRecipeRepairs } from "../repair";
import type { LoginReport } from "../runtime/report";
import type { LoginGeneration } from "../runtime/deps";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, target, startsOf, savedBinding, uriMatch, harness } =
  createRuntimeTestHarness(fake);

// JAL's member re-login (2026-11-17, #1676): the start path's only layout that shows there
// was learned on its one-time-code page, which reuses the password field's ID. An item with
// a password and no TOTP secret has no route on it, though the page asks for the password.
describe("repairing a code layout on a password page for an item without its TOTP secret (ADR 0058 A)", () => {
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.reconnects = [];
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.pageUrl = "https://login.example/signin";
    fake.state.onExecute = () => new Promise(() => undefined);
    fake.state.tabUrls = {};
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    // The sign-in again shows the shared field and its own button, never the code's.
    fake.state.present = new Set(["password", "login"]);
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.awaited = { ok: true };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signIn = false;
    fake.state.loaded = true;
  });
  const generatedId = "gen-0123456789abcdef0123456789abcdef";
  const codeOnly = parseLoginRecipe({
    version: 1,
    id: generatedId,
    revision: 3,
    origin,
    pageKind: "sign-in",
    slots: ["totp"],
    steps: [
      { kind: "fill", path: "/signin", fields: [{ slot: "totp", target: target("password") }] },
      { kind: "click", path: "/signin", target: target("send"), purpose: "submit" },
    ],
    maxSubmissions: 1,
  });
  const repaired = parseLoginRecipe({
    ...codeOnly,
    revision: 4,
    slots: ["password"],
    steps: [
      {
        kind: "fill",
        path: "/signin",
        fields: [{ slot: "password", target: target("password") }],
      },
      { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
    ],
  });
  const formPage = {
    ok: true,
    observation: {
      version: 1,
      origin,
      path: "/signin",
      language: "ja",
      complete: true,
      candidates: [
        { id: "c1", role: "password", target: target("password") },
        { id: "c2", role: "button", target: target("login"), label: "ログイン" },
      ],
    },
  };
  const release = vi.fn(async () => undefined);
  function start() {
    const reports: LoginReport[] = [];
    const generation = {
      available: vi.fn<LoginGeneration["available"]>(async () => true),
      generate: vi.fn<LoginGeneration["generate"]>(async (_request, sent) => {
        sent?.();
        return { outcome: "abstained", reason: "ambiguous" };
      }),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" })),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
      claimRepair: vi.fn<NonNullable<LoginGeneration["claimRepair"]>>(async () => ({
        outcome: "claimed",
        release,
      })),
    };
    const h = harness(
      {
        bindings: [
          { ...savedBinding, recipeId: generatedId, slots: [{ slot: "totp", field: "totp" }] },
        ],
      },
      {
        username: true,
        report: (entry) => reports.push(entry),
        passkeys: vi.fn(async () => ({ passkey: false, discoverable: false })),
        generation,
        repairs: createRecipeRepairs({
          read: async () => fake.state.storage["repairs"],
          write: async (value) => {
            fake.state.storage["repairs"] = value;
          },
        }),
        uris: async () => ({ ok: true as const, data: uriMatch() }),
      },
    );
    // The item holds a password, and its TOTP field is empty.
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok)
        response.catalog.connections[0]!.items[0]!.fields.push({
          id: "login.totp-code",
          label: "Verification code",
          name: null,
          kind: "otp",
          empty: true,
        } as never);
      return response;
    });
    h.recipes.recipe.mockResolvedValue(codeOnly);
    h.recipes.starts.mockResolvedValue(startsOf([codeOnly.steps[0]!]));
    return { h, reports, generation };
  }
  const executed = () => fake.state.messages.filter((entry) => entry.type === "login.execute");

  it("sends the page for the password route, and the repaired layout signs in with the password", async () => {
    fake.state.extracted = { login: formPage };
    const { h, reports, generation } = start();
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() =>
      expect(reports.filter((entry) => entry.type === "refused")).toHaveLength(1),
    );
    expect(generation.claimRepair).toHaveBeenCalledExactlyOnceWith(generatedId, "password");
    expect(reports.filter((entry) => entry.type === "unfit")).toMatchObject([
      { route: "password", outcome: "claimed", detail: "no-totp" },
    ]);
    expect(generation.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: formPage.observation,
        repair: { recipeId: generatedId, revision: 3 },
      }),
      expect.any(Function),
    );
    // Nothing was typed into the shared field: the code layout never ran.
    expect(executed()).toEqual([]);
    // A layout that fills the password, as the repair adds, runs for the same item and
    // binding, whose slot for it is filled from the item's password.
    h.recipes.recipe.mockResolvedValue(repaired);
    h.recipes.starts.mockResolvedValue(startsOf([repaired.steps[0]!]));
    expect(await h.hello({ documentId: "synthetic-document-2" })).toEqual({ ok: true });
    await vi.waitFor(() => expect(executed()).toHaveLength(1));
    expect(executed()[0]).toMatchObject({
      operation: { step: { kind: "fill", fields: [{ slot: "password" }] } },
    });
    expect(generation.claimRepair).toHaveBeenCalledOnce();
  });
});

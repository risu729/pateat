import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LoginRecipe } from "@pateat/contracts";
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
  // A layout learned on a page that asks for the email and a code together.
  const emailCode = parseLoginRecipe({
    ...codeOnly,
    slots: ["username", "totp"],
    steps: [
      {
        kind: "fill",
        path: "/signin",
        fields: [
          { slot: "username", target: target("email") },
          { slot: "totp", target: target("code") },
        ],
      },
      { kind: "click", path: "/signin", target: target("send"), purpose: "submit" },
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
  type Claim = NonNullable<LoginGeneration["claimRepair"]>;
  /** The service's claim: the first is claimed, and the next ones in 3 days are not due. */
  function onceClaim(): Claim {
    let claimed = false;
    return async () => {
      if (claimed) return { outcome: "not-due" };
      claimed = true;
      return { outcome: "claimed", release };
    };
  }
  function start(
    options: { layout?: LoginRecipe; claim?: Claim; password?: "empty"; signIn?: boolean } = {},
  ) {
    const layout = options.layout ?? codeOnly;
    // Whether the page shows a writable password input (`login.observe` with `signIn`).
    fake.state.signIn = { password: options.signIn ?? true };
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
      claimRepair: vi.fn<Claim>(options.claim ?? (async () => ({ outcome: "claimed", release }))),
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
    // The item's TOTP field is empty, and so is its password with `password: "empty"`.
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok) {
        const fields = response.catalog.connections[0]!.items[0]!.fields;
        if (options.password === "empty")
          for (const field of fields) if (field.id === "login.password") field.empty = true;
        fields.push({
          id: "login.totp-code",
          label: "Verification code",
          name: null,
          kind: "otp",
          empty: true,
        } as never);
      }
      return response;
    });
    h.recipes.recipe.mockResolvedValue(layout);
    h.recipes.starts.mockResolvedValue(startsOf([layout.steps[0]!]));
    return { h, reports, generation };
  }
  const executed = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
  const refusals = (reports: readonly LoginReport[]) =>
    reports.filter((entry) => entry.type === "refused");
  const unfits = (reports: readonly LoginReport[]) =>
    reports.filter((entry) => entry.type === "unfit");

  it("sends the page for the password route, and the repaired layout signs in with the password", async () => {
    fake.state.extracted = { login: formPage };
    const { h, reports, generation } = start();
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
    expect(generation.claimRepair).toHaveBeenCalledExactlyOnceWith(generatedId, "password");
    expect(unfits(reports)).toMatchObject([
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

  it("claims a code page that shows a password input once, then finds the repair not due", async () => {
    // The code page reuses the password field without marking it `one-time-code`, so it
    // reads as a password page: the first visit spends the recipe's repair, and the
    // service's claim keeps the next visits in 3 days from another request.
    fake.state.present = new Set(["password", "send"]);
    fake.state.extracted = { login: formPage };
    const { h, reports, generation } = start({ claim: onceClaim() });
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
    expect(await h.hello({ documentId: "synthetic-document-2" })).toEqual({
      ok: false,
      reason: "generating",
    });
    await vi.waitFor(() => expect(refusals(reports)).toHaveLength(2));
    expect(generation.claimRepair).toHaveBeenCalledTimes(2);
    expect(unfits(reports)).toMatchObject([
      { route: "password", outcome: "claimed", detail: "no-totp" },
      { route: "password", outcome: "not-due", detail: "no-totp" },
    ]);
    expect(generation.generate).toHaveBeenCalledOnce();
    expect(refusals(reports)).toMatchObject([{ reason: "no-route" }, { reason: "no-route" }]);
    expect(executed()).toEqual([]);
  });

  it("claims no repair on a code page whose field is marked one-time-code", async () => {
    fake.state.present = new Set(["password", "send"]);
    fake.state.extracted = { login: formPage };
    const { h, reports, generation } = start({ signIn: false });
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
    expect(generation.claimRepair).not.toHaveBeenCalled();
    expect(generation.generate).not.toHaveBeenCalled();
    expect(unfits(reports)).toMatchObject([
      { route: "password", outcome: "not-due", reason: "no-form", detail: "no-totp" },
    ]);
    expect(refusals(reports)).toMatchObject([{ reason: "no-route", detail: "no-totp" }]);
    expect(executed()).toEqual([]);
  });

  it("claims no repair of an email and code layout on a page without a password input", async () => {
    fake.state.present = new Set(["email", "code", "send"]);
    fake.state.extracted = { login: formPage };
    const { h, reports, generation } = start({ layout: emailCode, signIn: false });
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
    expect(generation.claimRepair).not.toHaveBeenCalled();
    expect(generation.generate).not.toHaveBeenCalled();
    expect(unfits(reports)).toMatchObject([
      { route: "password", outcome: "not-due", reason: "no-form" },
    ]);
    expect(executed()).toEqual([]);
  });

  it("claims no repair on a page that shows only an identifier input", async () => {
    fake.state.extracted = { login: formPage };
    const { h, reports, generation } = start();
    fake.state.signIn = { password: false, identifier: true };
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
    expect(generation.claimRepair).not.toHaveBeenCalled();
    expect(generation.generate).not.toHaveBeenCalled();
    expect(unfits(reports)).toMatchObject([
      { route: "password", outcome: "not-due", reason: "no-form" },
    ]);
  });

  /** Whether `message` is the page check before the claim (`showsPassword`). */
  const passwordCheck = (message: Record<string, unknown>) =>
    message["type"] === "login.observe" &&
    message["signIn"] === true &&
    (message["targets"] as unknown[]).length === 0;

  it("claims no repair when the page cannot be asked for its password input", async () => {
    fake.state.extracted = { login: formPage };
    const { h, reports, generation } = start();
    const send = fake.browser.tabs.sendMessage;
    const spy = vi
      .spyOn(fake.browser.tabs, "sendMessage")
      .mockImplementation(async (tabId, message, options) => {
        if (passwordCheck(message)) throw new Error("The message port closed.");
        return send(tabId, message, options);
      });
    try {
      expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
    } finally {
      spy.mockRestore();
    }
    expect(generation.claimRepair).not.toHaveBeenCalled();
    expect(generation.generate).not.toHaveBeenCalled();
    expect(unfits(reports)).toMatchObject([
      { route: "password", outcome: "not-due", reason: "no-form" },
    ]);
  });

  it("drops the repair of a document replaced while its password input is read", async () => {
    fake.state.extracted = { login: formPage };
    const { h, reports, generation } = start();
    const send = fake.browser.tabs.sendMessage;
    let answered: Promise<unknown> | undefined;
    const spy = vi
      .spyOn(fake.browser.tabs, "sendMessage")
      .mockImplementation((tabId, message, options) => {
        if (!passwordCheck(message) || answered) return send(tabId, message, options);
        // The page goes on to another document, one with no password input, before the
        // first one's check answers that it shows one.
        answered = (async () => {
          fake.state.signIn = { password: false };
          await h.hello({ documentId: "synthetic-document-2" });
          await vi.waitFor(() => expect(unfits(reports)).toHaveLength(1));
          fake.state.signIn = { password: true };
          return send(tabId, message, options);
        })();
        return answered;
      });
    try {
      expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() => expect(answered).toBeDefined());
      await answered;
      // The first document's repair goes on from the answer within these turns, if at all.
      // eslint-disable-next-line no-await-in-loop
      for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
    } finally {
      spy.mockRestore();
    }
    // Only the new document's own check counts: the first one's answer claims nothing.
    expect(generation.claimRepair).not.toHaveBeenCalled();
    expect(generation.generate).not.toHaveBeenCalled();
    expect(unfits(reports)).toMatchObject([
      { route: "password", outcome: "not-due", reason: "no-form" },
    ]);
  });

  it("repairs nothing for an item without a password or a TOTP secret", async () => {
    fake.state.extracted = { login: formPage };
    const { h, reports, generation } = start({ password: "empty" });
    expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
    expect(generation.claimRepair).not.toHaveBeenCalled();
    expect(generation.generate).not.toHaveBeenCalled();
    expect(unfits(reports)).toEqual([]);
    expect(executed()).toEqual([]);
  });
});

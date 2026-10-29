import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  laterStartSteps,
  parseLoginRecipe,
  type LocalSettings,
  type LoginChooserRecipe,
  type LoginRecipe,
  type LoginStep,
} from "@pateat/contracts";
import { createRecipeRepairs } from "../repair";
import type { GenerationOutcome, LoginGeneration, LoginReport } from "../runtime";
import { laterReadiness } from "../wire";
import type { ConditionalDecision } from "../../passkeys/runtime";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const {
  origin,
  connectionId,
  itemId,
  target,
  startsOf,
  recipe,
  savedBinding,
  uriMatch,
  excludingLive,
  harness,
} = createRuntimeTestHarness(fake);

describe("repairing a recipe the chosen item cannot run (ADR 0058 A, amended by ADR 0041)", () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2]) listener(tabId);
    fake.state.awaitReply = undefined;
  });
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.reconnects = [];
    fake.state.onReconnect = undefined;
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.pageUrl = "https://login.example/signin";
    fake.state.onExecute = undefined;
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observed = ["unique", "missing"];
    fake.state.observedPath = "/signin";
    fake.state.present = new Set(["password", "login"]);
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.signIn = false;
    fake.state.loaded = true;
    release.mockClear();
  });
  const generatedId = "gen-0123456789abcdef0123456789abcdef";
  const onePage = parseLoginRecipe({ ...recipe, id: generatedId, revision: 3 });
  const emailFirst = parseLoginRecipe({
    version: 1,
    id: generatedId,
    revision: 3,
    origin,
    pageKind: "sign-in",
    slots: ["username", "password"],
    steps: [
      { kind: "fill", path: "/signin", fields: [{ slot: "username", target: target("email") }] },
      { kind: "click", path: "/signin", target: target("next"), purpose: "advance" },
      {
        kind: "fill",
        path: "/password",
        fields: [{ slot: "password", target: target("password") }],
      },
      { kind: "click", path: "/password", target: target("login"), purpose: "submit" },
    ],
    maxSubmissions: 2,
  });
  const coded = parseLoginRecipe({
    ...emailFirst,
    slots: ["username", "password", "totp"],
    steps: [
      ...emailFirst.steps.slice(0, 2),
      {
        kind: "fill",
        path: "/password",
        fields: [
          { slot: "password", target: target("password") },
          { slot: "totp", target: target("app-code") },
        ],
      },
      emailFirst.steps[3]!,
    ],
  });
  const withoutTotp = (h: ReturnType<typeof harness>) => {
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
  };
  const discoverable = { passkey: true, discoverable: true };
  type Claim = NonNullable<LoginGeneration["claimRepair"]>;
  const repaired = parseLoginRecipe({
    ...onePage,
    revision: 4,
    passkey: { path: "/signin", target: target("passkey-login") },
  });
  function service(claim: Claim = async () => ({ outcome: "not-due" })) {
    return {
      available: vi.fn<LoginGeneration["available"]>(async () => true),
      generate: vi.fn<LoginGeneration["generate"]>(async (_request, sent) => {
        sent?.();
        return { outcome: "abstained", reason: "ambiguous" };
      }),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" })),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
      claimRepair: vi.fn<Claim>(claim),
    };
  }
  const emptyPassword = (h: ReturnType<typeof harness>, when: () => boolean = () => true) => {
    const original = h.store.handle.getMockImplementation()!;
    h.store.handle.mockImplementation(async () => {
      const response = await original();
      if (response.ok && when())
        for (const field of response.catalog.connections[0]!.items[0]!.fields)
          if (field.id === "login.password") field.empty = true;
      return response;
    });
  };
  function start(
    options: {
      used?: LoginRecipe;
      passkey?: { passkey: boolean; discoverable: boolean };
      password?: boolean;
      claim?: (h: ReturnType<typeof harness>) => Claim;
      live?: Parameters<typeof harness>[1];
      overrides?: Partial<LocalSettings>;
    } = {},
  ) {
    const used = options.used ?? onePage;
    const reports: LoginReport[] = [];
    let h!: ReturnType<typeof harness>;
    const generation = service(async (...args) =>
      options.claim ? options.claim(h)(...args) : { outcome: "not-due" },
    );
    const repairs = createRecipeRepairs({
      read: async () => fake.state.storage["repairs"],
      write: async (value) => {
        fake.state.storage["repairs"] = value;
      },
    });
    h = harness(
      {
        bindings: [
          {
            ...savedBinding,
            recipeId: used.id,
            slots: used.slots.map((slot) => ({
              slot,
              field: slot as "username" | "password" | "totp",
            })),
          },
        ],
        ...options.overrides,
      },
      {
        username: true,
        report: (entry) => reports.push(entry),
        passkeys: vi.fn(async () => options.passkey ?? discoverable),
        generation,
        repairs,
        uris: async () => ({ ok: true as const, data: uriMatch() }),
        ...options.live,
      },
    );
    h.fields.mockImplementation(async ({ fieldId }) =>
      fieldId === "login.username" ? "me@example.com" : "synthetic-secret",
    );
    h.recipes.recipe.mockResolvedValue(used);
    h.recipes.starts.mockResolvedValue(startsOf([used.steps[0]!]));
    if (!options.password) emptyPassword(h);
    return { h, reports, generation };
  }
  const release = vi.fn(async () => undefined);
  const claimed = (): ((h: ReturnType<typeof harness>) => Claim) => () => async () => ({
    outcome: "claimed",
    release,
  });
  const formPage = {
    ok: true,
    observation: {
      version: 1,
      origin,
      path: "/signin",
      language: "en",
      complete: true,
      candidates: [
        { id: "c1", role: "password", target: target("password") },
        { id: "c2", role: "button", target: target("login"), label: "Sign in" },
      ],
    },
  };
  const unfits = (reports: LoginReport[]) => reports.filter((entry) => entry.type === "unfit");
  const refusals = (reports: LoginReport[]) =>
    reports.flatMap((entry) => (entry.type === "refused" ? [entry] : []));
  const executed = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
  describe("a page that asks for a passkey only after the start (ADR 0034 amendment of 2026-10-25)", () => {
    const emailOnly = parseLoginRecipe({
      version: 1,
      id: generatedId,
      revision: 1,
      origin,
      pageKind: "sign-in",
      slots: ["username"],
      steps: [
        {
          kind: "fill",
          path: "/signin",
          fields: [{ slot: "username", target: target("email") }],
          effect: "prepare",
        },
        { kind: "click", path: "/signin", target: target("login"), purpose: "submit" },
      ],
      maxSubmissions: 1,
    });
    const ask = (h: ReturnType<typeof harness>) => {
      let decided: ConditionalDecision | undefined;
      void h.login
        .conditionalRequest({
          tabId: 1,
          origin,
          documentId: "synthetic-document",
          signal: new AbortController().signal,
        })
        .then((value) => (decided = value));
      return () => decided;
    };
    it("starts the refused login again for the request and answers it with the passkey", async () => {
      fake.state.present = new Set(["email", "login"]);
      const { h, reports } = start({ used: emailOnly });
      fake.state.onReconnect = () => h.hello();
      // No repair is due, so the start is refused before the page asks.
      expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
      expect(refusals(reports)[0]).toMatchObject({ reason: "no-route" });
      expect(unfits(reports)).toEqual([
        expect.objectContaining({
          route: "passkey",
          outcome: "not-due",
          detail: "password-empty:no-password-step",
        }),
      ]);
      const decided = ask(h);
      await vi.waitFor(() => expect(fake.state.reconnects).toHaveLength(1));
      await vi.waitFor(() =>
        expect(decided()).toMatchObject({ kind: "answer", item: { connectionId, itemId } }),
      );
      // Nothing is typed or pressed on the page.
      expect(executed()).toEqual([]);
      // The page announces again only once.
      expect(fake.state.reconnects).toHaveLength(1);
    });
    it("starts a login refused without a repair again for a request that comes later", async () => {
      fake.state.present = new Set(["email", "login"]);
      // A recipe that is not generated is never repaired: the start is refused at once.
      const { h, generation } = start({
        used: parseLoginRecipe({ ...emailOnly, id: "synthetic-email-only" }),
      });
      fake.state.onReconnect = () => h.hello();
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      expect(generation.claimRepair).not.toHaveBeenCalled();
      const decided = ask(h);
      await vi.waitFor(() =>
        expect(decided()).toMatchObject({ kind: "answer", item: { connectionId, itemId } }),
      );
      expect(fake.state.reconnects).toHaveLength(1);
      expect(executed()).toEqual([]);
    });
    it("keeps a request that comes during the repair, then answers it with the passkey", async () => {
      fake.state.present = new Set(["email", "login"]);
      fake.state.extracted = { login: formPage };
      let finish!: () => void;
      const { h, generation } = start({ used: emailOnly, claim: claimed() });
      generation.generate.mockImplementation(async (_request, sent) => {
        sent?.();
        await new Promise<void>((resolve) => (finish = resolve));
        return { outcome: "abstained", reason: "ambiguous" };
      });
      fake.state.onReconnect = () => h.hello();
      expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() => expect(generation.generate).toHaveBeenCalledOnce());
      vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"], shouldAdvanceTime: true });
      const decided = ask(h);
      // More than the three seconds a document has to start its login.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(decided()).toBeUndefined();
      finish();
      await vi.waitFor(() => expect(fake.state.reconnects).toHaveLength(1));
      await vi.waitFor(() =>
        expect(decided()).toMatchObject({ kind: "answer", item: { connectionId, itemId } }),
      );
      expect(executed()).toEqual([]);
    });
    it("never asks a page whose item holds no discoverable passkey to announce again", async () => {
      fake.state.present = new Set(["email", "login"]);
      const { h } = start({ used: emailOnly, passkey: { passkey: true, discoverable: false } });
      fake.state.onReconnect = () => h.hello();
      expect(await h.hello()).toMatchObject({ ok: false });
      vi.useFakeTimers({ toFake: ["setInterval", "setTimeout", "Date"], shouldAdvanceTime: true });
      const decided = ask(h);
      await vi.advanceTimersByTimeAsync(4_000);
      expect(decided()).toEqual({ kind: "delegate", reason: "no-login" });
      expect(fake.state.reconnects).toEqual([]);
    });
  });
  it("sends the start page for repair and asks the page to announce again with its answer", async () => {
    fake.state.extracted = { login: formPage };
    const { h, reports, generation } = start({ claim: claimed() });
    generation.generate.mockImplementation(async (_request, sent) => {
      sent?.();
      h.recipes.recipe.mockResolvedValue(repaired);
      return { outcome: "recipe", recipe: repaired };
    });
    // The page waits as for a generation, reading no secret.
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(fake.state.reconnects).toHaveLength(1));
    expect(generation.claimRepair).toHaveBeenCalledExactlyOnceWith(generatedId, "passkey");
    expect(generation.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: formPage.observation,
        repair: { recipeId: generatedId, revision: 3 },
      }),
      expect.any(Function),
    );
    expect(unfits(reports)).toEqual([
      {
        type: "unfit",
        tabId: 1,
        origin,
        recipeId: generatedId,
        recipeRevision: 3,
        route: "passkey",
        outcome: "claimed",
        detail: "password-empty:no-advance",
      },
    ]);
    // The claim stays, and the refusal the repair replaced is not logged.
    expect(release).not.toHaveBeenCalled();
    expect(refusals(reports)).toEqual([]);
    expect(executed()).toEqual([]);
    // Only the usernames to hide are read (ADR 0016), never a secret.
    expect(h.fields.mock.calls.map(([request]) => request.fieldId)).not.toContain("login.password");
    // Only a passkey-only recipe's page is checked for a form first.
    expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.entry.check");
  });
  it("tries a newer revision another device's repair stored before claiming one", async () => {
    fake.state.extracted = { login: formPage };
    const { h, reports, generation } = start({ claim: claimed() });
    // The pull brings the revision with the passkey route.
    const pullRecipes = vi.fn(async () => {
      h.recipes.recipe.mockResolvedValue(repaired);
    });
    Object.assign(generation, { pullRecipes });
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(fake.state.reconnects).toHaveLength(1));
    expect(pullRecipes).toHaveBeenCalledOnce();
    expect(generation.claimRepair).not.toHaveBeenCalled();
    expect(generation.generate).not.toHaveBeenCalled();
    expect(unfits(reports)).toEqual([
      expect.objectContaining({ recipeRevision: 3, outcome: "newer" }),
    ]);
    expect(refusals(reports)).toEqual([]);
  });
  it("claims the repair when the pull brings nothing newer", async () => {
    fake.state.extracted = { login: formPage };
    const { h, generation } = start({ claim: claimed() });
    const pullRecipes = vi.fn(async () => undefined);
    Object.assign(generation, { pullRecipes });
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(generation.generate).toHaveBeenCalledOnce());
    expect(pullRecipes).toHaveBeenCalledOnce();
    expect(generation.claimRepair).toHaveBeenCalledOnce();
  });
  it("keeps the claim and refuses the page when the model abstains", async () => {
    fake.state.extracted = { login: formPage };
    const { h, reports, generation } = start({ claim: claimed() });
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
    expect(generation.generate).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
    expect(refusals(reports)[0]).toMatchObject({
      reason: "no-route",
      detail: "password-empty:no-advance",
    });
    expect(fake.state.reconnects).toEqual([]);
  });
  it("gives the claim back when the page could not be sent", async () => {
    // The page's description is cancelled, so nothing reaches the service.
    fake.state.extracted = { login: { ok: false, reason: "cancelled" } };
    const { h, reports, generation } = start({ claim: claimed() });
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
    expect(generation.generate).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });
  it.each<[string, GenerationOutcome, boolean]>([
    ["refused output", { outcome: "failed", reason: "invalid-output", check: "plan" }, false],
    ["a model failure", { outcome: "failed", reason: "model-failed" }, false],
    [
      "the day's repair spent",
      { outcome: "unavailable", reason: "repair-limit", retry: true },
      true,
    ],
    [
      "a request refused before the model",
      { outcome: "failed", reason: "unreachable", retry: true },
      true,
    ],
  ])("after %s, keeps the claim only when the model was called", async (_, answer, released) => {
    fake.state.extracted = { login: formPage };
    const { h, reports, generation } = start({ claim: claimed() });
    generation.generate.mockImplementation(async (_request, sent) => {
      sent?.();
      return answer;
    });
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
    expect(release).toHaveBeenCalledTimes(released ? 1 : 0);
  });
  it("gives the claim back for a newer revision answered without a model call", async () => {
    fake.state.extracted = { login: formPage };
    const { h, generation } = start({ claim: claimed() });
    // The cache was behind: the service answers its current revision as it is.
    const current = parseLoginRecipe({ ...repaired, revision: 6 });
    generation.generate.mockImplementation(async (_request, sent) => {
      sent?.();
      h.recipes.recipe.mockResolvedValue(current);
      return { outcome: "recipe", recipe: current };
    });
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(fake.state.reconnects).toHaveLength(1));
    expect(release).toHaveBeenCalledOnce();
  });
  it.each<[string, Awaited<ReturnType<Claim>>]>([
    ["not due", { outcome: "not-due" }],
    ["not recorded", { outcome: "not-sent", reason: "storage-unavailable" }],
  ])("refuses the page as before when the repair is %s", async (_, answer) => {
    const { h, reports, generation } = start({ claim: () => async () => answer });
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
    expect(unfits(reports)).toEqual([
      expect.objectContaining({
        outcome: answer.outcome,
        ...("reason" in answer && answer.reason ? { reason: answer.reason } : {}),
        detail: "password-empty:no-advance",
      }),
    ]);
    // The claim's report comes first, then the refusal the repair would have replaced.
    expect(reports.findIndex((entry) => entry.type === "unfit")).toBeLessThan(
      reports.findIndex((entry) => entry.type === "refused"),
    );
    expect(generation.generate).not.toHaveBeenCalled();
    expect(fake.state.reconnects).toEqual([]);
    expect(executed()).toEqual([]);
  });
  it("refuses the page as before when the claim throws", async () => {
    const { h, reports } = start({
      claim: () => async () => {
        throw new Error("synthetic generation side failure");
      },
    });
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
    expect(unfits(reports)).toMatchObject([{ outcome: "not-sent", reason: "error" }]);
  });
  it("leaves a page that went away before the claim", async () => {
    let answer!: () => void;
    const { h, reports, generation } = start({
      claim: () => () =>
        new Promise((resolve) => {
          answer = () => resolve({ outcome: "claimed", release });
        }),
    });
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(answer).toBeDefined());
    // The tab closes before the claim is recorded.
    for (const listener of fake.state.removed) listener(1);
    answer();
    await vi.waitFor(() => expect(release).toHaveBeenCalledOnce());
    expect(generation.generate).not.toHaveBeenCalled();
    expect(refusals(reports)).toEqual([]);
  });
  it("refuses the page as before when the generation side cannot claim", async () => {
    const reports: LoginReport[] = [];
    const { claimRepair: _claim, ...withoutClaim } = service();
    const bare = harness(
      { bindings: [{ ...savedBinding, recipeId: generatedId }] },
      {
        username: true,
        report: (entry) => reports.push(entry),
        passkeys: vi.fn(async () => discoverable),
        generation: withoutClaim,
      },
    );
    bare.recipes.recipe.mockResolvedValue(onePage);
    emptyPassword(bare);
    expect(await bare.hello()).toEqual({ ok: false, reason: "no-route" });
    expect(unfits(reports)).toEqual([]);
    expect(refusals(reports)).toMatchObject([{ detail: "password-empty:no-advance" }]);
  });
  it("claims a repair for an item without its TOTP secret that holds a discoverable passkey", async () => {
    fake.state.present = new Set(["email", "next"]);
    fake.state.extracted = { login: formPage };
    const { h, reports, generation } = start({ used: coded, password: true, claim: claimed() });
    withoutTotp(h);
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
    expect(generation.claimRepair).toHaveBeenCalledWith(generatedId, "passkey");
    expect(unfits(reports)).toMatchObject([
      { route: "passkey", outcome: "claimed", detail: "no-totp" },
    ]);
    expect(executed()).toEqual([]);
  });
  const buttonOnly = parseLoginRecipe({
    version: 1,
    id: generatedId,
    revision: 3,
    origin,
    pageKind: "sign-in",
    slots: [],
    passkeyOnly: true,
    passkey: { path: "/signin", target: target("passkey-login") },
    steps: [{ kind: "click", path: "/signin", target: target("passkey-login"), purpose: "submit" }],
    maxSubmissions: 1,
  });
  it.each([
    ["no passkey", { passkey: false, discoverable: false }],
    ["a passkey that is not discoverable", { passkey: true, discoverable: false }],
  ])(
    "refuses a passkey-only recipe's page that shows no form at once for an item with a password and %s (ADR 0053)",
    async (_, passkey) => {
      fake.state.present = new Set(["passkey-login"]);
      // The page shows only the button, or the button beside an entry or a list.
      const before = fake.state.entry.check;
      onTestFinished(() => {
        fake.state.entry.check = before;
      });
      fake.state.entry.check = { ok: true, signIn: false, start: false, signUp: false };
      const { h, reports, generation } = start({
        used: buttonOnly,
        password: true,
        passkey,
        claim: claimed(),
      });
      expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
      await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
      expect(unfits(reports)).toEqual([
        {
          type: "unfit",
          tabId: 1,
          origin,
          recipeId: generatedId,
          recipeRevision: 3,
          route: "password",
          outcome: "not-due",
          reason: "no-form",
          // The recipe has no password variant, so the plan's refusal names no fact.
          detail: "no-route",
        },
      ]);
      // Nothing to send: no claim, no description of the page, no model call.
      expect(generation.claimRepair).not.toHaveBeenCalled();
      expect(fake.state.messages.map((entry) => entry.type)).not.toContain("login.extract");
      expect(generation.generate).not.toHaveBeenCalled();
      expect(refusals(reports)[0]).toMatchObject({ reason: "no-route" });
      // The button is never pressed, and no secret is read.
      expect(executed()).toEqual([]);
      expect(h.fields.mock.calls.map(([request]) => request.fieldId)).not.toContain(
        "login.password",
      );
    },
  );
  it("sends a passkey-only recipe's start page for the password route once it shows a form (ADR 0053)", async () => {
    fake.state.present = new Set(["passkey-login"]);
    fake.state.extracted = { login: formPage };
    const { h, reports, generation } = start({
      used: buttonOnly,
      password: true,
      passkey: { passkey: false, discoverable: false },
      claim: claimed(),
    });
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
    expect(generation.claimRepair).toHaveBeenCalledExactlyOnceWith(generatedId, "password");
    expect(generation.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: formPage.observation,
        repair: { recipeId: generatedId, revision: 3 },
      }),
      expect.any(Function),
    );
    // The model abstained, so the claim stays.
    expect(release).not.toHaveBeenCalled();
    expect(executed()).toEqual([]);
    // The page was read once, at once, before the claim.
    expect(fake.state.messages.filter((entry) => entry.type === "login.entry.check")).toEqual([
      expect.objectContaining({ starts: [], timeoutMs: 0 }),
    ]);
  });
  it.each<[string, unknown]>([
    ["an answer that fails its check", { ok: false }],
    ["a check that throws", "throws"],
  ])("refuses a passkey-only recipe's page at once after %s (ADR 0053)", async (_, answer) => {
    fake.state.present = new Set(["passkey-login"]);
    const before = fake.state.entry.check;
    onTestFinished(() => {
      fake.state.entry.check = before;
    });
    if (answer === "throws") {
      const failing = Promise.reject(new Error("synthetic check failure"));
      // Awaited only once the runtime asks; not an unhandled rejection meanwhile.
      failing.catch(() => undefined);
      fake.state.entry.check = failing;
    } else fake.state.entry.check = answer;
    const { h, reports, generation } = start({
      used: buttonOnly,
      password: true,
      passkey: { passkey: false, discoverable: false },
      claim: claimed(),
    });
    expect(await h.hello()).toEqual({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(refusals(reports)).toHaveLength(1));
    expect(unfits(reports)).toMatchObject([{ outcome: "not-due", reason: "no-form" }]);
    expect(generation.claimRepair).not.toHaveBeenCalled();
    expect(refusals(reports)[0]).toMatchObject({ reason: "no-route" });
  });
  describe("never for an item or recipe outside the trigger", () => {
    it("an item without its TOTP secret and no discoverable passkey", async () => {
      fake.state.present = new Set(["email", "next"]);
      const { h, reports, generation } = start({
        used: coded,
        password: true,
        passkey: { passkey: true, discoverable: false },
        claim: claimed(),
      });
      withoutTotp(h);
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      expect(refusals(reports)).toMatchObject([{ detail: "no-totp" }]);
      expect(generation.claimRepair).not.toHaveBeenCalled();
    });
    it("a variant refused for its binding beside one refused for the item's facts", async () => {
      // The first variant lacks the password; the second names a field the item lacks.
      const varied = parseLoginRecipe({
        ...onePage,
        alternatives: [
          {
            slots: ["contract"],
            steps: [
              {
                kind: "fill",
                path: "/signin",
                fields: [{ slot: "contract", target: target("contract") }],
              },
              {
                kind: "click",
                path: "/signin",
                target: target("contract-login"),
                purpose: "submit",
              },
            ],
          },
        ],
        maxSubmissions: 2,
      });
      const { h, reports, generation } = start({
        used: varied,
        claim: claimed(),
        overrides: {
          bindings: [
            {
              ...savedBinding,
              recipeId: generatedId,
              slots: [
                { slot: "password", field: "password" },
                { slot: "contract", field: { custom: "Contract" } },
              ],
            },
          ],
        },
      });
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      expect(refusals(reports)).toMatchObject([{ detail: "password-empty:alternatives" }]);
      expect(generation.claimRepair).not.toHaveBeenCalled();
    });
    it("a passkey that is not discoverable", async () => {
      const { h, reports, generation } = start({
        passkey: { passkey: true, discoverable: false },
        claim: claimed(),
      });
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      expect(refusals(reports)).toMatchObject([{ detail: "password-empty:no-advance" }]);
      expect(generation.claimRepair).not.toHaveBeenCalled();
      expect(unfits(reports)).toEqual([]);
    });
    it("an item without a passkey (password-empty:no-passkey)", async () => {
      fake.state.present = new Set(["email", "next"]);
      const { h, reports, generation } = start({
        used: emailFirst,
        passkey: { passkey: false, discoverable: false },
        claim: claimed(),
      });
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      expect(refusals(reports)).toMatchObject([{ detail: "password-empty:no-passkey" }]);
      expect(generation.claimRepair).not.toHaveBeenCalled();
    });
    it("an item whose login ADR 0036's stop carries", async () => {
      fake.state.present = new Set(["email", "next"]);
      fake.state.onExecute = () => new Promise(() => undefined);
      const { h, generation } = start({ used: emailFirst, claim: claimed() });
      expect(await h.hello()).toEqual({ ok: true });
      expect(generation.claimRepair).not.toHaveBeenCalled();
    });
    it("an item that holds the password the recipe fills", async () => {
      fake.state.onExecute = () => new Promise(() => undefined);
      const { h, generation } = start({ password: true, claim: claimed() });
      expect(await h.hello()).toEqual({ ok: true });
      expect(generation.claimRepair).not.toHaveBeenCalled();
    });
    it("a recipe that has a passkey button", async () => {
      fake.state.present = new Set(["password", "login", "passkey-login"]);
      fake.state.onExecute = () => new Promise(() => undefined);
      const button = parseLoginRecipe({
        ...onePage,
        passkey: { path: "/signin", target: target("passkey-login") },
      });
      const { h, generation } = start({ used: button, claim: claimed() });
      // The item takes the recipe's own passkey route.
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executed()).toHaveLength(1));
      expect(generation.claimRepair).not.toHaveBeenCalled();
    });
    it("a passkey-only recipe for an item with a password and a discoverable passkey (ADR 0053)", async () => {
      fake.state.present = new Set(["passkey-login"]);
      fake.state.onExecute = () => new Promise(() => undefined);
      const { h, reports, generation } = start({
        used: buttonOnly,
        password: true,
        claim: claimed(),
      });
      // The item takes the recipe's passkey route, its only one.
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executed()).toHaveLength(1));
      expect(fake.state.storage["pateat.login-attempts.v5"]).toMatchObject([{ route: "passkey" }]);
      expect(generation.claimRepair).not.toHaveBeenCalled();
      expect(unfits(reports)).toEqual([]);
    });
    it("a refusal for the binding rather than the item's facts", async () => {
      const { h, reports, generation } = start({
        claim: claimed(),
        overrides: excludingLive(["login.password"]),
      });
      expect(await h.hello()).toEqual({ ok: false, reason: "binding-field-excluded" });
      expect(generation.claimRepair).not.toHaveBeenCalled();
      expect(unfits(reports)).toEqual([]);
    });
    it("a recipe the service did not generate", async () => {
      const owned = parseLoginRecipe({ ...onePage, id: recipe.id });
      const { h, reports, generation } = start({ used: owned, claim: claimed() });
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      expect(refusals(reports)).toMatchObject([{ detail: "password-empty:no-advance" }]);
      expect(generation.claimRepair).not.toHaveBeenCalled();
    });
  });
  describe("never outside a new login of the tab's own page at the first step", () => {
    it("a frame", async () => {
      const { h, reports, generation } = start({ claim: claimed() });
      const top = "https://login.example/account";
      fake.state.tabUrls[1] = top;
      expect(
        await h.hello({ frameId: 3, documentId: "frame-document", tab: { id: 1, url: top } }),
      ).toEqual({ ok: false, reason: "no-route" });
      expect(refusals(reports)).toMatchObject([{ detail: "password-empty:frame" }]);
      expect(generation.claimRepair).not.toHaveBeenCalled();
    });
    it("a login that would start at a later step (ADR 0049)", async () => {
      fake.state.pageUrl = "https://login.example/password";
      fake.state.observedPath = "/password";
      fake.state.present = new Set(["password", "app-code", "login"]);
      fake.state.awaitReply = (readiness) => ({
        ok: (readiness as unknown as { targets: { value: string }[] }).targets.every((entry) =>
          fake.state.present!.has(entry.value),
        ),
      });
      const { h, reports, generation } = start({ used: coded, password: true, claim: claimed() });
      withoutTotp(h);
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.starts.mockResolvedValue([
        {
          path: "/signin",
          steps: [coded.steps[0]!],
          later: laterStartSteps(coded).map(laterReadiness),
        },
      ]);
      Object.assign(h.recipes, {
        later: vi.fn(async (_origin: string, path: string) =>
          path === "/password" ? [coded] : [],
        ),
      });
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      expect(refusals(reports)).toMatchObject([{ reason: "no-route", detail: "no-totp" }]);
      expect(generation.claimRepair).not.toHaveBeenCalled();
    });
    it("a login on a chooser's list (ADR 0028)", async () => {
      const chooser: LoginChooserRecipe = {
        version: 1,
        id: generatedId,
        revision: 3,
        origin,
        chooser: {
          path: "/signin",
          other: { by: "text", value: "Use another account" },
          afterAccount: parseLoginRecipe({
            ...coded,
            steps: coded.steps.slice(2).map((step) => ({ ...step, path: "/signin" })),
            slots: ["password", "totp"],
            maxSubmissions: 1,
          }),
        },
      };
      fake.state.present = new Set();
      const { h, reports, generation } = start({ used: coded, password: true, claim: claimed() });
      withoutTotp(h);
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.chooser.mockResolvedValue(chooser);
      h.recipes.starts.mockResolvedValue([
        { path: "/signin", steps: [], list: [chooser.chooser.other!] },
      ]);
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      expect(refusals(reports)).toMatchObject([{ reason: "no-route", detail: "no-totp" }]);
      expect(generation.claimRepair).not.toHaveBeenCalled();
    });
    it("a page the tab asks for after a rejected login (ADR 0062)", async () => {
      fake.state.session["pateat.login-rejected-asks.v1"] = [{ tabId: 1, origin }];
      const { h, generation } = start({ claim: claimed() });
      expect(await h.hello({ documentId: "signed-out" })).not.toEqual({
        ok: false,
        reason: "generating",
      });
      expect(generation.claimRepair).not.toHaveBeenCalled();
    });
    it("a resumed login of the recipe", async () => {
      // The submit never answers, so the login still runs when the next page announces.
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: LoginStep }).step.kind === "click")
          await new Promise(() => undefined);
      };
      let empty = false;
      const { h, generation } = start({ password: true, claim: claimed() });
      emptyPassword(h, () => empty);
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(executed()).toHaveLength(2));
      empty = true;
      expect(await h.hello({ documentId: "synthetic-document-2" })).not.toEqual({
        ok: false,
        reason: "generating",
      });
      expect(generation.claimRepair).not.toHaveBeenCalled();
    });
    it("while another tab runs a login of the recipe", async () => {
      fake.state.onExecute = async (message) => {
        if ((message["operation"] as { step: LoginStep }).step.kind === "click")
          await new Promise(() => undefined);
      };
      let empty = false;
      const { h, reports, generation } = start({ password: true, claim: claimed() });
      emptyPassword(h, () => empty);
      fake.state.tabUrls[2] = fake.state.pageUrl;
      expect(await h.hello({ tab: { id: 2 }, documentId: "other-tab" })).toEqual({ ok: true });
      await vi.waitFor(() => expect(executed()).toHaveLength(2));
      // The item's password is emptied by a sync while that login runs.
      empty = true;
      expect(await h.hello()).toEqual({ ok: false, reason: "no-route" });
      expect(refusals(reports).at(-1)).toMatchObject({
        tabId: 1,
        detail: "password-empty:no-advance",
      });
      expect(generation.claimRepair).not.toHaveBeenCalled();
      // Once that tab closes, its login no longer holds the recipe.
      for (const listener of fake.state.removed) listener(2);
      expect(await h.hello({ documentId: "synthetic-document-3" })).toEqual({
        ok: false,
        reason: "generating",
      });
      await vi.waitFor(() => expect(generation.claimRepair).toHaveBeenCalledTimes(1));
    });
  });
});

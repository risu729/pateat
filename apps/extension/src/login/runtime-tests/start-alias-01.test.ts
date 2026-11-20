import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import {
  storedLoginRecipeSchema,
  type LoginStep,
  type SavedLoginBinding,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import { createRecipeSync } from "../../service/recipes";
import type { LoginGeneration } from "../runtime/deps";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, savedBinding, uriMatch, harness } = createRuntimeTestHarness(fake);

// A site that shows its sign-in form on whatever page it guards, in the shape of USI's
// Student Portal (#1716): the recipe was learned where the site returned after its terms
// page, and the same form shows on its top page later, which the service added to the
// recipe's `starts` (ADR 0060 amendment of 2026-11-18). Synthetic pages and items only.

const LEARNED = "/student/Usi/Forgotten/Success";
const TOP = "/student";
const CODE = "/student/SecondFactor/ChooseAndVerifyOtp";
const HOME = "/student/Home";
const RECIPE_ID = "gen-learned";
const id = (value: string) => ({ by: "id" as const, value });

/** The learned recipe as the service stores it, with its other start paths if any. */
const learned = (starts?: string[]) =>
  v.parse(storedLoginRecipeSchema, {
    version: 1,
    id: RECIPE_ID,
    revision: 2,
    origin,
    layouts: [
      {
        key: "1000",
        language: "en",
        createdAt: 1000,
        pageKind: "sign-in",
        slots: ["username", "password"],
        steps: [
          {
            kind: "fill",
            path: LEARNED,
            effect: "prepare",
            fields: [
              { slot: "username", target: id("UserName") },
              { slot: "password", target: id("Password") },
            ],
          },
          {
            kind: "click",
            path: LEARNED,
            target: { by: "text", value: "Login" },
            purpose: "submit",
          },
        ],
        completion: [{ target: id("logout") }],
        handlers: [
          {
            kind: "totp",
            path: CODE,
            field: id("MfaOptions_OneTimePasscode"),
            target: id("nextButton"),
          },
        ],
        maxSubmissions: 2,
      },
    ],
    ...(starts ? { starts } : {}),
  });

/** The device's recipe cache holding `recipes`, as synced from a paired service. */
function cacheOf(recipes: readonly StoredLoginRecipe[]) {
  const now = Date.now();
  const connection = {
    origin: "https://pateat.example.com",
    deviceId: "6f1d3c1e-5d0b-4a52-9d55-3d7a8f0e2b41",
    credential: `pateat_device_${"C".repeat(43)}`,
    rejected: false,
    settingsSynced: true as const,
  };
  const cache = { version: 2, origin: connection.origin, deviceId: connection.deviceId };
  return createRecipeSync({
    service: {
      connection: async () => connection,
      fence: () => () => true,
      recordSync: async () => undefined,
    },
    transport: { recipeChanges: vi.fn() },
    storage: {
      read: async () => ({ ...cache, cursor: 3, recipes }),
      write: async () => undefined,
      readRecovery: async () => undefined,
      writeRecovery: async () => undefined,
      clear: async () => undefined,
    },
    // Synced just now, so no lookup starts another sync.
    schedule: {
      read: async () => ({ version: 1, startedAt: now, retryAt: now + 3_600_000 }),
      write: async () => undefined,
    },
    build: "development",
  }).recipes;
}

const binding: SavedLoginBinding = {
  ...savedBinding,
  recipeId: RECIPE_ID,
  slots: [
    { slot: "username", field: "username" },
    { slot: "password", field: "password" },
  ],
};
const noPasskey = async () => ({ passkey: false, discoverable: false });

/** A runtime on the recipe cache holding `recipes`, whose item has a TOTP key. */
function usi(recipes: readonly StoredLoginRecipe[], generation?: LoginGeneration) {
  const h = harness(
    { bindings: [binding] },
    {
      username: true,
      passkeys: noPasskey,
      ...(generation
        ? { generation, uris: async () => ({ ok: true as const, data: uriMatch() }) }
        : {}),
    },
  );
  Object.assign(h.recipes, cacheOf(recipes));
  const original = h.store.handle.getMockImplementation()!;
  h.store.handle.mockImplementation(async () => {
    const response = await original();
    if (response.ok)
      response.catalog.connections[0]!.items[0]!.fields.push({
        id: "login.totp-code",
        label: "Verification code",
        name: null,
        kind: "otp",
      } as never);
    return response;
  });
  h.fields.mockImplementation(async ({ fieldId }) =>
    fieldId === "login.totp-code" ? "012345" : "synthetic-secret",
  );
  return h;
}

const status = () =>
  fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
const executed = () =>
  fake.state.messages
    .filter((entry) => entry.type === "login.execute")
    .map((entry) => (entry as unknown as { operation: { step: LoginStep } }).operation.step);
const stepsRun = () =>
  executed().map((step) => [
    step.kind,
    step.path,
    step.kind === "fill" ? step.fields.map((field) => field.slot) : step.target.value,
  ]);
/** The site: its form on `path`, then the code page, then its signed-in home page. */
function site(path: string) {
  fake.state.pageUrl = `${origin}${path}`;
  fake.state.observedPath = path;
  fake.state.present = new Set(["UserName", "Password", "Login"]);
  fake.state.onExecute = async (message) => {
    const step = (message["operation"] as { step: LoginStep }).step;
    if (step.kind !== "click") return;
    if (step.target.value === "Login") {
      fake.state.observedPath = CODE;
      fake.state.present = new Set(["MfaOptions_OneTimePasscode", "nextButton"]);
    } else if (step.target.value === "nextButton") {
      fake.state.observedPath = HOME;
      fake.state.present = new Set(["logout"]);
    }
  };
}

describe("a recipe that starts on another path of its site (ADR 0060 amendment of 2026-11-18)", () => {
  afterEach(() => {
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2]) listener(tabId);
  });
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.badges = {};
    fake.state.reconnects = [];
    fake.state.onReconnect = undefined;
    fake.state.messages = [];
    fake.state.granted = true;
    fake.state.tabUrls = {};
    fake.state.incognito = new Set();
    fake.state.observed = ["unique", "missing"];
    fake.state.unusable = new Set();
    fake.state.unobservable = new Set();
    fake.state.disabled = new Set();
    fake.state.awaited = { ok: true };
    fake.state.onAwait = undefined;
    fake.state.awaitReply = undefined;
    fake.state.executeReply = undefined;
    fake.state.switchReply = { ok: true };
    fake.state.chosen = { ok: true, click: "entry" };
    fake.state.siteAccount = { ok: false };
    fake.state.gone = new Set();
    fake.state.extracted = {};
    fake.state.signs = undefined;
    fake.state.loaded = true;
    fake.state.openTabs = undefined;
  });

  it("fills and clicks on that path, and enters the code page's TOTP handler", async () => {
    site(TOP);
    const h = usi([learned([TOP])]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
      timeout: 6_000,
    });
    expect(stepsRun()).toEqual([
      ["fill", TOP, ["username", "password"]],
      ["click", TOP, "Login"],
      ["fill", CODE, ["totp"]],
      ["click", CODE, "nextButton"],
    ]);
    // The login records the path it started on, and the handler it entered.
    expect(status()![0]).toMatchObject({
      recipeId: RECIPE_ID,
      recipeRevision: 2,
      layout: "1000",
      start: TOP,
      handlers: [{ index: 0, start: 2 }],
      submissions: 2,
    });
    // The code page's handler reads the item's TOTP code once.
    expect(
      h.fields.mock.calls.filter(([request]) => request.fieldId === "login.totp-code"),
    ).toHaveLength(1);
  }, 10_000);

  it("records no other path for a login on the recipe's own start path", async () => {
    site(LEARNED);
    const h = usi([learned([TOP])]);
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
      timeout: 6_000,
    });
    expect(stepsRun().slice(0, 2)).toEqual([
      ["fill", LEARNED, ["username", "password"]],
      ["click", LEARNED, "Login"],
    ]);
    expect(status()![0]!["start"]).toBeUndefined();
  }, 10_000);

  it("resumes after a worker restart on the path it started on", async () => {
    // The first worker's login started there, then never saw its form ready again and
    // stopped; its record says where.
    site(TOP);
    let waits = 0;
    fake.state.awaitReply = () => (waits++ === 0 ? { ok: true } : { ok: false, reason: "timeout" });
    const first = usi([learned([TOP])]);
    expect(await first.hello()).toEqual({ ok: true });
    await vi.waitFor(() =>
      expect(status()).toMatchObject([{ state: "blocked", outcome: "retry-limit", start: TOP }]),
    );
    const [record] = status()!;
    fake.state.storage["pateat.login-attempts.v5"] = [
      {
        ...record,
        state: "retryable",
        outcome: "structural-mismatch",
        retries: 1,
        retryRequired: true,
      },
    ];
    fake.state.awaitReply = undefined;
    fake.state.messages = [];
    const query = fake.browser.tabs.query;
    fake.browser.tabs.query = async () => [{ id: 1 }] as never;
    try {
      // A restarted worker, with a new cache, and the form on the same path again.
      const restarted = usi([learned([TOP])]);
      expect(await restarted.hello({ documentId: "after-restart" })).toEqual({ ok: true });
      await vi.waitFor(
        () => expect(status()).toMatchObject([{ state: "authenticated", start: TOP }]),
        { timeout: 6_000 },
      );
      expect(stepsRun()).toEqual([
        ["fill", TOP, ["username", "password"]],
        ["click", TOP, "Login"],
        ["fill", CODE, ["totp"]],
        ["click", CODE, "nextButton"],
      ]);
      expect(status()![0]).toMatchObject({ id: record!["id"], retries: 2 });
    } finally {
      fake.browser.tabs.query = query;
    }
  }, 10_000);

  it("offers no generation on that path, unlike a recipe that does not start there", async () => {
    const generation = () => ({
      available: vi.fn<LoginGeneration["available"]>(async () => true),
      generate: vi.fn<LoginGeneration["generate"]>(),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(async () => ({ verdict: "unclear" as const })),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    });
    site(TOP);
    fake.state.present = new Set();
    const aliased = generation();
    const h = usi([learned([TOP])], aliased);
    // The page announces before its form shows: it watches for the form on this path.
    const reply = await h.hello({}, false);
    expect(reply).toMatchObject({
      ok: false,
      starts: expect.arrayContaining([expect.objectContaining({ path: TOP })]),
    });
    expect(reply).not.toHaveProperty("generate");
    expect(aliased.available).not.toHaveBeenCalled();
    // A recipe without other start paths behaves as before: the path is offered.
    const plain = generation();
    const before = usi([learned()], plain);
    const offered = await before.hello({ documentId: "plain-document" }, false);
    expect(offered).toMatchObject({ ok: false, reason: "recipe-not-found", generate: true });
    expect(offered).not.toMatchObject({
      starts: expect.arrayContaining([expect.objectContaining({ path: TOP })]),
    });
    expect(plain.available).toHaveBeenCalledWith(origin, TOP);
  });

  it("starts nothing on that path while the cache cannot say it is one", async () => {
    site(TOP);
    const h = usi([learned([TOP])]);
    Object.assign(h.recipes, { startAlias: async () => undefined });
    expect(await h.hello()).toMatchObject({ ok: false, reason: "recipe-not-found" });
    expect(executed()).toEqual([]);
    expect(status()).toBeUndefined();
  });

  it("starts nothing on that path for a recipe without other start paths", async () => {
    site(TOP);
    const h = usi([learned()]);
    expect(await h.hello()).toMatchObject({ ok: false, reason: "recipe-not-found" });
    expect(executed()).toEqual([]);
    expect(status()).toBeUndefined();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as v from "valibot";
import {
  parseLoginRecipe,
  projectionOn,
  storedLoginRecipeSchema,
  type LocalSettings,
  type LoginStep,
  type SavedLoginBinding,
  type StoredLoginRecipe,
} from "@pateat/contracts";
import { createRecipeSync } from "../../service/recipes";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, savedBinding, startsOf, uriMatch, harness } = createRuntimeTestHarness(fake);

// A login that started on another start path of its recipe (ADR 0060 amendment of
// 2026-11-18) keeps running there: when it parts from its layout, when a sign-in fill's
// page posts back, and when the service continues its recipe, which it answers on the
// recipe's own start path. Synthetic pages and items in the shape of USI's Student Portal.

const LEARNED = "/student/Usi/Forgotten/Success";
const TOP = "/student";
const SECOND = "/student/password";
const id = (value: string) => ({ by: "id" as const, value });

/** A stored recipe of `layouts`, with `/student` among its start paths. */
const stored = (recipeId: string, layouts: Record<string, unknown>[]) =>
  v.parse(storedLoginRecipeSchema, {
    version: 1,
    id: recipeId,
    revision: 1,
    origin,
    layouts,
    starts: [TOP],
  });
/** A layout whose username page on `/student/Usi/...` leads to `steps`. */
const layout = (key: string, steps: Record<string, unknown>[]) => ({
  key,
  language: "en",
  createdAt: Number(key),
  pageKind: "sign-in",
  slots: ["username", "password"],
  steps: [
    {
      kind: "fill",
      path: LEARNED,
      effect: "prepare",
      fields: [{ slot: "username", target: id("UserName") }],
    },
    { kind: "click", path: LEARNED, target: id("Next"), purpose: "advance" },
    ...steps,
  ],
  completion: [{ target: id("logout") }],
  maxSubmissions: 2,
});
const passwordOn = (path: string, field: string, button: string) => [
  { kind: "fill", path, effect: "prepare", fields: [{ slot: "password", target: id(field) }] },
  { kind: "click", path, target: id(button), purpose: "submit" },
];

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
    schedule: {
      read: async () => ({ version: 1, startedAt: now, retryAt: now + 3_600_000 }),
      write: async () => undefined,
    },
    build: "development",
  }).recipes;
}
const bound = (recipeId: string): SavedLoginBinding => ({
  ...savedBinding,
  recipeId,
  slots: [
    { slot: "username", field: "username" },
    { slot: "password", field: "password" },
  ],
});
const noPasskey = async () => ({ passkey: false, discoverable: false });

const status = () =>
  fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
const executes = () =>
  fake.state.messages.filter((entry) => entry.type === "login.execute") as unknown as {
    operation: { stepIndex: number; step: LoginStep };
  }[];
const stepsRun = () =>
  executes().map(({ operation: { step } }) => [
    step.kind,
    step.path,
    step.kind === "fill" ? step.fields.map((field) => field.target.value) : step.target.value,
  ]);
/** The page shows `path` with `present`, and a step's elements that do not show time out. */
function page(path: string, present: string[]) {
  fake.state.pageUrl = `${origin}${path}`;
  fake.state.observedPath = path;
  fake.state.present = new Set(present);
  fake.state.awaitReply = (readiness) =>
    (readiness as unknown as { targets: { value: string }[] }).targets.every((entry) =>
      fake.state.present!.has(entry.value),
    )
      ? { ok: true }
      : { ok: false, reason: "timeout" };
}

const originalSend = fake.browser.tabs.sendMessage;
let changes: (() => void)[] = [];
const change = () => {
  for (const resolve of changes.splice(0)) resolve();
};

beforeEach(() => {
  Object.assign(fake.state, {
    storage: {},
    session: {},
    messages: [],
    badges: {},
    reconnects: [],
    onReconnect: undefined,
    granted: true,
    signIn: false,
    onExecute: undefined,
    tabUrls: {},
    incognito: new Set(),
    observed: ["unique", "missing"],
    unusable: new Set(),
    disabled: new Set(),
    unobservable: new Set(),
    awaited: { ok: true },
    awaitReply: undefined,
    onAwait: undefined,
    executeReply: undefined,
    switchReply: { ok: true },
    chosen: { ok: true, click: "entry" },
    siteAccount: { ok: false },
    gone: new Set(),
    extracted: {},
    signs: undefined,
    loaded: true,
    openTabs: undefined,
  });
  changes = [];
  // A sign-in fill waits for the page to change its fields (ADR 0049).
  vi.spyOn(fake.browser.tabs, "sendMessage").mockImplementation(async (...args) => {
    const message = args[1];
    if (message["type"] === "login.fill.change") {
      fake.state.messages.push(structuredClone(message) as (typeof fake.state.messages)[number]);
      await new Promise<void>((resolve) => changes.push(resolve));
      return { ok: true };
    }
    return originalSend(...args);
  });
});
afterEach(() => {
  for (const listener of fake.state.removed.splice(0)) for (const tab of [1, 2]) listener(tab);
  change();
  vi.restoreAllMocks();
});

describe("a login on another start path of its recipe (ADR 0060 amendment of 2026-11-18)", () => {
  it("switches to the layout whose next page shows, there too", async () => {
    // Both layouts ask for the username first, so the newest runs; the page after it is
    // the older layout's.
    const recipe = stored("gen-parted", [
      layout("1000", passwordOn(SECOND, "Password", "Login")),
      layout("2000", passwordOn(SECOND, "Passcode", "Continue")),
    ]);
    page(TOP, ["UserName", "Next"]);
    fake.state.onExecute = async (message) => {
      const { step } = message["operation"] as { step: LoginStep };
      if (step.kind !== "click") return;
      if (step.purpose === "advance") page(SECOND, ["Password", "Login"]);
      else page("/student/Home", ["logout"]);
    };
    const reports: LoginReport[] = [];
    const h = harness(
      { bindings: [bound(recipe.id)] },
      { username: true, passkeys: noPasskey, report: (entry) => reports.push(entry) },
    );
    Object.assign(h.recipes, cacheOf([recipe]));
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
      timeout: 6_000,
    });
    expect(stepsRun()).toEqual([
      ["fill", TOP, ["UserName"]],
      ["click", TOP, "Next"],
      ["fill", SECOND, ["Password"]],
      ["click", SECOND, "Login"],
    ]);
    expect(status()![0]).toMatchObject({ layout: "1000", start: TOP });
    expect(
      reports.filter((entry) => entry.type === "attempt" && entry.layoutFrom !== undefined),
    ).toEqual([expect.objectContaining({ branch: "1000", layoutFrom: "2000" })]);
  }, 10_000);

  it("goes on with a sign-in fill whose form posts back to that path", async () => {
    const recipe = stored("gen-filled", [layout("1000", passwordOn(LEARNED, "Password", "Login"))]);
    page(TOP, ["UserName", "Next"]);
    const fill: Partial<LocalSettings> = {
      pagePermissionDefaults: { "sign-in": "fill", confirm: "fill", "personal-details": "fill" },
    };
    const h = harness(
      { ...fill, bindings: [bound(recipe.id)] },
      { username: true, passkeys: noPasskey },
    );
    Object.assign(h.recipes, cacheOf([recipe]));
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(executes()).toHaveLength(1));
    await vi.waitFor(() => expect(changes.length).toBeGreaterThan(0));
    expect(status()![0]).toMatchObject({ signInFill: true, start: TOP });
    // The form posts back to its own path and shows the username beside the password: the
    // first step shows, but so does the fill's next field, which goes on.
    page(TOP, ["UserName", "Password", "Login"]);
    expect(await h.hello({ documentId: "posted-back" })).toEqual({ ok: true });
    change();
    await vi.waitFor(() => expect(executes()).toHaveLength(2));
    expect(executes().map((entry) => entry.operation.stepIndex)).toEqual([0, 2]);
    expect(stepsRun()[1]).toEqual(["fill", TOP, ["Password"]]);
  }, 10_000);

  it("resumes the list's branch it clicked there in the next document (ADR 0028)", async () => {
    const listed = v.parse(storedLoginRecipeSchema, {
      version: 1,
      id: "gen-listed",
      revision: 1,
      origin,
      chooser: {
        path: LEARNED,
        layouts: [
          {
            key: "4000",
            createdAt: 4000,
            other: id("other"),
            afterOther: {
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
                { kind: "click", path: LEARNED, target: id("Login"), purpose: "submit" },
              ],
              completion: [{ target: id("logout") }],
              maxSubmissions: 1,
            },
          },
        ],
      },
      starts: [TOP],
    });
    // The list shows on `/student`; its "other account" button loads the form there.
    page(TOP, ["other"]);
    const shows = fake.state.awaitReply!;
    fake.state.awaitReply = (readiness) =>
      readiness.accounts === true ? { ok: true } : shows(readiness);
    fake.state.chosen = { ok: true, click: "other" };
    fake.state.onExecute = async (message) => {
      const { step } = message["operation"] as { step: LoginStep };
      // The button loads the form as the login's next document, on the same path.
      if (step.kind === "click" && step.target.value === "other") {
        fake.state.gone.add("synthetic-document");
        page(TOP, ["UserName", "Password", "Login"]);
      }
      if (step.kind === "click" && step.target.value === "Login") page("/student/Home", ["logout"]);
    };
    const h = harness({ bindings: [bound(listed.id)] }, { username: true, passkeys: noPasskey });
    Object.assign(h.recipes, cacheOf([listed]));
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(stepsRun()).toEqual([["click", TOP, "other"]]));
    expect(status()![0]).toMatchObject({ chooser: { click: "other" }, start: TOP });
    expect(await h.hello({ documentId: "form-document" }, false)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
      timeout: 6_000,
    });
    expect(stepsRun().slice(1)).toEqual([
      ["fill", TOP, ["UserName", "Password"]],
      ["click", TOP, "Login"],
    ]);
  }, 10_000);

  describe("whose recipe the service continues (ADR 0018)", () => {
    const emailFirst = parseLoginRecipe({
      version: 1,
      id: "gen-continued",
      revision: 1,
      origin,
      pageKind: "sign-in",
      slots: ["username"],
      steps: [
        { kind: "fill", path: LEARNED, fields: [{ slot: "username", target: id("UserName") }] },
        { kind: "click", path: LEARNED, target: id("Next"), purpose: "advance" },
      ],
      maxSubmissions: 1,
    });
    // The service reads a page on another start path on the recipe's own (ADR 0060
    // amendment of 2026-11-18), so its revision keeps the stored paths.
    const continued = parseLoginRecipe({
      ...emailFirst,
      revision: 2,
      slots: ["username", "password"],
      steps: [
        ...emailFirst.steps,
        { kind: "fill", path: LEARNED, fields: [{ slot: "password", target: id("Password") }] },
        { kind: "click", path: LEARNED, target: id("Login"), purpose: "submit" },
      ],
      maxSubmissions: 2,
    });
    const described = (path: string, candidates: unknown[]) => ({
      ok: true,
      observation: { version: 1, origin, path, language: "en", complete: true, candidates },
    });

    /**
     * A login on `/student` whose Next shows the password in place, with the service's
     * `generate`. The cache answers as the real one does: on `/student`, and by ID on the
     * path a login recorded, or else on the recipe's own start path.
     */
    function continuing(generate: (h: ReturnType<typeof harness>) => LoginGeneration["generate"]) {
      const cache = { held: emailFirst };
      const generation = {
        available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
        generate: vi.fn<LoginGeneration["generate"]>(async (...args) => generate(h)(...args)),
        generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
        judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
          args[4]?.();
          return { verdict: "signed-in" as const };
        }),
        slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
      };
      page(TOP, ["UserName", "Next"]);
      fake.state.onExecute = async (message) => {
        const { step } = message["operation"] as { step: LoginStep };
        if (step.kind !== "click") return;
        if (step.target.value === "Next") {
          // The password shows below the username, in the same document.
          fake.state.unusable = new Set(["UserName", "Next"]);
          fake.state.present = new Set(["UserName", "Next", "Password", "Login"]);
          fake.state.signIn = true;
          fake.state.extracted = {
            login: described(TOP, [
              { id: "c1", role: "password", target: id("Password"), label: "Password" },
              { id: "c2", role: "button", target: id("Login"), label: "Log in" },
            ]),
          };
        } else {
          page("/student/Home", ["logout"]);
          fake.state.signIn = false;
          fake.state.extracted = {
            "signed-in": described("/student/Home", [
              { id: "c1", role: "button", target: id("logout"), label: "Sign out" },
            ]),
          };
        }
      };
      const h = harness(
        { siteDefaults: [], bindings: [] },
        {
          allowedOrigins: [],
          uris: async () => ({ ok: true as const, data: uriMatch() }),
          username: true,
          custom: [],
          generation,
        },
      );
      h.recipes.recipe.mockImplementation(
        async (
          _origin: string,
          path: string,
          recipeId?: string,
          _layout?: string,
          start?: string,
        ) =>
          recipeId === undefined
            ? path === TOP
              ? projectionOn(cache.held, TOP)
              : undefined
            : start === undefined
              ? cache.held
              : projectionOn(cache.held, start),
      );
      h.recipes.starts.mockResolvedValue(startsOf([projectionOn(emailFirst, TOP).steps[0]!]));
      Object.assign(h.recipes, {
        startAlias: vi.fn(async (_origin: string, _id: string, path: string) => path === TOP),
      });
      return { h, generation, cache };
    }
    const signedIn = async () => {
      await vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
        timeout: 8_000,
      });
      expect(stepsRun()).toEqual([
        ["fill", TOP, ["UserName"]],
        ["click", TOP, "Next"],
        ["fill", TOP, ["Password"]],
        ["click", TOP, "Login"],
      ]);
      expect(status()![0]).toMatchObject({ recipeRevision: 2, start: TOP, submissions: 2 });
    };

    it("runs the service's revision on that path", async () => {
      const { h, generation, cache } = continuing(() => async () => {
        cache.held = continued;
        return { outcome: "recipe" as const, recipe: continued };
      });
      expect(await h.hello()).toEqual({ ok: true });
      await signedIn();
      expect(generation.generate).toHaveBeenCalledTimes(1);
    }, 10_000);

    it("takes over the revision that reached the cache while a new document resumed", async () => {
      let answer!: () => void;
      const { h, generation, cache } = continuing(() => async () => {
        cache.held = continued;
        await new Promise<void>((resolve) => (answer = resolve));
        return { outcome: "recipe" as const, recipe: continued };
      });
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(generation.generate).toHaveBeenCalledTimes(1));
      // The form posts back to its path before the answer; the cache already holds it.
      fake.state.gone.add("synthetic-document");
      expect(await h.hello({ documentId: "again" }, false)).toEqual({ ok: true });
      await signedIn();
      expect(status()![0]).toMatchObject({ document: { documentId: "again" } });
      answer();
    }, 10_000);
  });
});

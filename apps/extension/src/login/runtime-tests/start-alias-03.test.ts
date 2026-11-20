import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  parseLoginRecipe,
  projectionOn,
  type LoginChooserRecipe,
  type LoginStep,
} from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, target, startsOf, recipe, uriMatch, harness } = createRuntimeTestHarness(fake);

// A login on another start path of its recipe (ADR 0060 amendment of 2026-11-18) takes over
// the revisions the service answers on the recipe's own start path, moved onto its path:
// one the judge learned a handler in, and a chooser's (ADR 0028), sent or cached.
const ALIAS = "/student";

const status = () =>
  fake.state.storage["pateat.login-attempts.v5"] as Record<string, unknown>[] | undefined;
const executed = () =>
  fake.state.messages
    .filter((entry) => entry.type === "login.execute")
    .map((entry) => {
      const { step } = (entry as unknown as { operation: { step: LoginStep } }).operation;
      return `${step.kind}:${step.path}:${step.kind === "fill" ? step.fields.map((field) => field.target.value).join(",") : step.target.value}`;
    });
const described = (path: string, candidates: unknown[]) => ({
  ok: true,
  observation: { version: 1, origin, path, language: "en", complete: true, candidates },
});
const homePage = described("/home", [
  { id: "c1", role: "button", target: target("logout"), label: "Sign out" },
]);
function generation(
  judge: LoginGeneration["judge"] = async () => ({ verdict: "signed-in" }),
  generate: LoginGeneration["generate"] = async () => ({ outcome: "skipped", reason: "sent" }),
) {
  return {
    available: vi.fn<LoginGeneration["available"]>(async () => "sent"),
    generate: vi.fn<LoginGeneration["generate"]>(generate),
    generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
    judge: vi.fn<LoginGeneration["judge"]>(async (...args) => {
      args[4]?.();
      return judge(...args);
    }),
    slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
  };
}
const signedIn = () =>
  vi.waitFor(() => expect(status()).toMatchObject([{ state: "authenticated" }]), {
    timeout: 8_000,
  });

beforeEach(() => {
  Object.assign(fake.state, {
    storage: {},
    session: {},
    badges: {},
    reconnects: [],
    onReconnect: undefined,
    messages: [],
    granted: true,
    pageUrl: `${origin}${ALIAS}`,
    observedPath: ALIAS,
    onExecute: undefined,
    tabUrls: {},
    incognito: new Set(),
    observed: ["unique", "missing"],
    unusable: new Set(),
    unobservable: new Set(),
    disabled: new Set(),
    signIn: false,
    awaited: { ok: true },
    awaitReply: undefined,
    onAwait: undefined,
    executeReply: undefined,
    switchReply: { ok: true },
    chosen: { ok: true, click: "entry" },
    gone: new Set(),
    extracted: {},
    signs: undefined,
  });
});
afterEach(() => {
  for (const listener of fake.state.removed.splice(0)) for (const tabId of [1, 2]) listener(tabId);
});

describe("a login on another start path of its recipe (ADR 0060 amendment of 2026-11-18)", () => {
  /** The harness's recipe, stored on `/signin`, with `/student` among its start paths. */
  const onAlias = (h: ReturnType<typeof harness>) =>
    Object.assign(h.recipes, {
      startAlias: vi.fn(async (_origin: string, _id: string, path: string) => path === ALIAS),
    });

  it("takes over the revision the judge learned a handler in", async () => {
    const key = { by: "text" as const, value: "Use security key" };
    const { completion: _completion, ...unlearned } = recipe;
    const plain = parseLoginRecipe(unlearned);
    // The service stores the handler on the recipe's own paths.
    const taken = parseLoginRecipe({
      ...unlearned,
      revision: 2,
      handlers: [{ kind: "passkey", path: "/login/webauthn", target: key }],
    });
    fake.state.present = new Set(["password", "login"]);
    fake.state.onExecute = async (message) => {
      const { step } = message["operation"] as { step: LoginStep };
      if (step.kind !== "click") return;
      if (step.target.value === "login") {
        fake.state.observedPath = "/login/webauthn";
        fake.state.present = new Set([key.value]);
        fake.state.extracted = {
          "signed-in": described("/login/webauthn", [
            { id: "c1", role: "button", target: key, label: key.value },
          ]),
        };
      } else {
        fake.state.observedPath = "/home";
        fake.state.present = new Set(["logout"]);
        fake.state.extracted = { "signed-in": homePage };
      }
    };
    const answers = [{ verdict: "challenge" as const, recipe: taken }];
    const service = generation(async () => answers.shift() ?? { verdict: "signed-in" });
    const h = harness(
      {},
      { passkeys: async () => ({ passkey: true, discoverable: false }), generation: service },
    );
    const moved = projectionOn(plain, ALIAS);
    h.recipes.recipe.mockResolvedValue(moved);
    h.recipes.starts.mockResolvedValue(startsOf([moved.steps[0]!]));
    onAlias(h);
    expect(await h.hello()).toEqual({ ok: true });
    await signedIn();
    expect(executed()).toEqual([
      `fill:${ALIAS}:password`,
      `click:${ALIAS}:login`,
      `click:/login/webauthn:${key.value}`,
    ]);
    expect(status()![0]).toMatchObject({ recipeRevision: 2, start: ALIAS });
  }, 10_000);

  describe("on a chooser's list (ADR 0028)", () => {
    const other = { by: "text" as const, value: "Sign in with another profile" };
    const listed: LoginChooserRecipe = {
      version: 1,
      id: "gen-synthetic-chooser",
      revision: 1,
      origin,
      layout: "1000",
      chooser: { path: "/signin", other },
    };
    const branch = (revision: number) =>
      parseLoginRecipe({
        version: 1,
        id: listed.id,
        revision,
        origin,
        layout: "1000",
        pageKind: "sign-in",
        slots: ["password"],
        steps: [
          { kind: "fill", path: "/signin", fields: [{ slot: "password", target: target("pw") }] },
          { kind: "click", path: "/signin", target: target("go"), purpose: "submit" },
        ],
        maxSubmissions: 1,
      });
    // Another device's continuation of the other branch.
    const otherChanged: LoginChooserRecipe = {
      ...listed,
      revision: 2,
      chooser: { ...listed.chooser, afterOther: branch(2) },
    };
    const withAccount = (base: LoginChooserRecipe, revision: number): LoginChooserRecipe => ({
      ...base,
      revision,
      chooser: { ...base.chooser, afterAccount: branch(revision) },
    });
    /**
     * A login on the list on `/student`, whose cache answers as the real one does: on the
     * path, and by ID on the path the login recorded, or else on the recipe's own.
     */
    function onList(generate: LoginGeneration["generate"]) {
      const cache: { held: LoginChooserRecipe } = { held: listed };
      const service = generation(undefined, generate);
      const h = harness(
        { siteDefaults: [], bindings: [] },
        {
          allowedOrigins: [],
          uris: async () => ({ ok: true as const, data: uriMatch() }),
          username: true,
          custom: [],
          generation: service,
        },
      );
      h.recipes.recipe.mockResolvedValue(undefined);
      h.recipes.chooser.mockImplementation((async (
        _origin: string,
        path: string,
        recipeId?: string,
        _layout?: string,
        start?: string,
      ) =>
        recipeId === undefined
          ? path === ALIAS
            ? projectionOn(cache.held, ALIAS)
            : undefined
          : start === undefined
            ? cache.held
            : projectionOn(cache.held, start)) as never);
      h.recipes.starts.mockResolvedValue([{ path: ALIAS, steps: [], list: [other] }]);
      onAlias(h);
      fake.state.present = new Set();
      // The profile's click shows the branch's password form in place.
      fake.state.onExecute = async (message) => {
        const { step } = message["operation"] as { step: LoginStep };
        if (step.kind !== "click") return;
        if (JSON.stringify(step.target).includes("[account]")) {
          fake.state.present = new Set(["pw", "go"]);
          fake.state.signIn = true;
          fake.state.extracted = {
            login: described(ALIAS, [
              { id: "c1", role: "password", target: target("pw"), label: "Password" },
              { id: "c2", role: "button", target: target("go"), label: "Log in" },
            ]),
          };
        } else if (step.target.value === "go") {
          fake.state.observedPath = "/home";
          fake.state.present = new Set(["logout"]);
          fake.state.signIn = false;
          fake.state.extracted = { "signed-in": homePage };
        }
      };
      return { h, service, cache };
    }
    const branchRun = [`fill:${ALIAS}:pw`, `click:${ALIAS}:go`];

    it("sends the page again against a revision that changed the other branch", async () => {
      let cache!: { held: LoginChooserRecipe };
      const answers = [otherChanged, withAccount(otherChanged, 3)];
      const { h, service, ...rest } = onList(async () => {
        const answer = answers.shift()!;
        cache.held = answer;
        return { outcome: "recipe", recipe: answer };
      });
      cache = rest.cache;
      expect(await h.hello()).toEqual({ ok: true });
      await signedIn();
      expect(service.generate).toHaveBeenCalledTimes(2);
      expect(executed().slice(1)).toEqual(branchRun);
      expect(status()![0]).toMatchObject({ recipeRevision: 3, start: ALIAS });
    }, 10_000);

    it("takes over the revision that reached the cache while a new document resumed", async () => {
      let cache!: { held: LoginChooserRecipe };
      let answer!: () => void;
      const { h, service, ...rest } = onList(async () => {
        cache.held = withAccount(listed, 2);
        await new Promise<void>((resolve) => (answer = resolve));
        return { outcome: "recipe", recipe: withAccount(listed, 2) };
      });
      cache = rest.cache;
      expect(await h.hello()).toEqual({ ok: true });
      await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
      // The form posts back to its path before the answer; the cache already holds it.
      fake.state.gone.add("synthetic-document");
      expect(await h.hello({ documentId: "again" }, false)).toMatchObject({ ok: true });
      await signedIn();
      expect(executed().slice(1)).toEqual(branchRun);
      answer();
    }, 10_000);
  });
});

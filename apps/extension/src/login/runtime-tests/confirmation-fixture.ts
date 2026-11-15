// The shared setup of the confirmation-fill runtime tests (ADR 0035 delivery 3): a login
// confirmed in tab 1, then a cached `confirm` recipe on `/confirm`.
import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  parseLoginRecipe,
  type LoginAttemptMetadata,
  type LoginOperation,
  type LoginRecipe,
} from "@pateat/contracts";
import type { LoginReport } from "../runtime/report";
import { createRuntimeTestHarness } from "./harness";
import type { createBrowserFake } from "./browser-fake";

export function confirmationFixture(fake: ReturnType<typeof createBrowserFake>) {
  const base = createRuntimeTestHarness(fake);
  const { harness, recipe, origin, itemId, uriMatch, realTime } = base;
  const attemptKey = "pateat.login-attempts.v5";
  const sessionKey = "pateat.confirm-fills.v1";
  const popup = {
    id: "synthetic-extension",
    url: "chrome-extension://synthetic-extension/popup.html",
  };
  const stored = () => fake.state.storage[attemptKey] as LoginAttemptMetadata[];
  const executes = () =>
    fake.state.messages.filter((entry) => entry.type === "login.execute") as unknown as {
      operation: LoginOperation;
      values: { slot: string; value: string }[];
    }[];
  const confirmations = () =>
    executes().filter((entry) => entry.operation.attemptId.startsWith("confirm:"));
  const cached = (kind: "confirm" | "unclear" = "confirm") =>
    parseLoginRecipe({
      ...recipe,
      id: "synthetic-confirm",
      pageKind: kind,
      steps: recipe.steps.map((step) => ({ ...step, path: "/confirm" })),
    });
  const uris = async (_connection: string, url: string) => ({
    ok: true as const,
    data: uriMatch({ targetOrigin: new URL(url).origin }),
  });
  beforeEach(() => {
    realTime();
    Object.assign(fake.state, {
      storage: {},
      session: {},
      messages: [],
      badges: {},
      reconnects: [],
      onReconnect: undefined,
      granted: true,
      pageUrl: `${origin}/signin`,
      observedPath: "/signin",
      present: new Set(["password", "login"]),
      onExecute: undefined,
      onAwait: undefined,
      tabUrls: {},
      incognito: new Set(),
      observed: ["unique", "missing"],
      unusable: new Set(),
      disabled: new Set(),
      faint: new Set(),
      ambiguous: new Set(),
      unobservable: new Set(),
      awaited: { ok: true },
      executeReply: undefined,
      gone: new Set(),
      goneFrames: new Set(),
      onPresent: undefined,
      extracted: {},
      signs: undefined,
      loaded: true,
      openTabs: undefined,
      signIn: false,
    });
  });
  afterEach(async () => {
    for (const listener of fake.state.removed.splice(0))
      for (const tabId of [1, 2, 3]) listener(tabId);
    fake.state.replaced.length = 0;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  type H = ReturnType<typeof harness>;
  type Live = NonNullable<Parameters<typeof harness>[1]>;
  /** Logs in once in tab 1 and waits for the confirmed login's session proof. */
  async function authenticated(live: Live = {}, from: Record<string, unknown> = {}) {
    const reports: LoginReport[] = [];
    const options: Live = { uris, ...live, report: (entry) => reports.push(entry) };
    const h = harness({}, options);
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as LoginOperation).step.kind === "click")
        fake.state.present = new Set(["authenticated"]);
    };
    expect(await h.hello(from)).toEqual({ ok: true });
    await vi.waitFor(() => expect(stored()[0]).toMatchObject({ state: "authenticated" }));
    await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
    await vi.waitFor(() =>
      expect(fake.state.session[sessionKey]).toMatchObject({
        proofs: [expect.objectContaining({ itemId })],
      }),
    );
    h.fields.mockClear();
    h.store.update.mockClear();
    fake.state.onExecute = undefined;
    return { h, reports, options, original: structuredClone(stored()) };
  }
  function configure(h: H, confirm: LoginRecipe = cached()) {
    h.recipes.routes.mockResolvedValue([confirm]);
    h.recipes.recipe.mockResolvedValue(confirm);
    fake.state.pageUrl = `${origin}/confirm`;
    fake.state.observedPath = "/confirm";
    fake.state.present = new Set(["password", "login"]);
    return confirm;
  }
  const announce = (h: H, from: Record<string, unknown> = {}) =>
    h.hello({ documentId: "confirmation-document", ...from }, false);
  async function settled(h: H) {
    await vi.waitFor(async () => expect(await h.login.active()).toBe(false));
  }
  /** Holds every confirmation delivery until `release` is called. */
  function holdDelivery() {
    const held = Promise.withResolvers<void>();
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as LoginOperation).attemptId.startsWith("confirm:"))
        await held.promise;
    };
    return () => held.resolve();
  }
  return {
    ...base,
    attemptKey,
    sessionKey,
    popup,
    stored,
    executes,
    confirmations,
    cached,
    uris,
    authenticated,
    configure,
    announce,
    settled,
    holdDelivery,
  };
}

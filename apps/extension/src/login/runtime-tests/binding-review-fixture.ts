import { afterEach, beforeEach, expect, vi } from "vitest";
import {
  createSettingsStore,
  parseLoginRecipe,
  type SavedLoginBinding,
  type SettingsSnapshot,
} from "@pateat/contracts";
import type { BindingReviewResponse } from "../binding-review-wire";
import { createRuntimeTestHarness } from "./harness";
import type { createBrowserFake } from "./browser-fake";

export function bindingReviewFixture(fake: ReturnType<typeof createBrowserFake>) {
  const base = createRuntimeTestHarness(fake);
  const { recipe, savedBinding, target, harness } = base;
  const popup = {
    id: "synthetic-extension",
    url: "chrome-extension://synthetic-extension/popup.html",
  } as never;
  const stale: SavedLoginBinding = {
    ...savedBinding,
    slots: [
      { slot: "branch", field: { custom: "Old branch" } },
      { slot: "password", field: "password" },
    ],
  };
  const repairedRecipe = parseLoginRecipe({
    ...recipe,
    slots: ["branch", "password"],
    steps: [
      {
        kind: "fill",
        path: "/signin",
        fields: [
          { slot: "branch", target: target("branch") },
          { slot: "password", target: target("password") },
        ],
      },
      recipe.steps[1],
    ],
  });
  const start = (
    options: Parameters<typeof harness>[1] = {},
    overrides: Parameters<typeof harness>[0] = {},
  ) => {
    const h = harness(structuredClone({ bindings: [stale], ...overrides }), {
      custom: [{ name: "New branch", kind: "text" }],
      ...options,
    });
    const readCatalog = h.store.handle.getMockImplementation()!;
    const store = createSettingsStore(
      {
        read: async () => structuredClone(h.settings),
        write: async (snapshot) => {
          Object.assign(h.settings, structuredClone(snapshot as SettingsSnapshot));
          await fake.browser.storage.local.set({ "binding-review.synthetic-settings": snapshot });
        },
      },
      async () => {
        const response = await readCatalog();
        if (!response.ok) throw new Error("synthetic catalog unavailable");
        return response.catalog;
      },
    );
    h.store.handle.mockImplementation(() => store.handle({ version: 1, type: "settings.get" }));
    h.store.update.mockImplementation(store.update);
    h.recipes.recipe.mockResolvedValue(repairedRecipe);
    return h;
  };
  /** The popup's first read by default; `poll` reads as its interval does. */
  const get = async (h: ReturnType<typeof start>, poll = false) =>
    (await h.login.handle(
      {
        version: 1,
        type: "login.binding-review.get",
        tabId: 1,
        ...(poll ? {} : { reconnect: true }),
      },
      popup,
    )) as BindingReviewResponse;
  const offer = async (h: ReturnType<typeof start>) => {
    expect(await h.hello()).toEqual({ ok: false, reason: "field-missing" });
    const response = await get(h);
    expect(response.repair).toBeDefined();
    return response.repair!;
  };
  const pick = (
    h: ReturnType<typeof start>,
    review: NonNullable<BindingReviewResponse["repair"]>,
    picks = review.slots.map((slot) => ({ slot: slot.slot, fieldId: slot.candidates[0]!.fieldId })),
  ) =>
    h.login.handle(
      { version: 1, type: "login.binding-review.pick", tabId: 1, reviewId: review.reviewId, picks },
      popup,
    );
  const records = () =>
    fake.state.storage["pateat.login-attempts.v5"] as
      | { id: string; state: string; outcome?: string; unconfirmed?: boolean }[]
      | undefined;
  const executes = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
  beforeEach(() => {
    vi.restoreAllMocks();
    fake.state.storage = {};
    fake.state.session = {};
    fake.state.messages = [];
    fake.state.reconnects = [];
    fake.state.onReconnect = undefined;
    fake.state.onExecute = undefined;
    fake.state.onAwait = undefined;
    fake.state.pageUrl = "https://login.example/signin";
    fake.state.observedPath = "/signin";
    fake.state.present = undefined;
    fake.state.observed = ["unique", "missing"];
    fake.state.signs = undefined;
    fake.state.tabUrls = {};
    fake.state.gone = new Set();
    fake.state.executeReply = undefined;
    fake.state.granted = true;
    fake.state.awaited = { ok: true };
    fake.state.openTabs = undefined;
  });
  afterEach(() => {
    for (const listener of fake.state.removed.splice(0)) for (const id of [1, 2]) listener(id);
  });
  return { ...base, popup, stale, repairedRecipe, start, get, offer, pick, records, executes };
}

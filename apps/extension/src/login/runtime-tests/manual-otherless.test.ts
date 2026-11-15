import * as v from "valibot";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { LoginChooserRecipe } from "@pateat/contracts";
import { manualOfferResponseSchema } from "../manual-wire";
import type { LoginGeneration } from "../runtime/deps";
import type { LiveUriMatcher } from "../../vault/site-candidates";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { createRuntimeTestHarness } = await import("./harness");
const { origin, connectionId, itemId, target, uriMatch, harness, realTime } =
  createRuntimeTestHarness(fake);
const popup = {
  id: "synthetic-extension",
  url: "chrome-extension://synthetic-extension/popup.html",
};
const other = { by: "text" as const, value: "Sign in with another profile" };
const offer = async (h: ReturnType<typeof harness>) =>
  v.parse(
    manualOfferResponseSchema,
    await h.login.handle({ version: 1, type: "login.manual.get", tabId: 1 }, popup),
  );

beforeEach(() => {
  realTime();
  fake.state.storage = {};
  fake.state.session = {};
  fake.state.badges = {};
  fake.state.reconnects = [];
  fake.state.onReconnect = undefined;
  fake.state.messages = [];
  fake.state.granted = true;
  fake.state.pageUrl = origin + "/signin";
  fake.state.onExecute = undefined;
  fake.state.tabUrls = {};
  fake.state.observed = ["unique", "missing"];
  fake.state.observedPath = "/signin";
  fake.state.present = new Set(["email", "password", "login"]);
  fake.state.unusable = new Set();
  fake.state.awaited = { ok: true };
  fake.state.onAwait = undefined;
  fake.state.executeReply = undefined;
  fake.state.gone = new Set();
  fake.state.goneFrames = new Set();
  fake.state.signs = undefined;
  fake.state.incognito = new Set();
  fake.state.extracted = {
    login: {
      ok: true,
      observation: {
        version: 1,
        origin,
        path: "/signin",
        language: "en",
        complete: true,
        candidates: [
          { id: "c1", role: "email", target: target("email"), label: "Email" },
          { id: "c2", role: "password", target: target("password"), label: "Password" },
          { id: "c3", role: "button", target: target("login"), label: "Log in" },
        ],
      },
    },
  };
  // The chooser's list never shows: the path shows its form instead.
  fake.state.awaitReply = (readiness) =>
    readiness.accounts === true ? { ok: false, reason: "timeout" } : { ok: true };
});
afterEach(() => {
  for (const listener of fake.state.removed.splice(0)) for (const tabId of [1, 2]) listener(tabId);
});

it("ends a one-time request at once for a chooser form whose chooser names no layout", async () => {
  // Only the probe build's choosers lack a layout (ADR 0060); the request must not show
  // generation until it expires.
  const layoutless: LoginChooserRecipe = {
    version: 1,
    id: "gen-synthetic-chooser",
    revision: 1,
    origin,
    chooser: { path: "/signin", other },
  };
  const generation = {
    available: vi.fn<LoginGeneration["available"]>(async () => true),
    generate: vi.fn<LoginGeneration["generate"]>(),
    generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
    judge: vi.fn<LoginGeneration["judge"]>(),
    slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
  };
  const h = harness(
    { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] },
    {
      allowedOrigins: [],
      username: true,
      custom: [],
      generation,
      uris: vi.fn<LiveUriMatcher>(async (_connection, url) => ({
        ok: true,
        data: uriMatch({ targetOrigin: new URL(url).origin }),
      })),
    },
  );
  h.recipes.recipe.mockResolvedValue(undefined);
  h.recipes.chooser.mockResolvedValue(layoutless);
  h.recipes.starts.mockResolvedValue([{ path: "/signin", steps: [], list: [other] }]);
  await h.hello({}, false);
  const offered = await offer(h);
  if (!offered.ok || !offered.targets[0]) throw new Error("No offered page");
  fake.state.onReconnect = () => h.signIn();
  await h.login.handle(
    {
      version: 1,
      type: "login.manual.start",
      requestId: "manual-request",
      document: offered.targets[0].document,
      scope: offered.targets[0].scope,
      connectionId,
      itemId,
    },
    popup,
  );
  await vi.waitFor(async () =>
    expect(await offer(h)).toMatchObject({
      status: { requestId: "manual-request", state: "blocked", reason: "not-started" },
    }),
  );
  expect(generation.generate).not.toHaveBeenCalled();
  expect(fake.state.messages.filter((entry) => entry.type === "login.execute")).toEqual([]);
});

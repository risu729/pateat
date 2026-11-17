// **Fill** from the popup on a verification page (ADR 0035, amended 2026-11-17): the
// person picks one of the page's matching accounts, its password goes into the page's
// recipe fields once, and nothing is pressed or sent to a model for a page with a recipe.
import * as v from "valibot";
import { describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LocalSettings } from "@pateat/contracts";
import { manualOfferResponseSchema } from "../manual-wire";
import type { LoginGeneration } from "../runtime/deps";
import type { LoginReport } from "../runtime/report";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { confirmationFixture } = await import("./confirmation-fixture");
const {
  harness,
  recipe,
  origin,
  itemId,
  otherItemId,
  connectionId,
  sender,
  target,
  uriMatch,
  popup,
  stored,
  executes,
  confirmations,
  cached,
  configure,
  announce,
  settled,
  liveDefault,
  shownHello,
  setPause,
} = confirmationFixture(fake);
type H = ReturnType<typeof harness>;

function generation() {
  const answer = Promise.withResolvers<Awaited<ReturnType<LoginGeneration["generate"]>>>();
  const service = {
    available: vi.fn<LoginGeneration["available"]>(async () => true),
    generate: vi.fn<LoginGeneration["generate"]>(async (_request, sent) => {
      sent?.();
      return answer.promise;
    }),
    generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
    judge: vi.fn<LoginGeneration["judge"]>(),
    slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
  };
  return { service, answer };
}

/** Both items match every page of the site. */
const both = async (_connection: string, url: string) => ({
  ok: true as const,
  data: uriMatch({
    targetOrigin: new URL(url).origin,
    candidates: [
      { itemId, matches: [{ uriIndex: 0, match: 0 }] },
      { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
    ],
  }),
});

/** A tab whose site Pateat did not log in to, with both items matching its pages. */
function start(settings: Partial<LocalSettings> = {}, live: Parameters<typeof harness>[1] = {}) {
  const reports: LoginReport[] = [];
  const h = harness(
    // Both items are eligible on the site; the default is the first.
    { siteDefaults: [liveDefault()], ...settings },
    { uris: both, ...live, report: (entry) => reports.push(entry) },
  );
  return { h, reports };
}
const offers = async (h: H) =>
  v.parse(
    manualOfferResponseSchema,
    await h.login.handle({ version: 1, type: "login.manual.get", tabId: 1 }, popup),
  );
async function press(h: H, item = otherItemId, frameId = 0, requestId = "fill-press") {
  const offered = await offers(h);
  if (!offered.ok) throw new Error("No page");
  const selected = offered.targets.find((entry) => entry.document.frameId === frameId);
  if (!selected) throw new Error(`No target in frame ${frameId}: ${JSON.stringify(offered)}`);
  return h.login.handle(
    {
      version: 1,
      type: "login.confirm.fill",
      requestId,
      document: selected.document,
      scope: selected.scope,
      connectionId,
      itemId: item,
    },
    popup,
  );
}
const clicks = () => executes().filter((entry) => entry.operation.step.kind === "click");

describe("the popup's Fill on a verification page", () => {
  it.each(["confirm", "unclear"] as const)(
    "offers Fill on a %s page and Log in now on a sign-in page",
    async (kind) => {
      const { h } = start();
      configure(h, cached(kind));
      expect(await announce(h)).toMatchObject({ ok: false, reason: "form-not-ready" });
      expect(await offers(h)).toMatchObject({
        ok: true,
        targets: [expect.objectContaining({ fill: true })],
      });
      // The sign-in page of the same site offers Log in now, as before.
      const other = start();
      other.h.recipes.recipe.mockResolvedValue(parseLoginRecipe(recipe));
      other.h.recipes.routes.mockResolvedValue([parseLoginRecipe(recipe)]);
      fake.state.tabUrls = {};
      fake.state.pageUrl = `${origin}/signin`;
      fake.state.observedPath = "/signin";
      fake.state.present = new Set();
      await other.h.hello(
        { documentId: "signin-document", tab: { id: 2, incognito: false } },
        false,
      );
      const signIn = v.parse(
        manualOfferResponseSchema,
        await other.h.login.handle({ version: 1, type: "login.manual.get", tabId: 2 }, popup),
      );
      expect(signIn.ok && signIn.targets[0]).toBeTruthy();
      expect(signIn.ok && signIn.targets[0]?.fill).toBeUndefined();
    },
  );

  it.each(["confirm", "unclear"] as const)(
    "fills the picked account on a %s page, presses nothing and asks no model",
    async (kind) => {
      const { service } = generation();
      const repairs = {
        due: vi.fn(async () => "due" as const),
        hold: vi.fn(async () => undefined),
      };
      const { h, reports } = start({}, { generation: service, repairs, username: true });
      configure(h, cached(kind));
      // The page shows the site's signed-in marker, so its log signs are read at once.
      fake.state.present = new Set(["password", "login", "authenticated"]);
      await announce(h);
      const before = structuredClone(h.settings);
      // The page answers the reconnect with its first step shown, as the content script does.
      fake.state.onReconnect = () => shownHello(h, { documentId: "confirmation-document" });
      expect(await press(h)).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
      await settled(h);
      expect(confirmations()[0]).toMatchObject({
        operation: {
          attemptId: expect.stringMatching(/^confirm:pick:/),
          signInFill: true,
          step: { kind: "fill", effect: "prepare" },
        },
      });
      // Only the picked account's password is read; the other item's username is read only
      // for the page's value-free log signs, as for every verification page.
      const passwords = h.fields.mock.calls.filter(([read]) => read.fieldId === "login.password");
      expect(passwords.map(([read]) => read.account.itemId)).toEqual([otherItemId]);
      expect(clicks()).toEqual([]);
      expect(service.generate).not.toHaveBeenCalled();
      expect(service.judge).not.toHaveBeenCalled();
      expect(repairs.due).not.toHaveBeenCalled();
      // No login record, default or binding comes of it.
      expect(stored() ?? []).toEqual([]);
      expect(h.settings).toEqual(before);
      expect(h.store.update).not.toHaveBeenCalled();
      expect(await offers(h)).toMatchObject({
        fill: { requestId: "fill-press", state: "filled" },
      });
      // The log names the person's pick as the account's source, never the account.
      await vi.waitFor(() =>
        expect(reports).toContainEqual(
          expect.objectContaining({
            type: "refused",
            reason: "not-started",
            detail: "confirm-fill",
            accountSource: "pick",
          }),
        ),
      );
      expect(JSON.stringify(reports)).not.toContain(otherItemId);
    },
  );

  it("fills once per press and again on the next press", async () => {
    const { h } = start();
    configure(h);
    await announce(h);
    fake.state.onReconnect = () => announce(h);
    await press(h, itemId, 0, "first-press");
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    // Announcing again fills nothing more for that press.
    await announce(h);
    await settled(h);
    expect(confirmations()).toHaveLength(1);
    await vi.waitFor(async () =>
      expect(await offers(h)).toMatchObject({ targets: [expect.objectContaining({ fill: true })] }),
    );
    await press(h, itemId, 0, "second-press");
    await vi.waitFor(() => expect(confirmations()).toHaveLength(2));
    await settled(h);
    expect(new Set(confirmations().map((entry) => entry.operation.attemptId)).size).toBe(2);
    expect(clicks()).toEqual([]);
  });

  it("is neither offered nor run where verification filling is off", async () => {
    const { h } = start({
      pagePermissionDefaults: { "sign-in": "auto", confirm: "off", "personal-details": "fill" },
    });
    configure(h);
    expect(await announce(h)).toMatchObject({ ok: false });
    const offered = await offers(h);
    expect(offered.ok && offered.targets[0]?.fill).toBeUndefined();
    fake.state.onReconnect = () => announce(h);
    expect(await press(h)).toEqual({ ok: false, reason: "not-a-verification-page" });
    await settled(h);
    expect(h.fields).not.toHaveBeenCalled();
    expect(confirmations()).toEqual([]);
  });

  it.each(["paused", "excluded", "private"] as const)(
    "works on a %s site, as the person's own action",
    async (pause) => {
      const { h } = start(
        pause === "excluded"
          ? { excludedSites: [{ hostname: "login.example", includeSubdomains: false }] }
          : pause === "private"
            ? ({ loginInPrivateWindows: undefined } as Parameters<typeof harness>[0])
            : {},
      );
      configure(h);
      if (pause === "paused") expect(await setPause(h, true)).toMatchObject({ ok: true });
      const from = pause === "private" ? { tab: { id: 1, incognito: true } } : {};
      if (pause === "private") fake.state.incognito = new Set([1]);
      await announce(h, from);
      fake.state.onReconnect = () => announce(h, from);
      expect(await press(h)).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
      await settled(h);
      expect(clicks()).toEqual([]);
      // The site's sign-in page still starts no login of its own.
      h.recipes.recipe.mockResolvedValue(parseLoginRecipe(recipe));
      h.recipes.routes.mockResolvedValue([parseLoginRecipe(recipe)]);
      fake.state.pageUrl = `${origin}/signin`;
      fake.state.observedPath = "/signin";
      fake.state.tabUrls = {};
      expect(await h.hello({ documentId: "signin-document", ...from })).toMatchObject({
        ok: false,
      });
      expect(stored() ?? []).toEqual([]);
    },
  );

  it("refuses an account that does not match the page", async () => {
    const { h } = start(
      {},
      {
        uris: async (_connection, url) => ({
          ok: true,
          data: uriMatch({ targetOrigin: new URL(url).origin }),
        }),
      },
    );
    configure(h);
    await announce(h);
    fake.state.onReconnect = () => announce(h);
    expect(await press(h, "not-an-item")).toEqual({ ok: false, reason: "not-a-candidate" });
    expect(h.fields).not.toHaveBeenCalled();
    expect(confirmations()).toEqual([]);
  });

  it.each(["matched", "top-not-matched"] as const)(
    "fills a frame only with an account that matches its top page (%s)",
    async (scenario) => {
      const portal = `${origin}/portal`;
      const { h } = start(
        {},
        {
          uris: async (_connection, url) => ({
            ok: true,
            data: uriMatch({
              targetOrigin: new URL(url).origin,
              candidates:
                scenario === "top-not-matched" && new URL(url).pathname === "/portal"
                  ? []
                  : [
                      { itemId, matches: [{ uriIndex: 0, match: 0 }] },
                      { itemId: otherItemId, matches: [{ uriIndex: 0, match: 0 }] },
                    ],
            }),
          }),
        },
      );
      if (scenario === "top-not-matched") {
        const originalHandle = h.store.handle.getMockImplementation()!;
        h.store.handle.mockImplementation(async () => {
          const response = await originalHandle();
          if (response.ok)
            for (const item of response.catalog.connections[0]!.items) item.allowedOrigins = [];
          return response;
        });
      }
      fake.state.pageUrl = portal;
      fake.state.tabUrls[1] = portal;
      await h.hello({ documentId: "portal-top", url: portal }, false);
      configure(h);
      fake.state.pageUrl = portal;
      fake.state.observedPath = "/confirm";
      const frame = {
        frameId: 3,
        documentId: "confirm-frame",
        url: `${origin}/confirm`,
        tab: { id: 1, incognito: false, url: portal },
      };
      await announce(h, frame);
      fake.state.onReconnect = () => announce(h, frame);
      const offered = await offers(h);
      const framed = offered.ok && offered.targets.find((entry) => entry.document.frameId === 3);
      if (scenario === "top-not-matched") {
        // The frame's account does not match the top page: the frame is not offered, and a
        // press is refused before any vault read.
        expect(framed).toBeFalsy();
        expect(h.fields).not.toHaveBeenCalled();
        return;
      }
      expect(framed).toMatchObject({ fill: true });
      expect(await press(h, otherItemId, 3)).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
      await settled(h);
      expect(confirmations()[0]!.operation.document).toMatchObject({
        frameId: 3,
        documentId: "confirm-frame",
      });
      expect(clicks()).toEqual([]);
    },
  );

  it("opens the master password window of a re-prompt item, and fills once it is verified", async () => {
    const answers: PromiseWithResolvers<"verified" | "closed" | "unavailable">[] = [];
    const ask = vi.fn(async () => {
      const answer = Promise.withResolvers<"verified" | "closed" | "unavailable">();
      answers.push(answer);
      return answer.promise;
    });
    const { h } = start(
      { repromptSites: [{ hostname: "login.example", includeSubdomains: false }] },
      { askMasterPassword: ask, reprompt: true, otherReprompt: true },
    );
    configure(h);
    await announce(h);
    fake.state.onReconnect = () => announce(h);
    expect(await press(h)).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(ask).toHaveBeenCalledTimes(1));
    await settled(h);
    expect(h.fields).not.toHaveBeenCalled();
    expect(await offers(h)).toMatchObject({ targets: [], fill: { state: "asked" } });
    answers[0]!.resolve("verified");
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    expect(ask).toHaveBeenCalledTimes(1);
    expect(await offers(h)).toMatchObject({ fill: { state: "filled" } });
  });

  it("ends the press when its master password window is closed", async () => {
    const ask = vi.fn(async () => "closed" as const);
    const { h } = start(
      { repromptSites: [{ hostname: "login.example", includeSubdomains: false }] },
      { askMasterPassword: ask, reprompt: true, otherReprompt: true },
    );
    configure(h);
    await announce(h);
    fake.state.onReconnect = () => announce(h);
    await press(h);
    await vi.waitFor(async () =>
      expect(await offers(h)).toMatchObject({ fill: { state: "blocked", reason: "closed" } }),
    );
    expect(h.fields).not.toHaveBeenCalled();
    expect(confirmations()).toEqual([]);
  });
});

describe("Fill on a page without a recipe", () => {
  /** A secret-answer page without a recipe, as the content script reports one. */
  function secretAnswer(h: H) {
    h.recipes.recipe.mockResolvedValue(undefined);
    h.recipes.routes.mockResolvedValue([]);
    h.recipes.starts.mockResolvedValue([]);
    fake.state.pageUrl = `${origin}/confirm`;
    fake.state.observedPath = "/confirm";
    fake.state.present = new Set(["password", "login"]);
    fake.state.extracted["login"] = {
      ok: true,
      observation: {
        version: 1,
        origin,
        path: "/confirm",
        language: "en",
        complete: true,
        candidates: [
          { id: "password", role: "password", target: target("password") },
          { id: "login", role: "button", target: target("login"), label: "Confirm" },
        ],
      },
    };
    return (from: Record<string, unknown> = {}) =>
      h.login.handle(
        {
          version: 1,
          type: "login.document.ready",
          token: "synthetic-token",
          unoffered: { path: "/confirm", why: "text-answer" },
        },
        sender({ documentId: "confirmation-document", ...from }),
      );
  }

  it.each(["confirm", "sign-in"] as const)(
    "sends the page once and fills only a %s result as a verification",
    async (kind) => {
      const { service, answer } = generation();
      const { h } = start({}, { generation: service, custom: [] });
      const unoffered = secretAnswer(h);
      await unoffered();
      expect(service.generate).not.toHaveBeenCalled();
      expect(await offers(h)).toMatchObject({
        targets: [expect.objectContaining({ fill: true })],
      });
      fake.state.onReconnect = () => announce(h);
      expect(await press(h)).toMatchObject({ ok: true, state: "generating" });
      await vi.waitFor(() => expect(service.generate).toHaveBeenCalledTimes(1));
      expect(service.generate.mock.calls[0]![0].manual).toBeUndefined();
      expect(h.fields).not.toHaveBeenCalled();
      const generated = parseLoginRecipe({ ...cached(), pageKind: kind });
      h.recipes.routes.mockResolvedValue([generated]);
      if (kind !== "sign-in") h.recipes.recipe.mockResolvedValue(generated);
      answer.resolve({ outcome: "recipe", recipe: generated });
      if (kind === "confirm") {
        await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
        await settled(h);
        expect(clicks()).toEqual([]);
        expect(await offers(h)).toMatchObject({ fill: { state: "filled" } });
      } else {
        await vi.waitFor(async () =>
          expect(await offers(h)).toMatchObject({
            fill: { state: "blocked", reason: "not-a-verification-page" },
          }),
        );
        expect(confirmations()).toEqual([]);
      }
      expect(service.generate).toHaveBeenCalledTimes(1);
    },
  );

  it("is not offered on a plain sign-in form without a recipe", async () => {
    const { service } = generation();
    const { h } = start({}, { generation: service, custom: [] });
    secretAnswer(h);
    service.available.mockResolvedValue("sent");
    await h.signIn();
    const offered = await offers(h);
    expect(offered.ok && offered.targets[0]?.fill).toBeUndefined();
  });
});

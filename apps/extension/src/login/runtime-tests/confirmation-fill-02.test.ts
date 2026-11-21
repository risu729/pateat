// Confirmation filling (ADR 0035 delivery 3) across in-page routes, policy changes, vault
// replacement, storage failures, claims of pages a tab left and a replaced tab.
import { describe, expect, it, vi } from "vitest";
import { parseLoginRecipe, type LoginOperation } from "@pateat/contracts";
import type { LoginGeneration } from "../runtime/deps";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { confirmationFixture } = await import("./confirmation-fixture");
const {
  harness,
  origin,
  itemId,
  sender,
  sessionKey,
  shownHello,
  setPause,
  stored,
  confirmations,
  uris,
  authenticated,
  configure,
  announce,
  settled,
  holdDelivery,
  executes,
  cached,
  recipe,
  startsOf,
} = confirmationFixture(fake);

const authorize = (operation: LoginOperation) => ({
  version: 1,
  type: "login.operation.authorize",
  token: "synthetic-token",
  attemptId: operation.attemptId,
  operationId: operation.operationId,
});
const cancels = () => fake.state.messages.filter((entry) => entry.type === "login.cancel");

describe("confirmation documents that change in place", () => {
  it("authorizes a single-page route's verification whose sender keeps its load URL", async () => {
    const { h } = await authenticated();
    configure(h);
    // The document loaded at /landing and moved in place to /confirm: Chrome keeps the load
    // URL in `sender.url`, while the tab's URL is the current one.
    fake.state.pageUrl = `${origin}/landing`;
    fake.state.tabUrls = { 1: `${origin}/confirm` };
    const release = holdDelivery();
    expect(await announce(h, { url: `${origin}/landing` })).toMatchObject({
      reason: "confirm-fill",
    });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    const answer = await h.login.handle(
      authorize(confirmations()[0]!.operation),
      sender({ documentId: "confirmation-document", url: `${origin}/landing` }),
    );
    release();
    expect(answer).toBe(true);
    await settled(h);
  });

  it("stops only the background's work when the document moves in place, and keeps its content script", async () => {
    const { h, original } = await authenticated();
    configure(h);
    const release = holdDelivery();
    expect(await announce(h)).toMatchObject({ reason: "confirm-fill" });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    const operation = confirmations()[0]!.operation;
    // A repeat announcement keeps the work and still has the page watch the starts.
    expect(await announce(h)).toMatchObject({
      reason: "confirm-fill",
      starts: [expect.objectContaining({ path: "/signin" })],
    });
    expect(await h.login.active()).toBe(true);
    const before = cancels().length;
    // The same document moves in place to another route and announces it.
    fake.state.pageUrl = `${origin}/after`;
    fake.state.observedPath = "/after";
    const moved = await announce(h, { url: `${origin}/after` });
    expect(moved).not.toMatchObject({ reason: "confirm-fill" });
    expect(cancels()).toHaveLength(before);
    expect(await h.login.active()).toBe(false);
    // The delivered operation is no longer authorized, so its fill changes no field.
    expect(
      await h.login.handle(authorize(operation), sender({ documentId: "confirmation-document" })),
    ).not.toBe(true);
    release();
    await settled(h);
    expect(confirmations()).toHaveLength(1);
    expect(stored()).toEqual(original);
  });

  it("stops the work without disabling the content script when settings change", async () => {
    const { h } = await authenticated();
    configure(h);
    const release = holdDelivery();
    await announce(h);
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    const operation = confirmations()[0]!.operation;
    const before = cancels().length;
    h.login.settingsChanged("saved");
    expect(cancels()).toHaveLength(before);
    expect(await h.login.active()).toBe(false);
    expect(
      await h.login.handle(authorize(operation), sender({ documentId: "confirmation-document" })),
    ).not.toBe(true);
    release();
    await settled(h);
  });
});

describe("policy and vault changes during confirmation work", () => {
  it.each(["pause", "private-window", "vault-replaced"] as const)(
    "delivers nothing after a %s while a value is read",
    async (change) => {
      const incognito = change === "private-window";
      if (incognito) fake.state.incognito = new Set([1]);
      const tab = { tab: { id: 1, incognito } };
      const { h, original } = await authenticated({ username: true }, tab);
      configure(h);
      const held = Promise.withResolvers<string>();
      // The username is read after the password, mid-fill.
      h.fields.mockImplementation(async ({ fieldId }) =>
        fieldId === "login.username" ? held.promise : "synthetic-secret",
      );
      await announce(h, tab);
      await vi.waitFor(() => expect(h.fields).toHaveBeenCalledTimes(2));
      if (change === "pause") await setPause(h, true);
      if (change === "private-window") delete h.settings.settings.loginInPrivateWindows;
      if (change === "vault-replaced") h.snapshot.current = "60000000-0000-4000-8000-000000000002";
      held.resolve("synthetic-user@example.test");
      await settled(h);
      expect(confirmations()).toEqual([]);
      expect(stored()).toEqual(original);
    },
  );
});

describe("a framed login's own document", () => {
  it("stays a duplicate on every announcement once confirmation handling declines it", async () => {
    fake.state.tabUrls[1] = `${origin}/portal`;
    const frame = {
      frameId: 3,
      documentId: "login-frame",
      url: `${origin}/signin`,
      tab: { id: 1, incognito: false, url: `${origin}/portal` },
    };
    const top = { documentId: "top-document", url: `${origin}/portal` };
    const { h } = await authenticated({}, frame);
    expect(stored()[0]!.document).toMatchObject({ frameId: 3, documentId: "login-frame" });
    fake.state.pageUrl = `${origin}/portal`;
    await h.hello(top, false);
    fake.state.pageUrl = `${origin}/signin`;
    for (let repeat = 0; repeat < 3; repeat += 1)
      // oxlint-disable-next-line no-await-in-loop -- each announcement follows the last
      expect(await h.hello(frame, false)).toEqual({ ok: false, reason: "duplicate-document" });
  });
});

describe("the confirmed login's own transition", () => {
  it("goes on when its proof cannot be written, and confirmation filling refuses", async () => {
    const h = harness({}, { uris });
    const write = fake.browser.storage.session.set;
    const failing = vi
      .spyOn(fake.browser.storage.session, "set")
      .mockImplementation(async (values: Record<string, unknown>) => {
        if (sessionKey in values) throw new Error("quota");
        return write(values);
      });
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as LoginOperation).step.kind === "click")
        fake.state.present = new Set(["authenticated"]);
    };
    expect(await h.hello()).toEqual({ ok: true });
    await vi.waitFor(() => expect(stored()[0]).toMatchObject({ state: "authenticated" }));
    await vi.waitFor(() =>
      expect(
        fake.state.messages.filter(
          (entry) =>
            entry.type === "login.status" &&
            (entry as Record<string, unknown>)["state"] === "authenticated",
        ),
      ).not.toEqual([]),
    );
    await settled(h);
    failing.mockRestore();
    fake.state.onExecute = undefined;
    h.fields.mockClear();
    configure(h);
    await announce(h);
    await settled(h);
    expect(h.fields).not.toHaveBeenCalled();
    expect(confirmations()).toEqual([]);
  });
});

describe("evaluation rows of a confirmation page", () => {
  // The page shows the recipes' signed-in marker (E1), so its signs are read at once.
  const signedIn = () => (fake.state.present = new Set(["password", "login", "authenticated"]));
  it("logs a stopped fill's rows once each, with the page's fields, when it reports shown", async () => {
    const { h, reports } = await authenticated();
    configure(h);
    signedIn();
    h.fields.mockResolvedValue(undefined as unknown as string);
    expect(await announce(h)).toMatchObject({
      reason: "confirm-fill",
      starts: [expect.objectContaining({ path: "/signin" })],
    });
    await settled(h);
    const rows = () => reports.filter((entry) => entry.type === "refused");
    expect(rows()).toEqual([]);
    await shownHello(h, { documentId: "confirmation-document" });
    await shownHello(h, { documentId: "confirmation-document" });
    await settled(h);
    await vi.waitFor(() =>
      expect(rows()).toEqual([
        expect.objectContaining({
          detail: "confirm-fill",
          recipeId: "synthetic-confirm",
          pageKind: "confirm",
          previousUrl: `${origin}/signin`,
        }),
        expect.objectContaining({
          detail: "confirm-fill-stopped",
          recipeId: "synthetic-confirm",
          pageKind: "confirm",
          previousUrl: `${origin}/signin`,
        }),
      ]),
    );
    expect(confirmations()).toEqual([]);
  });

  it("logs a filled page and its end once, and never fills or logs it again later", async () => {
    const { h, reports } = await authenticated();
    configure(h);
    signedIn();
    await announce(h);
    await shownHello(h, { documentId: "confirmation-document" });
    await settled(h);
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await announce(h);
    await shownHello(h, { documentId: "confirmation-document" });
    await settled(h);
    expect(confirmations()).toHaveLength(1);
    expect(h.fields).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(reports.filter((entry) => entry.type === "refused")).toEqual([
        expect.objectContaining({ detail: "confirm-fill", recipeId: "synthetic-confirm" }),
        expect.objectContaining({
          detail: "confirm-filled",
          recipeId: "synthetic-confirm",
          pageKind: "confirm",
          accountSource: "login",
        }),
      ]),
    );
  });
  it("logs a fill's end only in the visit it ended in, not when the page comes back", async () => {
    const { h, reports } = await authenticated();
    configure(h);
    signedIn();
    await announce(h);
    await shownHello(h, { documentId: "confirmation-document" });
    await settled(h);
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    const ends = () =>
      reports.filter(
        (entry) =>
          entry.type === "refused" && (entry as { detail?: string }).detail === "confirm-filled",
      );
    await vi.waitFor(() => expect(ends()).toHaveLength(1));
    // The same document moves in place to another route and back to the verification.
    fake.state.pageUrl = `${origin}/after`;
    fake.state.observedPath = "/after";
    await announce(h, { url: `${origin}/after` });
    fake.state.pageUrl = `${origin}/confirm`;
    fake.state.observedPath = "/confirm";
    await announce(h);
    await shownHello(h, { documentId: "confirmation-document" });
    await settled(h);
    await vi.waitFor(() =>
      expect(
        reports.filter(
          (entry) =>
            entry.type === "refused" && (entry as { detail?: string }).detail === "confirm-fill",
        ),
      ).toHaveLength(2),
    );
    expect(confirmations()).toHaveLength(1);
    expect(ends()).toHaveLength(1);
  });
});

describe("confirmation claims and proofs over a tab's life", () => {
  const claims = () => (fake.state.session[sessionKey] as { claims: unknown[] }).claims;
  const proofs = () => (fake.state.session[sessionKey] as { proofs: { tabId: number }[] }).proofs;

  it("drops the claims of a page the tab left", async () => {
    const { h } = await authenticated();
    configure(h);
    await announce(h);
    await settled(h);
    expect(claims()).toHaveLength(1);
    fake.state.pageUrl = `${origin}/home`;
    fake.state.observedPath = "/home";
    await h.hello({ documentId: "next-document" }, false);
    await vi.waitFor(() => expect(claims()).toEqual([]));
    expect(proofs()).toHaveLength(1);
  });

  it("keeps a frame's claim when the frame announced before its page's top document", async () => {
    const h = harness({}, { uris });
    const portal = `${origin}/portal`;
    fake.state.pageUrl = portal;
    fake.state.tabUrls[1] = portal;
    await h.hello({ documentId: "portal-top", url: portal }, false);
    fake.state.observedPath = "/signin";
    fake.state.onExecute = async (message) => {
      if ((message["operation"] as LoginOperation).step.kind === "click")
        fake.state.present = new Set(["authenticated"]);
    };
    const frame = {
      frameId: 3,
      documentId: "authentication-frame",
      url: `${origin}/signin`,
      tab: { id: 1, incognito: false, url: portal },
    };
    expect(await h.hello(frame)).toEqual({ ok: true });
    await vi.waitFor(() => expect(proofs()).toHaveLength(1));
    await settled(h);
    fake.state.onExecute = undefined;
    // A restarted worker knows no document of the tab yet, and the frame announces first.
    fake.state.openTabs = [1];
    const next = harness({}, { uris });
    configure(next);
    fake.state.pageUrl = portal;
    const confirmation = { ...frame, documentId: "confirmation-frame", url: `${origin}/confirm` };
    await announce(next, confirmation);
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(next);
    await vi.waitFor(() => expect(claims()).toHaveLength(1));
    fake.state.observedPath = "/portal";
    await next.hello({ documentId: "portal-top", url: portal }, false);
    await vi.waitFor(() =>
      expect(claims()).toEqual([expect.objectContaining({ top: "portal-top" })]),
    );
    // Even in a worker restarted again, the frame's fill is never delivered again.
    const again = harness({}, { uris });
    configure(again);
    fake.state.pageUrl = portal;
    fake.state.observedPath = "/portal";
    await again.hello({ documentId: "portal-top", url: portal }, false);
    fake.state.observedPath = "/confirm";
    await announce(again, confirmation);
    await settled(again);
    expect(confirmations()).toHaveLength(1);
    expect(claims()).toHaveLength(1);
  });

  it("refuses a confirmation once its tab holds as many claims as one tab may", async () => {
    await authenticated();
    const record = stored()[0]!;
    const session = fake.state.session[sessionKey] as { claims: unknown[] };
    session.claims = Array.from({ length: 64 }, (_, i) => ({
      key: `claimed-${i}`,
      tabId: 1,
      document: { ...record.document, documentId: "confirmation-document" },
      top: "confirmation-document",
    }));
    fake.state.openTabs = [1];
    const next = harness({}, { uris });
    configure(next);
    await announce(next);
    await settled(next);
    expect(next.fields).not.toHaveBeenCalled();
    expect(confirmations()).toEqual([]);
  });

  it("drops the proof of a released login", async () => {
    const { h, original } = await authenticated();
    expect(proofs()).toHaveLength(1);
    // The sign-in form shows again on a new page, as after a logout: the record is
    // released and the tab logs in again (ADR 0062), a login that is not confirmed yet.
    fake.state.present = new Set(["password", "login"]);
    await h.hello({ documentId: "signed-out-document" });
    await vi.waitFor(() => expect(stored()[0]!.id).not.toBe(original[0]!.id));
    await vi.waitFor(() => expect(proofs()).toEqual([]));
  });

  it("moves the proof with the login when Chrome replaces the tab", async () => {
    const { h } = await authenticated();
    for (const listener of fake.state.replaced) listener(2, 1);
    await vi.waitFor(() => expect(proofs()).toEqual([expect.objectContaining({ tabId: 2 })]));
    await vi.waitFor(() =>
      expect(stored()).toEqual([
        expect.objectContaining({ document: expect.objectContaining({ tabId: 2 }) }),
      ]),
    );
    configure(h);
    await announce(h, { tab: { id: 2, incognito: false } });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    expect(h.fields.mock.calls.every(([read]) => read.account.itemId === itemId)).toBe(true);
  });
});

// The document announces a sign-in input only after an answer with `generate` (the
// content script's offer window), so the authenticated record's own answer must offer it:
// a password asked again on a path without a recipe, in the tab of the confirmed login
// (#1714, 2026-11-18), was otherwise never classified and never offered Fill.
describe("classifying a verification page of the authenticated tab", () => {
  const unclassified = (h: ReturnType<typeof harness>) => {
    h.recipes.recipe.mockResolvedValue(undefined);
    h.recipes.routes.mockResolvedValue([]);
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
          { id: "password", role: "password", target: { by: "id", value: "password" } },
          { id: "login", role: "button", target: { by: "id", value: "login" }, label: "Confirm" },
        ],
      },
    };
  };
  const signIn = (h: ReturnType<typeof harness>) =>
    h.login.handle(
      {
        version: 1,
        type: "login.document.ready",
        token: "synthetic-token",
        signIn: { path: "/confirm" },
      },
      sender({ documentId: "reconfirm" }),
    );
  function service() {
    const answer = Promise.withResolvers<Awaited<ReturnType<LoginGeneration["generate"]>>>();
    const generation = {
      available: vi.fn<LoginGeneration["available"]>(async () => true),
      generate: vi.fn<LoginGeneration["generate"]>(async (_request, sent) => {
        sent?.();
        return answer.promise;
      }),
      generateEntry: vi.fn<LoginGeneration["generateEntry"]>(),
      judge: vi.fn<LoginGeneration["judge"]>(),
      slotFields: vi.fn<LoginGeneration["slotFields"]>(async () => undefined),
    };
    return { generation, answer };
  }
  const offered = (answer: unknown) =>
    expect(answer).toMatchObject({ ok: false, reason: "logged-in", generate: true });
  const notOffered = (answer: unknown) => {
    expect(answer).toMatchObject({ ok: false });
    expect(answer).not.toHaveProperty("generate");
  };

  it.each([
    { outcome: "abstained", reason: "no-login-form" },
    { outcome: "recipe", kind: "sign-in" },
  ] as const)(
    "offers the page once from the login's answer, whatever its classification ($outcome)",
    async (result) => {
      const { generation, answer } = service();
      const { h, original } = await authenticated({ username: true, custom: [], generation });
      const clicks = () => executes().filter((entry) => entry.operation.step.kind === "click");
      const pressed = clicks().length;
      unclassified(h);
      offered(await h.hello({ documentId: "reconfirm" }, false));
      expect(await signIn(h)).toMatchObject({ ok: false, reason: "generating" });
      await vi.waitFor(() => expect(generation.generate).toHaveBeenCalledTimes(1));
      if (result.outcome === "abstained") answer.resolve(result);
      else {
        const signInPage = parseLoginRecipe({ ...cached(), pageKind: result.kind });
        answer.resolve({ outcome: "recipe", recipe: signInPage });
      }
      await settled(h);
      // The classification's claim holds the document and path, so the login's answer
      // there no longer offers it, and nothing logs in.
      notOffered(await h.hello({ documentId: "reconfirm" }, false));
      expect(generation.generate).toHaveBeenCalledTimes(1);
      expect(stored()).toEqual(original);
      expect(confirmations()).toEqual([]);
      expect(clicks()).toHaveLength(pressed);
    },
  );

  it.each(["unconfirmed", "paused", "not-available", "sign-in-start", "confirm-recipe"] as const)(
    "offers nothing for a %s page",
    async (reason) => {
      const { generation } = service();
      const { h } = await authenticated({ username: true, custom: [], generation });
      const record = stored()[0]!;
      let next = h;
      if (reason === "unconfirmed") {
        record.unconfirmed = true;
        fake.state.openTabs = [1];
        next = harness({}, { uris, username: true, custom: [], generation });
      }
      if (reason === "paused") await setPause(h, true);
      if (reason === "not-available") generation.available.mockResolvedValue("sent");
      unclassified(next);
      // A sign-in recipe starts on the path, though its first step does not show now.
      if (reason === "sign-in-start")
        next.recipes.starts.mockResolvedValue(
          startsOf([{ ...recipe.steps[0]!, path: "/confirm" }]),
        );
      if (reason === "confirm-recipe") configure(next);
      notOffered(await next.hello({ documentId: "reconfirm" }, false));
      await settled(next);
      expect(generation.generate).not.toHaveBeenCalled();
    },
  );

  it("offers no SSO before it classifies the page, for an item with a password and SSO", async () => {
    const { generation } = service();
    // The item has an `SSO` field beside its password (ADR 0085); no method is described
    // for the login itself, so that signs in with the password.
    const sso = {
      describe: vi.fn(async () => ({
        ok: true as const,
        data: { sourceEvidence: "E".repeat(43), policyRevision: 1, methods: [] },
      })),
      candidates: vi.fn(),
      validate: vi.fn(),
    };
    const { h } = await authenticated({
      username: true,
      custom: [{ name: "SSO", kind: "text" }],
      generation,
      sso: sso as never,
    });
    sso.describe.mockClear();
    unclassified(h);
    offered(await h.hello({ documentId: "reconfirm" }, false));
    expect(await signIn(h)).toMatchObject({ ok: false, reason: "generating" });
    await vi.waitFor(() => expect(generation.generate).toHaveBeenCalledTimes(1));
    expect(sso.describe).not.toHaveBeenCalled();
  });
});

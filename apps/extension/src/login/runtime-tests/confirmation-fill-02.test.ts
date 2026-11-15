// Confirmation filling (ADR 0035 delivery 3) across in-page routes, policy changes, vault
// replacement, storage failures, claims of pages a tab left and a replaced tab.
import { describe, expect, it, vi } from "vitest";
import { type LoginOperation } from "@pateat/contracts";
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

  it("logs a filled page once, and never fills or logs it again on a later announcement", async () => {
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
      ]),
    );
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

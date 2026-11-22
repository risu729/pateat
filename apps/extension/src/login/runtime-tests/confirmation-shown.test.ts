// A verification page in a tab without Pateat's login (ADR 0035, amended 2026-11-22): it
// is filled automatically only when it shows the username of exactly one of its matching
// accounts, never for an item that asks for the master password, and nothing is pressed.
import { describe, expect, it, vi } from "vitest";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.stubEnv("MODE", "production");
const { pickFixture } = await import("./confirmation-pick-fixture");
const {
  otherItemId,
  connectionId,
  popup,
  confirmations,
  cached,
  configure,
  announce,
  settled,
  shownHello,
  start,
  offers,
  clicks,
  both,
} = pickFixture(fake);

type H = ReturnType<typeof start>["h"];
type Live = Parameters<typeof start>[1];
const listed = { repromptSites: [{ hostname: "login.example", includeSubdomains: false }] };

/** The page announces its form, then reports its first step shown, as the content script does. */
async function announceShown(h: H) {
  await announce(h);
  await shownHello(h, { documentId: "confirmation-document" });
}

/** Each item's username, and the one the page shows in its header, if any. */
function page(
  usernames: { first: string; other: string; shown?: string },
  live: Live = {},
  settings: Parameters<typeof start>[0] = {},
) {
  const { h, reports } = start(settings, { username: true, otherUsername: true, ...live });
  h.fields.mockImplementation(async (read) =>
    read.fieldId === "login.username"
      ? read.account.itemId === otherItemId
        ? usernames.other
        : usernames.first
      : "synthetic-secret",
  );
  fake.state.signs = (message) => ({
    password: true,
    code: false,
    captcha: false,
    invalid: false,
    alert: false,
    username:
      usernames.shown !== undefined &&
      (message["account"] as { username?: string } | undefined)?.username === usernames.shown,
  });
  configure(h, cached());
  // A new login's lookup takes only recipes that run a login, as the recipe cache's does.
  h.recipes.recipe.mockResolvedValue(undefined);
  // The page shows the site's signed-in marker, so its log signs are read at once.
  fake.state.present = new Set(["password", "login", "authenticated"]);
  // The document announces again when asked, as the content script does.
  fake.state.onReconnect = () => announceShown(h);
  return { h, reports };
}

const passwordReads = (h: H) =>
  h.fields.mock.calls
    .filter(([read]) => read.fieldId === "login.password")
    .map(([read]) => read.account.itemId);
/** How many usernames were sent to the page for its comparison, E2's and the lookup's. */
const compared = () =>
  fake.state.messages.filter(
    (entry) => entry.type === "login.state" && (entry as { account?: unknown }).account,
  ).length;

/** Waits until the page compared `count` usernames and the lookup acted on its last answer. */
async function looked(h: H, count: number) {
  await vi.waitFor(() => expect(compared()).toBeGreaterThanOrEqual(count));
  await settled(h);
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("a verification page that shows one matching account's username", () => {
  it("fills that account's password once, pressing nothing", async () => {
    const { h, reports } = page({ first: "first-user", other: "other-user", shown: "other-user" });
    await announceShown(h);
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    await settled(h);
    expect(confirmations()[0]).toMatchObject({
      operation: {
        attemptId: "confirm:shown",
        signInFill: true,
        step: { kind: "fill", effect: "prepare" },
      },
    });
    expect(passwordReads(h)).toEqual([otherItemId]);
    expect(clicks()).toEqual([]);
    await vi.waitFor(() =>
      expect(reports).toContainEqual(
        expect.objectContaining({ detail: "confirm-filled", accountSource: "shown" }),
      ),
    );
    expect(JSON.stringify(reports)).not.toContain(otherItemId);
    // Another announcement of the same page fills nothing again, and is no unsupported page.
    await announceShown(h);
    await settled(h);
    expect(confirmations()).toHaveLength(1);
    expect(reports).not.toContainEqual(expect.objectContaining({ detail: "confirm-unsupported" }));
  });

  it("still fills when the page reports its step shown while the vault is read", async () => {
    const { h } = page({ first: "first-user", other: "other-user", shown: "other-user" });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = h.fields.getMockImplementation()!;
    h.fields.mockImplementationOnce(async (...args) => {
      await held;
      return read(...args);
    });
    await announce(h);
    await vi.waitFor(() => expect(h.fields).toHaveBeenCalled());
    // The page's own report arrives as a new announcement of the same document.
    await shownHello(h, { documentId: "confirmation-document" });
    release();
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    expect(passwordReads(h)).toEqual([otherItemId]);
  });

  it.each([
    ["shows no username", { first: "first-user", other: "other-user" }, 4],
    ["shows a username both accounts hold", { first: "same", other: "same", shown: "same" }, 3],
  ] as const)("fills nothing when the page %s", async (_name, usernames, count) => {
    const { h } = page(usernames);
    await announceShown(h);
    await looked(h, count);
    expect(fake.state.messages.filter((entry) => entry.type === "login.reconnect")).toEqual([]);
    expect(confirmations()).toEqual([]);
    expect(passwordReads(h)).toEqual([]);
    // The popup still offers **Fill**.
    expect(await offers(h)).toMatchObject({
      ok: true,
      targets: [expect.objectContaining({ fill: true })],
    });
  });

  it.each([
    ["its username", { first: "first-user", other: "other-user", shown: "first-user" }, 3],
    ["a username another item holds too", { first: "same", other: "same", shown: "same" }, 3],
  ] as const)(
    "never fills when an item asking for the master password shows %s",
    async (_name, usernames, count) => {
      const askMasterPassword = vi.fn();
      const { h } = page(usernames, { reprompt: true, askMasterPassword }, listed);
      await announceShown(h);
      await looked(h, count);
      expect(fake.state.messages.filter((entry) => entry.type === "login.reconnect")).toEqual([]);
      expect(confirmations()).toEqual([]);
      expect(passwordReads(h)).toEqual([]);
      expect(askMasterPassword).not.toHaveBeenCalled();
    },
  );

  it("fills an item without the re-prompt beside one that has it", async () => {
    const askMasterPassword = vi.fn();
    const { h } = page(
      { first: "first-user", other: "other-user", shown: "other-user" },
      { reprompt: true, askMasterPassword },
      listed,
    );
    await announceShown(h);
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    expect(passwordReads(h)).toEqual([otherItemId]);
    expect(askMasterPassword).not.toHaveBeenCalled();
  });

  it("lets a Fill press go ahead when the account is found while it is checked", async () => {
    let gate: Promise<void> | undefined;
    const entered = vi.fn();
    const uris: typeof both = async (connection, url) => {
      if (gate) {
        entered();
        await gate;
      }
      return both(connection, url);
    };
    const { h } = page({ first: "first-user", other: "other-user", shown: "other-user" }, { uris });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = h.fields.getMockImplementation()!;
    h.fields.mockImplementationOnce(async (...args) => {
      await held;
      return read(...args);
    });
    await announceShown(h);
    await vi.waitFor(() => expect(h.fields).toHaveBeenCalled());
    const offered = await offers(h);
    if (!offered.ok) throw new Error("No page");
    const [selected] = offered.targets;
    let open!: () => void;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const pressed = h.login.handle(
      {
        version: 1,
        type: "login.confirm.fill",
        requestId: "fill-press",
        document: selected!.document,
        scope: selected!.scope,
        connectionId,
        itemId: otherItemId,
      },
      popup,
    );
    // The lookup finds the account while the press is checked, and leaves the page alone.
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    release();
    await looked(h, 2);
    expect(fake.state.messages.filter((entry) => entry.type === "login.reconnect")).toEqual([]);
    expect(confirmations()).toEqual([]);
    gate = undefined;
    open();
    expect(await pressed).toMatchObject({ ok: true });
    await vi.waitFor(() =>
      expect(confirmations().map((entry) => entry.operation.attemptId)).toEqual([
        expect.stringMatching(/^confirm:pick:/),
      ]),
    );
  });

  it("fills after all when a press checked during the lookup is refused", async () => {
    let gate: Promise<void> | undefined;
    const entered = vi.fn();
    const uris: typeof both = async (connection, url) => {
      if (gate) {
        entered();
        await gate;
      }
      return both(connection, url);
    };
    const { h } = page({ first: "first-user", other: "other-user", shown: "other-user" }, { uris });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const read = h.fields.getMockImplementation()!;
    h.fields.mockImplementationOnce(async (...args) => {
      await held;
      return read(...args);
    });
    await announceShown(h);
    await vi.waitFor(() => expect(h.fields).toHaveBeenCalled());
    const offered = await offers(h);
    if (!offered.ok) throw new Error("No page");
    const [selected] = offered.targets;
    let open!: () => void;
    gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const pressed = h.login.handle(
      {
        version: 1,
        type: "login.confirm.fill",
        requestId: "stale-press",
        document: selected!.document,
        scope: selected!.scope,
        connectionId,
        itemId: "missing-item",
      },
      popup,
    );
    await vi.waitFor(() => expect(entered).toHaveBeenCalled());
    release();
    await looked(h, 2);
    expect(confirmations()).toEqual([]);
    gate = undefined;
    open();
    expect(await pressed).toMatchObject({ ok: false, reason: "not-a-candidate" });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    expect(confirmations()[0]?.operation.attemptId).toBe("confirm:shown");
    expect(passwordReads(h)).toEqual([otherItemId]);
  });

  it("goes on when a Fill press is refused", async () => {
    const { h } = page({ first: "first-user", other: "other-user", shown: "other-user" });
    let ready!: (value: { ok: boolean }) => void;
    fake.state.awaited = new Promise((resolve) => {
      ready = resolve;
    }) as never;
    await announceShown(h);
    await vi.waitFor(() =>
      expect(fake.state.messages.some((entry) => entry.type === "login.await")).toBe(true),
    );
    fake.state.awaited = { ok: true };
    const offered = await offers(h);
    if (!offered.ok) throw new Error("No page");
    const [selected] = offered.targets;
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.confirm.fill",
          requestId: "stale-press",
          document: selected!.document,
          scope: "stale-scope",
          connectionId,
          itemId: otherItemId,
        },
        popup,
      ),
    ).toMatchObject({ ok: false, reason: "page-changed" });
    ready({ ok: true });
    await vi.waitFor(() => expect(confirmations()).toHaveLength(1));
    expect(confirmations()[0]?.operation.attemptId).toBe("confirm:shown");
  });

  it("gives way to the person's own Fill press", async () => {
    const { h } = page({ first: "first-user", other: "other-user", shown: "other-user" });
    // The page's step is not ready yet, so the automatic fill waits for it.
    let ready!: (value: { ok: boolean }) => void;
    fake.state.awaited = new Promise((resolve) => {
      ready = resolve;
    }) as never;
    await announceShown(h);
    await vi.waitFor(() =>
      expect(fake.state.messages.some((entry) => entry.type === "login.await")).toBe(true),
    );
    fake.state.awaited = { ok: true };
    const offered = await offers(h);
    if (!offered.ok) throw new Error("No page");
    const [selected] = offered.targets;
    expect(
      await h.login.handle(
        {
          version: 1,
          type: "login.confirm.fill",
          requestId: "fill-press",
          document: selected!.document,
          scope: selected!.scope,
          connectionId,
          itemId: otherItemId,
        },
        popup,
      ),
    ).toMatchObject({ ok: true });
    ready({ ok: true });
    await vi.waitFor(() =>
      expect(confirmations().map((entry) => entry.operation.attemptId)).toEqual([
        expect.stringMatching(/^confirm:pick:/),
      ]),
    );
  });
});

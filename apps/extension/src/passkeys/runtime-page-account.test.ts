import { describe, expect, it, vi } from "vitest";
import {
  createPasskeyRuntime,
  type PasskeyChoice,
  type PasskeyChooser,
  type PasskeyItem,
  type PasskeySource,
} from "./runtime";

const extensionId = "synthetic-extension";
const origin = "https://login.example.com";
const sender = () => ({
  id: extensionId,
  tab: { id: 7 },
  frameId: 0,
  documentId: "document-a",
  documentLifecycle: "active",
  origin,
  url: `${origin}/sign-in`,
});
const base = {
  rpId: "example.com",
  userHandle: "dXNlcg",
  discoverable: true,
  counter: 0,
};
type Stored = typeof base & {
  credentialId: string;
  item: string;
  preferred?: boolean;
  display?: { item?: string; userName?: string };
};
// Three accounts of one site, as the owner's OpenAI items in #1670; B is the site default.
const accountA: Stored = {
  ...base,
  credentialId: "AAAA",
  item: "item-a",
  display: { item: "OpenAI", userName: "a@example.com" },
};
const accountB: Stored = {
  ...base,
  credentialId: "BBBB",
  item: "item-b",
  preferred: true,
  display: { item: "OpenAI", userName: "b@example.com" },
};
const accountC: Stored = {
  ...base,
  credentialId: "CCCC",
  item: "item-c",
  display: { item: "OpenAI" },
};
const request = { challenge: "AAECAwQFBgcICQoLDA0ODw", rpId: "example.com", allowCredentials: [] };
const get = (
  overrides: Record<string, unknown> = {},
  requestOverrides: Record<string, unknown> = {},
) => ({
  version: 1,
  type: "passkey.get",
  operationId: crypto.randomUUID(),
  request: { ...request, ...requestOverrides },
  userActivation: true,
  focused: true,
  ...overrides,
});
/** A vault of several items: with `only`, just that item's passkeys, none preferred. */
const vault = (overrides: Partial<PasskeySource> = {}, stored = [accountA, accountB, accountC]) => {
  const source: PasskeySource = {
    candidates: vi.fn(async (_origin: string, _rpId: string, _signal, only?: PasskeyItem) => ({
      candidates: only
        ? stored
            .filter((entry) => entry.item === only.itemId)
            .map(({ preferred: _preferred, ...entry }) => entry)
        : stored,
      complete: true,
      ...(only ? {} : { siteDefault: "searched" as const }),
    })),
    sign: vi.fn(async () => Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01)),
    ...overrides,
  };
  return source;
};
const choosing = (choice: PasskeyChoice = { kind: "chosen", index: 0, makeDefault: false }) => ({
  choose: vi.fn<PasskeyChooser["choose"]>(async () => choice),
});
const signedWith = (credentialId: string) => ({
  kind: "assertion",
  assertion: expect.objectContaining({ credentialId }),
});

describe("a page that shows another account than the site default (ADR 0028, 2026-11-17)", () => {
  it("opens the chooser with the shown account first instead of signing with the default", async () => {
    const chooser = choosing();
    const report = vi.fn();
    const runtime = createPasskeyRuntime(vault(), { extensionId, chooser, report });
    expect(await runtime.handle(get({ account: "A@Example.com" }), sender())).toMatchObject(
      signedWith("AAAA"),
    );
    expect(chooser.choose).toHaveBeenCalledOnce();
    const { entries, replacesDefault } = chooser.choose.mock.calls[0]![0];
    // The shown account first, then the default, marked as such, then the rest.
    expect(entries).toEqual([
      { item: "OpenAI", userName: "a@example.com" },
      { item: "OpenAI", userName: "b@example.com", preferred: true },
      { item: "OpenAI" },
    ]);
    expect(replacesDefault).toBe(true);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ pageAccount: "other", chooser: "chosen" }),
    );
    // The report never names the address.
    expect(JSON.stringify(report.mock.calls)).not.toContain("@");
  });

  it("compares the item's login username where the passkey stores none", async () => {
    const chooser = choosing();
    const loginUsernames = vi.fn(async (candidates: readonly { credentialId: string }[]) =>
      candidates.map((entry) => (entry.credentialId === "CCCC" ? "c@example.com" : undefined)),
    );
    const runtime = createPasskeyRuntime(vault({ loginUsernames }), { extensionId, chooser });
    expect(await runtime.handle(get({ account: "c@example.com" }), sender())).toMatchObject(
      signedWith("CCCC"),
    );
    expect(chooser.choose.mock.calls[0]![0].entries[0]).toEqual({ item: "OpenAI" });
    expect(loginUsernames).toHaveBeenCalledOnce();
  });

  it("signs with the default when the page shows the default's account or none of the vault's", async () => {
    for (const account of ["b@example.com", "z@example.com", "not an address"]) {
      const chooser = choosing();
      const runtime = createPasskeyRuntime(vault(), { extensionId, chooser });
      // oxlint-disable-next-line no-await-in-loop -- one request after another
      expect(await runtime.handle(get({ account }), sender())).toMatchObject(signedWith("BBBB"));
      expect(chooser.choose).not.toHaveBeenCalled();
    }
  });

  it("reads no display without a click, for an autofill request or for a list of credentials", async () => {
    const chooser = choosing();
    const runtime = createPasskeyRuntime(vault(), { extensionId, chooser });
    expect(
      await runtime.handle(get({ account: "a@example.com", userActivation: false }), sender()),
    ).toMatchObject(signedWith("BBBB"));
    // A request that names the credentials it accepts decides before the page's display.
    expect(
      await runtime.handle(
        get(
          { account: "a@example.com" },
          {
            allowCredentials: [
              { type: "public-key", id: "AAAA" },
              { type: "public-key", id: "BBBB" },
            ],
          },
        ),
        sender(),
      ),
    ).toMatchObject(signedWith("BBBB"));
    expect(chooser.choose).not.toHaveBeenCalled();
  });

  it("answers a running login's request with its item, whatever the page shows", async () => {
    const chooser = choosing();
    const runtime = createPasskeyRuntime(vault(), {
      extensionId,
      chooser,
      loginAccount: () => ({ connectionId: "personal", itemId: "item-c" }),
    });
    expect(await runtime.handle(get({ account: "a@example.com" }), sender())).toMatchObject(
      signedWith("CCCC"),
    );
    expect(chooser.choose).not.toHaveBeenCalled();
  });

  it("keeps a site without a default in force as it was: no order from the page", async () => {
    const chooser = choosing();
    const runtime = createPasskeyRuntime(vault(), {
      extensionId,
      chooser,
      defaultUnset: () => true,
    });
    await runtime.handle(get({ account: "c@example.com" }), sender());
    expect(chooser.choose.mock.calls[0]![0].entries.map((entry) => entry.userName)).toEqual([
      "a@example.com",
      "b@example.com",
      undefined,
    ]);
  });

  it("hands the request on, never signing with the default, where the chooser cannot open", async () => {
    const chooser = choosing();
    const runtime = createPasskeyRuntime(vault(), { extensionId, chooser });
    expect(
      await runtime.handle(get({ account: "a@example.com", focused: false }), sender()),
    ).toEqual({ kind: "delegate", reason: "page-account" });
    expect(chooser.choose).not.toHaveBeenCalled();
  });
});

describe("a login that moved to the page from another origin (ADR 0036, 2026-11-17)", () => {
  const moved = (sameSite: boolean, loginOrigin = "https://chat.example.net") => ({
    connectionId: "personal",
    itemId: "item-a",
    origin: loginOrigin,
    sameSite,
  });

  it("answers with the login's item on another origin of its site", async () => {
    const chooser = choosing();
    const report = vi.fn();
    const movedLogin = vi.fn(() => moved(true, "https://www.example.com"));
    const runtime = createPasskeyRuntime(vault(), { extensionId, chooser, movedLogin, report });
    expect(await runtime.handle(get(), sender())).toMatchObject(signedWith("AAAA"));
    expect(movedLogin).toHaveBeenCalledWith(7, origin, "document-a");
    expect(chooser.choose).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ movedLogin: true }));
  });

  it("answers with it from a related origin the RP lists (ADR 0084)", async () => {
    const allows = vi.fn(async () => true);
    const runtime = createPasskeyRuntime(vault(), {
      extensionId,
      movedLogin: () => moved(false),
      relatedOrigins: { allows },
    });
    expect(await runtime.handle(get(), sender())).toMatchObject(signedWith("AAAA"));
    expect(allows).toHaveBeenCalledWith("https://chat.example.net", "example.com");
  });

  it("leaves the default to answer from an origin the RP does not list", async () => {
    const allows = vi.fn(async () => false);
    const runtime = createPasskeyRuntime(vault(), {
      extensionId,
      movedLogin: () => moved(false),
      relatedOrigins: { allows },
    });
    expect(await runtime.handle(get(), sender())).toMatchObject(signedWith("BBBB"));
    // Without a related origins reader, another site never counts.
    const unread = createPasskeyRuntime(vault(), { extensionId, movedLogin: () => moved(false) });
    expect(await unread.handle(get(), sender())).toMatchObject(signedWith("BBBB"));
  });

  it("reads no RP list for an item without a passkey of the request's RP ID", async () => {
    const allows = vi.fn(async () => true);
    const runtime = createPasskeyRuntime(vault({}, [accountB, accountC]), {
      extensionId,
      movedLogin: () => moved(false),
      relatedOrigins: { allows },
    });
    expect(await runtime.handle(get(), sender())).toMatchObject(signedWith("BBBB"));
    expect(allows).not.toHaveBeenCalled();
  });

  it("answers with its item when the page shows the login's own account", async () => {
    const chooser = choosing();
    const shown = createPasskeyRuntime(vault(), {
      extensionId,
      chooser,
      movedLogin: () => moved(true),
    });
    expect(await shown.handle(get({ account: "a@example.com" }), sender())).toMatchObject(
      signedWith("AAAA"),
    );
    expect(chooser.choose).not.toHaveBeenCalled();
  });

  it("asks, never signing unasked, when the page shows another account than the login's", async () => {
    // The moved login is C's; the page shows A's address, then B's, the site default's.
    const movedC = () => ({ ...moved(true), itemId: "item-c" });
    const chooser = choosing();
    const report = vi.fn();
    const runtime = createPasskeyRuntime(vault(), {
      extensionId,
      chooser,
      report,
      movedLogin: movedC,
    });
    expect(await runtime.handle(get({ account: "a@example.com" }), sender())).toMatchObject(
      signedWith("AAAA"),
    );
    // The shown account first, then the login's own item, then the rest.
    expect(chooser.choose.mock.calls[0]![0].entries).toEqual([
      { item: "OpenAI", userName: "a@example.com" },
      { item: "OpenAI" },
      { item: "OpenAI", userName: "b@example.com", preferred: true },
    ]);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({ movedLogin: true, pageAccount: "other" }),
    );
    await runtime.handle(get({ account: "b@example.com" }), sender());
    expect(chooser.choose.mock.calls[1]![0].entries.map((entry) => entry.userName)).toEqual([
      "b@example.com",
      undefined,
      "a@example.com",
    ]);
    // Where the window cannot open, the request is handed on.
    expect(
      await runtime.handle(get({ account: "a@example.com", focused: false }), sender()),
    ).toEqual({ kind: "delegate", reason: "page-account" });
    // A login whose item holds no passkey here is not answered for either.
    const empty = createPasskeyRuntime(vault({}, [accountA, accountB]), {
      extensionId,
      chooser,
      movedLogin: movedC,
    });
    expect(await empty.handle(get({ account: "a@example.com" }), sender())).toMatchObject(
      signedWith("AAAA"),
    );
    expect(chooser.choose).toHaveBeenCalledTimes(3);
  });

  it("asks with its own item first on a site whose default counts as unset (ADR 0062, ADR 0063)", async () => {
    const movedC = () => ({ ...moved(true), itemId: "item-c" });
    const chooser = choosing();
    const defaultUnset = vi.fn((): true | "paused" => true);
    const runtime = createPasskeyRuntime(vault(), {
      extensionId,
      chooser,
      defaultUnset,
      movedLogin: movedC,
    });
    expect(await runtime.handle(get(), sender())).toMatchObject(signedWith("CCCC"));
    expect(defaultUnset).toHaveBeenCalledWith(origin, false);
    // Its own item first, then the rest; no default is marked on such a site.
    expect(chooser.choose.mock.calls[0]![0].entries).toEqual([
      { item: "OpenAI" },
      { item: "OpenAI", userName: "a@example.com" },
      { item: "OpenAI", userName: "b@example.com" },
    ]);
    // Such a site decides before the page's display.
    await runtime.handle(get({ account: "a@example.com" }), sender());
    expect(chooser.choose.mock.calls[1]![0].entries[0]).toEqual({ item: "OpenAI" });
    // A paused site where the window cannot open is handed on, never signed unasked.
    defaultUnset.mockReturnValue("paused");
    expect(await runtime.handle(get({ focused: false }), sender())).toEqual({
      kind: "delegate",
      reason: "paused",
    });
    expect(chooser.choose).toHaveBeenCalledTimes(2);
  });

  it("hands on a list of credentials that names only other items' passkeys", async () => {
    const chooser = choosing();
    const runtime = createPasskeyRuntime(vault(), {
      extensionId,
      chooser,
      movedLogin: () => moved(true),
    });
    expect(
      await runtime.handle(
        get(
          { account: "b@example.com" },
          { allowCredentials: [{ type: "public-key", id: "BBBB" }] },
        ),
        sender(),
      ),
    ).toEqual({ kind: "delegate", reason: "login-item-no-credential" });
    expect(chooser.choose).not.toHaveBeenCalled();
  });

  it("ranks after a running login of this origin", async () => {
    const movedLogin = vi.fn(() => moved(true));
    const here = createPasskeyRuntime(vault(), {
      extensionId,
      movedLogin,
      loginAccount: () => ({ connectionId: "personal", itemId: "item-c" }),
    });
    movedLogin.mockClear();
    expect(await here.handle(get(), sender())).toMatchObject(signedWith("CCCC"));
    expect(movedLogin).not.toHaveBeenCalled();
  });
});

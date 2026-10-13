import { describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  DUMMY_VAULT_CATALOG,
  type LocalSettings,
  type SettingsResponse,
  type VaultCatalog,
} from "@pateat/contracts";
import type { UriCandidates } from "../crypto/wire";
import type { LoginFieldSource } from "../login/vault";
import type { PasskeyFinder } from "../passkeys/vault";
import { vaultFailure } from "./record";
import { createSiteAccountsHandler, findSiteAccounts, rpIdsFor } from "./site-accounts";
import type { LiveUriMatcher } from "./site-candidates";

const snapshotId = "11111111-1111-4111-8111-111111111111";
const userId = "33333333-3333-4333-8333-333333333333";
const uriItem = "44444444-4444-4444-8444-444444444444";
const passkeyItem = "55555555-5555-4555-8555-555555555555";
const otherItem = "66666666-6666-4666-8666-666666666666";
const excludedItem = "77777777-7777-4777-8777-777777777777";
const origin = "https://my.bank.example";
const item = (id: string) => ({
  id,
  label: "Same name",
  allowedOrigins: [],
  groupIds: [],
  fields: [{ id: "login.password", label: "Password", name: null, kind: "hidden" as const }],
});

function saved(state: "ready" | "unavailable" = "ready"): Extract<SettingsResponse, { ok: true }> {
  const catalog: VaultCatalog = {
    connections: [
      ...structuredClone(DUMMY_VAULT_CATALOG.connections),
      {
        id: "live",
        label: "Live",
        provider: "bitwarden",
        userId,
        ...(state === "ready" ? { snapshotId } : {}),
        state,
        groups: [],
        items: [uriItem, passkeyItem, otherItem, excludedItem].map(item),
      },
    ],
  };
  const settings = createDefaultSettings(catalog);
  return { version: 1, ok: true, snapshot: { version: 1, revision: 3, settings }, catalog };
}
/** The settings page's draft: real connections start disabled until the owner enables one. */
function draft(value = saved()): LocalSettings {
  const settings = structuredClone(value.snapshot.settings);
  const live = settings.connections.find((entry) => entry.connectionId === "live")!;
  live.enabled = true;
  live.excludedItemIds.push(excludedItem);
  return settings;
}

const uris = (overrides: Partial<UriCandidates> = {}): UriCandidates => ({
  connectionId: "live",
  userId,
  snapshotId,
  targetOrigin: origin,
  candidates: [uriItem, excludedItem].map((itemId) => ({
    itemId,
    matches: [{ uriIndex: 0, match: 0 }],
  })),
  unavailableUris: [],
  unavailableItemIds: [],
  ...overrides,
});
const passkey = (itemId: string, rpId: string) => ({
  connectionId: "live",
  userId,
  snapshotId,
  itemId,
  credentialId: "AQID",
  rpId,
  userHandle: "AQID",
  discoverable: true,
  counter: 0,
  userName: null,
});
const passkeys =
  (holders: Record<string, string[]> = {}): PasskeyFinder =>
  async (connectionId, rpId) => ({
    ok: true,
    data: {
      connectionId,
      userId,
      snapshotId,
      rpId,
      candidates: (holders[rpId] ?? []).map((itemId) => passkey(itemId, rpId)),
      unavailableItemIds: [],
    },
  });

describe("findSiteAccounts", () => {
  it("lists eligible URI matches and passkey holders for the origin, nothing else", async () => {
    const matchUris = vi.fn<LiveUriMatcher>().mockResolvedValue({ ok: true, data: uris() });
    const findPasskeys = vi.fn(passkeys({ "bank.example": [passkeyItem, uriItem, excludedItem] }));
    const result = await findSiteAccounts({
      saved: saved(),
      settings: draft(),
      origin,
      matchUris,
      findPasskeys,
    });
    expect(result).toEqual({
      version: 1,
      ok: true,
      origin,
      accounts: [
        { connectionId: "live", itemId: uriItem, uri: true, passkey: true },
        { connectionId: "live", itemId: passkeyItem, uri: false, passkey: true },
      ],
      complete: true,
    });
    // Only the live vault is asked; the bundled demo vaults answer from static origins.
    expect(matchUris.mock.calls).toEqual([["live", `${origin}/`, undefined]]);
    expect(findPasskeys.mock.calls).toEqual([
      ["live", "my.bank.example"],
      ["live", "bank.example"],
    ]);
  });

  it("reads the login username of matched live items only", async () => {
    const readField = vi.fn<LoginFieldSource>(async ({ account }) =>
      account.itemId === uriItem ? "alice@example.test" : undefined,
    );
    const result = await findSiteAccounts({
      saved: saved(),
      settings: draft(),
      origin: "https://bank.example",
      matchUris: async () => ({
        ok: true,
        data: uris({ targetOrigin: "https://bank.example", candidates: [] }),
      }),
      findPasskeys: passkeys({ "bank.example": [uriItem, passkeyItem] }),
      readField,
    });
    expect(result).toMatchObject({
      ok: true,
      accounts: expect.arrayContaining([
        {
          connectionId: "live",
          itemId: uriItem,
          uri: false,
          passkey: true,
          username: "alice@example.test",
        },
        { connectionId: "live", itemId: passkeyItem, uri: false, passkey: true },
      ]),
    });
    // The demo vaults' static matches and unmatched live items are never read.
    expect(
      readField.mock.calls.map(([request]) => [request.account.itemId, request.fieldId]),
    ).toEqual([
      [uriItem, "login.username"],
      [passkeyItem, "login.username"],
    ]);
  });

  it("does not read a username the draft excludes", async () => {
    const settings = draft();
    settings.connections
      .find((entry) => entry.connectionId === "live")!
      .excludedFields.push({ itemId: uriItem, fieldId: "login.username" });
    const readField = vi.fn<LoginFieldSource>(async () => "alice@example.test");
    const result = await findSiteAccounts({
      saved: saved(),
      settings,
      origin,
      matchUris: async () => ({ ok: true, data: uris() }),
      findPasskeys: passkeys(),
      readField,
    });
    expect(result).toMatchObject({ ok: true, accounts: [{ itemId: uriItem }] });
    expect(result.ok && result.accounts[0]).not.toHaveProperty("username");
    expect(readField).not.toHaveBeenCalled();
  });

  it("searches what the draft enables, not only the saved settings", async () => {
    const value = saved();
    const matchUris = vi.fn<LiveUriMatcher>().mockResolvedValue({ ok: true, data: uris() });
    const disabled = await findSiteAccounts({
      saved: value,
      settings: value.snapshot.settings,
      origin,
      matchUris,
      findPasskeys: passkeys(),
    });
    expect(disabled).toMatchObject({ ok: true, accounts: [], complete: true });
    expect(matchUris).not.toHaveBeenCalled();
    expect(
      await findSiteAccounts({
        saved: value,
        settings: draft(value),
        origin,
        matchUris,
        findPasskeys: passkeys(),
      }),
    ).toMatchObject({ ok: true, accounts: [{ itemId: uriItem }] });
  });

  it("lists bundled demo items by their static origins", async () => {
    const result = await findSiteAccounts({
      saved: saved(),
      settings: draft(),
      origin: "https://mail.example",
      matchUris: async () => ({
        ok: true,
        data: uris({ targetOrigin: "https://mail.example", candidates: [] }),
      }),
      findPasskeys: passkeys(),
    });
    expect(result).toEqual({
      version: 1,
      ok: true,
      origin: "https://mail.example",
      accounts: [{ connectionId: "demo-personal", itemId: "secondary", uri: true, passkey: false }],
      complete: true,
    });
  });

  it("reports an unsearched vault or an unevaluated item as incomplete", async () => {
    const locked = await findSiteAccounts({
      saved: saved("unavailable"),
      settings: draft(saved("unavailable")),
      origin,
      matchUris: async () => vaultFailure("crypto-locked"),
      findPasskeys: passkeys(),
    });
    expect(locked).toEqual({ version: 1, ok: true, origin, accounts: [], complete: false });
    const unevaluated = await findSiteAccounts({
      saved: saved(),
      settings: draft(),
      origin,
      matchUris: async () => ({
        ok: true,
        data: uris({
          candidates: [],
          unavailableUris: [{ itemId: otherItem, uriIndex: 0, reason: "unsupported-uri-match" }],
        }),
      }),
      findPasskeys: passkeys(),
    });
    expect(unevaluated).toMatchObject({ ok: true, accounts: [], complete: false });
  });

  it("refuses an excluded site before asking any vault", async () => {
    const settings = draft();
    settings.excludedSites.push({ hostname: "bank.example", includeSubdomains: true });
    const matchUris = vi.fn<LiveUriMatcher>();
    const findPasskeys = vi.fn<PasskeyFinder>();
    expect(
      await findSiteAccounts({ saved: saved(), settings, origin, matchUris, findPasskeys }),
    ).toEqual({ version: 1, ok: false, reason: "site-excluded" });
    expect(matchUris).not.toHaveBeenCalled();
    expect(findPasskeys).not.toHaveBeenCalled();
  });
});

describe("createSiteAccountsHandler", () => {
  it("rejects malformed requests and answers for the draft", async () => {
    const handle = createSiteAccountsHandler({
      settings: { handle: async () => saved() },
      matchUris: async () => ({ ok: true, data: uris() }),
      findPasskeys: passkeys(),
    });
    expect(
      await handle({
        version: 1,
        type: "settings.site-accounts",
        origin: `${origin}/path`,
        settings: draft(),
      }),
    ).toEqual({ version: 1, ok: false, reason: "invalid-request" });
    expect(
      await handle({ version: 1, type: "settings.site-accounts", origin, settings: draft() }),
    ).toMatchObject({ ok: true, accounts: [{ itemId: uriItem }] });
  });
});

describe("createSiteAccountsHandler settings changes", () => {
  const request = () => ({
    version: 1,
    type: "settings.site-accounts",
    origin: "https://bank.example",
    settings: draft(),
  });
  const matchUris: LiveUriMatcher = async () => ({
    ok: true,
    data: uris({ targetOrigin: "https://bank.example", candidates: [] }),
  });

  it("searches again when the settings changed while it read the usernames", async () => {
    let revision = 3;
    const settings = vi.fn(async () => {
      const value = saved();
      value.snapshot.revision = revision;
      return value;
    });
    // A login saves its default while the first username is read, so that read is refused.
    const readField = vi.fn<LoginFieldSource>(async ({ account }) => {
      if (revision === 3) {
        revision = 4;
        return undefined;
      }
      return account.itemId === uriItem ? "alice@example.test" : "bob@example.test";
    });
    const handle = createSiteAccountsHandler({
      settings: { handle: settings },
      matchUris,
      findPasskeys: passkeys({ "bank.example": [uriItem, passkeyItem] }),
      readField,
    });
    expect(await handle(request())).toMatchObject({
      ok: true,
      accounts: expect.arrayContaining([
        expect.objectContaining({ itemId: uriItem, username: "alice@example.test" }),
        expect.objectContaining({ itemId: passkeyItem, username: "bob@example.test" }),
      ]),
    });
    expect(readField).toHaveBeenCalledTimes(4);
  });

  it("answers after three searches while the settings keep changing", async () => {
    let revision = 3;
    const handle = createSiteAccountsHandler({
      settings: {
        handle: async () => {
          const value = saved();
          value.snapshot.revision = revision;
          revision += 1;
          return value;
        },
      },
      matchUris,
      findPasskeys: passkeys({ "bank.example": [uriItem] }),
      readField: async () => "alice@example.test",
    });
    expect(await handle(request())).toMatchObject({
      ok: true,
      accounts: expect.arrayContaining([expect.objectContaining({ itemId: uriItem })]),
    });
    // Three searches, each with its read before and its check after, but the last.
    expect(revision).toBe(8);
  });
});

describe("createSiteAccountsHandler queue", () => {
  it("answers concurrent lookups one after another", async () => {
    let running = 0;
    let overlapped = false;
    const handle = createSiteAccountsHandler({
      settings: { handle: async () => saved() },
      matchUris: async () => {
        running += 1;
        if (running > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 5));
        running -= 1;
        return { ok: true, data: uris() };
      },
      findPasskeys: passkeys(),
    });
    const request = { version: 1, type: "settings.site-accounts", origin, settings: draft() };
    const answers = await Promise.all([handle(request), handle({}), handle(request)]);
    expect(overlapped).toBe(false);
    expect(answers.map((entry) => entry.ok)).toEqual([true, false, true]);
  });
});

describe("rpIdsFor", () => {
  it("lists the host and its registrable parent domains only", () => {
    expect(rpIdsFor("https://my.jcb.co.jp")).toEqual(["my.jcb.co.jp", "jcb.co.jp"]);
    expect(rpIdsFor("https://example.com")).toEqual(["example.com"]);
    expect(rpIdsFor("https://user.github.io")).toEqual(["user.github.io"]);
    // WebAuthn refuses IP addresses and plain HTTP outside localhost.
    expect(rpIdsFor("https://127.0.0.1")).toEqual([]);
    expect(rpIdsFor("http://bank.example")).toEqual([]);
  });
});

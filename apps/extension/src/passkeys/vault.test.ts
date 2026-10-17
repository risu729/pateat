import { describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  type SettingsResponse,
  type SettingsChangeCause,
  type SettingsSnapshot,
  type VaultCatalog,
} from "@pateat/contracts";
import type { PasskeyMatches } from "../crypto/passkey";
import { vaultFailure } from "../vault/record";
import type { PasskeySource } from "./runtime";
import { selectPasskey } from "./select";
import {
  createVaultPasskeySource,
  findVaultPasskeys,
  itemPasskeyFacts,
  originPasskeyItems,
  rememberVaultPasskey,
  type PasskeyFinder,
  type VaultPasskeyCandidate,
} from "./vault";

const snapshotId = "11111111-1111-4111-8111-111111111111";
const userId = "33333333-3333-4333-8333-333333333333";
const otherUserId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const first = "44444444-4444-4444-8444-444444444444";
const second = "55555555-5555-4555-8555-555555555555";
const quarantined = "66666666-6666-4666-8666-666666666666";
const excluded = "77777777-7777-4777-8777-777777777777";
const passkeyOnly = "88888888-8888-4888-8888-888888888888";
const fieldsExcluded = "99999999-9999-4999-8999-999999999999";
const otherSnapshotId = "22222222-2222-4222-8222-222222222222";
const origin = "https://github.com";
const rpId = "github.com";
const item = (id: string, fields = true) => ({
  id,
  label: `Synthetic ${id.slice(0, 4)}`,
  allowedOrigins: [],
  groupIds: [],
  fields: fields
    ? [{ id: "login.password", label: "Password", name: null, kind: "hidden" as const }]
    : [],
});

function saved(
  options: {
    state?: VaultCatalog["connections"][number]["state"];
    enabled?: boolean;
    siteDefault?: string;
    excludedSite?: string;
    revision?: number;
    snapshot?: string;
    quarantine?: string[];
    /** A second enabled connection holding the same item ID as `first`. */
    other?: VaultCatalog["connections"][number]["state"];
    /** The provider account the default names; `live`'s account when absent. */
    defaultAccount?: string;
    /** Connects the other connection to the same Bitwarden account as `live`. */
    sameAccount?: boolean;
  } = {},
): Extract<SettingsResponse, { ok: true }> {
  const catalog: VaultCatalog = {
    connections: [
      {
        id: "live",
        label: "Live",
        provider: "bitwarden",
        userId,
        snapshotId: options.snapshot ?? snapshotId,
        state: options.state ?? "ready",
        quarantinedItemIds: [quarantined, ...(options.quarantine ?? [])],
        groups: [],
        items: [
          item(first),
          item(second),
          item(quarantined),
          item(excluded),
          item(passkeyOnly, false),
          item(fieldsExcluded),
        ],
      },
      {
        id: "other",
        label: "Other",
        provider: "bitwarden",
        userId: options.sameAccount ? userId : otherUserId,
        snapshotId: otherSnapshotId,
        state: options.other ?? "ready",
        quarantinedItemIds: [],
        groups: [],
        items: [item(first)],
      },
    ],
  };
  const settings = createDefaultSettings(catalog);
  // Real connections start disabled; these tests model an explicit owner grant.
  settings.connections[0]!.enabled = options.enabled ?? true;
  settings.connections[0]!.excludedItemIds.push(excluded);
  settings.connections[0]!.excludedFields.push({
    itemId: fieldsExcluded,
    fieldId: "login.password",
  });
  settings.connections[1]!.enabled = options.other !== undefined;
  if (options.siteDefault)
    settings.siteDefaults.push({
      origin,
      provider: "bitwarden",
      userId: options.defaultAccount ?? userId,
      itemId: options.siteDefault,
    });
  if (options.excludedSite)
    settings.excludedSites.push({ hostname: options.excludedSite, includeSubdomains: false });
  return {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision: options.revision ?? 3, settings },
    catalog,
  };
}

const accountOf = (connectionId: string) => (connectionId === "live" ? userId : otherUserId);
const stored = (itemId: string, connectionId = "live") => ({
  connectionId,
  userId: accountOf(connectionId),
  snapshotId: connectionId === "live" ? snapshotId : otherSnapshotId,
  itemId,
  credentialId: `cred-${itemId.slice(0, 4)}`,
  rpId,
  userHandle: "dXNlcg",
  discoverable: true,
  counter: 0,
  userName: "synthetic-user",
});
const matches = (
  ids: readonly string[],
  unavailableItemIds: string[] = [],
  connectionId = "live",
): PasskeyMatches => ({
  connectionId,
  userId: accountOf(connectionId),
  snapshotId: connectionId === "live" ? snapshotId : otherSnapshotId,
  rpId,
  candidates: ids.map((id) => stored(id, connectionId)),
  unavailableItemIds,
});
/** One answer per connection. */
const perConnection = (results: Record<string, Awaited<ReturnType<PasskeyFinder>>>) =>
  vi.fn<PasskeyFinder>(async (connectionId) => results[connectionId]);
const finder = (result: Awaited<ReturnType<PasskeyFinder>>) =>
  vi.fn<PasskeyFinder>(async () => result);
const request = { rpId, allowCredentialIds: [] as string[] };

describe("vault passkey candidates", () => {
  it("searches by RP ID and keeps only eligible items", async () => {
    const find = finder({
      ok: true,
      data: matches([first, quarantined, excluded, passkeyOnly, fieldsExcluded]),
    });
    const found = await findVaultPasskeys({ saved: saved(), origin, rpId, find });
    expect(find).toHaveBeenCalledWith("live", rpId);
    expect(found).toEqual({
      complete: true,
      siteDefault: "unset",
      candidates: [first, passkeyOnly].map((itemId) => ({
        connectionId: "live",
        userId,
        snapshotId,
        itemId,
        settingsRevision: 3,
        credentialId: `cred-${itemId.slice(0, 4)}`,
        rpId,
        userHandle: "dXNlcg",
        discoverable: true,
        counter: 0,
        preferred: false,
        display: {
          item: `Synthetic ${itemId.slice(0, 4)}`,
          userName: "synthetic-user",
          account: "Live",
        },
      })),
    });
  });

  it("uses one match without a site default and the default among several", async () => {
    const one = await findVaultPasskeys({
      saved: saved(),
      origin,
      rpId,
      find: finder({ ok: true, data: matches([first]) }),
    });
    expect(selectPasskey(request, one!)).toMatchObject({ credential: { itemId: first } });
    const two = finder({ ok: true, data: matches([first, second]) });
    expect(
      selectPasskey(
        request,
        (await findVaultPasskeys({ saved: saved(), origin, rpId, find: two }))!,
      ),
    ).toEqual({ kind: "delegate", reason: "ambiguous-credential" });
    const withDefault = await findVaultPasskeys({
      saved: saved({ siteDefault: second }),
      origin,
      rpId,
      find: two,
    });
    expect(selectPasskey(request, withDefault!)).toMatchObject({
      credential: { itemId: second, preferred: true },
    });
    // The default applies to its exact origin only.
    const subdomain = await findVaultPasskeys({
      saved: saved({ siteDefault: second }),
      origin: "https://gist.github.com",
      rpId,
      find: two,
    });
    expect(selectPasskey(request, subdomain!)).toEqual({
      kind: "delegate",
      reason: "ambiguous-credential",
    });
  });

  it("reports whether the site default resolved to a searched, eligible item", async () => {
    const two = finder({ ok: true, data: matches([first, second]) });
    const state = async (overrides: Parameters<typeof saved>[0], find = two) =>
      (await findVaultPasskeys({ saved: saved(overrides), origin, rpId, find }))?.siteDefault;
    expect(await state({})).toBe("unset");
    expect(await state({ siteDefault: second })).toBe("searched");
    // A default in a connection that was not searched is not reported as searched.
    expect(await state({ other: "locked", siteDefault: first, defaultAccount: otherUserId })).toBe(
      "not-searched",
    );
    // A default saved for an account that no connection here belongs to cannot resolve.
    expect(await state({ siteDefault: second, defaultAccount: crypto.randomUUID() })).toBe(
      "unresolved",
    );
    // An item the owner excluded is never searched as the default.
    expect(await state({ siteDefault: excluded })).toBe("not-searched");
    expect(await state({ siteDefault: second }, finder(vaultFailure("crypto-locked")))).toBe(
      "not-searched",
    );
  });

  it("marks the search incomplete for an unreadable eligible item or connection", async () => {
    const unreadable = await findVaultPasskeys({
      saved: saved(),
      origin,
      rpId,
      find: finder({ ok: true, data: matches([first], [second]) }),
    });
    expect(unreadable?.complete).toBe(false);
    expect(selectPasskey(request, unreadable!)).toEqual({
      kind: "delegate",
      reason: "vault-incomplete",
    });
    // An unreadable item the owner excluded cannot hold the answer.
    const ignored = await findVaultPasskeys({
      saved: saved(),
      origin,
      rpId,
      find: finder({ ok: true, data: matches([first], [excluded, quarantined]) }),
    });
    expect(ignored?.complete).toBe(true);
    for (const result of [
      vaultFailure("crypto-locked"),
      undefined,
      { ok: true as const, data: { ...matches([first]), snapshotId: crypto.randomUUID() } },
      { ok: true as const, data: { ...matches([first]), rpId: "example.com" } },
      { ok: true as const, data: { ...matches([first]), userId: crypto.randomUUID() } },
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const found = await findVaultPasskeys({ saved: saved(), origin, rpId, find: finder(result) });
      expect(found).toEqual({ candidates: [], complete: false, siteDefault: "unset" });
    }
    const locked = finder({ ok: true, data: matches([first]) });
    expect(
      await findVaultPasskeys({ saved: saved({ state: "locked" }), origin, rpId, find: locked }),
    ).toEqual({ candidates: [], complete: false, siteDefault: "unset" });
    expect(locked).not.toHaveBeenCalled();
  });

  it("searches every enabled connection and binds the default to its connection", async () => {
    const find = perConnection({
      live: { ok: true, data: matches([first]) },
      other: { ok: true, data: matches([first], [], "other") },
    });
    const both = await findVaultPasskeys({ saved: saved({ other: "ready" }), origin, rpId, find });
    expect(find.mock.calls.map(([connectionId]) => connectionId)).toEqual(["live", "other"]);
    expect(selectPasskey(request, both!)).toEqual({
      kind: "delegate",
      reason: "ambiguous-credential",
    });
    // The same item ID in another connection is not the default.
    const chosen = await findVaultPasskeys({
      saved: saved({ other: "ready", siteDefault: first, defaultAccount: otherUserId }),
      origin,
      rpId,
      find,
    });
    expect(selectPasskey(request, chosen!)).toMatchObject({
      credential: { connectionId: "other", itemId: first, preferred: true },
    });
    // A locked connection might hold the only other match.
    const partial = await findVaultPasskeys({
      saved: saved({ other: "locked" }),
      origin,
      rpId,
      find,
    });
    expect(partial).toMatchObject({ complete: false, candidates: [{ itemId: first }] });
    expect(selectPasskey(request, partial!)).toEqual({
      kind: "delegate",
      reason: "vault-incomplete",
    });
    const preferredWhileIncomplete = await findVaultPasskeys({
      saved: saved({ other: "locked", siteDefault: first }),
      origin,
      rpId,
      find,
    });
    expect(selectPasskey(request, preferredWhileIncomplete!)).toMatchObject({
      credential: { connectionId: "live", itemId: first },
    });
  });

  it("resolves a default saved by provider account to that account's connection", async () => {
    const find = perConnection({
      live: { ok: true, data: matches([first]) },
      other: { ok: true, data: matches([first], [], "other") },
    });
    for (const [account, connectionId] of [
      [userId, "live"],
      [otherUserId, "other"],
    ] as const) {
      // eslint-disable-next-line no-await-in-loop
      const found = await findVaultPasskeys({
        saved: saved({ other: "ready", siteDefault: first, defaultAccount: account }),
        origin,
        rpId,
        find,
      });
      expect(selectPasskey(request, found!)).toMatchObject({
        credential: { connectionId, itemId: first, preferred: true },
      });
    }
    // An account connected twice, or not connected here, names no connection.
    for (const options of [
      { sameAccount: true, defaultAccount: userId },
      { defaultAccount: crypto.randomUUID() },
    ]) {
      const account = options.sameAccount ? userId : otherUserId;
      const other = matches([first], [], "other");
      // eslint-disable-next-line no-await-in-loop
      const found = await findVaultPasskeys({
        saved: saved({ other: "ready", siteDefault: first, ...options }),
        origin,
        rpId,
        find: perConnection({
          live: { ok: true, data: matches([first]) },
          other: {
            ok: true,
            data: {
              ...other,
              userId: account,
              candidates: other.candidates.map((entry) => ({ ...entry, userId: account })),
            },
          },
        }),
      });
      expect(found?.candidates.some((entry) => entry.preferred)).toBe(false);
      expect(selectPasskey(request, found!)).toEqual({
        kind: "delegate",
        reason: "ambiguous-credential",
      });
    }
  });

  it("never prefers a default that names an excluded or quarantined item", async () => {
    for (const named of [excluded, quarantined]) {
      // eslint-disable-next-line no-await-in-loop
      const found = await findVaultPasskeys({
        saved: saved({ siteDefault: named }),
        origin,
        rpId,
        find: finder({ ok: true, data: matches([first, second, named]) }),
      });
      expect(selectPasskey(request, found!)).toEqual({
        kind: "delegate",
        reason: "ambiguous-credential",
      });
    }
  });

  it("skips disabled connections and answers nothing on an excluded site", async () => {
    const find = finder({ ok: true, data: matches([first]) });
    expect(
      await findVaultPasskeys({ saved: saved({ enabled: false }), origin, rpId, find }),
    ).toEqual({ candidates: [], complete: true, siteDefault: "unset" });
    expect(
      await findVaultPasskeys({ saved: saved({ excludedSite: "github.com" }), origin, rpId, find }),
    ).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
  });
});

describe("a login item's passkeys (ADR 0027)", () => {
  const only = { connectionId: "live", itemId: first };

  it("searches only the item's connection and keeps only its passkeys, none preferred", async () => {
    const find = perConnection({
      live: { ok: true, data: matches([first, second]) },
      other: { ok: true, data: matches([first], [], "other") },
    });
    const found = await findVaultPasskeys({
      saved: saved({ other: "ready", siteDefault: second }),
      origin,
      rpId,
      find,
      only,
    });
    expect(find.mock.calls.map(([connectionId]) => connectionId)).toEqual(["live"]);
    expect(found).toEqual({
      complete: true,
      candidates: [
        expect.objectContaining({ connectionId: "live", itemId: first, preferred: false }),
      ],
    });
    expect(selectPasskey(request, found!)).toMatchObject({ credential: { itemId: first } });
    // The same item ID in another connection is another item.
    const elsewhere = await findVaultPasskeys({
      saved: saved({ other: "ready" }),
      origin,
      rpId,
      find,
      only: { connectionId: "other", itemId: first },
    });
    expect(find.mock.calls.map(([connectionId]) => connectionId)).toEqual(["live", "other"]);
    expect(elsewhere?.candidates).toEqual([
      expect.objectContaining({ connectionId: "other", itemId: first }),
    ]);
  });

  it("is complete only when the item's own connection answered for it", async () => {
    const search = (
      result: Awaited<ReturnType<PasskeyFinder>>,
      options: Parameters<typeof saved>[0] = {},
      searched = only,
    ) =>
      findVaultPasskeys({
        saved: saved(options),
        origin,
        rpId,
        find: finder(result),
        only: searched,
      });
    // Another item that could not be read does not matter.
    expect(await search({ ok: true, data: matches([first], [second]) })).toMatchObject({
      complete: true,
    });
    expect(await search({ ok: true, data: matches([], [first]) })).toEqual({
      candidates: [],
      complete: false,
    });
    expect(await search(vaultFailure("crypto-locked"))).toEqual({
      candidates: [],
      complete: false,
    });
    expect(await search({ ok: true, data: matches([first]) }, { state: "locked" })).toEqual({
      candidates: [],
      complete: false,
    });
    expect(await search({ ok: true, data: matches([first]) }, { enabled: false })).toEqual({
      candidates: [],
      complete: false,
    });
    expect(
      await search(
        { ok: true, data: matches([first]) },
        {},
        { connectionId: "gone", itemId: first },
      ),
    ).toEqual({ candidates: [], complete: false });
    expect(
      await search({ ok: true, data: matches([first]) }, { excludedSite: "github.com" }),
    ).toBeUndefined();
  });

  it("reads the item's passkey facts for each RP ID the origin may use", async () => {
    const candidates = vi.fn<PasskeySource["candidates"]>(async (_origin, candidateRpId) =>
      candidateRpId === "github.com"
        ? {
            complete: true,
            candidates: [{ ...stored(first), userHandle: null, discoverable: false }],
          }
        : { complete: true, candidates: [] },
    );
    const account = { origin: "https://login.github.com", ...only };
    expect(await itemPasskeyFacts({ candidates }, account)).toEqual({
      passkey: true,
      discoverable: false,
    });
    expect(candidates.mock.calls.map(([, candidateRpId]) => candidateRpId)).toEqual([
      "login.github.com",
      "github.com",
    ]);
    for (const call of candidates.mock.calls) expect(call[3]).toEqual(only);
    // A discoverable passkey with a user handle signs in on its own.
    candidates.mockResolvedValue({ complete: true, candidates: [stored(first)] });
    expect(await itemPasskeyFacts({ candidates }, account)).toEqual({
      passkey: true,
      discoverable: true,
    });
  });

  it.each<[string, Awaited<ReturnType<PasskeySource["candidates"]>>]>([
    ["an incomplete search", { complete: false, candidates: [stored(first)] }],
    [
      "a passkey with a counter",
      { complete: true, candidates: [{ ...stored(first), counter: 3 }] },
    ],
    ["no passkey", { complete: true, candidates: [] }],
    ["no answer", undefined],
  ])("counts %s as no passkey", async (_label, answer) => {
    expect(
      await itemPasskeyFacts({ candidates: vi.fn(async () => answer) }, { origin, ...only }),
    ).toEqual({ passkey: false, discoverable: false });
  });
});

describe("the items holding a passkey for an origin (ADR 0034)", () => {
  /** A passkey the vault search found, as the vault source answers it. */
  const found = (id: string, connectionId = "live"): VaultPasskeyCandidate => ({
    ...stored(id, connectionId),
    settingsRevision: 1,
  });

  it("searches once per RP ID the origin may use, across every connection", async () => {
    const candidates = vi.fn<PasskeySource<VaultPasskeyCandidate>["candidates"]>(
      async (_origin, candidateRpId) => ({
        complete: true,
        candidates:
          candidateRpId === "github.com"
            ? [found(first), found(first, "other"), found(second)]
            : [found(first)],
      }),
    );
    expect(await originPasskeyItems({ candidates }, "https://login.github.com")).toEqual([
      { connectionId: "live", itemId: first },
      // The same item ID in another connection is another item.
      { connectionId: "other", itemId: first },
      { connectionId: "live", itemId: second },
    ]);
    expect(candidates.mock.calls.map(([at, candidateRpId]) => [at, candidateRpId])).toEqual([
      ["https://login.github.com", "login.github.com"],
      ["https://login.github.com", "github.com"],
    ]);
    // Not limited to one item.
    for (const call of candidates.mock.calls) expect(call[3]).toBeUndefined();
  });

  it("keeps only discoverable passkeys with a user handle and a zero counter", async () => {
    const candidates = vi.fn<PasskeySource<VaultPasskeyCandidate>["candidates"]>(async () => ({
      complete: true,
      candidates: [
        { ...found(first), counter: 3 },
        { ...found(second), discoverable: false },
        { ...found(excluded), userHandle: null },
        found(passkeyOnly),
      ],
    }));
    expect(await originPasskeyItems({ candidates }, origin)).toEqual([
      { connectionId: "live", itemId: passkeyOnly },
    ]);
  });

  it("takes nothing from a search without an answer", async () => {
    const answers: Awaited<ReturnType<PasskeySource<VaultPasskeyCandidate>["candidates"]>>[] = [
      undefined,
      { complete: true, candidates: [found(second)] },
    ];
    const candidates = vi.fn<PasskeySource<VaultPasskeyCandidate>["candidates"]>(async () =>
      answers.shift(),
    );
    // The other RP ID's answer still counts.
    expect(await originPasskeyItems({ candidates }, "https://login.github.com")).toEqual([
      { connectionId: "live", itemId: second },
    ]);
    expect(candidates).toHaveBeenCalledTimes(2);
  });

  it("keeps the passkeys a search found when it could not reach every item", async () => {
    // Another connection or item could not be searched, as in a locked vault.
    const candidates = vi.fn<PasskeySource<VaultPasskeyCandidate>["candidates"]>(async () => ({
      complete: false,
      candidates: [found(first), { ...found(second), userHandle: null }],
    }));
    expect(await originPasskeyItems({ candidates }, origin)).toEqual([
      { connectionId: "live", itemId: first },
    ]);
    candidates.mockResolvedValue({ complete: false, candidates: [] });
    expect(await originPasskeyItems({ candidates }, origin)).toEqual([]);
  });

  it("searches nothing for an origin without an RP ID", async () => {
    const candidates = vi.fn<PasskeySource<VaultPasskeyCandidate>["candidates"]>();
    expect(await originPasskeyItems({ candidates }, "http://login.github.com")).toEqual([]);
    expect(candidates).not.toHaveBeenCalled();
  });
});

describe("vault passkey source", () => {
  const signature = "MAYCAQECAQE";
  function runtime(
    settingsSequence: ReturnType<typeof saved>[],
    overrides: { signed?: Record<string, unknown>; handle?: unknown; registered?: boolean } = {},
  ) {
    const reads = [...settingsSequence];
    const manager = {
      status: () => ({ handle: "handle" in overrides ? overrides.handle : { synthetic: true } }),
      findPasskeys: vi.fn(async () => ({ ok: true as const, data: matches([first]) })),
      signPasskey: vi.fn(async () => ({
        ok: true as const,
        data: {
          connectionId: "live",
          userId,
          snapshotId,
          itemId: first,
          credentialId: "c",
          signature,
          ...overrides.signed,
        },
      })),
    };
    const connections = {
      settings: {
        read: vi.fn(async () => reads[0]!.snapshot),
        handle: vi.fn(async () => (reads.length > 1 ? reads.shift()! : reads[0]!)),
      },
      registry: {
        get: vi.fn(async () =>
          overrides.registered === false ? undefined : { profile: { connectionId: "live" } },
        ),
      },
      vaultFor: vi.fn(() => ({ manager })),
    };
    return {
      manager,
      connections,
      source: createVaultPasskeySource(
        connections as unknown as Parameters<typeof createVaultPasskeySource>[0],
      ),
    };
  }
  const data = Uint8Array.from({ length: 37 }, (_, index) => index);
  const hash = Uint8Array.from({ length: 32 }, (_, index) => index);
  const signal = new AbortController().signal;

  it("signs in the Worker for a candidate whose settings and snapshot still hold", async () => {
    const { source, manager } = runtime([saved()]);
    const found = await source.candidates(origin, rpId, signal);
    const [candidate] = found!.candidates;
    expect(await source.sign(candidate!, data, hash, signal)).toEqual(
      Uint8Array.of(0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01),
    );
    expect(manager.findPasskeys).toHaveBeenCalledWith({ synthetic: true }, rpId);
    expect(manager.signPasskey).toHaveBeenCalledWith(
      { synthetic: true },
      expect.objectContaining({ itemId: first, rpId, credentialId: candidate!.credentialId }),
    );
    // The runtime's per-request signal never reaches the vault manager.
    expect(manager.signPasskey.mock.calls[0]).toHaveLength(2);
  });

  it("searches only a login's item when asked to", async () => {
    const { source } = runtime([saved({ siteDefault: second })]);
    expect(
      await source.candidates(origin, rpId, signal, { connectionId: "live", itemId: second }),
    ).toEqual({ candidates: [], complete: true });
    expect(
      await source.candidates(origin, rpId, signal, { connectionId: "live", itemId: first }),
    ).toMatchObject({ complete: true, candidates: [{ itemId: first, preferred: false }] });
  });

  it("refuses to sign after the settings revision changes before or during signing", async () => {
    const before = runtime([saved(), saved({ revision: 4 })]);
    const [stale] = (await before.source.candidates(origin, rpId, signal))!.candidates;
    await expect(before.source.sign(stale!, data, hash, signal)).rejects.toThrow("passkey-stale");
    expect(before.manager.signPasskey).not.toHaveBeenCalled();
    const during = runtime([saved(), saved(), saved({ revision: 4 })]);
    const [changed] = (await during.source.candidates(origin, rpId, signal))!.candidates;
    await expect(during.source.sign(changed!, data, hash, signal)).rejects.toThrow(
      "passkey-unavailable",
    );
  });

  it.each([
    [
      "the snapshot was replaced",
      [saved(), saved({ snapshot: otherSnapshotId })],
      {},
      "passkey-stale",
    ],
    ["the item was quarantined", [saved(), saved({ quarantine: [first] })], {}, "passkey-stale"],
    [
      "the reply names another connection",
      [saved()],
      { signed: { connectionId: "other" } },
      "passkey-unavailable",
    ],
    [
      "the reply names another account",
      [saved()],
      { signed: { userId: crypto.randomUUID() } },
      "passkey-unavailable",
    ],
    [
      "the reply names another snapshot",
      [saved()],
      { signed: { snapshotId: otherSnapshotId } },
      "passkey-unavailable",
    ],
    [
      "the reply names another item",
      [saved()],
      { signed: { itemId: second } },
      "passkey-unavailable",
    ],
  ] as const)(
    "refuses to return a signature when %s",
    async (_name, sequence, overrides, error) => {
      const { source } = runtime([...sequence], overrides);
      const [candidate] = (await source.candidates(origin, rpId, signal))!.candidates;
      await expect(source.sign(candidate!, data, hash, signal)).rejects.toThrow(error);
    },
  );

  it("reads no vault catalog for an excluded site or without an enabled connection", async () => {
    for (const [settings, expected] of [
      [saved({ excludedSite: "github.com" }), undefined],
      [saved({ enabled: false }), { candidates: [], complete: true }],
    ] as const) {
      const { source, connections, manager } = runtime([settings]);
      // eslint-disable-next-line no-await-in-loop
      expect(await source.candidates(origin, rpId, signal)).toEqual(expected);
      expect(connections.settings.handle).not.toHaveBeenCalled();
      expect(manager.findPasskeys).not.toHaveBeenCalled();
    }
  });

  it("finds nothing and signs nothing without an unlocked, registered vault", async () => {
    for (const overrides of [{ handle: undefined }, { registered: false }]) {
      const { source, manager } = runtime([saved()], overrides);
      // eslint-disable-next-line no-await-in-loop
      expect(await source.candidates(origin, rpId, signal)).toEqual({
        candidates: [],
        complete: false,
        siteDefault: "unset",
      });
      const candidate = { ...stored(first), settingsRevision: 3 };
      // eslint-disable-next-line no-await-in-loop
      await expect(source.sign(candidate, data, hash, signal)).rejects.toThrow(
        "passkey-unavailable",
      );
      expect(manager.signPasskey).not.toHaveBeenCalled();
    }
  });
});

describe("saving a chosen passkey as the site default", () => {
  const chosen = (itemId = second, overrides: Partial<VaultPasskeyCandidate> = {}) => ({
    connectionId: "live",
    userId,
    snapshotId,
    itemId,
    settingsRevision: 3,
    credentialId: "cred",
    rpId,
    userHandle: "dXNlcg",
    discoverable: true,
    counter: 0,
    ...overrides,
  });
  const store = (response = saved()) => {
    let current = response;
    const update = vi.fn(
      async (
        expected: number | undefined,
        _cause: SettingsChangeCause,
        mutate: (s: SettingsSnapshot) => SettingsSnapshot,
      ) => {
        expect(expected).toBe(current.snapshot.revision);
        current = { ...current, snapshot: mutate(current.snapshot) };
        return current.snapshot;
      },
    );
    return {
      settings: { handle: vi.fn(async () => current), update },
      update,
      defaults: () => current.snapshot.settings.siteDefaults,
    };
  };

  it("names the item by provider account and replaces the origin's earlier default", async () => {
    const replaced = store(saved({ siteDefault: first }));
    expect(
      await rememberVaultPasskey({ settings: replaced.settings, origin, candidate: chosen() }),
    ).toBe(true);
    expect(replaced.defaults()).toEqual([
      {
        origin,
        provider: "bitwarden",
        userId,
        itemId: second,
        itemName: "Synthetic 5555",
        accountName: "Live",
      },
    ]);
    // Saving the same default again writes nothing.
    expect(
      await rememberVaultPasskey({ settings: replaced.settings, origin, candidate: chosen() }),
    ).toBe(true);
    expect(replaced.update).toHaveBeenCalledOnce();
  });

  it.each([
    ["a newer settings revision", saved({ revision: 4 }), chosen()],
    ["a newer snapshot", saved({ snapshot: otherSnapshotId }), chosen()],
    ["a quarantined item", saved(), chosen(quarantined)],
    ["an excluded item", saved(), chosen(excluded)],
    ["an excluded site", saved({ excludedSite: "github.com" }), chosen()],
    // Both connections name the same account, so the default would not lead back to one.
    ["an account connected twice", saved({ other: "ready", sameAccount: true }), chosen()],
  ])("saves nothing after %s", async (_name, response, candidate) => {
    const unchanged = store(response);
    expect(await rememberVaultPasskey({ settings: unchanged.settings, origin, candidate })).toBe(
      false,
    );
    expect(unchanged.update).not.toHaveBeenCalled();
  });
});

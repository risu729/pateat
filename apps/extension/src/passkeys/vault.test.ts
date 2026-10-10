import { describe, expect, it, vi } from "vitest";
import { createDefaultSettings, type SettingsResponse, type VaultCatalog } from "@pateat/contracts";
import type { PasskeyMatches } from "../crypto/passkey";
import { vaultFailure } from "../vault/record";
import { selectPasskey } from "./select";
import { createVaultPasskeySource, findVaultPasskeys, type PasskeyFinder } from "./vault";

const snapshotId = "11111111-1111-4111-8111-111111111111";
const userId = "33333333-3333-4333-8333-333333333333";
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
    defaultConnection?: string;
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
        userId,
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
      connectionId: options.defaultConnection ?? "live",
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

const stored = (itemId: string, connectionId = "live") => ({
  connectionId,
  userId,
  snapshotId: connectionId === "live" ? snapshotId : otherSnapshotId,
  itemId,
  credentialId: `cred-${itemId.slice(0, 4)}`,
  rpId,
  userHandle: "dXNlcg",
  discoverable: true,
  counter: 0,
});
const matches = (
  ids: readonly string[],
  unavailableItemIds: string[] = [],
  connectionId = "live",
): PasskeyMatches => ({
  connectionId,
  userId,
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
    ]) {
      // eslint-disable-next-line no-await-in-loop
      const found = await findVaultPasskeys({ saved: saved(), origin, rpId, find: finder(result) });
      expect(found).toEqual({ candidates: [], complete: false });
    }
    const locked = finder({ ok: true, data: matches([first]) });
    expect(
      await findVaultPasskeys({ saved: saved({ state: "locked" }), origin, rpId, find: locked }),
    ).toEqual({ candidates: [], complete: false });
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
      saved: saved({ other: "ready", siteDefault: first, defaultConnection: "other" }),
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

  it("rejects an answer bound to another account", async () => {
    const found = await findVaultPasskeys({
      saved: saved(),
      origin,
      rpId,
      find: finder({ ok: true, data: { ...matches([first]), userId: crypto.randomUUID() } }),
    });
    expect(found).toEqual({ candidates: [], complete: false });
  });

  it("skips disabled connections and answers nothing on an excluded site", async () => {
    const find = finder({ ok: true, data: matches([first]) });
    expect(
      await findVaultPasskeys({ saved: saved({ enabled: false }), origin, rpId, find }),
    ).toEqual({ candidates: [], complete: true });
    expect(
      await findVaultPasskeys({ saved: saved({ excludedSite: "github.com" }), origin, rpId, find }),
    ).toBeUndefined();
    expect(find).not.toHaveBeenCalled();
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
      settings: { handle: vi.fn(async () => (reads.length > 1 ? reads.shift()! : reads[0]!)) },
      registry: {
        get: vi.fn(async () =>
          overrides.registered === false ? undefined : { profile: { connectionId: "live" } },
        ),
      },
      vaultFor: vi.fn(() => ({ manager })),
    };
    return {
      manager,
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

  it("finds nothing and signs nothing without an unlocked, registered vault", async () => {
    for (const overrides of [{ handle: undefined }, { registered: false }]) {
      const { source, manager } = runtime([saved()], overrides);
      // eslint-disable-next-line no-await-in-loop
      expect(await source.candidates(origin, rpId, signal)).toEqual({
        candidates: [],
        complete: false,
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

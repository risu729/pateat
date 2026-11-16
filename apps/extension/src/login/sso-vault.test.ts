import { describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  type SettingsResponse,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import { createVaultSsoSource, type SsoSourceRef } from "./sso-vault";
import {
  excludeField,
  excludeItem,
  itemPolicy,
  setAccountPolicy,
} from "../vault/__fixtures__/policy";
import type { SsoMethods, SsoCandidates } from "../crypto/sso-wire";

const sourceId = "a0000000-0000-4000-8000-000000000001";
const targetId = "a0000000-0000-4000-8000-000000000002";
const snapshotId = "b0000000-0000-4000-8000-000000000001";
const otherSnapshot = "b0000000-0000-4000-8000-000000000002";
const fieldId = `custom.${snapshotId}.0`;
const proof = "P".repeat(43);
const evidence = "E".repeat(43);
const sourceAccount = { connectionId: "site", itemId: sourceId };
const selected = {
  account: { connectionId: "idp", itemId: targetId },
  origin: "https://idp.example.test",
};
const source: SsoSourceRef = {
  account: sourceAccount,
  method: { number: 1 },
  sourceEvidence: evidence,
};
type Saved = Extract<SettingsResponse, { ok: true }>;
function connection(id: string, itemId: string): VaultConnectionMetadata {
  return {
    id,
    label: "Synthetic",
    provider: "bitwarden",
    server: "cloud-us",
    userId: id === "site" ? sourceId : targetId,
    snapshotId,
    state: "ready",
    groups: [],
    items: [
      {
        id: itemId,
        label: "Synthetic item",
        allowedOrigins: [],
        groupIds: [],
        fields: [
          { id: "login.username", label: "Username", name: null, kind: "text" },
          { id: "login.password", label: "Password", name: null, kind: "hidden" },
          ...(id === "site"
            ? [{ id: fieldId, label: "SSO", name: "SSO", kind: "text" as const }]
            : []),
        ],
      },
    ],
  };
}
function harness() {
  const catalog = { connections: [connection("site", sourceId), connection("idp", targetId)] };
  const settings = createDefaultSettings(catalog);
  for (const entry of catalog.connections) setAccountPolicy(settings, entry);
  let saved: SettingsResponse = {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision: 7, settings },
    catalog,
  };
  const methodData: SsoMethods = {
    itemId: sourceId,
    snapshotId,
    sourceEvidence: evidence,
    result: {
      status: "ready",
      methods: [
        {
          method: { number: 1 },
          fieldId,
          automatic: true,
          form: "bracket",
          label: "Private Provider Label",
          usernameProof: proof,
        },
      ],
    },
  };
  const managers = new Map(
    catalog.connections.map((entry) => [
      entry.id,
      {
        status: vi.fn(() => ({ handle: { userId: entry.userId, snapshotId: entry.snapshotId } })),
        ssoMethods: vi.fn(async (_handle: unknown, _input: unknown, _signal?: AbortSignal) => ({
          ok: true as const,
          data: structuredClone(methodData),
        })),
        ssoCandidates: vi.fn(async (_handle: unknown, _input: unknown, _signal?: AbortSignal) => ({
          ok: true as const,
          data: {
            snapshotId,
            candidates:
              entry.id === "idp"
                ? [
                    {
                      itemId: targetId,
                      origins: [selected.origin, "https://other-idp.example.test"],
                    },
                  ]
                : [],
          } as SsoCandidates,
        })),
        unlock: vi.fn(),
        restore: vi.fn(),
        resolveField: vi.fn(),
        used: vi.fn(),
        touch: vi.fn(),
      },
    ]),
  );
  const connections = {
    registry: { get: vi.fn(async (id: string) => ({ profile: { connectionId: id } })) },
    vaultFor: vi.fn((profile: { connectionId: string }) => ({
      manager: managers.get(profile.connectionId)!,
    })),
    current: vi.fn(async (id: string, _restore: boolean) => ({
      catalog: structuredClone(catalog.connections.find((entry) => entry.id === id)!),
    })),
    snapshotCurrent: vi.fn(() => true),
    used: vi.fn(),
    touch: vi.fn(),
    unlock: vi.fn(),
  };
  const readSettings = vi.fn(async () => structuredClone(saved));
  const api = createVaultSsoSource(
    connections as unknown as Parameters<typeof createVaultSsoSource>[0],
    readSettings,
  );
  return {
    api,
    connections,
    managers,
    sourceManager: managers.get("site")!,
    targetManager: managers.get("idp")!,
    readSettings,
    methodData,
    saved: () => saved as Saved,
    setSaved: (value: SettingsResponse) => {
      saved = value;
    },
  };
}
function expectNoUse(h: ReturnType<typeof harness>) {
  for (const manager of h.managers.values())
    for (const key of ["unlock", "restore", "resolveField", "used", "touch"] as const)
      expect(manager[key]).not.toHaveBeenCalled();
  expect(h.connections.used).not.toHaveBeenCalled();
  expect(h.connections.touch).not.toHaveBeenCalled();
  expect(h.connections.unlock).not.toHaveBeenCalled();
  expect(h.connections.current.mock.calls.every(([, restore]) => restore === false)).toBe(true);
}

describe("public SSO discovery and exact local selection", () => {
  it("exposes only method number, automatic status, form and label, never local field/proof/origin", async () => {
    const h = harness();
    expect(await h.api.describe(sourceAccount)).toEqual({
      ok: true,
      data: {
        sourceEvidence: evidence,
        policyRevision: 7,
        methods: [
          {
            method: { number: 1 },
            automatic: true,
            form: "bracket",
            label: "Private Provider Label",
          },
        ],
      },
    });
    h.methodData.result = {
      status: "ready",
      methods: [
        {
          method: { number: 1 },
          automatic: true,
          form: "url",
          origin: selected.origin,
          fieldId,
          usernameProof: proof,
        },
      ],
    };
    const url = await h.api.describe(sourceAccount);
    expect(url).toEqual({
      ok: true,
      data: {
        sourceEvidence: evidence,
        policyRevision: 7,
        methods: [{ method: { number: 1 }, automatic: true, form: "url" }],
      },
    });
    for (const privateValue of [proof, selected.origin, fieldId, "usernameProof"])
      expect(JSON.stringify(url)).not.toContain(privateValue);
    expectNoUse(h);
  });
  it("enumerates eligible saved accounts on every enabled connection without selecting by label", async () => {
    const h = harness();
    expect(await h.api.candidates(source)).toEqual({
      ok: true,
      data: {
        sourceEvidence: evidence,
        policyRevision: 7,
        candidates: [
          {
            account: selected.account,
            snapshotId,
            origins: [selected.origin, "https://other-idp.example.test"],
          },
        ],
      },
    });
    // The site account itself is never its own IdP account.
    expect(h.sourceManager.ssoCandidates).not.toHaveBeenCalled();
    expect(h.targetManager.ssoCandidates).toHaveBeenCalledWith(
      { userId: targetId, snapshotId },
      {
        usernameProof: proof,
        candidates: [{ itemId: targetId, allowedFieldIds: ["login.username", "login.password"] }],
      },
      undefined,
    );
    expectNoUse(h);
  });
  it("revalidates exactly the selected connection, item and origin", async () => {
    const h = harness();
    expect(await h.api.validate(source, selected)).toEqual({
      ok: true,
      data: {
        sourceEvidence: evidence,
        policyRevision: 7,
        candidates: [{ account: selected.account, snapshotId, origins: [selected.origin] }],
      },
    });
    expect(h.sourceManager.ssoCandidates).not.toHaveBeenCalled();
    expect(h.targetManager.ssoCandidates).toHaveBeenCalledOnce();
    expectNoUse(h);
    for (const choice of [
      { ...selected, origin: "https://unsaved.example.test" },
      { ...selected, account: { ...selected.account, itemId: sourceId } },
      { ...selected, account: { ...selected.account, connectionId: "unknown" } },
    ])
      // oxlint-disable-next-line no-await-in-loop -- validate each changed choice against the same live source
      expect(await h.api.validate(source, choice)).toEqual({
        ok: false,
        reason: "mapping-unresolved",
      });
  });
  it("restricts URL methods to their exact origin while keeping all bracket origins", async () => {
    const h = harness();
    h.methodData.result = {
      status: "ready",
      methods: [
        {
          method: { number: 1 },
          fieldId,
          automatic: true,
          form: "url",
          origin: selected.origin,
          usernameProof: proof,
        },
      ],
    };
    expect(await h.api.candidates(source)).toMatchObject({
      ok: true,
      data: { candidates: [{ origins: [selected.origin] }] },
    });
    expect(
      await h.api.validate(source, { ...selected, origin: "https://other-idp.example.test" }),
    ).toEqual({ ok: false, reason: "mapping-unresolved" });
  });
  it("rejects stale encrypted evidence and absent method without querying candidates", async () => {
    const h = harness();
    expect(await h.api.candidates({ ...source, sourceEvidence: "C".repeat(43) })).toEqual({
      ok: false,
      reason: "source-changed",
    });
    expect(await h.api.candidates({ ...source, method: { number: 2 } })).toEqual({
      ok: false,
      reason: "method-unavailable",
    });
    expect(h.targetManager.ssoCandidates).not.toHaveBeenCalled();
  });
  it("preserves fixed field refusal codes without inventing candidates or fallback", async () => {
    const h = harness();
    h.methodData.result = { status: "refused", reason: "invalid-value", field: "SSO" };
    expect(await h.api.describe(sourceAccount)).toEqual({
      ok: false,
      reason: "invalid-value",
      field: "SSO",
    });
    expect(await h.api.validate(source, selected)).toEqual({
      ok: false,
      reason: "invalid-value",
      field: "SSO",
    });
    expect(h.targetManager.ssoCandidates).not.toHaveBeenCalled();
    expectNoUse(h);
  });
  it("treats incomplete URI evaluation and unavailable crypto as refusal, never no-match", async () => {
    const h = harness();
    h.targetManager.ssoCandidates.mockResolvedValueOnce({
      ok: true,
      data: {
        snapshotId,
        candidates: [
          { itemId: targetId, origins: [selected.origin], unavailable: "uri-unavailable" },
        ],
      },
    });
    expect(await h.api.candidates(source)).toEqual({ ok: false, reason: "uri-unavailable" });
    h.targetManager.ssoCandidates.mockResolvedValueOnce({
      ok: false,
      error: { code: "crypto-locked" },
    } as never);
    expect(await h.api.validate(source, selected)).toEqual({ ok: false, reason: "crypto-locked" });
    expectNoUse(h);
  });
});

describe("discovery policy, timeout and snapshot fences", () => {
  it.each(["pending", "failed", "throws"])(
    "refuses settings that are %s before touching a vault",
    async (kind) => {
      const h = harness();
      if (kind === "pending") h.saved().catalog.settingsSyncPending = true;
      if (kind === "failed") h.setSaved({ version: 1, ok: false, error: "unavailable" } as never);
      if (kind === "throws")
        h.readSettings.mockRejectedValueOnce(new Error("synthetic storage refusal"));
      expect(await h.api.describe(sourceAccount)).toEqual({
        ok: false,
        reason: "settings-unavailable",
      });
      expect(h.connections.current).not.toHaveBeenCalled();
    },
  );
  it.each([
    "disabled",
    "excluded",
    "not-selected",
    "quarantine",
    "unavailable",
    "snapshot",
    "provider",
    "review",
  ])("refuses source policy/state %s before any method query", async (kind) => {
    const h = harness();
    const saved = h.saved();
    const site = saved.catalog.connections[0]!;
    if (kind === "disabled") setAccountPolicy(saved.snapshot.settings, site, false);
    if (kind === "excluded") excludeItem(saved.snapshot.settings, site, sourceId);
    if (kind === "not-selected")
      setAccountPolicy(saved.snapshot.settings, site, true, { mode: "selected", groups: [] });
    if (kind === "quarantine") site.quarantinedItemIds = [sourceId];
    if (kind === "unavailable") site.state = "unavailable";
    if (kind === "snapshot") site.snapshotId = undefined;
    if (kind === "provider") site.provider = "dummy";
    if (kind === "review")
      itemPolicy(saved.snapshot.settings, site, sourceId).excludedFields = [
        { name: "SSO", kind: "text" } as never,
      ];
    const answer = await h.api.describe(sourceAccount);
    expect(answer.ok).toBe(false);
    expect(h.sourceManager.ssoMethods).not.toHaveBeenCalled();
    expectNoUse(h);
  });
  it("passes only allowed field IDs and removes targets with excluded native usernames", async () => {
    const h = harness();
    const saved = h.saved();
    excludeField(saved.snapshot.settings, saved.catalog.connections[0]!, sourceId, fieldId);
    excludeField(
      saved.snapshot.settings,
      saved.catalog.connections[1]!,
      targetId,
      "login.username",
    );
    await h.api.candidates(source);
    expect(h.sourceManager.ssoMethods).toHaveBeenCalledWith(
      expect.anything(),
      { itemId: sourceId, allowedFieldIds: ["login.username", "login.password"] },
      undefined,
    );
    expect(h.targetManager.ssoCandidates).not.toHaveBeenCalled();
  });
  it.each(["timeout", "snapshot", "user", "closed"])(
    "refuses a %s during initial live checks without restore/unlock",
    async (kind) => {
      const h = harness();
      if (kind === "timeout")
        h.connections.current.mockRejectedValueOnce(new Error("vault timeout"));
      if (kind === "snapshot")
        h.connections.current.mockResolvedValueOnce({
          catalog: { ...h.saved().catalog.connections[0]!, snapshotId: otherSnapshot },
        });
      if (kind === "user")
        h.sourceManager.status.mockReturnValueOnce({ handle: { snapshotId, userId: targetId } });
      if (kind === "closed") h.sourceManager.status.mockReturnValueOnce({} as never);
      expect(await h.api.describe(sourceAccount)).toEqual({
        ok: false,
        reason: "vault-unavailable",
      });
      expect(h.sourceManager.ssoMethods).not.toHaveBeenCalled();
      expectNoUse(h);
    },
  );
  it("drops a method result when policy revision changes during the final current(false) await", async () => {
    const h = harness();
    let checks = 0;
    h.connections.current.mockImplementation(async (id) => {
      checks += 1;
      if (checks === 2) h.saved().snapshot.revision += 1;
      return {
        catalog: structuredClone(h.saved().catalog.connections.find((entry) => entry.id === id)!),
      };
    });
    expect(await h.api.describe(sourceAccount)).toEqual({ ok: false, reason: "scope-changed" });
    expect(h.readSettings).toHaveBeenCalledTimes(2);
    expectNoUse(h);
  });
  it.each([
    ["keeps", "passkey-browser-site", true],
    ["keeps", "detail-refused", true],
    ["keeps", "sso-mapping", true],
    ["drops", "account-choice", false],
  ] as const)(
    "%s a validation across a revision whose only cause is %s",
    async (_name, cause, kept) => {
      const h = harness();
      h.targetManager.ssoCandidates.mockImplementationOnce(async () => {
        const { snapshot } = h.saved();
        snapshot.revision += 1;
        snapshot.changes = [{ revision: snapshot.revision, cause }];
        return {
          ok: true,
          data: { snapshotId, candidates: [{ itemId: targetId, origins: [selected.origin] }] },
        };
      });
      expect((await h.api.validate(source, selected)).ok).toBe(kept);
    },
  );
  it.each(["revision", "catalog", "snapshot", "timeout", "pending"])(
    "drops candidate results after final %s change",
    async (kind) => {
      const h = harness();
      h.targetManager.ssoCandidates.mockImplementationOnce(async () => {
        if (kind === "revision") h.saved().snapshot.revision += 1;
        if (kind === "catalog") h.saved().catalog.connections[1]!.quarantinedItemIds = [targetId];
        if (kind === "snapshot") h.connections.snapshotCurrent.mockReturnValue(false);
        if (kind === "timeout") h.connections.current.mockRejectedValue(new Error("vault expired"));
        if (kind === "pending") h.saved().catalog.settingsSyncPending = true;
        return {
          ok: true,
          data: { snapshotId, candidates: [{ itemId: targetId, origins: [selected.origin] }] },
        };
      });
      expect(await h.api.validate(source, selected)).toEqual({
        ok: false,
        reason: "scope-changed",
      });
      expectNoUse(h);
    },
  );
  it("does not silently ignore an enabled unavailable target connection", async () => {
    const h = harness();
    h.saved().catalog.connections[1]!.state = "unavailable";
    expect(await h.api.candidates(source)).toEqual({ ok: false, reason: "vault-unavailable" });
    expect(h.targetManager.ssoCandidates).not.toHaveBeenCalled();
  });
  it("skips disabled target accounts during discovery but refuses explicit selection of them", async () => {
    const h = harness();
    setAccountPolicy(h.saved().snapshot.settings, h.saved().catalog.connections[1]!, false);
    expect(await h.api.candidates(source)).toEqual({
      ok: true,
      data: { sourceEvidence: evidence, policyRevision: 7, candidates: [] },
    });
    expect(await h.api.validate(source, selected)).toEqual({
      ok: false,
      reason: "mapping-unresolved",
    });
    expect(h.targetManager.ssoCandidates).not.toHaveBeenCalled();
  });
});

describe("large-vault SSO candidate enumeration", () => {
  function largeVault() {
    const h = harness();
    const target = h.saved().catalog.connections[1]!;
    const template = target.items[0]!;
    const ids = Array.from(
      { length: 2001 },
      (_, index) => `d0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    );
    target.items = ids.map((id) => ({ ...structuredClone(template), id }));
    h.targetManager.ssoCandidates.mockImplementation(async (_handle, rawInput) => {
      const input = rawInput as { candidates: { itemId: string }[] };
      if (input.candidates.length > 2000)
        return { ok: false, error: { code: "invalid-request" } } as never;
      return {
        ok: true,
        data: {
          snapshotId,
          candidates: input.candidates
            .filter((item) => item.itemId === ids.at(-1))
            .map((item) => ({ itemId: item.itemId, origins: [selected.origin] })),
        },
      };
    });
    return { ...h, ids };
  }
  it("reaches the last of 2,001 eligible candidates in bounded sequential requests", async () => {
    const h = largeVault();
    const invoke = h.targetManager.ssoCandidates.getMockImplementation()!;
    let running = 0;
    let overlapped = false;
    h.targetManager.ssoCandidates.mockImplementation(async (...args) => {
      running += 1;
      overlapped ||= running > 1;
      const answer = await invoke(...args);
      running -= 1;
      return answer;
    });
    expect(await h.api.candidates(source)).toEqual({
      ok: true,
      data: {
        sourceEvidence: evidence,
        policyRevision: 7,
        candidates: [
          {
            account: { connectionId: "idp", itemId: h.ids.at(-1) },
            snapshotId,
            origins: [selected.origin],
          },
        ],
      },
    });
    expect(
      h.targetManager.ssoCandidates.mock.calls.map(
        ([, input]) => (input as { candidates: unknown[] }).candidates.length,
      ),
    ).toEqual([2000, 1]);
    expect(overlapped).toBe(false);
    expectNoUse(h);
  });
  it.each(["revision", "snapshot"])(
    "withholds all chunks when %s changes between requests",
    async (change) => {
      const h = largeVault();
      const invoke = h.targetManager.ssoCandidates.getMockImplementation()!;
      h.targetManager.ssoCandidates.mockImplementationOnce(async (...args) => {
        const answer = await invoke(...args);
        if (change === "revision") h.saved().snapshot.revision += 1;
        if (change === "snapshot") h.connections.snapshotCurrent.mockReturnValue(false);
        return answer;
      });
      expect(await h.api.candidates(source)).toEqual({ ok: false, reason: "scope-changed" });
      expectNoUse(h);
    },
  );
});

describe("inactive vault items never provide SSO discovery authority", () => {
  it("refuses an archived/deleted source descriptor and mapping before crypto access", async () => {
    const h = harness();
    h.saved().catalog.connections[0]!.items[0]!.inactive = true;
    expect((await h.api.describe(sourceAccount)).ok).toBe(false);
    expect((await h.api.validate(source, selected)).ok).toBe(false);
    expect(h.sourceManager.ssoMethods).not.toHaveBeenCalled();
    expectNoUse(h);
  });
  it("omits inactive IdP items from discovery and refuses explicit selection", async () => {
    const h = harness();
    h.saved().catalog.connections[1]!.items[0]!.inactive = true;
    expect(await h.api.candidates(source)).toEqual({
      ok: true,
      data: { sourceEvidence: evidence, policyRevision: 7, candidates: [] },
    });
    expect((await h.api.validate(source, selected)).ok).toBe(false);
    expect(h.targetManager.ssoCandidates).not.toHaveBeenCalled();
    expectNoUse(h);
  });
});

describe("the source and SSO accounts are never the IdP account", () => {
  const siblingId = "a0000000-0000-4000-8000-000000000003";
  it("passes over the source item but not its siblings in the same vault", async () => {
    const h = harness();
    const site = h.saved().catalog.connections[0]!;
    site.items.push({ ...structuredClone(site.items[0]!), id: siblingId });
    setAccountPolicy(h.saved().snapshot.settings, site);
    await h.api.candidates(source);
    expect(h.sourceManager.ssoCandidates).toHaveBeenCalledOnce();
    const [, input] = h.sourceManager.ssoCandidates.mock.calls[0]!;
    expect((input as { candidates: { itemId: string }[] }).candidates).toEqual([
      expect.objectContaining({ itemId: siblingId }),
    ]);
  });
  it("refuses choosing the source item as its own IdP account", async () => {
    const h = harness();
    for (const account of [sourceAccount, { ...sourceAccount, itemId: sourceId.toUpperCase() }])
      // oxlint-disable-next-line no-await-in-loop -- each choice is refused before any read
      expect(await h.api.validate(source, { account, origin: selected.origin })).toEqual({
        ok: false,
        reason: "source-item",
      });
    expect(h.sourceManager.ssoMethods).not.toHaveBeenCalled();
    expect(h.sourceManager.ssoCandidates).not.toHaveBeenCalled();
    expectNoUse(h);
  });
  it("passes over an account that signs in through an IdP, and refuses choosing it", async () => {
    const h = harness();
    const nested = {
      ok: true as const,
      data: {
        snapshotId,
        candidates: [{ itemId: targetId, origins: [], unavailable: "signs-in-with-sso" as const }],
      },
    };
    h.targetManager.ssoCandidates.mockResolvedValue(nested);
    expect(await h.api.candidates(source)).toEqual({
      ok: true,
      data: { sourceEvidence: evidence, policyRevision: 7, candidates: [] },
    });
    expect(await h.api.validate(source, selected)).toEqual({
      ok: false,
      reason: "signs-in-with-sso",
    });
    expectNoUse(h);
  });
});

describe("unrelated URI rules on a chosen IdP item", () => {
  const partial = (origins: string[]) => ({
    ok: true as const,
    data: {
      snapshotId,
      candidates: [{ itemId: targetId, origins, unavailable: "uri-unavailable" as const }],
    },
  });
  it("validates a chosen concrete origin beside an unevaluable sibling rule", async () => {
    const h = harness();
    h.targetManager.ssoCandidates.mockResolvedValueOnce(partial([selected.origin]));
    expect(await h.api.validate(source, selected)).toEqual({
      ok: true,
      data: {
        sourceEvidence: evidence,
        policyRevision: 7,
        candidates: [{ account: selected.account, snapshotId, origins: [selected.origin] }],
      },
    });
  });
  it("still refuses when the chosen origin is not among the concrete ones", async () => {
    const h = harness();
    h.targetManager.ssoCandidates.mockResolvedValueOnce(partial(["https://other.example.test"]));
    expect(await h.api.validate(source, selected)).toEqual({
      ok: false,
      reason: "uri-unavailable",
    });
  });
});

describe("discovery fences every connection it considered", () => {
  const quietId = "a0000000-0000-4000-8000-000000000004";
  function withQuietVault() {
    const h = harness();
    const quiet = { ...connection("quiet", quietId), userId: quietId };
    h.saved().catalog.connections.push(quiet);
    setAccountPolicy(h.saved().snapshot.settings, quiet);
    // No candidate is asked of this vault: its only item's username is excluded.
    excludeField(h.saved().snapshot.settings, quiet, quietId, "login.username");
    return { ...h, quiet };
  }
  it("drops discovery when a sync adds an item to a vault that had no candidates", async () => {
    const h = withQuietVault();
    expect((await h.api.candidates(source)).ok).toBe(true);
    h.targetManager.ssoCandidates.mockImplementationOnce(async () => {
      const quiet = h.saved().catalog.connections[2]!;
      quiet.items.push({
        ...structuredClone(quiet.items[0]!),
        id: "a0000000-0000-4000-8000-000000000005",
      });
      return { ok: true, data: { snapshotId, candidates: [] } };
    });
    expect(await h.api.candidates(source)).toEqual({ ok: false, reason: "scope-changed" });
    expectNoUse(h);
  });
  it("drops discovery when a connection is added meanwhile", async () => {
    const h = harness();
    h.targetManager.ssoCandidates.mockImplementationOnce(async () => {
      h.saved().catalog.connections.push(connection("added", quietId));
      return { ok: true, data: { snapshotId, candidates: [] } };
    });
    expect(await h.api.candidates(source)).toEqual({ ok: false, reason: "scope-changed" });
  });
  it("does not drop a validation for a change in a vault it did not choose", async () => {
    const h = withQuietVault();
    h.targetManager.ssoCandidates.mockImplementationOnce(async () => {
      h.saved().catalog.connections[2]!.items[0]!.label = "Renamed elsewhere";
      return {
        ok: true,
        data: { snapshotId, candidates: [{ itemId: targetId, origins: [selected.origin] }] },
      };
    });
    expect((await h.api.validate(source, selected)).ok).toBe(true);
  });
});

describe("cancellation", () => {
  it("passes the caller's signal to each vault request", async () => {
    const h = harness();
    const { signal } = new AbortController();
    await h.api.describe(sourceAccount, signal);
    await h.api.candidates(source, signal);
    await h.api.validate(source, selected, signal);
    for (const call of h.sourceManager.ssoMethods.mock.calls) expect(call[2]).toBe(signal);
    for (const call of h.targetManager.ssoCandidates.mock.calls) expect(call[2]).toBe(signal);
    expect(h.sourceManager.ssoMethods).toHaveBeenCalledTimes(3);
    expect(h.targetManager.ssoCandidates).toHaveBeenCalledTimes(2);
  });
  it("asks for no further batch once the signal is aborted", async () => {
    const h = harness();
    const target = h.saved().catalog.connections[1]!;
    target.items = Array.from({ length: 2001 }, (_, index) => ({
      ...structuredClone(target.items[0]!),
      id: `d0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    }));
    const controller = new AbortController();
    h.targetManager.ssoCandidates.mockImplementation(async () => {
      controller.abort();
      return { ok: true, data: { snapshotId, candidates: [] } };
    });
    expect(await h.api.candidates(source, controller.signal)).toEqual({
      ok: false,
      reason: "cancelled",
    });
    expect(h.targetManager.ssoCandidates).toHaveBeenCalledOnce();
  });
});

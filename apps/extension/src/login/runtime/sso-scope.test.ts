import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  parseAttemptMetadata,
  type SettingsResponse,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import { setAccountPolicy } from "../../vault/__fixtures__/policy";
import type { Runtime } from "./state";
import type { SsoWork } from "./sso-state";
import { ssoChildOn, ssoCurrent, ssoScope } from "./sso-scope";

const seams = vi.hoisted(() => ({
  tab: vi.fn(),
  pause: vi.fn(),
  match: vi.fn(),
}));
vi.mock("wxt/browser", () => ({ browser: { tabs: { get: seams.tab } } }));
vi.mock("./pause", () => ({ pauseOf: seams.pause }));
vi.mock("./plan", () => ({ itemMatchesUrl: seams.match }));
const rp = "https://rp.example.test";
const idp = "https://idp.example.test";
const rpItem = "a0000000-0000-4000-8000-000000000001";
const idpItem = "a0000000-0000-4000-8000-000000000002";
const snapshotId = "b0000000-0000-4000-8000-000000000001";
const connection = (id: string, itemId: string): VaultConnectionMetadata => ({
  id,
  label: "Synthetic " + id,
  provider: "bitwarden",
  server: "cloud-us",
  userId: itemId,
  snapshotId,
  state: "ready",
  groups: [],
  items: [
    {
      id: itemId,
      label: "Synthetic item",
      allowedOrigins: [],
      groupIds: [],
      fields: [{ id: "login.username", label: "Username", name: null, kind: "text" }],
    },
  ],
});
function harness() {
  const catalog = { connections: [connection("rp", rpItem), connection("idp", idpItem)] };
  const settings = createDefaultSettings(catalog);
  for (const entry of catalog.connections) setAccountPolicy(settings, entry);
  const saved: Extract<SettingsResponse, { ok: true }> = {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision: 3, settings },
    catalog,
  };
  let current = structuredClone(saved);
  const live = {
    document: { origin: rp, tabId: 7, frameId: 0, documentId: "rp-document" },
    token: "rp-token",
    url: rp + "/signin",
    path: "/signin",
    incognito: false,
    seenAt: Date.now(),
    timing: { since: 1, serviceMs: 0, networkMs: 0, personMs: 0 },
  };
  const account = { origin: rp, connectionId: "rp", itemId: rpItem };
  const work: SsoWork = {
    id: "flow",
    account,
    chosen: { connectionId: "rp", itemId: rpItem, saved: false, source: "match" },
    source: { account, method: { number: 1 }, sourceEvidence: "E".repeat(43) },
    selected: { account: { connectionId: "idp", itemId: idpItem }, origin: idp },
    phase: "prepared",
    rpLive: live,
    live,
    saved,
    abort: new AbortController(),
    startedAt: Date.now(),
    used: new Set(),
    busy: false,
    ended: false,
  };
  const validate = vi.fn(async () => ({ ok: true, data: { policyRevision: 3 } }));
  const read = vi.fn(async () => structuredClone(current));
  const snapshot = vi.fn(() => true);
  const rt = {
    sso: { flows: new Map([[7, work]]), healthy: () => true },
    vars: { storageHealthy: true },
    documents: new Map([["7:0", live]]),
    manualStarts: new Map(),
    incognitoTabs: new Map([[7, false]]),
    persisted: new Map(),
    accountPicks: { switchingElsewhere: () => false },
    picked: new Map(),
    switchesRunning: new Set(),
    bindingReviews: new Map(),
    settings: { handle: read },
    options: { sso: { validate }, bindingSnapshotCurrent: snapshot },
    recipes: {},
  } as unknown as Runtime;
  seams.tab.mockResolvedValue({ id: 7, url: live.url, incognito: false });
  return {
    rt,
    work,
    live,
    saved,
    validate,
    read,
    snapshot,
    current: () => current,
    replace: (value: typeof current) => {
      current = value;
    },
  };
}
beforeEach(() => {
  seams.tab.mockReset();
  seams.pause.mockReset().mockResolvedValue(false);
  seams.match.mockReset().mockResolvedValue({});
});

describe("SSO live scope", () => {
  it("checks both vault accounts and origins, the exact tab URL, mapping, URI and final policy", async () => {
    const h = harness();
    expect(await ssoScope(h.rt, h.work)).toBe(true);
    expect(h.snapshot).toHaveBeenCalledWith("rp", snapshotId);
    expect(h.snapshot).toHaveBeenCalledWith("idp", snapshotId);
    expect(h.validate).toHaveBeenCalledWith(h.work.source, h.work.selected);
    expect(seams.match).toHaveBeenCalledWith(
      h.rt,
      h.current(),
      h.work.source.account,
      h.live.url,
      h.current().catalog,
    );
    expect(h.read).toHaveBeenCalledTimes(2);
    expect(h.saved).toEqual(h.current());
  });
  it.each([
    "ended",
    "aborted",
    "replaced-flow",
    "missing-document",
    "replaced-document",
    "subframe",
    "expired",
    "journal",
    "storage",
  ])("refuses %s before asynchronous authority reads", async (change) => {
    const h = harness();
    if (change === "ended") h.work.ended = true;
    if (change === "aborted") h.work.abort.abort();
    if (change === "replaced-flow") h.rt.sso.flows.delete(7);
    if (change === "missing-document") h.rt.documents.clear();
    if (change === "replaced-document") h.rt.documents.set("7:0", { ...h.live });
    if (change === "subframe") h.live.document.frameId = 1;
    if (change === "expired") h.work.startedAt = Date.now() - 600_001;
    if (change === "journal") h.rt.sso.healthy = () => false;
    if (change === "storage") h.rt.vars.storageHealthy = false;
    expect(ssoCurrent(h.rt, h.work)).toBe(false);
    expect(await ssoScope(h.rt, h.work)).toBe(false);
    expect(seams.tab).not.toHaveBeenCalled();
  });
  it.each(["manual-pick", "switch", "review", "no-sso"])(
    "refuses concurrent %s authority",
    async (change) => {
      const h = harness();
      if (change === "manual-pick") h.rt.manualStarts.set(7, { pick: {} } as never);
      if (change === "switch") h.rt.switchesRunning.add(7);
      if (change === "review") h.rt.bindingReviews.set(7, {} as never);
      if (change === "no-sso") delete h.rt.options.sso;
      expect(await ssoScope(h.rt, h.work)).toBe(false);
      expect(h.validate).not.toHaveBeenCalled();
    },
  );
  it.each([
    undefined,
    { id: 7, url: rp + "/other", incognito: false },
    { id: 7, url: rp + "/signin?changed=1", incognito: false },
    { id: 7, url: rp + "/signin", incognito: true },
    { id: 7, url: "https://unexpected.example.test/", incognito: false },
  ])("refuses mismatched or missing current tab %#", async (tab) => {
    const h = harness();
    seams.tab.mockResolvedValue(tab);
    expect(await ssoScope(h.rt, h.work)).toBe(false);
    expect(h.read).not.toHaveBeenCalled();
  });
  it("checks a child against the selected IdP's own URI, never the RP item", async () => {
    const h = harness();
    const child = {
      ...h.live,
      document: { ...h.live.document, documentId: "idp-document", origin: idp },
      url: idp + "/signin",
    };
    h.rt.documents.set("7:0", child);
    h.work.live = child;
    seams.tab.mockResolvedValue({ id: 7, url: child.url, incognito: false });
    expect(await ssoScope(h.rt, h.work, child)).toBe(true);
    expect(seams.match).toHaveBeenCalledWith(
      h.rt,
      h.current(),
      h.work.selected.account,
      child.url,
      h.current().catalog,
    );
    expect(ssoChildOn(h.rt, child.document)).toBe(h.work);
    expect(ssoChildOn(h.rt, { ...child.document, frameId: 1 })).toBeUndefined();
    expect(ssoChildOn(h.rt, { ...child.document, origin: rp })).toBeUndefined();
  });
  it.each([
    "rp-excluded",
    "idp-excluded",
    "idp-fill-only",
    "allowlist",
    "account-disabled",
    "quarantined",
    "inactive",
    "missing-snapshot",
    "stale-vault",
  ])("revalidates %s rather than treating a mapping as a grant", async (change) => {
    const h = harness();
    const current = h.current();
    if (change.endsWith("excluded"))
      current.snapshot.settings.excludedSites = [
        {
          hostname: change.startsWith("rp") ? "rp.example.test" : "idp.example.test",
          includeSubdomains: false,
        },
      ];
    if (change === "idp-fill-only")
      current.snapshot.settings.sitePagePermissions = [
        {
          hostname: "idp.example.test",
          includeSubdomains: false,
          permissions: { "sign-in": "fill" },
        },
      ];
    if (change === "allowlist") {
      current.snapshot.settings.allowedSitesEnabled = true;
      current.snapshot.settings.allowedSites = [
        { hostname: "rp.example.test", includeSubdomains: false },
      ];
    }
    if (change === "account-disabled")
      current.snapshot.settings.accountPolicies[1]!.enabled = false;
    if (change === "quarantined") current.catalog.connections[1]!.quarantinedItemIds = [idpItem];
    if (change === "inactive") current.catalog.connections[1]!.items[0]!.inactive = true;
    if (change === "missing-snapshot") delete current.catalog.connections[1]!.snapshotId;
    // Catalog changes must also match the captured catalog to reach the live eligibility checks.
    if (["quarantined", "inactive", "missing-snapshot"].includes(change))
      h.work.saved.catalog = structuredClone(current.catalog);
    if (change === "stale-vault") h.snapshot.mockReturnValue(false);
    expect(await ssoScope(h.rt, h.work)).toBe(false);
    expect(seams.match).not.toHaveBeenCalled();
  });
  it("a manual RP choice never overrides the IdP's fill-only permission", async () => {
    const h = harness();
    h.work.chosen.source = "pick";
    h.current().snapshot.settings.pagePermissionDefaults = {
      "sign-in": "fill",
      confirm: "fill",
      "personal-details": "fill",
    };
    expect(await ssoScope(h.rt, h.work)).toBe(false);
    expect(h.validate).not.toHaveBeenCalled();
  });
  it.each(["revision", "catalog", "mapping", "mapping-revision", "uri", "paused"])(
    "rejects a changed %s result",
    async (change) => {
      const h = harness();
      if (change === "revision") h.current().snapshot.revision++;
      if (change === "catalog") h.current().catalog.connections[0]!.snapshotId = "new-snapshot";
      if (change === "mapping") h.validate.mockResolvedValue({ ok: false } as never);
      if (change === "mapping-revision")
        h.validate.mockResolvedValue({ ok: true, data: { policyRevision: 4 } });
      if (change === "uri") seams.match.mockResolvedValue({ reason: "uri-unavailable" });
      if (change === "paused") seams.pause.mockResolvedValue(true);
      expect(await ssoScope(h.rt, h.work)).toBe(false);
    },
  );
  it.each(["tab", "pause", "settings", "mapping", "uri", "final-settings"])(
    "withdraws a document replaced during the awaited %s check",
    async (stage) => {
      const h = harness();
      const replace = () => {
        h.rt.documents.set("7:0", { ...h.live, token: "new-token" });
      };
      if (stage === "tab")
        seams.tab.mockImplementationOnce(async () => {
          replace();
          return { id: 7, url: h.live.url, incognito: false };
        });
      if (stage === "pause")
        seams.pause.mockImplementationOnce(async () => {
          replace();
          return false;
        });
      if (stage === "settings")
        h.read.mockImplementationOnce(async () => {
          replace();
          return structuredClone(h.current());
        });
      if (stage === "mapping")
        h.validate.mockImplementationOnce(async () => {
          replace();
          return { ok: true, data: { policyRevision: 3 } };
        });
      if (stage === "uri")
        seams.match.mockImplementationOnce(async () => {
          replace();
          return {};
        });
      if (stage === "final-settings")
        h.read
          .mockImplementationOnce(async () => structuredClone(h.current()))
          .mockImplementationOnce(async () => {
            replace();
            return structuredClone(h.current());
          });
      expect(await ssoScope(h.rt, h.work)).toBe(false);
    },
  );
  it("rechecks policy after the provider URI await", async () => {
    const h = harness();
    seams.match.mockImplementationOnce(async () => {
      h.current().snapshot.revision++;
      return {};
    });
    expect(await ssoScope(h.rt, h.work)).toBe(false);
  });
  it("rechecks durable vault authority after the provider URI await", async () => {
    const h = harness();
    seams.match.mockImplementationOnce(async () => {
      h.snapshot.mockReturnValue(false);
      return {};
    });
    expect(await ssoScope(h.rt, h.work)).toBe(false);
  });
  it("rechecks durable vault authority after the final settings await", async () => {
    const h = harness();
    h.read
      .mockImplementationOnce(async () => structuredClone(h.current()))
      .mockImplementationOnce(async () => {
        h.snapshot.mockReturnValue(false);
        return structuredClone(h.current());
      });
    expect(await ssoScope(h.rt, h.work)).toBe(false);
  });
  it("requires the same SSO recipe revision and targets after the recipe lookup", async () => {
    const h = harness();
    h.rt.recipes.ssoFence = vi.fn(async () => () => true);
    h.work.recipe = {
      version: 1,
      id: "synthetic-sso",
      revision: 1,
      origin: rp,
      sso: {
        path: "/signin",
        layouts: [
          {
            key: "sso",
            createdAt: 1,
            entries: [{ label: "Synthetic", target: { by: "id", value: "entry" } }],
          },
        ],
      },
    };
    const changed = structuredClone(h.work.recipe);
    changed.revision++;
    h.rt.recipes.sso = vi.fn(async () => [changed]);
    expect(await ssoScope(h.rt, h.work)).toBe(false);
  });
  it("withdraws a vault invalidated during the recipe await", async () => {
    const h = harness();
    h.rt.recipes.ssoFence = vi.fn(async () => () => true);
    h.work.recipe = {
      version: 1,
      id: "synthetic-sso",
      revision: 1,
      origin: rp,
      sso: {
        path: "/signin",
        layouts: [
          {
            key: "sso",
            createdAt: 1,
            entries: [{ label: "Synthetic", target: { by: "id", value: "entry" } }],
          },
        ],
      },
    };
    h.rt.recipes.sso = vi.fn(async () => {
      h.snapshot.mockReturnValue(false);
      return [h.work.recipe!];
    });
    expect(await ssoScope(h.rt, h.work)).toBe(false);
  });
  it("withdraws a recipe invalidated during the final settings await", async () => {
    const h = harness();
    h.work.recipe = {
      version: 1,
      id: "synthetic-sso",
      revision: 1,
      origin: rp,
      sso: {
        path: "/signin",
        layouts: [
          {
            key: "sso",
            createdAt: 1,
            entries: [{ label: "Synthetic", target: { by: "id", value: "entry" } }],
          },
        ],
      },
    };
    let currentRecipe = true;
    h.rt.recipes.sso = vi.fn(async () => [h.work.recipe!]);
    h.rt.recipes.ssoFence = vi.fn(async () => () => currentRecipe);
    h.read
      .mockImplementationOnce(async () => structuredClone(h.current()))
      .mockImplementationOnce(async () => {
        currentRecipe = false;
        return structuredClone(h.current());
      });
    expect(await ssoScope(h.rt, h.work)).toBe(false);
  });
  it("a single-page RP pick never overrides RP or IdP fill policy for an SSO hop", async () => {
    const h = harness();
    h.work.chosen.source = "pick";
    h.current().snapshot.settings.sitePagePermissions = [
      { hostname: "rp.example.test", includeSubdomains: false, permissions: { "sign-in": "fill" } },
    ];
    expect(await ssoScope(h.rt, h.work)).toBe(false);
    expect(h.validate).not.toHaveBeenCalled();
    h.current().snapshot.settings.sitePagePermissions!.push({
      hostname: "idp.example.test",
      includeSubdomains: false,
      permissions: { "sign-in": "fill" },
    });
    expect(await ssoScope(h.rt, h.work)).toBe(false);
  });
  it("does not turn an automatic RP match into the account-pick policy exception", async () => {
    const h = harness();
    h.current().snapshot.settings.sitePagePermissions = [
      { hostname: "rp.example.test", includeSubdomains: false, permissions: { "sign-in": "fill" } },
    ];
    expect(await ssoScope(h.rt, h.work)).toBe(false);
  });
  it("withdraws a flow when a newly different popup account pick supersedes it", async () => {
    const h = harness();
    h.rt.picked.set(7, { attemptId: "another-login" } as never);
    expect(await ssoScope(h.rt, h.work)).toBe(false);
    expect(h.validate).not.toHaveBeenCalled();
  });
});

describe("SSO final scope preserves real origin-busy and cookie partition rules", () => {
  const otherNative = (tabId = 8) =>
    parseAttemptMetadata({
      version: 1,
      id: "other-native",
      recipeId: "native-idp",
      recipeRevision: 1,
      policyRevision: 3,
      account: { origin: idp, connectionId: "idp", itemId: idpItem },
      route: "password",
      variant: 0,
      facts: { password: true, totp: false, passkey: false, discoverablePasskey: false },
      handlers: [],
      document: { origin: idp, tabId, frameId: 0, documentId: "other-native-document" },
      state: "awaiting-result",
      stepIndex: 0,
      stepCount: 1,
      submissions: 1,
      maxSubmissions: 1,
      retries: 0,
      maxRetries: 2,
      usedOperationIds: ["native-submit"],
      operationId: "native-submit",
      operationKind: "click",
      changedAt: Date.now(),
      timing: { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0, pageMs: 0 },
    });
  it.each(["rp", "idp"])("refuses another live SSO flow holding the %s origin", async (scope) => {
    const h = harness();
    const other = {
      ...h.work,
      id: "other-flow",
      account: { ...h.work.account, origin: scope === "rp" ? rp : "https://other-rp.example.test" },
      selected: {
        ...h.work.selected,
        origin: scope === "idp" ? idp : "https://other-idp.example.test",
      },
      rpLive: { ...h.live, document: { ...h.live.document, tabId: 8 } },
    };
    h.rt.sso.flows.set(8, other);
    h.rt.incognitoTabs.set(8, false);
    expect(await ssoScope(h.rt, h.work)).toBe(false);
    expect(h.validate).not.toHaveBeenCalled();
  });
  it("refuses an existing native IdP submission in another ordinary tab", async () => {
    const h = harness();
    h.rt.persisted.set("8 " + idp, otherNative());
    h.rt.incognitoTabs.set(8, false);
    expect(await ssoScope(h.rt, h.work)).toBe(false);
  });
  it("keeps another tab's native hold conservative when its private-window state is unknown", async () => {
    const h = harness();
    h.rt.persisted.set("8 " + idp, otherNative());
    expect(await ssoScope(h.rt, h.work)).toBe(false);
  });
  it("does not conflate separate ordinary and private cookie partitions", async () => {
    const h = harness();
    h.rt.persisted.set("8 " + idp, otherNative());
    h.rt.incognitoTabs.set(8, true);
    expect(await ssoScope(h.rt, h.work)).toBe(true);
  });
  it("does not mistake the same tab's own IdP child for another login", async () => {
    const h = harness();
    h.rt.persisted.set("7 " + idp, otherNative(7));
    expect(await ssoScope(h.rt, h.work)).toBe(true);
  });
  it("withdraws a choice if a native IdP submission starts during the awaited URI check", async () => {
    const h = harness();
    seams.match.mockImplementationOnce(async () => {
      h.rt.persisted.set("8 " + idp, otherNative());
      h.rt.incognitoTabs.set(8, false);
      return {};
    });
    expect(await ssoScope(h.rt, h.work)).toBe(false);
  });
});

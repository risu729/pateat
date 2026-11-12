import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDefaultSettings,
  parseAttemptMetadata,
  type LoginRecipe,
  type SettingsResponse,
  type SsoRecipeDocument,
  type VaultConnectionMetadata,
} from "@pateat/contracts";
import { setAccountPolicy } from "../../vault/__fixtures__/policy";
import type { SsoWork } from "../runtime/sso-state";
import type { Execution, LiveDocument } from "../runtime/types";
import type { AdmitContext } from "../runtime/admit-context";
const fake = await vi.hoisted(async () => (await import("./browser-fake")).createBrowserFake());
const io = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  getItems: vi.fn(),
  setItems: vi.fn(),
}));
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
vi.mock("wxt/utils/storage", () => ({ storage: io }));
const { createRuntimeState } = await import("../runtime/state");
const { ssoAdmit } = await import("../runtime/sso/flow");
const { heldElsewhere } = await import("../runtime/hold");
const { createLoginBadge, memoryBadgeStorage } = await import("../badge");
const rp = "https://rp.example.test";
const idp = "https://idp.example.test";
const rpItem = "a0000000-0000-4000-8000-000000000001";
const idpItem = "a0000000-0000-4000-8000-000000000002";
const snapshotId = "b0000000-0000-4000-8000-000000000001";
const username = "synthetic@example.test";
const delivered = vi.spyOn(fake.browser.tabs, "sendMessage");
const connection = (id: string, itemId: string, origin: string): VaultConnectionMetadata => ({
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
      allowedOrigins: [origin],
      groupIds: [],
      fields: [{ id: "login.username", label: "Username", name: null, kind: "text" }],
    },
  ],
});
function harness(
  returnReading:
    | { ok: true; identity: "match" | "different" | "absent" }
    | { ok: false; reason: string },
  marker = true,
) {
  const catalog = {
    connections: [connection("rp-vault", rpItem, rp), connection("idp-vault", idpItem, idp)],
  };
  const settings = createDefaultSettings(catalog);
  for (const entry of catalog.connections) setAccountPolicy(settings, entry);
  const saved: Extract<SettingsResponse, { ok: true }> = {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision: 3, settings },
    catalog,
  };
  const read = vi.fn(async () => structuredClone(saved));
  const update = vi.fn<NonNullable<Parameters<typeof createRuntimeState>[0]["update"]>>(
    async (_revision, _cause, mutate, authorize) => {
      if (authorize && !(await authorize(saved.snapshot, async () => saved.catalog)))
        throw new Error("scope changed");
      saved.snapshot = {
        ...mutate(structuredClone(saved.snapshot)),
        revision: saved.snapshot.revision + 1,
      };
      return structuredClone(saved.snapshot);
    },
  );
  const ssoRecipe: SsoRecipeDocument = {
    version: 1,
    id: "synthetic-sso",
    revision: 1,
    origin: rp,
    sso: {
      path: "/signin",
      layouts: [
        {
          key: "1000",
          createdAt: 1,
          entries: [{ label: "Synthetic", target: { by: "id", value: "sso-entry" } }],
        },
      ],
    },
  };
  const markerRecipe: LoginRecipe = {
    version: 1,
    id: "synthetic-marker",
    revision: 1,
    origin: rp,
    pageKind: "sign-in",
    slots: ["password"],
    steps: [
      {
        kind: "fill",
        effect: "prepare",
        path: "/signin",
        fields: [{ slot: "password", target: { by: "id", value: "password" } }],
      },
      { kind: "click", path: "/signin", target: { by: "id", value: "submit" }, purpose: "submit" },
    ],
    completion: [{ target: { by: "id", value: "authenticated" } }],
    maxSubmissions: 1,
  };
  const signedIn = vi.fn();
  const fields = vi.fn(async () => username);
  const rt = createRuntimeState(
    { handle: read, update },
    {
      fields,
      signedIn,
      badge: createLoginBadge({ setBadge: vi.fn(), storage: memoryBadgeStorage() }),
      recipes: {
        recipe: async () => undefined,
        entries: async () => [],
        starts: async () => [],
        routes: async () => [markerRecipe],
        sso: async () => [ssoRecipe],
        ssoFence: async () => () => true,
      },
      sso: {
        describe: vi.fn(),
        candidates: vi.fn(),
        validate: vi.fn(async () => ({
          ok: true as const,
          data: { policyRevision: 3, sourceEvidence: "E".repeat(43), candidates: [] },
        })),
      },
      bindingSnapshotCurrent: () => true,
    },
  );
  rt.attemptRecords.write = vi.fn(async () => undefined);
  const timing = { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0 };
  const live: LiveDocument = {
    document: { origin: rp, tabId: 7, frameId: 0, documentId: "returned-rp" },
    token: "return-token",
    url: rp + "/home",
    path: "/home",
    incognito: false,
    seenAt: Date.now(),
    timing,
  };
  const rpLive = {
    ...live,
    document: { ...live.document, documentId: "initial-rp" },
    path: "/signin",
    url: rp + "/signin",
  };
  const account = { origin: rp, connectionId: "rp-vault", itemId: rpItem };
  const parent = parseAttemptMetadata({
    version: 1,
    id: "sso-parent",
    recipeId: ssoRecipe.id,
    recipeRevision: 1,
    layout: "1000",
    policyRevision: 3,
    account,
    route: "sso",
    ssoParent: true,
    facts: { password: false, totp: false, passkey: false, discoverablePasskey: false },
    handlers: [],
    document: rpLive.document,
    state: "reconciling",
    stepIndex: 0,
    stepCount: 1,
    submissions: 1,
    maxSubmissions: 1,
    retries: 0,
    maxRetries: 2,
    usedOperationIds: [],
    timing: { ...timing, pageMs: 0 },
  });
  const work: SsoWork = {
    id: parent.id,
    account,
    source: { account, method: { number: 1 }, sourceEvidence: "E".repeat(43) },
    selected: { account: { connectionId: "idp-vault", itemId: idpItem }, origin: idp },
    chosen: { connectionId: "rp-vault", itemId: rpItem, saved: false, source: "match" },
    phase: "returning-rp",
    rpLive,
    live,
    saved,
    abort: new AbortController(),
    startedAt: Date.now(),
    recipe: ssoRecipe,
    layout: "1000",
    parent,
    used: new Set(),
    busy: false,
    ended: false,
    choice: {
      connectionId: "rp-vault",
      binding: {
        origin: rp,
        provider: "bitwarden",
        server: "cloud-us",
        userId: rpItem,
        itemId: rpItem,
        itemName: "Synthetic RP",
      },
    },
  };
  rt.documents.set("7:0", live);
  rt.sso.flows.set(7, work);
  const ctx = {
    document: live.document,
    live,
    key: "7:0",
    refuse: vi.fn((reason: string) => ({ ok: false as const, reason })),
  } as unknown as AdmitContext;
  fake.state.tabUrls[7] = live.url;
  delivered.mockImplementation(async (_id, message) => {
    if (message["type"] === "login.sso.return") return returnReading;
    if (message["type"] === "login.state")
      return {
        ok: true,
        loaded: true,
        signs: {
          password: false,
          code: false,
          captcha: false,
          invalid: false,
          alert: false,
          username: true,
        },
      };
    if (message["type"] === "login.sso.inspect") return { ok: false, reason: "missing" };
    if (message["type"] === "login.observe")
      return {
        path: live.path,
        targets: (message["targets"] as { value?: string }[]).map((target) =>
          target.value === "authenticated" && marker ? "unique" : "missing",
        ),
      };
    return { ok: true };
  });
  return { rt, work, ctx, saved, update, signedIn, fields };
}
beforeEach(() => {
  io.getItem.mockReset().mockResolvedValue(null);
  io.setItem.mockReset().mockResolvedValue(undefined);
  io.getItems.mockReset().mockResolvedValue([]);
  io.setItems.mockReset().mockResolvedValue(undefined);
  delivered.mockReset();
  fake.state.tabUrls = {};
  fake.state.incognito = new Set();
});

describe("actual SSO RP-return admission and final evidence", () => {
  it("explicitly different local identity defeats both a generic marker and generic username=true", async () => {
    const h = harness({ ok: true, identity: "different" });
    await Promise.all([h.rt.sso.loaded, h.rt.confirmFill.loaded]);
    expect(await ssoAdmit(h.rt, h.ctx)).toEqual({ ok: false, reason: "sso-return-unconfirmed" });
    expect(h.work.parent?.state).toBe("blocked");
    expect(h.work.parent?.account.origin).toBe(rp);
    expect(h.update).not.toHaveBeenCalled();
    expect(h.rt.confirmFill.proofs).toEqual([]);
    expect(h.signedIn).not.toHaveBeenCalled();
    expect(
      delivered.mock.calls.some(
        ([, message]) => message["type"] === "login.state" || message["type"] === "login.observe",
      ),
    ).toBe(false);
  });
  it.each(["consent", "sharing", "signup"])(
    "an unsafe %s return defeats a matching identity and marker",
    async () => {
      const h = harness({ ok: false, reason: "unsafe-return" });
      await Promise.all([h.rt.sso.loaded, h.rt.confirmFill.loaded]);
      expect(await ssoAdmit(h.rt, h.ctx)).toEqual({ ok: false, reason: "sso-return-unconfirmed" });
      expect(h.work.parent?.state).toBe("blocked");
      expect(h.update).not.toHaveBeenCalled();
      expect(h.rt.confirmFill.proofs).toEqual([]);
      expect(h.signedIn).not.toHaveBeenCalled();
      expect(
        delivered.mock.calls.some(
          ([, message]) => message["type"] === "login.state" || message["type"] === "login.observe",
        ),
      ).toBe(false);
    },
  );
  it("accepts fresh RP marker evidence when selected identity is absent, retaining the RP account", async () => {
    const h = harness({ ok: true, identity: "absent" }, true);
    await Promise.all([h.rt.sso.loaded, h.rt.confirmFill.loaded]);
    expect(await ssoAdmit(h.rt, h.ctx)).toEqual({ ok: false, reason: "sso-completed" });
    expect(h.work.parent?.state).toBe("authenticated");
    expect(h.work.parent?.account).toEqual(h.work.account);
    expect(h.rt.confirmFill.proofs).toContainEqual(
      expect.objectContaining({ id: h.work.id, origin: rp, itemId: rpItem }),
    );
    expect(h.rt.confirmFill.proofs.some((proof) => proof.origin === idp)).toBe(false);
    expect(h.saved.snapshot.settings.siteDefaults).toContainEqual(
      expect.objectContaining({ origin: rp, itemId: rpItem }),
    );
    expect(h.saved.snapshot.settings.siteDefaults.some((entry) => entry.origin === idp)).toBe(
      false,
    );
    expect(h.signedIn).toHaveBeenCalledWith(7, rp);
  });
  it("absence of both exact local identity and a fresh marker never authenticates", async () => {
    const h = harness({ ok: true, identity: "absent" }, false);
    await Promise.all([h.rt.sso.loaded, h.rt.confirmFill.loaded]);
    expect(await ssoAdmit(h.rt, h.ctx)).toEqual({ ok: false, reason: "sso-return-unconfirmed" });
    expect(h.update).not.toHaveBeenCalled();
    expect(h.rt.confirmFill.proofs).toEqual([]);
    expect(h.signedIn).not.toHaveBeenCalled();
  });
});

describe("actual SSO judge continuation rechecks local RP evidence", () => {
  it.each(["stable", "entry-returns", "unsafe-return", "different-identity", "marker-disappears"])(
    "does not carry a pre-judge observation across %s",
    async (change) => {
      const h = harness({ ok: true, identity: "absent" }, false);
      await Promise.all([h.rt.sso.loaded, h.rt.confirmFill.loaded]);
      const learned = structuredClone(h.work.recipe!);
      learned.revision++;
      learned.sso.layouts[0]!.completion = [{ target: { by: "id", value: "learned-marker" } }];
      let judged = false;
      let marker = true;
      const judgeSso = vi.fn(async () => {
        judged = true;
        h.rt.recipes.sso = async () => [learned];
        return { signedIn: true, recipe: learned };
      });
      h.rt.generation = {
        available: async () => true as const,
        generate: vi.fn(),
        generateEntry: vi.fn(),
        slotFields: async () => undefined,
        judge: vi.fn(),
        judgeSso,
      };
      const baseDelivery = delivered.getMockImplementation()!;
      delivered.mockImplementation(async (tabId, message, options) => {
        if (message["type"] === "login.extract")
          return {
            ok: true,
            observation: {
              version: 1,
              origin: rp,
              path: "/home",
              language: "en",
              complete: true,
              candidates: [
                {
                  id: "marker",
                  role: "button",
                  target: { by: "id", value: "learned-marker" },
                  label: "Account menu",
                },
              ],
            },
          };
        if (judged && message["type"] === "login.sso.inspect" && change === "entry-returns")
          return { ok: true, url: rp + "/home", destinations: [] };
        if (
          judged &&
          message["type"] === "login.observe" &&
          change === "entry-returns" &&
          (message["targets"] as { value?: string }[]).some(
            (target) => target.value === "sso-entry",
          )
        )
          return { path: "/home", targets: ["unique"] };
        if (judged && message["type"] === "login.sso.return") {
          if (change === "unsafe-return") return { ok: false, reason: "unsafe-return" };
          if (change === "different-identity") return { ok: true, identity: "different" };
          if (change === "marker-disappears") marker = false;
        }
        if (
          message["type"] === "login.observe" &&
          (message["targets"] as { value?: string }[]).some(
            (target) => target.value === "learned-marker",
          )
        )
          return { path: "/home", targets: [marker ? "unique" : "missing"] };
        return baseDelivery(tabId, message, options);
      });
      const result = await ssoAdmit(h.rt, h.ctx);
      expect(judgeSso).toHaveBeenCalledTimes(1);
      if (change === "stable") {
        expect(result).toEqual({ ok: false, reason: "sso-completed" });
        expect(h.work.parent).toMatchObject({
          state: "authenticated",
          recipeRevision: learned.revision,
        });
        expect(h.update).toHaveBeenCalledTimes(1);
        expect(h.rt.confirmFill.proofs).toContainEqual(expect.objectContaining({ origin: rp }));
      } else {
        expect(result).toEqual({ ok: false, reason: "sso-return-unconfirmed" });
        expect(h.work.parent?.state).toBe("blocked");
        expect(h.update).not.toHaveBeenCalled();
        expect(h.rt.confirmFill.proofs).toEqual([]);
        expect(h.signedIn).not.toHaveBeenCalled();
      }
    },
  );
});

describe("URL-form RP return does not compare the IdP identifier as an RP username", () => {
  it.each([true, false])(
    "requires fresh RP proof with a different RP display name (marker=%s)",
    async (marker) => {
      const h = harness({ ok: true, identity: "absent" }, marker);
      h.work.form = "url";
      await Promise.all([h.rt.sso.loaded, h.rt.confirmFill.loaded]);
      const baseDelivery = delivered.getMockImplementation()!;
      delivered.mockImplementation(async (tabId, message, options) => {
        if (message["type"] === "login.sso.return") {
          expect(message).not.toHaveProperty("username");
          return { ok: true, identity: "absent" };
        }
        if (message["type"] === "login.state") {
          expect(message).not.toHaveProperty("account");
          return {
            ok: true,
            loaded: true,
            signs: {
              password: false,
              code: false,
              captcha: false,
              invalid: false,
              alert: false,
              username: false,
            },
          };
        }
        return baseDelivery(tabId, message, options);
      });
      expect(await ssoAdmit(h.rt, h.ctx)).toEqual({
        ok: false,
        reason: marker ? "sso-completed" : "sso-return-unconfirmed",
      });
      expect(h.fields).not.toHaveBeenCalled();
      if (marker) {
        expect(h.work.parent?.state).toBe("authenticated");
        expect(h.update).toHaveBeenCalledTimes(1);
        expect(h.rt.confirmFill.proofs).toContainEqual(expect.objectContaining({ origin: rp }));
      } else {
        expect(h.work.parent?.state).toBe("blocked");
        expect(h.update).not.toHaveBeenCalled();
        expect(h.rt.confirmFill.proofs).toEqual([]);
      }
    },
  );
});

describe("RP completion persistence boundaries", () => {
  it("releases the exact detached IdP child hold while preserving its historical mutation evidence", async () => {
    const h = harness({ ok: true, identity: "absent" }, true);
    await Promise.all([h.rt.sso.loaded, h.rt.confirmFill.loaded]);
    const child = parseAttemptMetadata({
      ...h.work.parent!,
      id: "historical-idp-child",
      route: "password",
      ssoParent: undefined,
      ssoChild: { parentId: h.work.id, attemptId: "historical-idp-child" },
      variant: 0,
      account: { ...h.work.selected.account, origin: idp },
      document: { origin: idp, tabId: 7, frameId: 0, documentId: "idp-document" },
      state: "blocked",
      outcome: "cancelled",
      usedOperationIds: ["child-submit"],
      operationId: "child-submit",
      operationKind: "click",
      mutationIntent: true,
    });
    const childLive = {
      ...h.ctx.live,
      document: child.document,
      url: idp + "/login",
      path: "/login",
    };
    h.work.childId = child.id;
    h.rt.attempts.set(7, { metadata: child, live: childLive, running: false } as Execution);
    h.rt.persisted.set("7 " + idp, child);
    expect(await ssoAdmit(h.rt, h.ctx)).toEqual({ ok: false, reason: "sso-completed" });
    const historical = h.rt.persisted.get("7 " + idp)!;
    expect(historical).toMatchObject({
      ssoChild: { released: true },
      submissions: 1,
      mutationIntent: true,
      operationId: "child-submit",
    });
    expect(heldElsewhere(h.rt, 8, idp)).toBe(false);
    expect(h.rt.persisted.get("7 " + rp)?.state).toBe("authenticated");
    expect(h.rt.confirmFill.proofs.some((proof) => proof.origin === idp)).toBe(false);
  });
  it("saves the RP default without reentering a locked settings update queue", async () => {
    const h = harness({ ok: true, identity: "absent" }, true);
    await Promise.all([h.rt.sso.loaded, h.rt.confirmFill.loaded]);
    let updating = false;
    h.rt.settings.handle = vi.fn(async () => {
      if (updating) throw new Error("A settings update authorizer cannot reenter its own queue");
      return structuredClone(h.saved);
    });
    h.update.mockImplementation(async (_revision, _cause, mutate, authorize) => {
      updating = true;
      try {
        expect(await authorize?.(h.saved.snapshot, async () => h.saved.catalog)).toBe(true);
        h.saved.snapshot = {
          ...mutate(structuredClone(h.saved.snapshot)),
          revision: h.saved.snapshot.revision + 1,
        };
        return structuredClone(h.saved.snapshot);
      } finally {
        updating = false;
      }
    });
    expect(await ssoAdmit(h.rt, h.ctx)).toEqual({ ok: false, reason: "sso-completed" });
    expect(h.update).toHaveBeenCalledTimes(1);
    expect(h.saved.snapshot.settings.siteDefaults).toContainEqual(
      expect.objectContaining({ origin: rp, itemId: rpItem }),
    );
  });
  it.each(["revision", "catalog", "document"])(
    "does not save an RP default if %s changes inside the settings update authorization",
    async (changed) => {
      const h = harness({ ok: true, identity: "absent" }, true);
      await Promise.all([h.rt.sso.loaded, h.rt.confirmFill.loaded]);
      const mutateDefault = vi.fn();
      h.update.mockImplementation(async (_revision, _cause, mutate, authorize) => {
        const snapshot = structuredClone(h.saved.snapshot);
        if (changed === "revision") snapshot.revision++;
        const catalog = async () => {
          if (changed === "document") h.rt.documents.delete(h.ctx.key);
          const current = structuredClone(h.saved.catalog);
          if (changed === "catalog") current.connections = [];
          return current;
        };
        const allowed = await authorize?.(snapshot, catalog);
        expect(allowed).toBe(false);
        if (allowed) {
          mutateDefault();
          mutate(snapshot);
        }
        return structuredClone(h.saved.snapshot);
      });
      expect(await ssoAdmit(h.rt, h.ctx)).toEqual({ ok: false, reason: "sso-completed" });
      expect(h.update).toHaveBeenCalledTimes(1);
      expect(mutateDefault).not.toHaveBeenCalled();
      expect(h.saved.snapshot.settings.siteDefaults.some((entry) => entry.origin === rp)).toBe(
        false,
      );
    },
  );
});

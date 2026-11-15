import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAttemptMetadata,
  createDefaultSettings,
  type LoginRecipe,
  type SettingsResponse,
} from "@pateat/contracts";
import type { SsoNativeChoice as Choice } from "../runtime/sso-state";
import type { Execution, LiveDocument } from "../runtime/types";
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
const { fallBack } = await import("../runtime/passkey");
const { bindNativeChoice, ssoAfterPasskey } = await import("../runtime/sso/passkey-refused");
const { createLoginBadge, memoryBadgeStorage } = await import("../badge");
const rp = "https://rp.example.test";
const itemId = "a0000000-0000-4000-8000-000000000001";
const account = { origin: rp, connectionId: "rp-vault", itemId };

/** A login on the passkey route the SSO method chooser picked, with a password variant. */
function harness() {
  const saved: Extract<SettingsResponse, { ok: true }> = {
    version: 1,
    ok: true,
    snapshot: { version: 1, revision: 3, settings: createDefaultSettings() },
    catalog: { connections: [] },
  };
  const handle = vi.fn(async () => structuredClone(saved));
  const fields = vi.fn(async () => "Synthetic value");
  const report = vi.fn();
  const rt = createRuntimeState(
    { handle, update: vi.fn() },
    {
      fields,
      report,
      badge: createLoginBadge({ setBadge: vi.fn(), storage: memoryBadgeStorage() }),
    },
  );
  rt.attemptRecords.write = vi.fn(async () => undefined);
  const live: LiveDocument = {
    document: { origin: rp, tabId: 7, frameId: 0, documentId: "rp-document" },
    token: "rp-token",
    url: rp + "/signin",
    path: "/signin",
    seenAt: Date.now(),
    timing: { since: Date.now(), serviceMs: 0, networkMs: 0, personMs: 0 },
  };
  const recipe: LoginRecipe = {
    version: 1,
    id: "synthetic-rp",
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
    passkey: { path: "/signin", target: { by: "id", value: "passkey" } },
    maxSubmissions: 1,
  };
  const metadata = createAttemptMetadata({
    id: "rp-passkey-run",
    timing: { ...live.timing, pageMs: 0 },
    recipe,
    policyRevision: 3,
    account,
    choice: { route: "passkey" },
    facts: { password: true, totp: false, passkey: true, discoverablePasskey: true },
    document: live.document,
  });
  const run: Execution = {
    metadata,
    recipe,
    live,
    running: false,
    choice: {
      connectionId: account.connectionId,
      binding: {
        origin: rp,
        provider: "bitwarden",
        server: "cloud-us",
        userId: itemId,
        itemId,
        itemName: "Synthetic RP",
      },
    },
  };
  rt.documents.set("7:0", live);
  rt.attempts.set(7, run);
  rt.sso.native.set(7, {
    document: live.document,
    account,
    chosen: { connectionId: account.connectionId, itemId, saved: true, source: "default" },
    route: "passkey",
    automatic: true,
    methods: true,
    attemptId: metadata.id,
  });
  return { rt, run, live, fields, report };
}
const executed = () => fake.state.messages.filter((entry) => entry.type === "login.execute");
beforeEach(() => {
  io.getItem.mockReset().mockResolvedValue(null);
  io.setItem.mockReset().mockResolvedValue(undefined);
  io.getItems.mockReset().mockResolvedValue([]);
  io.setItems.mockReset().mockResolvedValue(undefined);
  fake.state.storage = {};
  fake.state.session = {};
  fake.state.messages = [];
  fake.state.reconnects = [];
  fake.state.onReconnect = undefined;
});

describe("a passkey the site refused after the SSO method chooser picked it (ADR 0085)", () => {
  it.each(["answer-failed", "sign-in-rejected", "sign-in-shown", "request-missing"] as const)(
    "goes back to the chooser without the passkey instead of the password (%s)",
    async (cause) => {
      const h = harness();
      await Promise.all([h.rt.sso.loaded, h.rt.confirmFill.loaded]);
      await fallBack(h.rt, h.run, cause);
      // No password route: nothing is filled or clicked, and the login holds nothing.
      expect(h.run.metadata).toMatchObject({ route: "passkey", state: "blocked" });
      expect(h.rt.attempts.has(7)).toBe(false);
      expect(executed()).toEqual([]);
      expect(h.fields).not.toHaveBeenCalled();
      // The page announces itself again, and its next choice leaves the passkey out.
      expect(h.rt.sso.native.has(7)).toBe(false);
      expect(h.rt.sso.passkeyRefused.get(7)).toEqual(account);
      expect(fake.state.reconnects).toEqual([{ tabId: 7, frameId: 0, documentId: "rp-document" }]);
    },
  );
  it("leaves a passkey login the chooser did not pick to the password fallback", async () => {
    const h = harness();
    h.rt.sso.native.delete(7);
    expect(await ssoAfterPasskey(h.rt, h.run)).toBe(false);
    expect(h.rt.attempts.get(7)).toBe(h.run);
    expect(h.rt.sso.passkeyRefused.size).toBe(0);
  });
  it.each([
    ["a password choice", (choice: Choice): Choice => ({ ...choice, route: "password" })],
    [
      "another account's choice",
      (choice: Choice): Choice => ({ ...choice, account: { ...account, itemId: "other-item" } }),
    ],
    // The person's own pick for "Log in now" on an item with no SSO method (ADR 0034 rule 6).
    [
      "an explicit manual choice on an item without SSO methods",
      ({ automatic: _automatic, methods: _methods, ...choice }: Choice): Choice => choice,
    ],
    // A choice made for an earlier login, or one that started none, is not this login's.
    [
      "an earlier login's choice",
      (choice: Choice): Choice => ({ ...choice, attemptId: "earlier" }),
    ],
    [
      "a choice that started no login",
      ({ attemptId: _attemptId, ...choice }: Choice): Choice => choice,
    ],
  ] as const)("leaves the password fallback to a login after %s", async (_name, change) => {
    const h = harness();
    h.rt.sso.native.set(7, change(h.rt.sso.native.get(7)!));
    expect(await ssoAfterPasskey(h.rt, h.run)).toBe(false);
    expect(h.rt.attempts.get(7)).toBe(h.run);
    expect(h.rt.sso.native.has(7)).toBe(true);
    expect(h.rt.sso.passkeyRefused.size).toBe(0);
  });
  it("lets an IdP's own login during an SSO hop fall back as any native login does", async () => {
    const h = harness();
    // The durable exclusion an exact native IdP child carries.
    h.run.metadata = {
      ...h.run.metadata,
      ssoChild: { parentId: "sso-parent", attemptId: h.run.metadata.id },
    };
    expect(await ssoAfterPasskey(h.rt, h.run)).toBe(false);
    expect(h.rt.attempts.get(7)).toBe(h.run);
    expect(h.rt.sso.passkeyRefused.size).toBe(0);
  });
  it.each(["answer-failed", "sign-in-rejected"] as const)(
    "stops a passkey the person picked for Log in now on an item with SSO methods (%s)",
    async (cause) => {
      const h = harness();
      const { automatic: _automatic, ...manual } = h.rt.sso.native.get(7)!;
      h.rt.sso.native.set(7, manual);
      await Promise.all([h.rt.sso.loaded, h.rt.confirmFill.loaded]);
      await fallBack(h.rt, h.run, cause);
      // No password: the login stops with the refused passkey, and the next choice the
      // popup offers leaves the passkey out.
      expect(h.run.metadata).toMatchObject({ route: "passkey", state: "blocked" });
      expect(h.rt.attempts.get(7)).toBe(h.run);
      expect(executed()).toEqual([]);
      expect(h.fields).not.toHaveBeenCalled();
      expect(h.rt.sso.native.has(7)).toBe(false);
      expect(h.rt.sso.passkeyRefused.get(7)).toEqual(account);
      // Nothing chooses a method by itself after the person's own pick.
      expect(fake.state.reconnects).toEqual([]);
    },
  );
});

describe("the login a native method choice started", () => {
  const started = (id: string, item = itemId) =>
    ({ id, account: { ...account, itemId: item } }) as Execution["metadata"];
  it("names only the first login of the choice's own document and account", () => {
    const h = harness();
    const { attemptId: _attemptId, ...choice } = h.rt.sso.native.get(7)!;
    h.rt.sso.native.set(7, choice);
    bindNativeChoice(h.rt, { ...h.live.document, documentId: "other" }, started("a"));
    bindNativeChoice(h.rt, h.live.document, started("b", "other-item"));
    expect(h.rt.sso.native.get(7)!.attemptId).toBeUndefined();
    bindNativeChoice(h.rt, h.live.document, started("c"));
    bindNativeChoice(h.rt, h.live.document, started("d"));
    expect(h.rt.sso.native.get(7)!.attemptId).toBe("c");
  });
});

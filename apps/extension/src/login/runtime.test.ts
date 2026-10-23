import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsResponse } from "@pateat/contracts";
import type { LoginFieldSource } from "./vault";
import type { LoginReport } from "./runtime";

const fake = vi.hoisted(() => {
  const state = {
    storage: {} as Record<string, unknown>,
    messages: [] as { type: string; values?: { slot: string; value: string }[] }[],
    /** The tab's page, and the path its observations report. */
    pageUrl: "http://127.0.0.1:3847/single",
    observedPath: "/single",
  };
  const pageUrl = state.pageUrl;
  const browser = {
    runtime: {
      id: "synthetic-extension",
      getURL: (path: string) => `chrome-extension://synthetic-extension${path}`,
    },
    storage: {
      local: {
        setAccessLevel: async () => undefined,
        get: async (keys: string | string[]) =>
          Object.fromEntries(
            [keys]
              .flat()
              .filter((key) => key in state.storage)
              .map((key) => [key, state.storage[key]]),
          ),
        set: async (values: Record<string, unknown>) => {
          Object.assign(state.storage, structuredClone(values));
        },
        remove: async (keys: string | string[]) => {
          for (const key of [keys].flat()) delete state.storage[key];
        },
      },
    },
    tabs: {
      query: async () => [{ id: 1, url: state.pageUrl }],
      get: async (id: number) => ({ id, url: state.pageUrl }),
      // A cooperative synthetic page: each fixed operation succeeds and completion is visible.
      sendMessage: async (_tabId: number, message: Record<string, unknown>) => {
        state.messages.push(structuredClone(message) as (typeof state.messages)[number]);
        if (message["type"] === "login.observe")
          return { path: state.observedPath, targets: ["unique", "missing"] };
        if (message["type"] === "login.execute") {
          const operation = message["operation"] as {
            operationId: string;
            document: { documentId: string };
          };
          return {
            ok: true,
            operationId: operation.operationId,
            documentId: operation.document.documentId,
            mutation: "possible",
          };
        }
        return { ok: true };
      },
      onRemoved: { addListener: () => undefined },
      onReplaced: { addListener: () => undefined },
    },
  };
  // WXT storage reads `chrome` when it loads.
  Object.assign(globalThis, { chrome: browser });
  return { state, browser, pageUrl };
});
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
// The loopback adapter and its controls exist only in the probe build.
vi.stubEnv("MODE", "probe");
const { createLoginRuntime } = await import("./runtime");

const origin = "http://127.0.0.1:3847";
const connectionId = "50000000-0000-4000-8000-000000000001";
const itemId = "80000000-0000-4000-8000-000000000001";
const userId = "70000000-0000-4000-8000-000000000001";
const first = "60000000-0000-4000-8000-000000000001";
const second = "60000000-0000-4000-8000-000000000002";
const trusted = {
  id: "synthetic-extension",
  url: "chrome-extension://synthetic-extension/options.html",
};
const page = {
  id: "synthetic-extension",
  tab: { id: 1 },
  frameId: 0,
  documentId: "synthetic-document",
  origin: new URL(fake.pageUrl).origin,
  url: fake.pageUrl,
} as never;

type Catalog = {
  snapshot?: () => string;
  state?: "ready" | "review-required" | "unavailable";
  quarantined?: string[];
  /** Text fields the item holds besides its password. */
  texts?: string[];
};
function settingsFor({
  snapshot = () => first,
  state = "ready",
  quarantined = [],
  texts = [],
}: Catalog) {
  return {
    handle: vi.fn(async (): Promise<SettingsResponse> => ({
      version: 1,
      ok: true,
      snapshot: {
        version: 1,
        revision: 1,
        settings: {
          connections: [
            {
              connectionId,
              enabled: true,
              selection: { mode: "all", groupIds: [], itemIds: [] },
              excludedItemIds: [],
              excludedFields: [],
            },
          ],
          excludedSites: [],
          siteDefaults: [{ origin, provider: "bitwarden", userId, itemId }],
          bindings: [],
        },
      },
      catalog: {
        connections: [
          {
            id: connectionId,
            label: "Synthetic live vault",
            provider: "bitwarden",
            userId,
            snapshotId: snapshot(),
            state,
            quarantinedItemIds: quarantined,
            groups: [],
            items: [
              {
                id: itemId,
                label: "Synthetic item",
                allowedOrigins: [],
                groupIds: [],
                fields: [
                  { id: "login.password", label: "Password", name: null, kind: "hidden" as const },
                  ...texts.map((id) => ({ id, label: id, name: id, kind: "text" as const })),
                ],
              },
            ],
          },
        ],
      },
    })),
  };
}
async function start(
  fields: LoginFieldSource,
  catalog: Catalog = {},
  report?: (report: LoginReport) => void,
  vault?: Parameters<typeof createLoginRuntime>[1]["vault"],
) {
  const login = createLoginRuntime(settingsFor(catalog), {
    fields,
    ...(report ? { report } : {}),
    ...(vault ? { vault } : {}),
  });
  expect(
    await login.handle(
      {
        version: 1,
        type: "login.probe.configure",
        origin,
        account: { connectionId, itemId, slots: [{ slot: "password", fieldId: "login.password" }] },
      },
      trusted as never,
    ),
  ).toEqual({ ok: true });
  const ready = await login.handle(
    {
      version: 1,
      type: "login.document.ready",
      token: "synthetic-token",
      start: { path: new URL(fake.pageUrl).pathname },
    },
    page,
  );
  const attempt = async () =>
    (
      (await login.handle({ version: 1, type: "login.probe.status" }, trusted as never)) as {
        attempts: { state: string; outcome?: string }[];
      }
    ).attempts[0];
  return { login, ready, attempt };
}
const executions = () => fake.state.messages.filter((message) => message.type === "login.execute");

describe("login runtime with a live vault field source", () => {
  beforeEach(() => {
    fake.state.storage = {};
    fake.state.messages = [];
    fake.state.pageUrl = fake.pageUrl;
    fake.state.observedPath = "/single";
  });
  it("delivers a resolved value only to the bound slot and completes the login", async () => {
    const fields = vi.fn<LoginFieldSource>(async () => "synthetic-secret");
    const run = await start(fields);
    expect(run.ready).toEqual({ ok: true });
    await vi.waitFor(async () =>
      expect(await run.attempt()).toMatchObject({ state: "authenticated" }),
    );
    expect(fields).toHaveBeenCalledTimes(1);
    expect(fields.mock.calls[0]![0]).toMatchObject({
      account: { origin, connectionId, itemId },
      connection: { id: connectionId, snapshotId: first },
      fieldId: "login.password",
    });
    // The fill step carried the one bound value; the submit click carried none.
    expect(executions().map((message) => message.values?.length)).toEqual([1, 0]);
    expect(JSON.stringify(fake.state.storage)).not.toContain("synthetic-secret");
  });
  it.each([
    ["withholds a value", async () => undefined],
    [
      "fails",
      async () => {
        throw new Error("synthetic vault failure");
      },
    ],
  ])("blocks without any page operation when the source %s", async (_name, source) => {
    const report = vi.fn<(report: LoginReport) => void>();
    const run = await start(source, {}, report);
    await vi.waitFor(async () =>
      expect(await run.attempt()).toMatchObject({ state: "blocked", outcome: "policy-changed" }),
    );
    expect(executions()).toEqual([]);
    expect(report.mock.calls.at(-1)![0]).toMatchObject({
      state: "blocked",
      operation: "fill",
      cause: "field-unavailable",
    });
  });
  it("withdraws resolved values when the catalog snapshot is replaced before delivery", async () => {
    let snapshot = first;
    const report = vi.fn<(report: LoginReport) => void>();
    const run = await start(
      async () => {
        snapshot = second;
        return "synthetic-secret";
      },
      { snapshot: () => snapshot },
      report,
    );
    await vi.waitFor(async () =>
      expect(await run.attempt()).toMatchObject({ state: "blocked", outcome: "policy-changed" }),
    );
    expect(executions()).toEqual([]);
    expect(report.mock.calls.at(-1)![0]).toMatchObject({
      state: "blocked",
      cause: "vault-replaced",
    });
  });
  it.each(["synced", "saved"] as const)(
    "names settings %s while a login runs as the cause that stopped it",
    async (source) => {
      let release!: (value: string) => void;
      const pending = new Promise<string>((resolve) => (release = resolve));
      const report = vi.fn<(report: LoginReport) => void>();
      const fields = vi.fn<LoginFieldSource>(() => pending);
      const run = await start(fields, {}, report);
      await vi.waitFor(() => expect(fields).toHaveBeenCalled());
      run.login.settingsChanged(source);
      await vi.waitFor(async () =>
        expect(await run.attempt()).toMatchObject({ state: "blocked", outcome: "policy-changed" }),
      );
      release("synthetic-secret");
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "attempt",
          state: "blocked",
          cause: source === "synced" ? "settings-synced" : "settings-saved",
        }),
      );
      expect(executions()).toEqual([]);
    },
  );
  it.each<[string, Catalog]>([
    ["an item that awaits field review", { state: "review-required", quarantined: [itemId] }],
    ["a quarantined item even if the connection reports ready", { quarantined: [itemId] }],
    ["an unavailable connection", { state: "unavailable" }],
  ])("refuses %s before creating an attempt", async (_name, catalog) => {
    const fields = vi.fn<LoginFieldSource>(async () => "synthetic-secret");
    const run = await start(fields, catalog);
    expect(run.ready).toEqual({ ok: false, reason: "vault-unavailable" });
    expect(await run.attempt()).toBeUndefined();
    expect(fields).not.toHaveBeenCalled();
  });
  it("checks the vault and holds its replacement off until the login is recorded", async () => {
    const events: string[] = [];
    const vault = {
      refreshIfStale: () => events.push("refresh"),
      enter: vi.fn(async (_wait: boolean) => {
        events.push("enter");
        return () => events.push("leave");
      }),
    };
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => (release = resolve));
    const run = await start(() => pending, {}, undefined, vault);
    expect(run.ready).toEqual({ ok: true });
    expect(events).toEqual(["refresh", "enter", "leave"]);
    expect(vault.enter).toHaveBeenCalledWith(true);
    // Once the page is released, the login itself keeps a replacement waiting.
    expect(await run.login.active()).toBe(true);
    release("synthetic-secret");
    await vi.waitFor(async () =>
      expect(await run.attempt()).toMatchObject({ state: "authenticated" }),
    );
  });
  it("a site count's job delays a page's login without refusing it, and stops for it", async () => {
    const login = createLoginRuntime(settingsFor({}), {
      fields: vi.fn<LoginFieldSource>(async () => "synthetic-secret"),
      vault: { refreshIfStale: () => undefined, enter: async () => () => undefined },
    });
    expect(
      await login.handle(
        {
          version: 1,
          type: "login.probe.configure",
          origin,
          account: {
            connectionId,
            itemId,
            slots: [{ slot: "password", fieldId: "login.password" }],
          },
        },
        trusted as never,
      ),
    ).toEqual({ ok: true });
    let finish!: () => void;
    const job = new Promise<void>((resolve) => (finish = resolve));
    const sent = vi.fn(() => job);
    const counted = login.siteCount.step(sent);
    // The job is sent before the page announces.
    await vi.waitFor(() => expect(sent).toHaveBeenCalled());
    let answered = false;
    const ready = login
      .handle(
        {
          version: 1,
          type: "login.document.ready",
          token: "synthetic-token",
          start: { path: new URL(fake.pageUrl).pathname },
        },
        page,
      )
      .finally(() => (answered = true));
    // While the page is being admitted, the count's next job does not start.
    const next = vi.fn(async () => "next");
    expect(await login.siteCount.step(next)).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(answered).toBe(false);
    finish();
    expect(await counted).toEqual({ value: undefined });
    expect(await ready).toEqual({ ok: true });
    // Nor while the login it admitted runs.
    expect(await login.active()).toBe(true);
    expect(await login.siteCount.step(next)).toBeUndefined();
    expect(next).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect(await login.active()).toBe(false));
  });
  it("tells the site count once a top frame's announcement is handled", async () => {
    const events: string[] = [];
    const login = createLoginRuntime(settingsFor({}), {
      fields: vi.fn<LoginFieldSource>(async () => "synthetic-secret"),
      vault: {
        refreshIfStale: () => undefined,
        enter: async () => () => events.push("admitted"),
      },
      announced: (tabId, url) => events.push(`announced ${tabId} ${url}`),
    });
    const hello = { version: 1, type: "login.document.ready", token: "synthetic-token" };
    await login.handle(hello, page);
    await login.handle(hello, { ...(page as object), frameId: 3 } as never);
    await vi.waitFor(() => expect(events).toContain(`announced 1 ${fake.pageUrl}`));
    expect(events.indexOf("admitted")).toBeLessThan(events.indexOf(`announced 1 ${fake.pageUrl}`));
    expect(events.filter((event) => event.startsWith("announced"))).toHaveLength(1);
  });
  it("a hello waiting on a vault check is stale once a later hello from the frame arrives", async () => {
    let open!: () => void;
    const blocked = new Promise<void>((resolve) => (open = resolve));
    let waits = 0;
    const vault = {
      refreshIfStale: () => undefined,
      enter: async (wait: boolean) => {
        if (wait && (waits += 1) === 2) await blocked;
        return () => undefined;
      },
    };
    const run = await start(async () => "synthetic-secret", {}, undefined, vault);
    await vi.waitFor(async () =>
      expect(await run.attempt()).toMatchObject({ state: "authenticated" }),
    );
    const hello = (startPath?: string) =>
      run.login.handle(
        {
          version: 1,
          type: "login.document.ready",
          token: "synthetic-token",
          ...(startPath ? { start: { path: startPath } } : {}),
        },
        page,
      );
    const older = hello(new URL(fake.pageUrl).pathname);
    const later = await hello();
    expect(later).not.toEqual({ ok: false, reason: "stale-document" });
    open();
    expect(await older).toEqual({ ok: false, reason: "stale-document" });
  });
  it("reports a running login, also from its saved state after a restart", async () => {
    let release!: (value: string) => void;
    const pending = new Promise<string>((resolve) => (release = resolve));
    const fields = vi.fn<LoginFieldSource>(() => pending);
    const run = await start(fields);
    expect(run.ready).toEqual({ ok: true });
    await vi.waitFor(() => expect(fields).toHaveBeenCalled());
    expect(await run.login.active()).toBe(true);
    // A restarted worker has no live document yet; the saved attempt still counts.
    const restarted = createLoginRuntime(settingsFor({}), { fields: async () => undefined });
    // Read before anything else, the saved attempts are loaded first.
    expect(await restarted.active()).toBe(true);
    release("synthetic-secret");
    await vi.waitFor(async () =>
      expect(await run.attempt()).toMatchObject({ state: "authenticated" }),
    );
    expect(await run.login.active()).toBe(false);
  });
  it("reports state changes and refusals without account or item IDs", async () => {
    const report = vi.fn<(report: LoginReport) => void>();
    const run = await start(async () => "synthetic-secret", {}, report);
    await vi.waitFor(async () =>
      expect(await run.attempt()).toMatchObject({ state: "authenticated" }),
    );
    const attempts = report.mock.calls.map(([value]) => value);
    expect(attempts.at(-1)).toMatchObject({
      type: "attempt",
      origin,
      state: "authenticated",
      tabId: expect.any(Number),
      recipeId: expect.any(String),
    });
    // Each report is a change from the previous state.
    const states = attempts.map((value) => (value.type === "attempt" ? value.state : value.type));
    expect(states.every((state, index) => index === 0 || state !== states[index - 1])).toBe(true);
    const refused = vi.fn<(report: LoginReport) => void>();
    // A fresh worker with no saved attempt.
    fake.state.storage = {};
    await start(async () => "synthetic-secret", { state: "unavailable" }, refused);
    expect(refused).toHaveBeenCalledWith(
      expect.objectContaining({ type: "refused", origin, reason: "vault-unavailable" }),
    );
    const serialized = JSON.stringify([...report.mock.calls, ...refused.mock.calls]);
    for (const id of [connectionId, itemId, userId, "synthetic-secret"])
      expect(serialized).not.toContain(id);
  });
  it("still uses an unrelated item while another item in the connection awaits review", async () => {
    const run = await start(async () => "synthetic-secret", {
      state: "review-required",
      quarantined: ["80000000-0000-4000-8000-000000000002"],
    });
    expect(run.ready).toEqual({ ok: true });
    await vi.waitFor(async () =>
      expect(await run.attempt()).toMatchObject({ state: "authenticated" }),
    );
  });

  describe("the probe recipe with two identifier sets (ADR 0027)", () => {
    const variantsUrl = `${origin}/variants`;
    async function startVariants(
      slots: { slot: string; fieldId: string }[],
      fields: LoginFieldSource,
      report?: (report: LoginReport) => void,
    ) {
      fake.state.pageUrl = variantsUrl;
      fake.state.observedPath = "/authenticated";
      const login = createLoginRuntime(
        settingsFor({ texts: ["branch-number", "account-number", "contract-number"] }),
        {
          fields,
          ...(report ? { report } : {}),
        },
      );
      expect(
        await login.handle(
          {
            version: 1,
            type: "login.probe.configure",
            origin,
            account: { connectionId, itemId, slots },
          },
          trusted as never,
        ),
      ).toEqual({ ok: true });
      const ready = await login.handle(
        {
          version: 1,
          type: "login.document.ready",
          token: "synthetic-token",
          start: { path: "/variants" },
        },
        { ...(page as object), url: variantsUrl } as never,
      );
      const attempt = async () =>
        (
          (await login.handle({ version: 1, type: "login.probe.status" }, trusted as never)) as {
            attempts: { state: string; variant?: number }[];
          }
        ).attempts[0];
      return { ready, attempt };
    }

    it("binds only the slots of the variant the configured account maps", async () => {
      const fields = vi.fn<LoginFieldSource>(async () => "synthetic-secret");
      const run = await startVariants(
        [
          { slot: "branch", fieldId: "branch-number" },
          { slot: "account", fieldId: "account-number" },
          { slot: "password", fieldId: "login.password" },
        ],
        fields,
      );
      expect(run.ready).toEqual({ ok: true });
      await vi.waitFor(async () =>
        expect(await run.attempt()).toMatchObject({ state: "authenticated", variant: 1 }),
      );
      expect(fields.mock.calls.map(([read]) => read.fieldId)).toEqual([
        "branch-number",
        "account-number",
        "login.password",
      ]);
      expect(executions().map((message) => message.values?.map((value) => value.slot))).toEqual([
        ["branch", "account", "password"],
        [],
      ]);
    });

    it("takes the first variant when the account maps every slot, ignoring the others", async () => {
      const fields = vi.fn<LoginFieldSource>(async () => "synthetic-secret");
      const run = await startVariants(
        [
          { slot: "contract", fieldId: "contract-number" },
          { slot: "branch", fieldId: "branch-number" },
          { slot: "account", fieldId: "account-number" },
          { slot: "password", fieldId: "login.password" },
        ],
        fields,
      );
      expect(run.ready).toEqual({ ok: true });
      await vi.waitFor(async () =>
        expect(await run.attempt()).toMatchObject({ state: "authenticated", variant: 0 }),
      );
      expect(fields.mock.calls.map(([read]) => read.fieldId)).toEqual([
        "contract-number",
        "login.password",
      ]);
    });

    it("refuses no-route when the account maps neither identifier set", async () => {
      const fields = vi.fn<LoginFieldSource>(async () => "synthetic-secret");
      const report = vi.fn<(report: LoginReport) => void>();
      const run = await startVariants(
        [{ slot: "password", fieldId: "login.password" }],
        fields,
        report,
      );
      expect(run.ready).toEqual({ ok: false, reason: "no-route" });
      expect(report).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "refused",
          reason: "no-route",
          detail: "binding-slots-mismatch",
        }),
      );
      expect(await run.attempt()).toBeUndefined();
      expect(fields).not.toHaveBeenCalled();
    });
  });
});

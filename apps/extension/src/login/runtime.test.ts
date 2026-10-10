import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SettingsResponse } from "@pateat/contracts";
import type { LoginFieldSource } from "./vault";

const fake = vi.hoisted(() => {
  const state = {
    storage: {} as Record<string, unknown>,
    messages: [] as { type: string; values?: { slot: string; value: string }[] }[],
  };
  const pageUrl = "http://127.0.0.1:3847/single";
  const browser = {
    runtime: {
      id: "synthetic-extension",
      getURL: (path: string) => `chrome-extension://synthetic-extension${path}`,
    },
    storage: {
      local: {
        setAccessLevel: async () => undefined,
        get: async (keys: string[]) =>
          Object.fromEntries(
            keys.filter((key) => key in state.storage).map((key) => [key, state.storage[key]]),
          ),
        set: async (values: Record<string, unknown>) => {
          Object.assign(state.storage, structuredClone(values));
        },
      },
    },
    tabs: {
      query: async () => [{ id: 1, url: pageUrl }],
      get: async (id: number) => ({ id, url: pageUrl }),
      // A cooperative synthetic page: each fixed operation succeeds and completion is visible.
      sendMessage: async (_tabId: number, message: Record<string, unknown>) => {
        state.messages.push(structuredClone(message) as (typeof state.messages)[number]);
        if (message["type"] === "login.observe")
          return { path: "/single", targets: ["unique", "missing"] };
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
    },
  };
  return { state, browser, pageUrl };
});
vi.mock("wxt/browser", () => ({ browser: fake.browser }));
// The loopback adapter and its controls exist only in the probe build.
vi.stubEnv("MODE", "probe");
const { createLoginRuntime } = await import("./runtime");

const origin = "http://127.0.0.1:3847";
const connectionId = "50000000-0000-4000-8000-000000000001";
const itemId = "80000000-0000-4000-8000-000000000001";
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
  url: fake.pageUrl,
} as never;

type Catalog = {
  snapshot?: () => string;
  state?: "ready" | "review-required" | "unavailable";
  quarantined?: string[];
};
function settingsFor({ snapshot = () => first, state = "ready", quarantined = [] }: Catalog) {
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
          siteDefaults: [{ origin, connectionId, itemId }],
        },
      },
      catalog: {
        connections: [
          {
            id: connectionId,
            label: "Synthetic live vault",
            provider: "bitwarden",
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
                ],
              },
            ],
          },
        ],
      },
    })),
  };
}
async function start(fields: LoginFieldSource, catalog: Catalog = {}) {
  const login = createLoginRuntime(settingsFor(catalog), { fields });
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
    { version: 1, type: "login.document.ready", token: "synthetic-token" },
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
    const run = await start(source);
    await vi.waitFor(async () =>
      expect(await run.attempt()).toMatchObject({ state: "blocked", outcome: "policy-changed" }),
    );
    expect(executions()).toEqual([]);
  });
  it("withdraws resolved values when the catalog snapshot is replaced before delivery", async () => {
    let snapshot = first;
    const run = await start(
      async () => {
        snapshot = second;
        return "synthetic-secret";
      },
      { snapshot: () => snapshot },
    );
    await vi.waitFor(async () =>
      expect(await run.attempt()).toMatchObject({ state: "blocked", outcome: "policy-changed" }),
    );
    expect(executions()).toEqual([]);
  });
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
});
